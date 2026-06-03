// ═══════════════════════════════════════════════════════════════
// PROJECT WORKSPACE — 3 tabs (All Issues / Duplicate Review / Result)
// State is loaded from and saved to the server (shared, last-write-wins).
// Reuses the pipeline (stage1/2/3) and file-loader.js (column mapping).
// ═══════════════════════════════════════════════════════════════

let RAW_DATA = [];
let BLOCKS = [];
let BLOCK_COUNTS = {};

let PROJECT = { id: null, name: '', status: 'draft', isOwner: false, members: [] };

let state = {
  tab: 'issues',          // 'issues' | 'review' | 'result'
  currentBlock: 'all',
  groups: [],
  decisions: {},
  removedIds: new Set(),
  currentGroupIdx: 0,
  filterText: '',
  filterBlock: 'all',
  filterStatus: 'all',
  fileName: '',
  failedBlocks: [],       // blocks whose Stage-2 call failed (e.g. 502) — retryable
};

// Max simultaneous /api/messages calls. Firing one per block all at once
// overloads the proxy on a small instance → 502s. 3 keeps it fast but safe.
const LLM_CONCURRENCY = 3;

// ─── Helpers ─────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Run `worker` over `items` with at most `limit` in flight. Preserves order.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function recomputeBlocks() {
  BLOCKS = [...new Set(RAW_DATA.map(d => d.block))];
  BLOCK_COUNTS = {};
  BLOCKS.forEach(b => { BLOCK_COUNTS[b] = RAW_DATA.filter(d => d.block === b).length; });
}

function getBlockIssues(block) {
  if (block === 'all' || block === '__review__') return RAW_DATA;
  return RAW_DATA.filter(d => d.block === block);
}

// ─── Load / open project ─────────────────────────────────────────

async function openProject(projectId) {
  const v = document.getElementById('viewProject');
  v.innerHTML = `<div class="loading-screen">Loading project…</div>`;
  try {
    const res = await api.getProject(projectId);
    PROJECT = {
      id: res.project.id,
      name: res.project.name,
      status: res.project.status,
      isOwner: res.is_owner,
      members: res.members,
    };
    const d = res.data || {};
    RAW_DATA = d.raw_data || [];
    recomputeBlocks();
    state.groups = d.groups || [];
    state.decisions = d.decisions || {};
    state.failedBlocks = d.failed_blocks || [];
    migrateDecisions();              // upgrade any legacy decision shapes
    recomputeRemoved();              // derive removed set from decisions (consistent)
    state.fileName = d.file_name || '';
    state.currentBlock = 'all';
    state.currentGroupIdx = 0;
    draft = { gi: null, removed: new Set() };
    // pick a sensible starting tab
    state.tab = PROJECT.status === 'completed' ? 'result'
              : (state.groups.length ? 'review' : 'issues');
    renderProjectShell();
    renderTab();
  } catch (err) {
    if (err.status === 403) {
      v.innerHTML = `<div class="loading-screen">You don't have access to this project. <a href="#/projects">Back to projects</a></div>`;
    } else if (err.status === 401) {
      onSessionExpired();
    } else {
      v.innerHTML = `<div class="loading-screen">Could not load project: ${escapeHtml(err.message)} <a href="#/projects">Back</a></div>`;
    }
  }
}

// ─── Persistence ─────────────────────────────────────────────────

let _saveTimer = null;
function saveProjectData(immediate) {
  const payload = {
    file_name: state.fileName,
    raw_data: RAW_DATA,
    groups: state.groups,
    decisions: state.decisions,
    removed_ids: [...state.removedIds],
    failed_blocks: state.failedBlocks || [],
    status: PROJECT.status,
  };
  const doSave = () => api.saveData(PROJECT.id, payload).catch(e => console.warn('save failed', e));
  clearTimeout(_saveTimer);
  if (immediate) return doSave();
  _saveTimer = setTimeout(doSave, 600);
}

async function setStatus(status) {
  PROJECT.status = status;
  await saveProjectData(true);
  updateHeader();
}

// ─── Shell (header + tabs) ───────────────────────────────────────

function renderProjectShell() {
  const v = document.getElementById('viewProject');
  v.innerHTML = `
    <div class="header">
      <div class="header-top">
        <div class="logo">
          <div class="logo-hex-mark"></div>
          <div class="logo-wordmark">
            <span class="logo-brand">Atscale</span>
            <span class="logo-product">Deduplication</span>
          </div>
        </div>
        <button class="back-btn" onclick="goDashboard()">← Projects</button>
        <div class="proj-name" id="projName">${escapeHtml(PROJECT.name)}</div>
        <span class="pstatus pstatus-${PROJECT.status}" id="projStatus">${PROJECT.status}</span>
        <div class="stats-bar">
          <div class="stat"><div class="stat-num" id="stat-total">0</div><div class="stat-label">Total Issues</div></div>
          <div class="stat-divider"></div>
          <div class="stat"><div class="stat-num red" id="stat-removed">0</div><div class="stat-label">Removed</div></div>
          <div class="stat-divider"></div>
          <div class="stat"><div class="stat-num green" id="stat-kept">0</div><div class="stat-label">Unique Kept</div></div>
          <div class="stat-divider"></div>
          <div class="stat"><div class="stat-num" id="stat-groups">0</div><div class="stat-label">Dup Groups</div></div>
        </div>
        <div class="topbar-user">
          ${PROJECT.isOwner ? `<button class="nav-btn" onclick="openMembers()">Members (${PROJECT.members.length})</button>` : ''}
          <button class="nav-btn" onclick="goDashboard()">Dashboard</button>
        </div>
      </div>
      <div class="project-tabs" id="projectTabs"></div>
    </div>
    <div class="main">
      <div class="sidebar" id="projectSidebar"></div>
      <div class="content">
        <div class="panel" id="mainPanel"></div>
        <div class="action-row" id="actionRow" style="display:none;"></div>
      </div>
    </div>`;
  updateHeader();
  renderTabs();
}

