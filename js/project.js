// ═══════════════════════════════════════════════════════════════
// PROJECT WORKSPACE — 3 tabs (All Issues / Duplicate Review / Result)
// State is loaded from and saved to the server (shared, last-write-wins).
// Reuses the pipeline (stage1/2/3) and file-loader.js (column mapping).
// ═══════════════════════════════════════════════════════════════

let RAW_DATA = [];
let BLOCKS = [];
let BLOCK_COUNTS = {};

let PROJECT = { id: null, name: '', status: 'draft', isOwner: false, members: [] };

// Project pipeline modules shown in the header flow. 'dedup' is the live module;
// the rest are scaffolded placeholders that future features will fill in.
const STAGES = [
  { key: 'dedup',     label: 'Deduplication' },
  { key: 'takeaways', label: 'Key Takeaways' },
  { key: 'roadmap',   label: 'Roadmap' },
  { key: 'deck',      label: 'Final Deck' },
];
const STAGE_BUILT = { dedup: true, takeaways: true, roadmap: true, deck: true };

let state = {
  stage: 'dedup',         // which pipeline module is open (see STAGES)
  tab: 'issues',          // 'issues' | 'review' | 'result' (within the Deduplication module)
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
  // Key Takeaways module: ids of deduplicated takeaways kept for the next step,
  // and the subset of those highlighted. Sets for O(1) toggles.
  takeawaysSelected: new Set(),
  takeawaysHighlighted: new Set(),
  takeawaysConfirmed: false,   // user explicitly confirmed the selection for Roadmap
  tkBlockIdx: 0,               // which building-block tab is open in Key Takeaways
  // Roadmap module: subset of the selected key takeaways picked for the roadmap.
  roadmapSelected: new Set(),
  roadmapConfirmed: false,
  roadmapFilter: 'all',        // building-block filter in the Roadmap selection
  roadmapPhase: 'select',      // 'select' (pick items) | 'build' (Gantt editor)
  // Gantt plan: cycles = number of columns; items[id] = {start, span} in cycle units.
  roadmapPlan: { cycles: 3, items: {} },
};

// Roadmap Gantt limits. Bars and cycle dividers live on a 0..1 timeline.
const ROADMAP_CYCLES_MAX = 8;
const ROADMAP_SNAP = 0.01;        // fine snap (1% of the timeline)
const ROADMAP_CYCLE_MIN = 0.05;   // a cycle can't shrink below 5% of the timeline

// Max key takeaways a building block can carry to the next step.
const TAKEAWAYS_PER_BLOCK = 10;
// Max items that can be carried into the roadmap.
const ROADMAP_MAX = 25;

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
    const tk = d.takeaways || {};
    state.takeawaysSelected = new Set(tk.selected || []);
    state.takeawaysHighlighted = new Set(tk.highlighted || []);
    state.takeawaysConfirmed = !!tk.confirmed;
    const rm = d.roadmap || {};
    state.roadmapSelected = new Set(rm.selected || []);
    state.roadmapConfirmed = !!rm.confirmed;
    state.roadmapPhase = rm.phase === 'build' ? 'build' : 'select';
    const p = rm.plan || {};
    state.roadmapPlan = {
      cycles: Math.min(ROADMAP_CYCLES_MAX, Math.max(1, p.cycles || 3)),
      weights: Array.isArray(p.weights) ? p.weights : null,
      order: Array.isArray(p.order) ? p.order : [],
      items: p.items || {},
      labels: p.labels || {},
    };
    migrateDecisions();              // upgrade any legacy decision shapes
    recomputeRemoved();              // derive removed set from decisions (consistent)
    state.fileName = d.file_name || '';
    state.stage = 'dedup';
    state.tkBlockIdx = 0;
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
    takeaways: {
      selected: [...state.takeawaysSelected],
      highlighted: [...state.takeawaysHighlighted],
      confirmed: state.takeawaysConfirmed,
    },
    roadmap: {
      selected: [...state.roadmapSelected],
      confirmed: state.roadmapConfirmed,
      phase: state.roadmapPhase,
      plan: state.roadmapPlan,
    },
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
      <div class="flow-nav" id="flowNav"></div>
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
  renderFlow();
  renderTabs();
}

// ─── Module flow (project pipeline stepper) ──────────────────────
function renderFlow() {
  const el = document.getElementById('flowNav');
  if (!el) return;
  const activeIdx = STAGES.findIndex(s => s.key === state.stage);
  el.innerHTML = STAGES.map((s, i) => {
    const built = STAGE_BUILT[s.key];
    const cls = s.key === state.stage ? 'active'
              : (i < activeIdx ? 'done' : 'upcoming');
    const soon = built ? '' : `<span class="flow-soon">soon</span>`;
    const step = `
      <button class="flow-step ${cls}" onclick="switchStage('${s.key}')" title="${escapeHtml(s.label)}">
        <span class="flow-idx">${i + 1}</span>${escapeHtml(s.label)}${soon}
      </button>`;
    const sep = i < STAGES.length - 1 ? `<span class="flow-sep">›</span>` : '';
    return step + sep;
  }).join('');
}

