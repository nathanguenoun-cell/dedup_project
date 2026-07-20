// ═══════════════════════════════════════════════════════════════
// TYPEFORM LOADER — fetch responses, pick a project, compute averages
//
// Workflow:
//  1. "Fetch responses" → load the connected form (fixed server-side) + its
//     responses. This ONLY populates the selectors; no answer detail is shown.
//  2. Pick which field identifies the project (auto-detected, overridable —
//     includes hidden fields), then pick a project value.
//  3. Then, and only then, show per-question averages (1 decimal) grouped by
//     building block (the Typeform group/section), plus each block's average.
// A collapsible debug panel dumps the raw JSON to adjust detection if needed.
// ═══════════════════════════════════════════════════════════════

let _tfForm = null;       // last fetched form definition
let _tfResponses = null;  // last fetched responses payload ({items, total_items, …})
let _tfQMap = null;       // {questions:[{id,ref,title,type,block}], projectField}
let _tfSources = [];      // candidate "project" sources (form fields + hidden fields)

function tfStatus(msg, type) {
  const el = document.getElementById('typeformStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : (type === 'ok' ? 'var(--green)' : 'var(--muted)');
}

// Human-readable value of a Typeform answer (key depends on its `type`).
function tfAnswerValue(a) {
  if (!a) return '';
  switch (a.type) {
    case 'text':
    case 'email':
    case 'url':
    case 'file_url':
    case 'phone_number':
    case 'date':      return String(a[a.type] ?? '');
    case 'number':    return String(a.number ?? '');
    case 'boolean':   return a.boolean ? 'Yes' : 'No';
    case 'choice':    return (a.choice && (a.choice.label ?? a.choice.other)) || '';
    case 'choices':   return ((a.choices && (a.choices.labels || [])) || []).join(', ');
    default:
      { const v = a[a.type]; return typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''); }
  }
}

// Numeric value of an answer (rating / opinion_scale / number → type "number").
// Returns null when not numeric, so such questions are skipped in the averages.
function tfNumeric(a) {
  if (!a) return null;
  if (typeof a.number === 'number') return a.number;
  return null;
}

// Walk form fields (recursing into groups) → flat question list tagged with its
// building block (the enclosing group's title), plus best-guess project field.
function tfBuildQuestionMap(fields) {
  const questions = [];
  let projectField = null;
  const isProject = f => f.ref === 't' || f.type === 'dropdown' || /projec|projet/i.test(f.title || '');

  function walk(list, block) {
    (list || []).forEach(f => {
      if (f.type === 'group' && f.properties && Array.isArray(f.properties.fields)) {
        walk(f.properties.fields, f.title || block);   // group title = building block
      } else {
        if (!projectField && isProject(f)) projectField = f;
        questions.push({ id: f.id, ref: f.ref, title: f.title, type: f.type, block: block || '(no block)' });
      }
    });
  }
  walk(fields, null);
  return { questions, projectField };
}

// Candidate project sources: every form field + every hidden field seen.
function tfBuildSources(items) {
  const sources = [];
  _tfQMap.questions.forEach(q => sources.push({ kind: 'field', id: q.id, ref: q.ref, title: q.title || '(untitled)', type: q.type }));
  const hiddenKeys = new Set();
  items.forEach(it => { if (it.hidden) Object.keys(it.hidden).forEach(k => hiddenKeys.add(k)); });
  [...hiddenKeys].forEach(k => sources.push({ kind: 'hidden', key: k, title: k }));
  return sources;
}

function tfSourceKey(s) { return s.kind === 'hidden' ? `hidden:${s.key}` : `field:${s.id}`; }
function tfSourceLabel(s) {
  return s.kind === 'hidden' ? `${s.title} (hidden)` : `${s.title}${s.type ? ` [${s.type}]` : ''}`;
}
function tfFindSource(key) { return _tfSources.find(s => tfSourceKey(s) === key) || null; }

