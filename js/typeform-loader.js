// ═══════════════════════════════════════════════════════════════
// TYPEFORM LOADER — fetch responses, pick a project, compute averages
//
// Workflow:
//  1. "Fetch responses" → load the connected form (fixed server-side) + its
//     responses. This ONLY populates the Project dropdown; no detail is shown.
//  2. Pick a project → show per-question averages (1 decimal) grouped by
//     building block (the Typeform group/section), plus each block's average.
//
// The project is identified by the hidden field "t" (item.hidden.t) — fixed,
// not user-selectable. A collapsible debug panel dumps the raw JSON.
// ═══════════════════════════════════════════════════════════════

const PROJECT_HIDDEN_KEY = 't';   // the hidden field that carries the project name

let _tfForm = null;       // last fetched form definition
let _tfResponses = null;  // last fetched responses payload ({items, total_items, …})
let _tfQMap = null;       // {questions:[{id,ref,title,type,block}]}

function tfStatus(msg, type) {
  const el = document.getElementById('typeformStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : (type === 'ok' ? 'var(--green)' : 'var(--muted)');
}

// Numeric value of an answer (rating / opinion_scale / number → type "number").
// Returns null when not numeric, so such questions are skipped in the averages.
function tfNumeric(a) {
  if (!a) return null;
  if (typeof a.number === 'number') return a.number;
  return null;
}

// The project name of a response — the hidden field "t".
function tfProjectOf(item) {
  const v = item && item.hidden && item.hidden[PROJECT_HIDDEN_KEY];
  return v != null ? String(v) : '';
}

// Walk form fields (recursing into groups) → flat question list tagged with its
// building block (the enclosing group's title).
function tfBuildQuestionMap(fields) {
  const questions = [];
  function walk(list, block) {
    (list || []).forEach(f => {
      if (f.type === 'group' && f.properties && Array.isArray(f.properties.fields)) {
        walk(f.properties.fields, f.title || block);   // group title = building block
      } else {
        questions.push({ id: f.id, ref: f.ref, title: f.title, type: f.type, block: block || '(no block)' });
      }
    });
  }
  walk(fields, null);
  return { questions };
}

function tfDistinctProjects(items) {
  const set = new Set();
  items.forEach(it => { const v = tfProjectOf(it); if (v) set.add(v); });
  return [...set].sort();
}

// For a chosen project: per-question averages, split by SERIES.
// A single response answers each question more than once (the question blocks
// repeat within one response). We split those occurrences by order: series 0 =
// 1st occurrence ("Note 1"), series 1 = 2nd ("Note 2"), … Each series is
// averaged separately across the project's responses (to 1 decimal), and each
// building block gets one average per series (mean of its question averages).
function tfComputeAverages(items, projectValue, qmap) {
  const rows = items.filter(it => tfProjectOf(it) === projectValue);
  const perQ = {};   // questionId -> [ {sum,count,values}, ... ] indexed by series
  let maxSeries = 0;

  rows.forEach(it => {
    // Group this response's numeric answers by field id, preserving order.
    const byField = {};
    (it.answers || []).forEach(a => {
      const num = tfNumeric(a);
      if (num == null) return;
      const key = a.field && a.field.id;
      if (!key) return;
      (byField[key] || (byField[key] = [])).push(num);
    });
    // Each occurrence i feeds series i for that question.
    Object.keys(byField).forEach(key => {
      const series = (perQ[key] || (perQ[key] = []));
      byField[key].forEach((v, i) => {
        (series[i] || (series[i] = { sum: 0, count: 0, values: [] }));
        series[i].sum += v; series[i].count += 1; series[i].values.push(v);
        if (i + 1 > maxSeries) maxSeries = i + 1;
      });
    });
  });

  const blocks = {};   // block -> {questions:[{title, series:[{avg,values}|null]}]}
  qmap.questions.forEach(q => {
    const s = perQ[q.id];
    if (!s || !s.length) return;         // skip questions with no numeric answers
    const series = s.map(x => (x && x.count) ? { avg: x.sum / x.count, values: x.values } : null);
    (blocks[q.block] || (blocks[q.block] = { questions: [] }));
    blocks[q.block].questions.push({ title: q.title, series });
  });
  // Per-block average for each series (mean of that block's question averages).
  Object.values(blocks).forEach(b => {
    const acc = [];
    b.questions.forEach(q => q.series.forEach((sv, i) => {
      if (!sv) return;
      (acc[i] || (acc[i] = { sum: 0, count: 0 }));
      acc[i].sum += sv.avg; acc[i].count += 1;
    }));
    b.blockAvgs = acc.map(a => (a && a.count) ? a.sum / a.count : null);
  });

  return { rowsCount: rows.length, blocks, maxSeries: Math.max(maxSeries, 1) };
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

    tfStatus(`✓ ${_tfForm.title || 'form'} — ${_tfQMap.questions.length} questions · ${_tfResponses.total_items ?? items.length} responses`, 'ok');
    renderTypeformPanel(items);
  } catch (err) {
    tfStatus('Error: ' + (err && err.message || err), 'error');
  }
}