function switchStage(stage) {
  if (state.stage === stage) return;
  state.stage = stage;
  renderFlow();
  // The dedup sub-tabs only belong to the Deduplication module.
  const tabs = document.getElementById('projectTabs');
  if (tabs) tabs.style.display = stage === 'dedup' ? '' : 'none';
  renderStage();
}

// Dispatch the content area based on the active pipeline module.
function renderStage() {
  const sidebar = document.getElementById('projectSidebar');
  document.getElementById('actionRow').style.display = 'none';
  if (state.stage === 'dedup') {
    if (sidebar) sidebar.style.display = '';
    renderTab();
    return;
  }
  if (state.stage === 'takeaways') {
    if (sidebar) sidebar.style.display = 'none';
    renderKeyTakeaways();
    return;
  }
  if (state.stage === 'roadmap') {
    if (sidebar) sidebar.style.display = 'none';
    renderRoadmap();
    return;
  }
  if (state.stage === 'deck') {
    if (sidebar) sidebar.style.display = 'none';
    renderDeck();
    return;
  }
  // Future modules: scaffolded placeholder until their feature lands.
  if (sidebar) sidebar.style.display = 'none';
  renderStagePlaceholder();
}

function renderStagePlaceholder() {
  const meta = STAGES.find(s => s.key === state.stage);
  const blurb = {
    takeaways: 'Auto-summarised insights from the deduplicated issues — the headline findings per building block.',
    roadmap:   'Turn the prioritised findings into a sequenced action plan with owners and timeframes.',
    deck:      'Assemble takeaways and roadmap into a client-ready presentation, exportable in one click.',
  }[state.stage] || 'This module is coming soon.';
  document.getElementById('mainPanel').innerHTML = `
    <div class="stage-placeholder">
      <div class="sp-icon">🚧</div>
      <h2>${escapeHtml(meta ? meta.label : 'Coming soon')}</h2>
      <p>${escapeHtml(blurb)}</p>
      <div class="sp-soon">In development</div>
    </div>`;
}

// ─── Key Takeaways module ────────────────────────────────────────
// Candidates are the deduplicated (kept) takeaways grouped by building block.
// Per block the user selects up to TAKEAWAYS_PER_BLOCK to carry forward, and may
// highlight any of the selected ones.

let _tkBlocks = [];   // building-block names (with kept items), stable index for handlers

function keptTakeawaysByBlock() {
  const out = {};
  RAW_DATA.forEach(d => {
    if (state.removedIds.has(d.id)) return;   // dropped in deduplication
    (out[d.block] = out[d.block] || []).push(d);
  });
  return out;
}

function renderKeyTakeaways() {
  const byBlock = keptTakeawaysByBlock();
  _tkBlocks = BLOCKS.filter(b => byBlock[b] && byBlock[b].length);
  const panel = document.getElementById('mainPanel');
  const actionRow = document.getElementById('actionRow');

  if (!_tkBlocks.length) {
    actionRow.style.display = 'none';
    panel.innerHTML = `
      <div class="stage-placeholder">
        <div class="sp-icon">📋</div>
        <h2>No takeaways yet</h2>
        <p>Import data and run the Deduplication step first — the surviving
           takeaways will appear here, grouped by building block, ready to select.</p>
      </div>`;
    return;
  }

  // Sticky confirm bar — the explicit "carry forward to Roadmap" action.
  actionRow.innerHTML = `
    <button class="btn-primary" id="tkConfirmBtn" onclick="confirmTakeaways()">
      Confirm selections → Roadmap
    </button>
    <span class="action-hint" id="tkActionHint"></span>`;
  actionRow.style.display = 'flex';

  if (state.tkBlockIdx >= _tkBlocks.length) state.tkBlockIdx = 0;

  panel.innerHTML = `
    <div class="tk-wrap">
      <div class="tk-head">
        <div>
          <h2 class="tk-title">Key Takeaways</h2>
          <p class="tk-sub">Pick a building block, select up to ${TAKEAWAYS_PER_BLOCK} takeaways to
             carry forward, and star the ones that matter most.</p>
        </div>
        <div class="tk-summary" id="tkSummary"></div>
      </div>
      <div class="tk-tabs" id="tkTabs">${tkTabsHtml()}</div>
      <div class="tk-panel" id="tkPanel">${tkPanelHtml()}</div>
    </div>`;
  updateTakeawaySummary();
}

// One tab per building block, with a live "selected / cap" badge.
function tkTabsHtml() {
  const byBlock = keptTakeawaysByBlock();
  return _tkBlocks.map((b, i) => {
    const sel = (byBlock[b] || []).filter(d => state.takeawaysSelected.has(d.id)).length;
    const full = sel >= TAKEAWAYS_PER_BLOCK;
    return `
      <button class="tk-tab ${i === state.tkBlockIdx ? 'active' : ''}" onclick="switchTkBlock(${i})">
        <span class="tk-tab-name">${escapeHtml(b)}</span>
        <span class="tk-tab-badge ${full ? 'full' : ''} ${sel ? 'has' : ''}">${sel}/${TAKEAWAYS_PER_BLOCK}</span>
      </button>`;
  }).join('');
}