// Default source: the auto-detected project field, else a hidden/field whose
// name hints "project"/"t", else the first available source.
function tfDefaultSourceKey() {
  const pf = _tfQMap.projectField;
  if (pf) { const s = _tfSources.find(x => x.kind === 'field' && x.id === pf.id); if (s) return tfSourceKey(s); }
  const hinted = _tfSources.find(s => /^t$|projec|projet/i.test(s.kind === 'hidden' ? s.key : (s.title || '')));
  if (hinted) return tfSourceKey(hinted);
  return _tfSources.length ? tfSourceKey(_tfSources[0]) : '';
}

// The project value of a response for a chosen source (field answer or hidden).
function tfSourceValue(item, source) {
  if (!source) return '';
  if (source.kind === 'hidden') return (item.hidden && item.hidden[source.key] != null) ? String(item.hidden[source.key]) : '';
  const ans = (item.answers || []).find(a => a.field && (a.field.id === source.id || a.field.ref === source.ref));
  return ans ? tfAnswerValue(ans) : '';
}

function tfDistinctValues(items, source) {
  const set = new Set();
  items.forEach(it => { const v = tfSourceValue(it, source); if (v) set.add(v); });
  return [...set].sort();
}

// For a chosen project: per-question average + per-block (avg of its Q averages).
function tfComputeAverages(items, projectValue, source, qmap) {
  const rows = items.filter(it => tfSourceValue(it, source) === projectValue);
  const perQ = {};   // questionId -> {sum, count}
  rows.forEach(it => (it.answers || []).forEach(a => {
    const num = tfNumeric(a);
    if (num == null) return;
    const key = a.field && a.field.id;
    if (!key) return;
    (perQ[key] || (perQ[key] = { sum: 0, count: 0 }));
    perQ[key].sum += num;
    perQ[key].count += 1;
  }));

  const blocks = {};   // block -> {questions:[{title, avg}], avgs:[...]}
  qmap.questions.forEach(q => {
    const agg = perQ[q.id];
    if (!agg || !agg.count) return;      // skip non-numeric questions (e.g. project)
    const avg = agg.sum / agg.count;
    (blocks[q.block] || (blocks[q.block] = { questions: [], avgs: [] }));
    blocks[q.block].questions.push({ title: q.title, avg });
    blocks[q.block].avgs.push(avg);
  });
  return { rowsCount: rows.length, blocks };
}

async function importFromTypeform() {
  const resultEl = document.getElementById('typeformResult');
  if (resultEl) resultEl.innerHTML = '';
  tfStatus('Fetching form + responses…');

  try {
    const [formRes, respRes] = await Promise.all([
      api.typeformForm(),
      api.typeformResponses(1000),
    ]);
    if (!formRes || formRes.available === false) {
      tfStatus((formRes && formRes.error) || 'Typeform not configured.', 'error');
      return;
    }
    if (!respRes || respRes.available === false) {
      tfStatus((respRes && respRes.error) || 'Could not fetch responses.', 'error');
      return;
    }

    _tfForm = formRes.data || {};
    _tfResponses = respRes.data || {};
    const fields = Array.isArray(_tfForm.fields) ? _tfForm.fields : [];
    const items  = Array.isArray(_tfResponses.items) ? _tfResponses.items : [];
    _tfQMap = tfBuildQuestionMap(fields);
    _tfSources = tfBuildSources(items);

    tfStatus(`✓ ${_tfForm.title || 'form'} — ${_tfQMap.questions.length} questions · ${_tfResponses.total_items ?? items.length} responses`, 'ok');
    renderTypeformPanel(items);
  } catch (err) {
    tfStatus('Error: ' + (err && err.message || err), 'error');
  }
}