function updateHeader() {
  const removed = state.removedIds.size;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('stat-total', RAW_DATA.length);
  set('stat-removed', removed);
  set('stat-kept', RAW_DATA.length - removed);
  set('stat-groups', state.groups.length);
  const st = document.getElementById('projStatus');
  if (st) { st.textContent = PROJECT.status; st.className = `pstatus pstatus-${PROJECT.status}`; }
}
const updateStats = updateHeader; // alias used by decision handlers

function renderTabs() {
  const pending = state.groups.filter((_, i) => !state.decisions[i]).length;
  const hasGroups = state.groups.length > 0;
  const tabs = [
    { key: 'issues', label: 'All Issues', enabled: true,
      badge: RAW_DATA.length ? String(RAW_DATA.length) : '' },
    { key: 'review', label: 'Duplicate Review', enabled: hasGroups,
      badge: hasGroups ? String(pending) : '' },
    { key: 'result', label: 'Result', enabled: hasGroups,
      badge: '' },
  ];
  document.getElementById('projectTabs').innerHTML = tabs.map(t => `
    <button class="ptab ${state.tab === t.key ? 'active' : ''} ${t.enabled ? '' : 'disabled'}"
            ${t.enabled ? `onclick="switchTab('${t.key}')"` : 'disabled'}>
      ${t.label}${t.badge ? ` <span class="ptab-badge">${t.badge}</span>` : ''}
    </button>`).join('');
}

function switchTab(tab) {
  state.tab = tab;
  renderTabs();
  renderTab();
}

function renderTab() {
  renderTabs();
  document.getElementById('actionRow').style.display = 'none';
  if (state.tab === 'issues') renderIssuesTab();
  else if (state.tab === 'review') renderReviewPanel();
  else if (state.tab === 'result') renderResultTab();
  renderSidebar();
}

// ─── Sidebar (issue list) ────────────────────────────────────────