// The active block's takeaway list.
function tkPanelHtml() {
  const block = _tkBlocks[state.tkBlockIdx];
  const items = (keptTakeawaysByBlock()[block] || []);
  const sel = items.filter(d => state.takeawaysSelected.has(d.id)).length;
  const hi = items.filter(d => state.takeawaysHighlighted.has(d.id)).length;
  const full = sel >= TAKEAWAYS_PER_BLOCK;
  // Float highlighted to the very top, then plain-selected, keeping each group's
  // original order. rank 0 = highlighted, 1 = selected, 2 = neither.
  const rank = d => state.takeawaysHighlighted.has(d.id) ? 0
                  : state.takeawaysSelected.has(d.id) ? 1 : 2;
  const ordered = items
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(x => x.d);
  return `
    <div class="tk-block-bar">
      <span class="tk-block-name">${escapeHtml(block)}</span>
      <span class="tk-block-count ${full ? 'full' : ''}">
        ${sel} selected in ${items.length} Key Takeaway${items.length === 1 ? '' : 's'}
        · ${sel} / ${TAKEAWAYS_PER_BLOCK} cap${hi ? ` · ${hi} highlighted` : ''}
      </span>
    </div>
    <div class="tk-list">
      ${ordered.map(d => renderTakeawayRow(d, full)).join('')}
    </div>`;
}

function renderTakeawayRow(d, blockFull) {
  const selected = state.takeawaysSelected.has(d.id);
  const highlighted = state.takeawaysHighlighted.has(d.id);
  const locked = !selected && blockFull;   // block is full and this row isn't in it
  const initiative = (d.initiative || '').trim();
  return `
    <div class="tk-item ${selected ? 'selected' : ''} ${highlighted ? 'highlighted' : ''}">
      <button class="tk-check ${locked ? 'locked' : ''}" ${locked ? 'disabled' : ''}
              onclick="toggleTakeaway(${d.id})"
              title="${selected ? 'Remove from selection' : (locked ? 'Block limit reached' : 'Select')}">
        ${selected ? '✓' : ''}
      </button>
      <div class="tk-body">
        <div class="tk-field">
          <span class="tk-label">Key Takeaway</span>
          <div class="tk-text">${escapeHtml(d.takeaway)}</div>
        </div>
        <div class="tk-field">
          <span class="tk-label">Initiative</span>
          <div class="tk-init ${initiative ? '' : 'empty'}">${initiative ? escapeHtml(initiative) : '—'}</div>
        </div>
      </div>
      <button class="tk-star ${highlighted ? 'on' : ''} ${locked ? 'locked' : ''}" ${locked ? 'disabled' : ''}
              onclick="toggleHighlight(${d.id})"
              title="${highlighted ? 'Remove highlight' : (locked ? 'Block limit reached' : 'Highlight')}">★</button>
    </div>`;
}

function switchTkBlock(idx) {
  state.tkBlockIdx = idx;
  refreshTk();
}

function toggleTakeaway(id) {
  state.takeawaysConfirmed = false;   // selection changed → must re-confirm
  if (state.takeawaysSelected.has(id)) {
    state.takeawaysSelected.delete(id);
    state.takeawaysHighlighted.delete(id);    // highlight only applies to selected
  } else if (!addTakeawayWithinCap(id)) {
    return;                                    // block full → no-op
  }
  refreshTk();
  saveProjectData();
}

// Star always works: highlighting an unselected takeaway also keeps it (if room).
function toggleHighlight(id) {
  if (state.takeawaysHighlighted.has(id)) {
    state.takeawaysHighlighted.delete(id);
  } else {
    if (!state.takeawaysSelected.has(id) && !addTakeawayWithinCap(id)) return;
    state.takeawaysHighlighted.add(id);
  }
  state.takeawaysConfirmed = false;
  refreshTk();
  saveProjectData();
}

// Add `id` to the selection unless its block is already at the cap. Returns success.
function addTakeawayWithinCap(id) {
  const block = _tkBlocks[state.tkBlockIdx];
  const byBlock = keptTakeawaysByBlock();
  const count = (byBlock[block] || []).filter(d => state.takeawaysSelected.has(d.id)).length;
  if (count >= TAKEAWAYS_PER_BLOCK) return false;
  state.takeawaysSelected.add(id);
  return true;
}

function refreshTk() {
  const tabs = document.getElementById('tkTabs');
  const panel = document.getElementById('tkPanel');
  if (tabs) tabs.innerHTML = tkTabsHtml();
  if (panel) panel.innerHTML = tkPanelHtml();
  updateTakeawaySummary();
}

function updateTakeawaySummary() {
  const total = state.takeawaysSelected.size;
  const el = document.getElementById('tkSummary');
  if (el) {
    el.innerHTML =
      `<span class="tk-sum-num">${total}</span> selected` +
      ` · <span class="tk-sum-num hi">${state.takeawaysHighlighted.size}</span> highlighted`;
  }
  // Keep the confirm bar in sync: disable when nothing is selected; editing after
  // a prior confirmation clears the confirmed flag (selection changed).
  const btn = document.getElementById('tkConfirmBtn');
  const hint = document.getElementById('tkActionHint');
  if (btn) btn.disabled = total === 0;
  if (hint) {
    hint.innerHTML = total === 0
      ? 'Select at least one takeaway to continue.'
      : (state.takeawaysConfirmed
          ? `✓ Confirmed — ${total} takeaway${total === 1 ? '' : 's'} carried to Roadmap.`
          : `${total} takeaway${total === 1 ? '' : 's'} across ${_tkBlocks.length} block${_tkBlocks.length === 1 ? '' : 's'} ready to confirm.`);
  }
}

