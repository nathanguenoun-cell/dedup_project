// ═══════════════════════════════════════════════════════════════
// TYPEFORM LOADER — fetch responses, pick a project, compute averages
//
// Flow:
//  1. Fetch the connected form (fixed server-side) + its responses.
//  2. Walk the form definition → build question map (question title + its
//     building block, i.e. the Typeform group/section it lives in) and detect
//     the "project" field (the dropdown that exposes the project list).
//  3. Let the user pick a project → filter responses to that project.
//  4. For EACH question compute the average of all responses (1 decimal), and
//     for EACH building block the average of its questions' averages.
// A collapsible debug panel dumps the raw JSON so we can adjust detection if
// the real structure differs from these assumptions.
// ═══════════════════════════════════════════════════════════════

let _tfForm = null;       // last fetched form definition
let _tfResponses = null;  // last fetched responses payload ({items, total_items, …})
let _tfQMap = null;       // {questions:[{id,ref,title,type,block}], projectField}

function tfStatus(msg, type) {
  const el = document.getElementById('typeformStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--red)' : (type === 'ok' ? 'var(--green)' : 'var(--muted)');
}

// Pull a human-readable value out of a Typeform answer object. The value lives
// under a key that depends on the answer `type` (text / choice / number / …).
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

// Numeric value of an answer (rating / opinion_scale / number all come back as
// type "number"). Returns null when the answer isn't numeric (e.g. the project
// dropdown), so such questions are skipped in the averages.
function tfNumeric(a) {
  if (!a) return null;
  if (typeof a.number === 'number') return a.number;
  return null;
}

// Map an answer's field to its question title using the form definition.
function tfFieldTitle(fieldId, fieldRef) {
  if (_tfQMap) {
    const q = _tfQMap.questions.find(x => x.id === fieldId || x.ref === fieldRef);
    if (q) return q.title;
  }
  return fieldRef || fieldId || '(unknown)';
}

// Walk the form fields (recursing into groups) → flat question list tagged with
// its building block (the enclosing group's title), plus the project field.
function tfBuildQuestionMap(fields) {
  const questions = [];
  let projectField = null;
  const isProject = f => f.type === 'dropdown' || f.ref === 't' || /projec|projet/i.test(f.title || '');

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

// The project value of a single response (reads the project field's answer).
function tfProjectValueOf(item, pf) {
  if (!pf) return '';
  const ans = (item.answers || []).find(a => a.field && (a.field.id === pf.id || a.field.ref === pf.ref));
  return ans ? tfAnswerValue(ans) : '';
}

// Distinct project values across all responses.
function tfDistinctProjects(items, pf) {
  if (!pf) return [];
  const set = new Set();
  items.forEach(it => { const v = tfProjectValueOf(it, pf); if (v) set.add(v); });
  return [...set].sort();
}

// For a chosen project: per-question average + per-block (avg of its Q averages).
function tfComputeAverages(items, projectValue, pf, qmap) {
  const rows = items.filter(it => tfProjectValueOf(it, pf) === projectValue);
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

    tfStatus(`✓ ${_tfForm.title || 'form'} — ${_tfQMap.questions.length} questions · ${_tfResponses.total_items ?? items.length} responses`, 'ok');
    renderTypeformPanel(items);
  } catch (err) {
    tfStatus('Error: ' + (err && err.message || err), 'error');
  }
}

function renderTypeformPanel(items) {
  const el = document.getElementById('typeformResult');
  if (!el) return;
  const pf = _tfQMap.projectField;
  const projects = tfDistinctProjects(items, pf);

  const selectorHtml = pf
    ? `<div style="display:flex;align-items:center;gap:10px;margin-top:16px;">
         <label style="font-size:13px;font-weight:600;">Project</label>
         <select id="tfProjectSelect" class="filter-select" style="min-width:220px;" onchange="tfRenderAverages()">
           ${projects.map(p => `<option value="${tfEsc(p)}">${tfEsc(p)}</option>`).join('') || '<option value="">(no project values)</option>'}
         </select>
       </div>`
    : `<div style="margin-top:16px;color:var(--red);font-size:13px;">
         No project field detected. Check the raw JSON below (looked for a dropdown / ref "t" / a title containing "project").
       </div>`;

  el.innerHTML = `
    ${selectorHtml}
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

  if (pf && projects.length) tfRenderAverages();
}

function tfRenderAverages() {
  const el = document.getElementById('tfAverages');
  if (!el) return;
  const items = (_tfResponses && _tfResponses.items) || [];
  const pf = _tfQMap.projectField;
  const sel = document.getElementById('tfProjectSelect');
  const projectValue = sel ? sel.value : '';
  const res = tfComputeAverages(items, projectValue, pf, _tfQMap);
  const blockNames = Object.keys(res.blocks);

  if (!blockNames.length) {
    el.innerHTML = `<div style="color:var(--muted);margin-top:12px;">No numeric answers for this project.</div>`;
    return;
  }
  el.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin:12px 0;">
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
