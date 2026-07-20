// ═══════════════════════════════════════════════════════════════
// TYPEFORM LOADER — fetch responses from the connected form + inspect
//
// Step 1 (this file): connect to the form fixed server-side and DISPLAY the
// real structure — the list of questions and a preview of one response — so we
// can confirm the question→building-block mapping and the "project" field.
//
// Step 1.5 (later): flattenResponses() will explode each response (which holds
// the notes for every sub building block) into issue rows {block, takeaway, …}
// and hand them to onDataLoaded() — the same sink the Excel import uses.
// ═══════════════════════════════════════════════════════════════

let _tfForm = null;       // last fetched form definition
let _tfResponses = null;  // last fetched responses payload

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
      // Fallback: stringify whatever payload came back.
      { const v = a[a.type]; return typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''); }
  }
}

// Map an answer to its question title using the form definition.
function tfFieldTitle(fieldId, fieldRef) {
  if (!_tfForm || !Array.isArray(_tfForm.fields)) return fieldRef || fieldId || '(unknown)';
  const f = _tfForm.fields.find(x => x.id === fieldId || x.ref === fieldRef);
  return f ? f.title : (fieldRef || fieldId || '(unknown)');
}

async function importFromTypeform() {
  const resultEl = document.getElementById('typeformResult');
  if (resultEl) resultEl.innerHTML = '';
  tfStatus('Fetching form + responses…');

  try {
    const [formRes, respRes] = await Promise.all([
      api.typeformForm(),
      api.typeformResponses(),
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

    tfStatus(`✓ ${_tfForm.title || 'form'} — ${fields.length} questions · ${_tfResponses.total_items ?? items.length} responses`, 'ok');
    renderTypeformInspection(fields, items);
  } catch (err) {
    tfStatus('Error: ' + (err && err.message || err), 'error');
  }
}

// Read-only inspection: the form's questions + a preview of the first response.
// This is the deliverable of step 1 — it lets us confirm the real structure.
function renderTypeformInspection(fields, items) {
  const el = document.getElementById('typeformResult');
  if (!el) return;

  const questionsHtml = fields.length
    ? fields.map((f, i) => `
        <tr>
          <td class="td-block">${i + 1}</td>
          <td class="td-takeaway">${tfEsc(f.title || '')}</td>
          <td class="td-block" style="color:var(--muted)">${tfEsc(f.type || '')}</td>
          <td class="td-block" style="color:var(--muted);font-family:'DM Mono',monospace;font-size:11px">${tfEsc(f.ref || '')}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="color:var(--muted)">No questions in this form.</td></tr>`;

  const first = items[0];
  const hidden = first && first.hidden ? Object.entries(first.hidden) : [];
  const answers = first && Array.isArray(first.answers) ? first.answers : [];
  const previewHtml = first
    ? `
      ${hidden.length ? `
        <div style="font-size:12px;font-weight:600;margin:14px 0 6px;">Hidden fields (candidate "project" identifiers)</div>
        <table class="result-table"><tbody>
          ${hidden.map(([k, v]) => `<tr><td class="td-block">${tfEsc(k)}</td><td class="td-takeaway">${tfEsc(String(v))}</td></tr>`).join('')}
        </tbody></table>` : ''}
      <div style="font-size:12px;font-weight:600;margin:14px 0 6px;">Answers of the first response</div>
      <table class="result-table">
        <thead><tr><th>Question</th><th>Answer</th></tr></thead>
        <tbody>
          ${answers.map(a => `<tr>
            <td class="td-takeaway">${tfEsc(tfFieldTitle(a.field && a.field.id, a.field && a.field.ref))}</td>
            <td class="td-initiative">${tfEsc(tfAnswerValue(a))}</td>
          </tr>`).join('') || `<tr><td colspan="2" style="color:var(--muted)">No answers.</td></tr>`}
        </tbody>
      </table>`
    : `<div style="color:var(--muted);margin-top:12px;">No responses submitted yet.</div>`;

  el.innerHTML = `
    <div style="margin-top:16px;">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;">Form questions</div>
      <table class="result-table">
        <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Ref</th></tr></thead>
        <tbody>${questionsHtml}</tbody>
      </table>
      ${previewHtml}
    </div>`;
}

function tfEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