function confirmTakeaways() {
  if (state.takeawaysSelected.size === 0) return;
  state.takeawaysConfirmed = true;
  saveProjectData(true);          // persist immediately before moving on
  switchStage('roadmap');
}

// ─── Roadmap module ──────────────────────────────────────────────
// Candidates are the key takeaways selected in the previous step. The user
// picks up to ROADMAP_MAX of them to carry into the roadmap. Highlighted
// takeaways are marked but selection is independent.

// Stable per-block colour from its index — spread hues, no palette to maintain.
function blockColor(block) {
  const hue = (Math.max(0, BLOCKS.indexOf(block)) * 47) % 360;
  return {
    bar:  `hsl(${hue} 65% 48%)`,
    bg:   `hsl(${hue} 70% 95%)`,
    text: `hsl(${hue} 55% 32%)`,
    fill: `hsl(${hue} 58% 74%)`,   // soft pastel for Gantt bars
  };
}

// Selected key takeaways (still kept), in block order, ready to choose from.
function roadmapCandidates() {
  const out = [];
  BLOCKS.forEach(b => {
    RAW_DATA.forEach(d => {
      if (d.block !== b) return;
      if (state.removedIds.has(d.id)) return;
      if (state.takeawaysSelected.has(d.id)) out.push(d);
    });
  });
  return out;
}

function renderRoadmap() {
  const candidates = roadmapCandidates();
  const panel = document.getElementById('mainPanel');
  const actionRow = document.getElementById('actionRow');

  if (!candidates.length) {
    actionRow.style.display = 'none';
    panel.innerHTML = `
      <div class="stage-placeholder">
        <div class="sp-icon">🗺️</div>
        <h2>No items to plan yet</h2>
        <p>Select and confirm key takeaways in the previous step — they become
           the candidates you sequence into the roadmap here.</p>
      </div>`;
    return;
  }

  // Drop any stale selections (takeaway since unselected/removed upstream).
  const valid = new Set(candidates.map(d => d.id));
  [...state.roadmapSelected].forEach(id => { if (!valid.has(id)) state.roadmapSelected.delete(id); });

  if (state.roadmapPhase === 'build') { renderRoadmapGantt(candidates); return; }

  actionRow.innerHTML = `
    <button class="btn-primary" id="rmConfirmBtn" onclick="createRoadmap()">
      Create roadmap →
    </button>
    <span class="action-hint" id="rmActionHint"></span>`;
  actionRow.style.display = 'flex';

  panel.innerHTML = `
    <div class="tk-wrap">
      <div class="tk-head">
        <div>
          <h2 class="tk-title">Roadmap selection</h2>
          <p class="tk-sub">Choose up to ${ROADMAP_MAX} of the confirmed key takeaways to
             carry into the roadmap.</p>
        </div>
        <div class="tk-summary" id="rmSummary"></div>
      </div>
      <div class="pill-nav" id="rmFilter">${rmFilterHtml(candidates)}</div>
      <div class="tk-panel" id="rmPanel">${rmPanelHtml(candidates)}</div>
    </div>`;
  updateRoadmapSummary();
}

// Filter pills: All + one per block present in the candidates, colour-coded.
let _rmFilterKeys = [];
function rmFilterHtml(candidates) {
  const blocks = BLOCKS.filter(b => candidates.some(d => d.block === b));
  _rmFilterKeys = ['all', ...blocks];
  return _rmFilterKeys.map((key, idx) => {
    const active = state.roadmapFilter === key;
    if (key === 'all') {
      return `<div class="pill ${active ? 'active' : ''}" onclick="setRoadmapFilter(${idx})">
        All Blocks <span class="pill-count">${candidates.length}</span></div>`;
    }
    const c = blockColor(key);
    const n = candidates.filter(d => d.block === key).length;
    const style = active
      ? `background:${c.bar};border-color:${c.bar};color:#fff`
      : `border-left:4px solid ${c.bar};color:${c.text}`;
    return `<div class="pill ${active ? 'active' : ''}" style="${style}" onclick="setRoadmapFilter(${idx})">
      ${escapeHtml(key.replace(/^\d+\.\s*/, ''))} <span class="pill-count">${n}</span></div>`;
  }).join('');
}
function setRoadmapFilter(i) {
  const k = _rmFilterKeys[i];
  if (k == null) return;
  state.roadmapFilter = k;
  renderRoadmap();
}