// Step 1 render: just the Project dropdown (populated from hidden "t").
function renderTypeformPanel(items) {
  const el = document.getElementById('typeformResult');
  if (!el) return;
  const projects = tfDistinctProjects(items);

  el.innerHTML = `
    <div style="margin-top:16px;">
      <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">Project</label>
      <select id="tfProjectSelect" class="filter-select" style="min-width:260px;" onchange="tfRenderAverages()">
        <option value="">— Select a project —</option>
        ${projects.map(p => `<option value="${tfEsc(p)}">${tfEsc(p)}</option>`).join('')}
      </select>
      ${projects.length ? '' : `<div style="color:var(--red);font-size:12px;margin-top:6px;">No project values found in hidden field "${PROJECT_HIDDEN_KEY}". See Debug below.</div>`}
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
      <div style="font-size:12px;font-weight:600;margin:12px 0 4px;">All responses (compact: hidden + answers as ref/id/type/value)</div>
      <pre style="max-height:320px;overflow:auto;background:var(--surface);padding:10px;border-radius:6px;font-size:11px;">${tfEsc(JSON.stringify(tfCompactResponses(items), null, 2))}</pre>
    </details>`;
}

// A small, readable projection of every response: its hidden fields and each
// answer reduced to {ref, id, type, value}. Independent of the question map, so
// it reveals the true value under each field ref (used to debug matching).
function tfCompactResponses(items) {
  return items.map((it, i) => ({
    i,
    hidden: it.hidden || {},
    answers: (it.answers || []).map(a => ({
      ref: a.field && a.field.ref,
      id:  a.field && a.field.id,
      type: a.type,
      value: (tfNumeric(a) != null) ? tfNumeric(a) : (a.text ?? (a.choice && a.choice.label) ?? a.boolean ?? null),
    })),
  }));
}

// Step 2 render: averages for the chosen project (only once one is selected).
function tfRenderAverages() {
  const el = document.getElementById('tfAverages');
  if (!el) return;
  const items = (_tfResponses && _tfResponses.items) || [];
  const sel = document.getElementById('tfProjectSelect');
  const projectValue = sel ? sel.value : '';

  if (!projectValue) { el.innerHTML = ''; return; }   // nothing until a project is picked

  const res = tfComputeAverages(items, projectValue, _tfQMap);
  const blockNames = Object.keys(res.blocks);
  if (!blockNames.length) {
    el.innerHTML = `<div style="color:var(--muted);margin-top:12px;">No numeric answers for this project.</div>`;
    return;
  }
  const S = res.maxSeries;
  const num = v => `<td style="text-align:right;font-variant-numeric:tabular-nums;">${v == null ? '—' : v.toFixed(1)}</td>`;
  const seriesHead = Array.from({ length: S }, (_, i) => `<th style="text-align:right;">Note ${i + 1}</th>`).join('');

  el.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin:14px 0 6px;">
      ${res.rowsCount} response(s) for “${tfEsc(projectValue)}” · averages to 1 decimal
      ${S > 1 ? `· each question has ${S} notes per response (shown as Note 1…${S})` : ''}
    </div>
    ${blockNames.map(bn => {
      const b = res.blocks[bn];
      return `
        <table class="result-table" style="margin-bottom:16px;">
          <thead><tr><th style="width:${78 - (S - 1) * 8}%">${tfEsc(bn)}</th>${seriesHead}</tr></thead>
          <tbody>
            ${b.questions.map(q => `<tr>
              <td class="td-takeaway">${tfEsc(q.title)}
                <div style="font-size:11px;color:var(--muted);font-family:'DM Mono',monospace;">
                  ${Array.from({ length: S }, (_, i) => q.series[i] ? `N${i + 1}=[${q.series[i].values.join(', ')}]` : '').filter(Boolean).join(' · ')}
                </div>
              </td>
              ${Array.from({ length: S }, (_, i) => num(q.series[i] ? q.series[i].avg : null)).join('')}
            </tr>`).join('')}
            <tr style="font-weight:700;background:var(--surface);">
              <td>Building block average</td>
              ${Array.from({ length: S }, (_, i) => num(b.blockAvgs[i])).join('')}
            </tr>
          </tbody>
        </table>`;
    }).join('')}`;
}

function tfEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