// Step 1 render: selectors only (project-field chooser + project dropdown).
// No averages until a project is chosen.
function renderTypeformPanel(items) {
  const el = document.getElementById('typeformResult');
  if (!el) return;
  const defKey = tfDefaultSourceKey();

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;margin-top:16px;">
      <div>
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">Project field</label>
        <select id="tfSourceSelect" class="filter-select" style="min-width:220px;" onchange="tfOnSourceChange()">
          ${_tfSources.map(s => `<option value="${tfEsc(tfSourceKey(s))}" ${tfSourceKey(s) === defKey ? 'selected' : ''}>${tfEsc(tfSourceLabel(s))}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">Project</label>
        <select id="tfProjectSelect" class="filter-select" style="min-width:240px;" onchange="tfRenderAverages()"></select>
      </div>
    </div>
    <div id="tfAverages"></div>
    <details style="margin-top:18px;">
      <summary style="cursor:pointer;font-size:12px;color:var(--muted);">Debug — raw structure</summary>
      <div style="font-size:12px;font-weight:600;margin:10px 0 4px;">Questions &amp; building blocks (${_tfQMap.questions.length})</div>
      <table class="result-table">
        <thead><tr><th>Building block</th><th>Question</th><th>Type</th></tr></thead>
        <tbody>
          ${_tfQMap.questions.map(q => `<tr>
            <td class="td-block" style="color:var(--muted)">${tfEsc(q.block)}</td>
            <td class="td-takeaway">${tfEsc(q.title || '')}</td>
            <td class="td-block" style="color:var(--muted)">${tfEsc(q.type || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="font-size:12px;font-weight:600;margin:12px 0 4px;">Raw form fields</div>
      <pre style="max-height:260px;overflow:auto;background:var(--surface);padding:10px;border-radius:6px;font-size:11px;">${tfEsc(JSON.stringify(_tfForm.fields, null, 2))}</pre>
      <div style="font-size:12px;font-weight:600;margin:12px 0 4px;">First raw response</div>
      <pre style="max-height:260px;overflow:auto;background:var(--surface);padding:10px;border-radius:6px;font-size:11px;">${tfEsc(JSON.stringify(items[0] || null, null, 2))}</pre>
    </details>`;

  tfOnSourceChange();   // populate the project dropdown from the default field
}

// Repopulate the project dropdown when the project-field choice changes.
function tfOnSourceChange() {
  const items = (_tfResponses && _tfResponses.items) || [];
  const srcSel = document.getElementById('tfSourceSelect');
  const projSel = document.getElementById('tfProjectSelect');
  const avgEl = document.getElementById('tfAverages');
  if (avgEl) avgEl.innerHTML = '';
  if (!srcSel || !projSel) return;

  const source = tfFindSource(srcSel.value);
  const values = tfDistinctValues(items, source);
  projSel.innerHTML = `<option value="">— Select a project —</option>` +
    values.map(v => `<option value="${tfEsc(v)}">${tfEsc(v)}</option>`).join('');
}

// Step 2 render: averages for the chosen project (only once one is selected).
function tfRenderAverages() {
  const el = document.getElementById('tfAverages');
  if (!el) return;
  const items = (_tfResponses && _tfResponses.items) || [];
  const srcSel = document.getElementById('tfSourceSelect');
  const sel = document.getElementById('tfProjectSelect');
  const source = srcSel ? tfFindSource(srcSel.value) : null;
  const projectValue = sel ? sel.value : '';

  if (!projectValue) { el.innerHTML = ''; return; }   // nothing until a project is picked

  const res = tfComputeAverages(items, projectValue, source, _tfQMap);
  const blockNames = Object.keys(res.blocks);
  if (!blockNames.length) {
    el.innerHTML = `<div style="color:var(--muted);margin-top:12px;">No numeric answers for this project.</div>`;
    return;
  }
  el.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin:14px 0 6px;">
      ${res.rowsCount} response(s) for “${tfEsc(projectValue)}” · averages to 1 decimal
    </div>
    ${blockNames.map(bn => {
      const b = res.blocks[bn];
      const blockAvg = b.avgs.reduce((a, c) => a + c, 0) / b.avgs.length;
      return `
        <table class="result-table" style="margin-bottom:16px;">
          <thead><tr><th style="width:78%">${tfEsc(bn)}</th><th>Avg</th></tr></thead>
          <tbody>
            ${b.questions.map(q => `<tr>
              <td class="td-takeaway">${tfEsc(q.title)}</td>
              <td class="td-block" style="text-align:right;font-variant-numeric:tabular-nums;">${q.avg.toFixed(1)}</td>
            </tr>`).join('')}
            <tr style="font-weight:700;background:var(--surface);">
              <td>Building block average</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums;">${blockAvg.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>`;
    }).join('')}`;
}

function tfEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