function rmPanelHtml(candidates) {
  const sel = state.roadmapSelected.size;
  const full = sel >= ROADMAP_MAX;
  const shown = state.roadmapFilter === 'all'
    ? candidates
    : candidates.filter(d => d.block === state.roadmapFilter);
  // Default order: highlighted takeaways first, then selected, then the rest;
  // original (block) order preserved within each group.
  const rank = d => state.takeawaysHighlighted.has(d.id) ? 0
                  : state.roadmapSelected.has(d.id) ? 1 : 2;
  const ordered = shown
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(x => x.d);
  return `
    <div class="tk-block-bar">
      <span class="tk-block-name">${state.roadmapFilter === 'all' ? 'Confirmed takeaways' : escapeHtml(state.roadmapFilter.replace(/^\d+\.\s*/, ''))}</span>
      <span class="tk-block-count ${full ? 'full' : ''}">
        ${sel} selected in ${candidates.length} item${candidates.length === 1 ? '' : 's'}
        · ${sel} / ${ROADMAP_MAX} cap
      </span>
    </div>
    <div class="tk-list">
      ${ordered.map(d => renderRoadmapRow(d, full)).join('')}
    </div>`;
}

function renderRoadmapRow(d, full) {
  const selected = state.roadmapSelected.has(d.id);
  const highlighted = state.takeawaysHighlighted.has(d.id);
  const locked = !selected && full;
  const initiative = (d.initiative || '').trim();
  const c = blockColor(d.block);
  return `
    <div class="tk-item ${selected ? 'selected' : ''} ${highlighted ? 'highlighted' : ''}"
         style="border-left:5px solid ${c.bar}">
      <button class="tk-check ${locked ? 'locked' : ''}" ${locked ? 'disabled' : ''}
              onclick="toggleRoadmap(${d.id})"
              title="${selected ? 'Remove from roadmap' : (locked ? 'Roadmap limit reached' : 'Add to roadmap')}">
        ${selected ? '✓' : ''}
      </button>
      <div class="tk-body">
        <div class="tk-field">
          <span class="tk-block-tag" style="background:${c.bg};color:${c.text}">${escapeHtml(d.block.replace(/^\d+\.\s*/, ''))}</span>
          <div class="tk-text">${escapeHtml(d.takeaway)}${highlighted ? ' <span style="color:var(--amber)">★</span>' : ''}</div>
        </div>
        <div class="tk-field">
          <span class="tk-label">Initiative</span>
          <div class="tk-init ${initiative ? '' : 'empty'}">${initiative ? escapeHtml(initiative) : '—'}</div>
        </div>
      </div>
    </div>`;
}

function toggleRoadmap(id) {
  state.roadmapConfirmed = false;
  if (state.roadmapSelected.has(id)) {
    state.roadmapSelected.delete(id);
  } else {
    if (state.roadmapSelected.size >= ROADMAP_MAX) return;   // cap reached → no-op
    state.roadmapSelected.add(id);
  }
  const panel = document.getElementById('rmPanel');
  if (panel) panel.innerHTML = rmPanelHtml(roadmapCandidates());
  updateRoadmapSummary();
  saveProjectData();
}

function updateRoadmapSummary() {
  const total = state.roadmapSelected.size;
  const el = document.getElementById('rmSummary');
  if (el) el.innerHTML = `<span class="tk-sum-num">${total}</span> / ${ROADMAP_MAX} selected`;
  const btn = document.getElementById('rmConfirmBtn');
  const hint = document.getElementById('rmActionHint');
  if (btn) btn.disabled = total === 0;
  if (hint) {
    hint.innerHTML = total === 0
      ? 'Select at least one item to build the roadmap.'
      : (state.roadmapConfirmed
          ? `✓ Confirmed — ${total} item${total === 1 ? '' : 's'} in the roadmap.`
          : `${total} item${total === 1 ? '' : 's'} ready to confirm.`);
  }
}

// ─── Roadmap Gantt builder ───────────────────────────────────────
// Bars live on a continuous 0..1 timeline: item = {start, end} as fractions.
// Cycles are variable-width partitions (weights summing to 1) whose dividers
// the user can drag. Rows can be reordered by dragging their handle.

// Selected items, indexed by id, in their natural (block) order.
function roadmapItems() {
  return roadmapCandidates().filter(d => state.roadmapSelected.has(d.id));
}

// Selected items in the user's chosen row order.
function orderedRoadmapItems() {
  const byId = new Map(roadmapItems().map(d => [d.id, d]));
  return state.roadmapPlan.order.map(id => byId.get(id)).filter(Boolean);
}

// Normalise the plan: weights match the cycle count, order/items track the
// current selection, and any legacy {start,span} cycle-unit shape is migrated.
function ensureRoadmapPlan() {
  const plan = state.roadmapPlan;
  const items = roadmapItems();
  const ids = items.map(d => d.id);
  const idset = new Set(ids);

  if (!Array.isArray(plan.weights) || plan.weights.length !== plan.cycles) {
    plan.weights = Array(plan.cycles).fill(1 / plan.cycles);
  }
  if (!Array.isArray(plan.order)) plan.order = [];
  plan.order = plan.order.filter(id => idset.has(id));
  ids.forEach(id => { if (!plan.order.includes(id)) plan.order.push(id); });

  plan.items = plan.items || {};
  plan.labels = plan.labels || {};
  Object.keys(plan.items).forEach(id => { if (!idset.has(+id)) delete plan.items[id]; });
  Object.keys(plan.labels).forEach(id => { if (!idset.has(+id)) delete plan.labels[id]; });
  items.forEach((d, i) => {
    let it = plan.items[d.id];
    if (it && it.span != null) {                 // legacy cycle-unit shape → fractions
      const cyc = Math.max(1, plan.cycles);
      it = { start: it.start / cyc, end: (it.start + it.span) / cyc };
      plan.items[d.id] = it;
    }
    if (!it) {                                    // default: stagger one cycle-width across the timeline
      const w = 1 / Math.max(1, plan.cycles);
      const s = Math.min(1 - w, (i % plan.cycles) * w);
      plan.items[d.id] = { start: s, end: s + w };
    }
  });
}