function renderSidebar() {
  const sb = document.getElementById('projectSidebar');
  if (!RAW_DATA.length) { sb.innerHTML = ''; sb.style.display = 'none'; return; }
  sb.style.display = '';
  const issues = getBlockIssues(state.currentBlock);
  const removedInView = issues.filter(i => state.removedIds.has(i.id)).length;
  sb.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-title">${state.currentBlock === 'all' ? 'All Issues' : escapeHtml(state.currentBlock.replace(/^\d+\.\s*/,''))}</div>
      <div class="sidebar-meta">${issues.length} issues · ${removedInView} removed</div>
    </div>
    <div class="issue-list">
      ${issues.map(item => {
        const isRemoved = state.removedIds.has(item.id);
        const gi = state.groups.findIndex(g => g.primary.id === item.id || g.duplicates.some(d => d.id === item.id));
        let badge = '';
        if (isRemoved) badge = '<span class="badge badge-removed">removed</span>';
        else if (gi >= 0 && state.decisions[gi]) badge = '<span class="badge badge-kept">kept</span>';
        else if (gi >= 0) badge = '<span class="badge badge-dup">dup group</span>';
        return `<div class="issue-item ${isRemoved ? 'removed' : ''}" onclick="jumpToIssue(${item.id})">
          <div class="issue-text">${escapeHtml(item.takeaway)}</div>
          <div class="issue-meta"><span class="issue-id">#${item.id}</span>${badge}</div>
        </div>`;
      }).join('')}
    </div>`;
}

function jumpToIssue(id) {
  const gi = state.groups.findIndex(g => g.primary.id === id || g.duplicates.some(d => d.id === id));
  if (gi >= 0) { state.tab = 'review'; state.currentGroupIdx = gi; renderTab(); }
}

// ─── Block filter pills (within All Issues) ──────────────────────

// Pills pass an INDEX (not the block string) to the onclick handler — block
// names contain quotes/spaces/&, which would break an inline string attribute.
let ISSUES_FILTER_KEYS = [];
function blockPills() {
  if (!RAW_DATA.length) return '';
  ISSUES_FILTER_KEYS = ['all', ...BLOCKS];
  const html = ISSUES_FILTER_KEYS.map((key, idx) => {
    const label = key === 'all' ? 'All Blocks' : key.replace(/^\d+\.\s*/, '');
    const count = key === 'all' ? RAW_DATA.length : BLOCK_COUNTS[key];
    return `<div class="pill ${state.currentBlock === key ? 'active' : ''}" onclick="setBlockIdx(${idx})">
      ${escapeHtml(label)} <span class="pill-count">${count}</span>
    </div>`;
  }).join('');
  return `<div class="pill-nav">${html}</div>`;
}
function setBlockIdx(i) { const k = ISSUES_FILTER_KEYS[i]; if (k == null) return; setBlock(k); }
function setBlock(b) { state.currentBlock = b; renderTab(); }

// ═══════════════════════════════════════════════════════════════
// TAB 1 — ALL ISSUES (import + table + start analysis)
// ═══════════════════════════════════════════════════════════════

function renderIssuesTab() {
  const panel = document.getElementById('mainPanel');

  if (!RAW_DATA.length) {
    // Import zone (file-loader.js drives showColumnMapper / applyColumnMap)
    panel.innerHTML = `
      <div class="howto-panel" style="max-width:640px;margin:24px auto;text-align:left;">
        <div class="howto-title">📂 Import the input data (Excel / CSV)</div>
        <div id="dropZone" class="drop-zone"
             ondragover="event.preventDefault();this.classList.add('drag-over')"
             ondragleave="this.classList.remove('drag-over')"
             ondrop="handleDrop(event)">
          <div style="font-size:28px;margin-bottom:8px;">⬆</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:4px;">Drag and drop your .xlsx / .xls / .csv here</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">or</div>
          <button class="btn-primary" onclick="document.getElementById('fileInput').click()">Choose a file</button>
          <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" style="display:none" onchange="handleFileInput(event)">
          <div id="fileStatus" style="margin-top:10px;font-size:12px;font-family:'DM Mono',monospace;"></div>
        </div>
        <div id="columnMapSection" style="display:none;margin-top:16px;">
          <div class="howto-title" style="font-size:14px;">🗂 Map the columns</div>
          <div id="columnMapFields"></div>
          <button class="btn-primary" style="margin-top:16px;" onclick="applyColumnMap()">Confirm mapping →</button>
        </div>
      </div>`;
    injectDropStyles();
    return;
  }

  const analyzed = state.groups.length > 0;
  panel.innerHTML = failedBanner() + `
    <div class="issues-toolbar">
      <div>
        <div class="issues-h">Input data</div>
        <div class="issues-sub">${RAW_DATA.length} issues · ${BLOCKS.length} building blocks · ${escapeHtml(state.fileName || '')}</div>
      </div>
      ${analyzed
        ? `<button class="btn-keep-all" onclick="confirmReanalyze()">↻ Re-run analysis</button>`
        : `<button class="btn-primary" onclick="startAnalysis()">✦ Start analysis (3 stages)</button>`}
    </div>
    ${blockPills()}
    <div id="issuesTableWrap">${issuesTable()}</div>`;
}

function issuesTable() {
  const rows = getBlockIssues(state.currentBlock);
  return `
    <table class="result-table">
      <thead><tr><th>ID</th><th>Building Block</th><th>Key Takeaway</th><th>Initiative</th></tr></thead>
      <tbody>
        ${rows.map(i => `<tr>
          <td class="td-block">#${i.id}</td>
          <td class="td-block">${escapeHtml((i.block||'').replace(/^\d+\.\s*/,''))}</td>
          <td class="td-takeaway">${escapeHtml(i.takeaway)}</td>
          <td class="td-initiative">${escapeHtml(i.initiative||'')}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function injectDropStyles() {
  if (document.getElementById('dropStyles')) return;
  const s = document.createElement('style');
  s.id = 'dropStyles';
  s.textContent = `.drop-zone{border:2px dashed var(--border);border-radius:12px;padding:28px;text-align:center;transition:all .2s;background:var(--surface)}.drop-zone.drag-over{border-color:var(--accent);background:rgba(42,65,229,.04)}`;
  document.head.appendChild(s);
}

// file-loader.js calls this after column mapping is confirmed.
function onDataLoaded(parsedRows, fileName) {
  RAW_DATA = parsedRows;
  recomputeBlocks();
  state.fileName = fileName;
  state.groups = [];
  state.decisions = {};
  state.removedIds = new Set();
  draft = { gi: null, removed: new Set() };
  PROJECT.status = 'draft';
  saveProjectData(true);
  updateHeader();
  renderTab();
}

function confirmReanalyze() {
  if (confirm('Re-run the analysis? This discards current duplicate groups and review decisions.')) {
    state.groups = []; state.decisions = {}; state.removedIds = new Set();
    startAnalysis();
  }
}

// ═══════════════════════════════════════════════════════════════
// ANALYSIS (Stage 1 → 2 → 3)
// ═══════════════════════════════════════════════════════════════

async function startAnalysis() {
  const panel = document.getElementById('mainPanel');
  document.getElementById('actionRow').style.display = 'none';
  panel.innerHTML = `
    <div class="progress-screen">
      <div class="progress-ring"></div>
      <div class="progress-title">3-stage pipeline running…</div>
      <div class="progress-sub" id="progressSub">Initializing…</div>
      <div class="progress-bar-wrap"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
      <div class="batch-log" id="batchLog"></div>
    </div>`;
  const bar = document.getElementById('progressBar');
  const sub = document.getElementById('progressSub');
  const logEl = document.getElementById('batchLog');
  const log = (m, t='current') => { const d=document.createElement('div'); d.className=`batch-log-line ${t}`; d.textContent=m; logEl.appendChild(d); logEl.scrollTop=logEl.scrollHeight; };

  // Stage 0 — Embeddings (semantic vectors). Falls back to lexical-only if the
  // embeddings provider isn't configured or errors.
  sub.textContent = 'Stage 0: embedding issues (semantic)…';
  log('▶ Stage 0 — Embeddings');
  let vecById = null;
  try {
    vecById = await embedAll(RAW_DATA);
  } catch { vecById = null; }
  if (vecById) log(`  ✓ embedded ${vecById.size} issues — semantic matching ON`, 'done');
  else log('  ℹ embeddings unavailable — falling back to lexical matching', 'done');
  bar.style.width = '10%';

  // Stage 1 — Candidate pairs = embedding ∪ lexical (recall).
  sub.textContent = 'Stage 1: building candidate pairs…';
  log('▶ Stage 1 — Candidates (embedding ∪ lexical)');
  const candByBlock = {}; let totalPairs = 0;
  for (const block of BLOCKS) {
    const bi = RAW_DATA.filter(d => d.block === block);
    const lex = getCandidatePairs(bi);
    const emb = vecById ? embeddingCandidatePairs(bi, vecById) : [];
    const pairs = unionPairs(emb, lex);
    candByBlock[block] = pairs; totalPairs += pairs.length;
    log(`  ✓ ${block.replace(/^\d+\.\s*/,'')} : ${pairs.length} pairs (emb ${emb.length} / lex ${lex.length}) · ${bi.length} issues`, 'done');
  }
  log(`  → ${totalPairs} candidate pairs total`, 'done');
  bar.style.width = '20%';

  // Stage 2 — LLM clustering (one call per block, capped concurrency).
  sub.textContent = 'Stage 2: semantic LLM grouping…';
  log(`▶ Stage 2 — LLM grouping (1 call / block, max ${LLM_CONCURRENCY} in parallel)`);
  const withPairs = BLOCKS.filter(b => (candByBlock[b]||[]).length); let done = 0;
  const failed = [];
  const results = await runPool(BLOCKS, LLM_CONCURRENCY, async block => {
    const bi = RAW_DATA.filter(d => d.block === block);
    const pairs = candByBlock[block] || [];
    if (!pairs.length) { log(`  — ${block.replace(/^\d+\.\s*/,'')} : no pairs, skipped`, 'done'); return []; }
    try {
      const groups = await analyzeBlock(block, bi, pairs);
      done++; bar.style.width = (20 + Math.round(done / withPairs.length * 50)) + '%';
      log(`  ✓ ${block.replace(/^\d+\.\s*/,'')} : ${groups.length} groups proposed`, 'done');
      return groups;
    } catch (e) {
      log(`  ✗ ${block.replace(/^\d+\.\s*/,'')} : ${e.message}`, 'done');
      failed.push(block);
      return [];
    }
  });
  const rawGroups = results.flat();
  state.failedBlocks = failed;
  log(`  → ${rawGroups.length} raw groups proposed by the LLM`, 'done');
  if (failed.length) log(`  ⚠ ${failed.length} block(s) failed: ${failed.map(b=>b.replace(/^\d+\.\s*/,'')).join(', ')}`, 'done');
  bar.style.width = '70%';

  // Stage 3a — finalize (dedupe membership + pick richest primary).
  let groups = finalizeGroups(rawGroups);

  // Stage 2½ — Verification: re-check doubtful groups (low confidence or large)
  // and split/trim them. Improves precision; only doubtful groups cost a call.
  const toVerify = groups.filter(needsVerification);
  if (toVerify.length) {
    sub.textContent = `Stage 2½: verifying ${toVerify.length} doubtful group(s)…`;
    log(`▶ Stage 2½ — Verifying ${toVerify.length} doubtful group(s)`);
    const keep = groups.filter(g => !needsVerification(g));
    let vdone = 0;
    const verified = await runPool(toVerify, LLM_CONCURRENCY, async g => {
      try {
        const refined = await verifyGroup(g);
        vdone++; bar.style.width = (70 + Math.round(vdone / toVerify.length * 25)) + '%';
        if (refined.length !== 1 || refined[0].duplicates.length !== g.duplicates.length) {
          log(`  ↪ "${(g.primary.takeaway||'').slice(0,40)}…" → ${refined.length} subgroup(s)`, 'done');
        }
        return refined;
      } catch (e) {
        log(`  ⚠ verify failed, kept as-is: ${e.message}`, 'done');
        return [g];
      }
    });
    groups = keep.concat(verified.flat());
    log(`  → ${groups.length} groups after verification`, 'done');
  }

  // Stage 3b — commit
  sub.textContent = 'Stage 3: finalizing…';
  state.groups = groups;
  state.decisions = {};
  state.removedIds = new Set();
  draft = { gi: null, removed: new Set() };
  const dup = state.groups.reduce((s,g)=>s+g.duplicates.length,0);
  log(`  → ${state.groups.length} final groups · ${dup} duplicates to remove`, 'done');
  bar.style.width = '100%';
  sub.textContent = 'Analysis complete!';

  PROJECT.status = 'review';
  updateHeader();
  await saveProjectData(true);

  setTimeout(() => { state.currentGroupIdx = 0; state.tab = 'review'; renderTab(); }, 700);
}

// ═══════════════════════════════════════════════════════════════
// TAB 2 — DUPLICATE REVIEW
// ═══════════════════════════════════════════════════════════════

// Working keep/remove selection for the group currently on screen (committed via Apply).
let draft = { gi: null, removed: new Set() };

function getFilteredIndices() {
  const all = state.groups.map((_, i) => i);
  if (state.currentBlock === '__review__') return all.filter(i => state.groups[i].needsReview && !state.decisions[i]);
  if (state.currentBlock !== 'all') return all.filter(i => state.groups[i].block === state.currentBlock);
  return all;
}

// Building-block filter bar for the review tab. Each pill shows the number of
// groups still PENDING in that block — so a team can split the work by block.
// Pills pass an INDEX into REVIEW_FILTER_KEYS (block names break inline string attrs).
let REVIEW_FILTER_KEYS = [];
function reviewBlockPills() {
  const perBlock = {};
  state.groups.forEach((g, i) => {
    const b = g.block;
    perBlock[b] = perBlock[b] || { pending: 0 };
    if (!state.decisions[i]) perBlock[b].pending++;
  });
  const totalPending = state.groups.filter((_, i) => !state.decisions[i]).length;
  const needsReview = state.groups.filter((g, i) => g.needsReview && !state.decisions[i]).length;

  const keys = ['all', ...Object.keys(perBlock).sort()];
  const labels = { all: 'All blocks' };
  const counts = { all: totalPending };
  Object.keys(perBlock).forEach(b => { labels[b] = b.replace(/^\d+\.\s*/, ''); counts[b] = perBlock[b].pending; });
  if (needsReview > 0) { keys.push('__review__'); labels['__review__'] = '⚠ Needs review'; counts['__review__'] = needsReview; }
  REVIEW_FILTER_KEYS = keys;

  const html = keys.map((key, idx) => {
    const extra = key === '__review__' ? 'style="border-color:rgba(245,158,11,0.5);color:#f59e0b;"' : '';
    return `<div class="pill ${state.currentBlock === key ? 'active' : ''}" ${extra} onclick="setReviewBlockIdx(${idx})">
      ${escapeHtml(labels[key])} <span class="pill-count">${counts[key]}</span>
    </div>`;
  }).join('');
  return `<div class="pill-nav" style="margin-bottom:16px;">${html}</div>`;
}

function setReviewBlockIdx(i) {
  const k = REVIEW_FILTER_KEYS[i];
  if (k == null) return;
  state.currentBlock = k;
  state.currentGroupIdx = -1;   // jump to the first group of the new filter
  renderReviewPanel();
}

// Notice shown when some blocks failed Stage 2 (so results are partial).
function failedBanner() {
  const f = state.failedBlocks || [];
  if (!f.length) return '';
  return `<div class="notice" style="margin-bottom:14px;">
    <span class="notice-icon">⚠</span>
    <span><strong>${f.length} building block(s) failed to analyze</strong> (likely a temporary API/proxy error):
      ${f.map(b => escapeHtml(b.replace(/^\d+\.\s*/, ''))).join(', ')}.
      <a href="#" onclick="retryFailedBlocks();return false;" style="color:var(--accent);font-weight:600;">Retry these blocks →</a>
    </span>
  </div>`;
}

// Re-run Stage 1+2 for the failed blocks only, finalize, and append their groups
// (existing groups/decisions keep their indices → review progress is preserved).
async function retryFailedBlocks() {
  const blocks = (state.failedBlocks || []).slice();
  if (!blocks.length) return;
  const panel = document.getElementById('mainPanel');
  document.getElementById('actionRow').style.display = 'none';
  panel.innerHTML = `<div class="progress-screen">
    <div class="progress-ring"></div>
    <div class="progress-title">Retrying ${blocks.length} block(s)…</div>
    <div class="batch-log" id="batchLog"></div></div>`;
  const logEl = document.getElementById('batchLog');
  const log = (m, t = 'current') => { const d = document.createElement('div'); d.className = `batch-log-line ${t}`; d.textContent = m; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; };

  const stillFailed = [];
  const newRaw = await runPool(blocks, LLM_CONCURRENCY, async block => {
    const bi = RAW_DATA.filter(d => d.block === block);
    const pairs = getCandidatePairs(bi);
    if (!pairs.length) { log(`— ${block.replace(/^\d+\.\s*/, '')} : no pairs`, 'done'); return []; }
    try {
      const g = await analyzeBlock(block, bi, pairs);
      log(`✓ ${block.replace(/^\d+\.\s*/, '')} : ${g.length} groups`, 'done');
      return g;
    } catch (e) {
      log(`✗ ${block.replace(/^\d+\.\s*/, '')} : ${e.message}`, 'done');
      stillFailed.push(block);
      return [];
    }
  });

  state.groups = state.groups.concat(finalizeGroups(newRaw.flat()));
  state.failedBlocks = stillFailed;
  recomputeRemoved();
  if (state.groups.some((_, i) => !state.decisions[i])) PROJECT.status = 'review';
  updateHeader();
  await saveProjectData(true);
  state.tab = 'review';
  state.currentBlock = 'all';
  state.currentGroupIdx = -1;
  renderTab();
}

function renderReviewPanel() {
  const panel = document.getElementById('mainPanel');
  const actionRow = document.getElementById('actionRow');

  if (!state.groups.length) {
    panel.innerHTML = failedBanner() + (state.failedBlocks && state.failedBlocks.length
      ? `<div class="empty-state">All blocks failed to analyze. Use “Retry these blocks” above.</div>`
      : `<div class="empty-state">No duplicate groups yet. Import data and run the analysis from the All Issues tab.</div>`);
    actionRow.style.display = 'none'; return;
  }
  const undecided = state.groups.filter((_, i) => !state.decisions[i]);
  if (!undecided.length) { renderReviewComplete(); return; }

  const fi = getFilteredIndices();
  if (!fi.length) {
    panel.innerHTML = reviewBlockPills() + `<div class="empty-state">No groups in this block — pick another above.</div>`;
    actionRow.style.display = 'none';
    return;
  }

  let localIdx = fi.indexOf(state.currentGroupIdx);
  if (localIdx < 0) localIdx = 0;
  const globalIdx = fi[localIdx];
  state.currentGroupIdx = globalIdx;
  const group = state.groups[globalIdx];
  const decision = state.decisions[globalIdx];
  const all = [group.primary, ...group.duplicates];
  const pending = fi.filter(i => !state.decisions[i]).length;

  // Per-member keep/remove draft. Init from a committed decision, else from the
  // AI default (keep the primary/richest, remove the rest).
  if (draft.gi !== globalIdx) {
    draft = {
      gi: globalIdx,
      removed: new Set(decision && Array.isArray(decision.removed)
        ? decision.removed
        : group.duplicates.map(d => d.id)),
    };
  }
  const keptCount = all.length - draft.removed.size;

  const reviewBadge = group.needsReview
    ? `<span class="badge badge-dup" style="background:rgba(245,158,11,.12);color:#f59e0b;border-color:rgba(245,158,11,.3);">⚠ Needs review</span>` : '';
  const memberCount = all.length;
  const sizeTag = memberCount > 2
    ? `<span class="badge badge-dup" style="background:rgba(79,127,255,.12);color:var(--accent);border-color:rgba(79,127,255,.3);">${memberCount} grouped issues</span>`
    : `<span class="badge badge-dup">pair</span>`;

  panel.innerHTML = failedBanner() + reviewBlockPills() + `
    <div class="review-header">
      <div style="font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:600;letter-spacing:-0.01em;color:var(--text);">Duplicate group</div>
      ${sizeTag}${reviewBadge}
      <div class="review-badge">${pending} pending</div>
      <div class="review-nav">
        <button class="nav-btn" onclick="prevGroup()" ${localIdx===0?'disabled':''}>← Prev</button>
        <span class="group-counter">${localIdx+1} / ${fi.length}</span>
        <button class="nav-btn" onclick="nextGroup()" ${localIdx>=fi.length-1?'disabled':''}>Next →</button>
      </div>
    </div>
    <div class="ai-reasoning">
      <div class="ai-label">AI reasoning — Stage 2</div>
      <div class="ai-text">${escapeHtml(group.reasoning)}</div>
      <div class="ai-similarity">
        <div class="sim-bar-wrap"><div class="sim-bar" style="width:${Math.round(group.similarity*100)}%"></div></div>
        <div class="sim-label">Confidence: ${Math.round(group.similarity*100)}%</div>
      </div>
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">
      💡 Toggle <strong style="color:var(--green);">Keep</strong> / <strong style="color:var(--red);">Remove</strong> on each card —
      keep any subset (e.g. 2 of 3). Default follows the AI suggestion (keep the richest, remove the rest).
    </div>
    <div class="review-subhint">
      Keeping <strong style="color:var(--green);">${keptCount}</strong> ·
      Removing <strong style="color:var(--red);">${draft.removed.size}</strong> of ${all.length}
    </div>
    <div class="issues-grid">
      ${all.map((issue, idx) => {
        const kept = !draft.removed.has(issue.id);
        const cardClass = 'issue-card ' + (kept ? 'kept-as-primary' : 'removed-card');
        const labelClass = 'card-label ' + (kept ? 'kept-primary' : 'removed');
        const star = idx === 0 ? '★ ' : '';
        const labelText = kept ? `${star}✓ Keep${idx === 0 ? ' (primary)' : ''}` : `${star}✕ Remove`;
        return `<div class="${cardClass}">
          <div class="${labelClass}">${labelText}</div>
          <div class="card-takeaway">${escapeHtml(issue.takeaway)}</div>
          ${issue.initiative ? `<div class="card-initiative">💡 ${escapeHtml(issue.initiative)}</div>` : ''}
          <div class="card-footer">
            <span class="card-id">Row #${issue.id} · ${escapeHtml(issue.block.replace(/^\d+\.\s*/,''))}</span>
            <button class="keep-btn ${kept ? 'selected' : 'remove-state'}" onclick="toggleMember(${issue.id})">
              ${kept ? '✓ Keeping — click to remove' : '✕ Removing — click to keep'}
            </button>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  actionRow.style.display = 'flex';
  const k = all.length - draft.removed.size, r = draft.removed.size;
  actionRow.innerHTML = `
    <button class="btn-confirm" onclick="applyDecision(${globalIdx})" ${k === 0 ? 'disabled title="Keep at least one"' : ''}>
      ✓ Apply — keep ${k}, remove ${r}
    </button>
    <button class="btn-keep-all" onclick="draftKeepAll()">Keep all</button>
    ${all.length > 2 ? `<button class="btn-keep-all" onclick="draftKeepBest(${globalIdx})">Keep only best</button>` : ''}
    ${decision ? `<button class="btn-keep-all" onclick="undoDecision(${globalIdx})">↩ Undo</button>` : ''}
    <div class="action-hint" style="margin-left:auto;">${decision ? '✓ reviewed — adjust &amp; re-apply if needed' : 'toggle each card, then Apply'}</div>`;
}

function renderReviewComplete() {
  const removed = state.removedIds.size, kept = RAW_DATA.length - removed;
  document.getElementById('mainPanel').innerHTML = `
    <div style="padding:0;"><div class="complete-banner">
      <div class="complete-icon">🎉</div>
      <div>
        <div class="complete-title">Review complete!</div>
        <div class="complete-sub">${state.groups.length} groups reviewed · ${removed} removed · ${kept} unique kept.</div>
      </div>
      <button class="view-results-btn" onclick="completeProject()">Mark complete & view result →</button>
    </div></div>`;
  document.getElementById('actionRow').style.display = 'none';
}

async function completeProject() {
  await setStatus('completed');
  state.tab = 'result';
  renderTab();
}

// ── decisions (per-member keep/remove model) ──
// A decision is { removed: [issueId, ...] }. Kept = group members not in `removed`.
// This generalizes every case: keep all (removed=[]), keep one (remove the rest),
// or keep any subset (e.g. 2 of 3).

// Rebuild the global removed set from all committed decisions (idempotent → safe undo).
function recomputeRemoved() {
  state.removedIds = new Set();
  state.groups.forEach((g, i) => {
    const dec = state.decisions[i];
    if (dec && Array.isArray(dec.removed)) dec.removed.forEach(id => state.removedIds.add(id));
  });
}

// Convert any legacy decisions ({action:'confirm'|'keep_all'}) to the new shape.
function migrateDecisions() {
  Object.keys(state.decisions).forEach(k => {
    const d = state.decisions[k], g = state.groups[k];
    if (!g || !d || Array.isArray(d.removed)) return;
    if (d.action === 'keep_all') state.decisions[k] = { removed: [] };
    else if (d.action === 'confirm') {
      const keep = d.chosenId != null ? d.chosenId : g.primary.id;
      state.decisions[k] = { removed: [g.primary, ...g.duplicates].filter(x => x.id !== keep).map(x => x.id) };
    }
  });
}

// Draft toggles (not committed until Apply)
function toggleMember(id) {
  if (draft.removed.has(id)) draft.removed.delete(id); else draft.removed.add(id);
  renderReviewPanel();
}
function draftKeepAll() { draft.removed.clear(); renderReviewPanel(); }
function draftKeepBest(gi) { draft.removed = new Set(state.groups[gi].duplicates.map(d => d.id)); renderReviewPanel(); }

function applyDecision(gi) {
  if (draft.removed.size >= (state.groups[gi].duplicates.length + 1)) return; // never remove every member
  state.decisions[gi] = { removed: [...draft.removed] };
  recomputeRemoved();
  updateHeader(); renderTabs(); saveProjectData();
  nextGroup(); // advance (or show completion if all decided)
}

function undoDecision(gi) {
  delete state.decisions[gi];
  draft.gi = null; // force default re-init on next render
  recomputeRemoved();
  updateHeader(); renderTabs(); saveProjectData(); renderReviewPanel(); renderSidebar();
}

function prevGroup() { const fi=getFilteredIndices(), i=fi.indexOf(state.currentGroupIdx); if (i>0){state.currentGroupIdx=fi[i-1];renderReviewPanel();} }
function nextGroup() {
  const fi=getFilteredIndices(), i=fi.indexOf(state.currentGroupIdx);
  if (i<fi.length-1){state.currentGroupIdx=fi[i+1];renderReviewPanel();}
  else if (!state.groups.some((_,k)=>!state.decisions[k])) renderReviewComplete();
  else renderReviewPanel(); // last in current filter but work remains elsewhere → refresh (pills/state)
}

// ═══════════════════════════════════════════════════════════════
// TAB 3 — RESULT
// ═══════════════════════════════════════════════════════════════

function renderResultTab() {
  const panel = document.getElementById('mainPanel');
  const removed = state.removedIds.size, kept = RAW_DATA.length - removed;
  panel.innerHTML = `
    <div class="results-header">
      <div class="results-title">Clean issue list</div>
      <div class="results-stats">
        <div class="result-stat"><div class="result-stat-num blue">${RAW_DATA.length}</div><div class="result-stat-label">Original</div></div>
        <div class="result-stat"><div class="result-stat-num red">${removed}</div><div class="result-stat-label">Removed</div></div>
        <div class="result-stat"><div class="result-stat-num green">${kept}</div><div class="result-stat-label">Kept</div></div>
      </div>
    </div>
    <div class="filter-row">
      <input class="filter-input" type="text" placeholder="Search…" id="filterText" oninput="filterResults()" value="${escapeHtml(state.filterText)}">
      <select class="filter-select" id="filterBlock" onchange="filterResults()" style="min-width:0;max-width:100%;">
        <option value="all">All blocks</option>
        ${BLOCKS.map(b => `<option value="${escapeHtml(b)}" ${state.filterBlock===b?'selected':''}>${escapeHtml(b)}</option>`).join('')}
      </select>
      <select class="filter-select" id="filterStatus" onchange="filterResults()" style="min-width:0;max-width:100%;">
        <option value="all">All statuses</option>
        <option value="kept" ${state.filterStatus==='kept'?'selected':''}>Kept</option>
        <option value="removed" ${state.filterStatus==='removed'?'selected':''}>Removed</option>
      </select>
      <button class="export-btn" onclick="exportCSV()">⬇ Export CSV</button>
    </div>
    <div id="resultsTableWrap">${buildResultsTable()}</div>`;
}

function buildResultsTable() {
  const text = state.filterText.toLowerCase(), bF = state.filterBlock, sF = state.filterStatus;
  const rows = RAW_DATA.filter(i => {
    if (bF !== 'all' && i.block !== bF) return false;
    if (sF === 'kept' && state.removedIds.has(i.id)) return false;
    if (sF === 'removed' && !state.removedIds.has(i.id)) return false;
    if (text && !i.takeaway.toLowerCase().includes(text) && !(i.initiative||'').toLowerCase().includes(text)) return false;
    return true;
  });
  return `<div style="font-size:11px;color:var(--muted);margin-bottom:8px;font-family:'DM Mono',monospace;">${rows.length} results</div>
    <table class="result-table">
      <thead><tr><th>ID</th><th>Building Block</th><th>Key Takeaway</th><th>Initiative</th><th>Status</th></tr></thead>
      <tbody>${rows.map(i => { const rem = state.removedIds.has(i.id);
        return `<tr style="${rem?'opacity:0.4;':''}">
          <td class="td-block">#${i.id}</td>
          <td class="td-block">${escapeHtml((i.block||'').replace(/^\d+\.\s*/,''))}</td>
          <td class="td-takeaway">${escapeHtml(i.takeaway)}</td>
          <td class="td-initiative">${escapeHtml(i.initiative||'')}</td>
          <td class="td-status">${rem?'<span class="badge badge-removed">removed</span>':'<span class="badge badge-kept">kept</span>'}</td>
        </tr>`; }).join('')}</tbody>
    </table>`;
}

function filterResults() {
  state.filterText = document.getElementById('filterText').value;
  state.filterBlock = document.getElementById('filterBlock').value;
  state.filterStatus = document.getElementById('filterStatus').value;
  document.getElementById('resultsTableWrap').innerHTML = buildResultsTable();
}

function exportCSV() {
  const clean = RAW_DATA.filter(d => !state.removedIds.has(d.id));
  const headers = ['ID','Building Block','Key Takeaway','Initiative Recommended','Importance','Quick Win'];
  const q = s => `"${(s||'').replace(/"/g,'""')}"`;
  const rows = clean.map(i => [i.id, q(i.block), q(i.takeaway), q(i.initiative), q(i.importance), q(i.quickWin)].join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url, download: `${(PROJECT.name||'project').replace(/[^a-z0-9]+/gi,'_')}_clean.csv`,
  });
  a.click(); URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════
// MEMBERS (owner only) — invite registered OPs by email
// ═══════════════════════════════════════════════════════════════

function openMembers() {
  const list = PROJECT.members.map(m =>
    `<div class="member-row">
      <div><div class="member-name">${escapeHtml(m.name)}</div><div class="member-email">${escapeHtml(m.email)}</div></div>
      <div>${m.role === 'owner'
        ? '<span class="badge badge-primary">owner</span>'
        : `<button class="keep-btn" onclick="removeMember(${m.id})">Remove</button>`}</div>
    </div>`).join('');
  document.getElementById('mainPanel').innerHTML = `
    <div class="howto-panel" style="max-width:560px;margin:24px auto;text-align:left;">
      <div class="howto-title">👥 Project members</div>
      <div class="member-list">${list}</div>
      <div style="margin-top:16px;">
        <div class="auth-label">Invite an operating partner (must already be registered)</div>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <input class="filter-input" id="inviteEmail" type="email" placeholder="colleague@firm.com" style="flex:1;">
          <button class="btn-primary" onclick="inviteMember()">Invite</button>
        </div>
        <div class="auth-error" id="inviteError" style="display:none;margin-top:8px;"></div>
      </div>
      <button class="btn-keep-all" style="margin-top:18px;" onclick="renderTab()">← Back to ${state.tab}</button>
    </div>`;
  document.getElementById('actionRow').style.display = 'none';
}

async function inviteMember() {
  const email = document.getElementById('inviteEmail').value.trim();
  const errEl = document.getElementById('inviteError');
  errEl.style.display = 'none';
  try {
    const { member } = await api.addMember(PROJECT.id, email);
    if (!PROJECT.members.some(m => m.id === member.id)) PROJECT.members.push(member);
    openMembers();
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  }
}

async function removeMember(userId) {
  try {
    await api.removeMember(PROJECT.id, userId);
    PROJECT.members = PROJECT.members.filter(m => m.id !== userId);
    openMembers();
  } catch (err) { alert(err.message); }
}
