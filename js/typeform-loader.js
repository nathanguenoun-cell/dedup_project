// ═══════════════════════════════════════════════════════════════
// TYPEFORM LOADER — fetch responses, pick a project, compute averages
//
// Pure(ish) data functions consumed by the Assessment step:
//  1. tfFetchTypeform() — loads the connected form (fixed server-side) + its
//     responses, returns {form, items, qmap}.
//  2. tfBuildAssessment(items, projectValue, qmap) — for a chosen project,
//     returns ordered per-building-block rows with the client (Typeform)
//     average per question.
//
// The project is identified by the hidden field "t" (item.hidden.t) — fixed,
// not user-selectable.
// ═══════════════════════════════════════════════════════════════

const PROJECT_HIDDEN_KEY = 't';   // the hidden field that carries the project name

// Numeric value of an answer (rating / opinion_scale / number → type "number").
// Returns null when not numeric, so such questions are skipped in the averages.
function tfNumeric(a) {
  if (!a) return null;
  if (typeof a.number === 'number') return a.number;
  return null;
}

// The value of a Typeform answer object, numeric-first.
function tfAnswerValue(a) {
  if (!a) return null;
  const num = tfNumeric(a);
  if (num != null) return num;
  return a.text ?? (a.choice && a.choice.label) ?? a.boolean ?? null;
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

// For a chosen project: per-question average + per-block (avg of its Q averages).
// A response may list the same question more than once (test data duplicates
// each answer); the form declares each question once, so we keep only the FIRST
// occurrence per (response, question) — one value per question per response.
function tfComputeAverages(items, projectValue, qmap) {
  const rows = items.filter(it => tfProjectOf(it) === projectValue);
  const perQ = {};   // questionId -> {sum, count, values}
  rows.forEach(it => {
    const seen = new Set();   // dedupe repeated answers within this response
    (it.answers || []).forEach(a => {
      const num = tfNumeric(a);
      if (num == null) return;
      const key = a.field && a.field.id;
      if (!key || seen.has(key)) return;
      seen.add(key);
      (perQ[key] || (perQ[key] = { sum: 0, count: 0, values: [] }));
      perQ[key].sum += num;
      perQ[key].count += 1;
      perQ[key].values.push(num);
    });
  });

  const blocks = {};   // block -> {questions:[{title, avg, values}], avgs:[...]}
  qmap.questions.forEach(q => {
    const agg = perQ[q.id];
    if (!agg || !agg.count) return;      // skip questions with no numeric answers
    const avg = agg.sum / agg.count;
    (blocks[q.block] || (blocks[q.block] = { questions: [], avgs: [] }));
    blocks[q.block].questions.push({ id: q.id, title: q.title, avg, values: agg.values });
    blocks[q.block].avgs.push(avg);
  });
  return { rowsCount: rows.length, blocks };
}

// Fetch the connected form + its responses, and build the question map.
async function tfFetchTypeform() {
  const [formRes, respRes] = await Promise.all([api.typeformForm(), api.typeformResponses(1000)]);
  if (!formRes || formRes.available === false) throw new Error((formRes && formRes.error) || 'Typeform not configured.');
  if (!respRes || respRes.available === false) throw new Error((respRes && respRes.error) || 'Could not fetch responses.');
  const form = formRes.data || {};
  const items = Array.isArray((respRes.data || {}).items) ? respRes.data.items : [];
  const qmap = tfBuildQuestionMap(Array.isArray(form.fields) ? form.fields : []);
  return { form, items, qmap };
}

// Ordered per-building-block rows with the client average (Typeform) per question.
function tfBuildAssessment(items, projectValue, qmap) {
  const res = tfComputeAverages(items, projectValue, qmap);
  // Index computed averages by unique field id (titles can collide within a block).
  const byId = {};
  Object.keys(res.blocks).forEach(bn => {
    res.blocks[bn].questions.forEach(q => { byId[q.id] = q.avg; });
  });

  const blocksInOrder = [];
  const seen = {};
  qmap.questions.forEach(q => {
    if (q.type !== 'opinion_scale' && q.type !== 'rating' && q.type !== 'number') return;
    let entry = seen[q.block];
    if (!entry) { entry = seen[q.block] = { block: q.block, rows: [] }; blocksInOrder.push(entry); }
    const avg = Object.prototype.hasOwnProperty.call(byId, q.id) ? byId[q.id] : null;
    entry.rows.push({ fieldId: q.id, title: q.title, client: (avg == null ? null : Number(avg.toFixed(1))) });
  });
  return { project: projectValue, blocks: blocksInOrder };
}

function tfEsc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