function createRoadmap() {
  if (state.roadmapSelected.size === 0) return;
  ensureRoadmapPlan();
  state.roadmapPhase = 'build';
  saveProjectData(true);
  renderRoadmap();
}

function backToRoadmapSelect() {
  state.roadmapPhase = 'select';
  saveProjectData();
  renderRoadmap();
}

// Changing the cycle count resets the partition to equal widths; bars keep
// their place on the 0..1 timeline.
function setRoadmapCycles(delta) {
  const plan = state.roadmapPlan;
  const next = Math.min(ROADMAP_CYCLES_MAX, Math.max(1, plan.cycles + delta));
  if (next === plan.cycles) return;
  plan.cycles = next;
  plan.weights = Array(next).fill(1 / next);
  saveProjectData();
  renderRoadmap();
}

function renderRoadmapGantt(candidates) {
  ensureRoadmapPlan();
  const items = orderedRoadmapItems();
  const plan = state.roadmapPlan;
  const actionRow = document.getElementById('actionRow');
  const panel = document.getElementById('mainPanel');

  actionRow.innerHTML = `
    <button class="btn-ghost" onclick="backToRoadmapSelect()">← Edit selection</button>
    <button class="btn-primary" onclick="confirmRoadmap()">Confirm roadmap → Deck</button>
    <span class="action-hint">${items.length} program${items.length === 1 ? '' : 's'} · ${plan.cycles} cycles · drag bars to move/resize, ⠿ to reorder, dividers to rebalance</span>`;
  actionRow.style.display = 'flex';

  const legendBlocks = BLOCKS.filter(b => items.some(d => d.block === b));
  const legend = legendBlocks.map(b => {
    const c = blockColor(b);
    return `<div class="rm-leg-item"><span class="rm-leg-sw" style="background:${c.fill}"></span>${escapeHtml(b.replace(/^\d+\.\s*/, ''))}</div>`;
  }).join('');

  // Cumulative boundaries from weights (sum = 1).
  const bounds = [];
  let acc = 0;
  plan.weights.forEach(w => { acc += w; bounds.push(acc); });   // bounds[i] = right edge of cycle i

  const dividers = plan.weights.slice(0, -1).map((_, i) =>
    `<div class="rm-divider" data-div="${i}" style="left:${bounds[i] * 100}%"></div>`).join('');
  const cycleLabels = plan.weights.map((w, i) =>
    `<div class="rm-cycle" style="width:${w * 100}%">Cycle ${i + 1}</div>`).join('');

  const rows = items.map(d => rmRowHtml(d)).join('');

  panel.innerHTML = `
    <div class="rm-gantt">
      <div class="rm-gantt-head">
        <div>
          <h2 class="rm-gantt-title">Initiatives Prioritization <span>| Gantt view</span></h2>
          <p class="rm-gantt-sub">Recommended programs over time</p>
        </div>
        <div class="rm-cycle-ctrl">
          Cycles
          <button onclick="setRoadmapCycles(-1)" ${plan.cycles <= 1 ? 'disabled' : ''}>−</button>
          <span>${plan.cycles}</span>
          <button onclick="setRoadmapCycles(1)" ${plan.cycles >= ROADMAP_CYCLES_MAX ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="rm-main">
        <div class="rm-chart">
          <div class="rm-yaxis">Programs / decisions to set up</div>
          <div class="rm-plot">
            <div class="rm-rows" id="rmRows">${rows}</div>
            <div class="rm-dividers" id="rmDividers">${dividers}</div>
          </div>
          <div class="rm-axis"><div class="rm-axis-label"></div><div class="rm-cycles">${cycleLabels}</div></div>
        </div>
        <div class="rm-legend">
          <div class="rm-legend-title">Building Blocks</div>
          ${legend}
        </div>
      </div>
    </div>`;

  attachGanttDrag();
}

const _rmSnap = v => Math.round(v / ROADMAP_SNAP) * ROADMAP_SNAP;
const _clamp01 = v => Math.max(0, Math.min(1, v));

// Display label for a row: the user's override if set, else the initiative.
function rmDefaultLabel(d) { return (d.initiative || d.takeaway || '').trim(); }
function rmLabel(d) {
  const custom = state.roadmapPlan.labels && state.roadmapPlan.labels[d.id];
  return custom != null && custom !== '' ? custom : rmDefaultLabel(d);
}

function rmRowHtml(d, draggingId) {
  const it = state.roadmapPlan.items[d.id];
  const c = blockColor(d.block);
  const label = rmLabel(d);
  return `
    <div class="rm-row ${d.id === draggingId ? 'dragging' : ''}" data-id="${d.id}">
      <div class="rm-row-label">
        <span class="rm-row-handle" data-handle="1" title="Drag to reorder">⠿</span>
        <span class="rm-row-text" data-edit="${d.id}" title="${escapeHtml(label)} — double-click to rename">${escapeHtml(label)}</span>
      </div>
      <div class="rm-track">
        <div class="rm-bar" data-id="${d.id}"
             style="left:${it.start * 100}%;width:${(it.end - it.start) * 100}%;background:${c.fill}">
          <span class="rm-bar-grip left" data-grip="left"></span>
          <span class="rm-bar-grip right" data-grip="right"></span>
        </div>
      </div>
    </div>`;
}

// One active drag at a time. Document-level move/up listeners (bound once) keep
// tracking the pointer even across the in-place row re-render used by reorder —
// no pointer capture, so nothing gets lost.
let _gDrag = null;

function attachGanttDrag() {
  const rows = document.getElementById('rmRows');
  const divLayer = document.getElementById('rmDividers');
  if (!rows) return;

  rows.onpointerdown = e => {
    const handle = e.target.closest('.rm-row-handle');
    if (handle) {
      const row = handle.closest('.rm-row');
      _gDrag = { kind: 'row', id: +row.dataset.id };
      row.classList.add('dragging');
      e.preventDefault();
      return;
    }
    const bar = e.target.closest('.rm-bar');
    if (!bar) return;
    const it = state.roadmapPlan.items[+bar.dataset.id];
    _gDrag = {
      kind: 'bar', bar, it,
      mode: e.target.dataset.grip || 'move',
      trackW: bar.parentElement.getBoundingClientRect().width,
      startX: e.clientX, s0: it.start, e0: it.end,
    };
    bar.classList.add('dragging');
    e.preventDefault();
  };

  rows.ondblclick = e => {
    const t = e.target.closest('.rm-row-text');
    if (t) editRoadmapLabel(+t.dataset.edit, t);
  };

  if (divLayer) divLayer.onpointerdown = e => {
    const dv = e.target.closest('.rm-divider');
    if (!dv) return;
    const i = +dv.dataset.div;                       // boundary between cycle i and i+1
    const plan = state.roadmapPlan;
    const rect = divLayer.getBoundingClientRect();
    const leftEdge = plan.weights.slice(0, i).reduce((a, b) => a + b, 0);
    const pairSum = plan.weights[i] + plan.weights[i + 1];
    _gDrag = {
      kind: 'divider', dv, i,
      rectLeft: rect.left, rectW: rect.width,
      leftEdge, pairSum,
      minB: leftEdge + ROADMAP_CYCLE_MIN,
      maxB: leftEdge + pairSum - ROADMAP_CYCLE_MIN,
    };
    dv.classList.add('dragging');
    e.preventDefault();
  };

  if (!attachGanttDrag._bound) {
    document.addEventListener('pointermove', onGanttPointerMove);
    document.addEventListener('pointerup', endGanttDrag);
    document.addEventListener('pointercancel', endGanttDrag);
    attachGanttDrag._bound = true;
  }
}

function onGanttPointerMove(e) {
  const g = _gDrag;
  if (!g) return;
  if (g.kind === 'bar') {
    const d = (e.clientX - g.startX) / g.trackW;
    const it = g.it;
    if (g.mode === 'move') {
      const span = g.e0 - g.s0;
      let s = _clamp01(_rmSnap(g.s0 + d));
      s = Math.min(s, 1 - span);
      it.start = s; it.end = s + span;
    } else if (g.mode === 'left') {
      it.start = _clamp01(Math.min(_rmSnap(g.s0 + d), it.end - ROADMAP_SNAP));
    } else {
      it.end = _clamp01(Math.max(_rmSnap(g.e0 + d), it.start + ROADMAP_SNAP));
    }
    g.bar.style.left = it.start * 100 + '%';
    g.bar.style.width = (it.end - it.start) * 100 + '%';
  } else if (g.kind === 'divider') {
    const plan = state.roadmapPlan;
    // Absolute: put the boundary exactly under the cursor, then clamp/snap.
    let b = _rmSnap((e.clientX - g.rectLeft) / g.rectW);
    b = Math.max(g.minB, Math.min(g.maxB, b));
    plan.weights[g.i] = b - g.leftEdge;
    plan.weights[g.i + 1] = g.pairSum - plan.weights[g.i];
    g.dv.style.left = b * 100 + '%';
    const labels = document.querySelectorAll('.rm-cycles .rm-cycle');
    if (labels[g.i]) labels[g.i].style.width = plan.weights[g.i] * 100 + '%';
    if (labels[g.i + 1]) labels[g.i + 1].style.width = plan.weights[g.i + 1] * 100 + '%';
  } else if (g.kind === 'row') {
    reorderRowsByY(g.id, e.clientY);
  }
}

function endGanttDrag() {
  if (!_gDrag) return;
  document.querySelectorAll('.rm-bar.dragging, .rm-row.dragging, .rm-divider.dragging')
    .forEach(el => el.classList.remove('dragging'));
  _gDrag = null;
  saveProjectData();
}

// Move the dragged row to wherever the pointer sits; re-render rows in place.
function reorderRowsByY(id, clientY) {
  const order = state.roadmapPlan.order;
  const rowEls = [...document.querySelectorAll('#rmRows .rm-row')];
  let target = rowEls.length - 1;
  for (let i = 0; i < rowEls.length; i++) {
    const r = rowEls[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { target = i; break; }
  }
  const cur = order.indexOf(id);
  if (cur === target || cur === -1) return;
  order.splice(cur, 1);
  order.splice(target, 0, id);
  rebuildRoadmapRows(id);
}

// Re-render just the rows list (cheap; keeps #rmRows and its handlers alive).
function rebuildRoadmapRows(draggingId) {
  const rows = document.getElementById('rmRows');
  if (!rows) return;
  rows.innerHTML = orderedRoadmapItems().map(d => rmRowHtml(d, draggingId)).join('');
}

// Inline-rename a row to a more concise label. Blank reverts to the default.
function editRoadmapLabel(id, span) {
  const d = roadmapItems().find(x => x.id === id);
  if (!d) return;
  const input = document.createElement('input');
  input.className = 'rm-row-edit';
  input.value = rmLabel(d);
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    const plan = state.roadmapPlan;
    plan.labels = plan.labels || {};
    if (v && v !== rmDefaultLabel(d)) plan.labels[id] = v; else delete plan.labels[id];
    saveProjectData();
    rebuildRoadmapRows();
  };
  input.onkeydown = ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    else if (ev.key === 'Escape') { input.onblur = null; rebuildRoadmapRows(); }
  };
  input.onblur = commit;
}

function confirmRoadmap() {
  if (state.roadmapSelected.size === 0) return;
  state.roadmapConfirmed = true;
  saveProjectData(true);
  switchStage('deck');
}

// ─── Deck module ─────────────────────────────────────────────────
// Generates the filled Revenue Audit deck from the bundled template: the user
// uploads the self-assessment xlsx, the server places the Diagnosis Synthesis
// dots and returns the .pptx for download.

let _deckXlsx = null;   // { name, b64 }

function renderDeck() {
  const panel = document.getElementById('mainPanel');
  document.getElementById('actionRow').style.display = 'none';
  panel.innerHTML = `
    <div class="deck-wrap">
      <h2 class="tk-title">Generate the deck</h2>
      <p class="tk-sub">Upload the self-assessment Excel export — the Diagnosis Synthesis
         slides are filled with the scored dots and the deck downloads as a .pptx.</p>

      <div class="deck-form">
        <label class="deck-field">
          <span>Client name</span>
          <input id="deckClient" type="text" placeholder="e.g. Horizons Optical"
                 value="${escapeHtml(PROJECT.name || '')}">
        </label>
        <div class="deck-row">
          <label class="deck-field">
            <span>Segment <em>(optional)</em></span>
            <input id="deckSegment" type="text" placeholder="e.g. Enterprise">
          </label>
          <label class="deck-field">
            <span>Date <em>(optional)</em></span>
            <input id="deckDate" type="text" placeholder="e.g. June 2026">
          </label>
        </div>
        <label class="deck-field">
          <span>Self-assessment (.xlsx)</span>
          <input id="deckFile" type="file" accept=".xlsx" onchange="onDeckFile(event)">
          <span class="deck-filehint" id="deckFileName">No file selected.</span>
        </label>

        <button class="btn-primary" id="deckGenBtn" onclick="generateDeck()" disabled>
          Generate deck
        </button>
        <span class="action-hint" id="deckHint">Upload the Excel file to enable generation.</span>
      </div>
    </div>`;
}

function onDeckFile(e) {
  const file = e.target.files && e.target.files[0];
  const nameEl = document.getElementById('deckFileName');
  const btn = document.getElementById('deckGenBtn');
  const hint = document.getElementById('deckHint');
  if (!file) { _deckXlsx = null; btn.disabled = true; nameEl.textContent = 'No file selected.'; return; }
  const reader = new FileReader();
  reader.onload = () => {
    // dataURL → strip the "data:...;base64," prefix
    _deckXlsx = { name: file.name, b64: String(reader.result).split(',')[1] };
    nameEl.textContent = file.name;
    btn.disabled = false;
    hint.textContent = 'Ready to generate.';
  };
  reader.readAsDataURL(file);
}

async function generateDeck() {
  const client = document.getElementById('deckClient').value.trim();
  const btn = document.getElementById('deckGenBtn');
  const hint = document.getElementById('deckHint');
  if (!client) { hint.textContent = 'Enter a client name first.'; return; }
  if (!_deckXlsx) { hint.textContent = 'Upload the Excel file first.'; return; }

  btn.disabled = true;
  hint.textContent = 'Generating…';
  try {
    const res = await fetch('/api/deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        client,
        segment: document.getElementById('deckSegment').value.trim(),
        date: document.getElementById('deckDate').value.trim(),
        xlsx_b64: _deckXlsx.b64,
      }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'deck.pptx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    hint.textContent = '✓ Deck downloaded.';
  } catch (err) {
    hint.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
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
