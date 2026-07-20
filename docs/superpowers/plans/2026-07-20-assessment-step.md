# Assessment step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app "Assessment" step where Typeform client averages appear as fixed pink dots and the user drags blue Atscale dots per sub-block, then feeds both to the deck as JSON scores (Excel upload removed).

**Architecture:** Reuse `js/typeform-loader.js` (already computes per-question client averages grouped by building block). Add an `assessment` stage in `js/project.js` that reproduces the rating rows (1→5 axis, fixed pink dot, draggable blue dot), persists to a new `project_data.assessment` JSON column, and posts JSON scores to `/api/deck`. `deck_builder.build_deck` takes `scores` instead of parsing an xlsx.

**Tech Stack:** Python stdlib HTTP server + `python-pptx`/`openpyxl` (deck only); vanilla JS frontend (no build step, no framework); SQLite via stdlib.

## Global Constraints

- No new Python dependencies (stdlib + existing `python-pptx`/`openpyxl` only).
- No JS build step or framework; plain `<script>` files, DOM via template strings.
- **No automated test harness exists.** Verify with: (a) small `python3 -c` asserts for pure Python helpers, (b) running the server locally / on staging and exercising the UI, (c) generating a deck and inspecting the `.pptx`.
- Persistence is last-write-wins via `PUT /api/projects/{id}/data`.
- Score scale is 1..5. Client score is a decimal average; Atscale is a decimal in [1,5].
- Dot colors: client pink `#DDC7C7` (`CLIENT_COLOR`), Atscale blue `#BDD3F3` (`ATSCALE_COLOR`).
- Deck dot placement is **by row order** within a building block; Typeform question order == deck row order (163 questions == 163 rows).
- Work on `dev`, commit per task; push to `dev` (staging) only when a task needs UI verification. Never commit to `main`.

---

## File Structure

- `db.py` — add `assessment` JSON column (migration) + read/write it.
- `api_handlers.py` — pass `assessment` through `_save_data`.
- `deck_builder.py` — `bb_avgs_from_scores()` helper; `build_deck(..., scores=...)` replaces xlsx parsing.
- `server.py` — `/api/deck` accepts `scores` JSON instead of `xlsx_b64`.
- `js/typeform-loader.js` — add `tfBuildAssessment()`; delete the debug UI (diag, inspector, raw dumps, averages tables) and the dedup-zone panel wiring.
- `js/project.js` — new `assessment` stage + interactive rating screen + state hydration/save; remove the Typeform panel from the dedup import zone; rewire the deck step (drop xlsx, send `scores`).

---

## Task 1: Persist the `assessment` column

**Files:**
- Modify: `db.py` (init migration ~line 87; `get_project_data` ~line 296; `save_project_data` ~line 320)
- Modify: `api_handlers.py:133-150` (`_save_data`)

**Interfaces:**
- Produces: `save_project_data(..., assessment=None)` stores JSON; `get_project_data()` returns key `"assessment"` (dict, default `{}`).

- [ ] **Step 1: Add the migration** in `db.py` `init_db()`, right after the `roadmap` migration block (`db.py:87-88`):

```python
        if "assessment" not in cols:
            conn.execute("ALTER TABLE project_data ADD COLUMN assessment TEXT NOT NULL DEFAULT '{}'")
```

- [ ] **Step 2: Return it from `get_project_data`** — in the returned dict (after the `roadmap` line ~`db.py:313`):

```python
            "assessment": json.loads(row["assessment"]) if "assessment" in keys and row["assessment"] else {},
```

- [ ] **Step 3: Accept and store it in `save_project_data`** — change the signature and the INSERT/UPDATE. Replace the `def save_project_data(...)` line and the SQL:

```python
def save_project_data(project_id, file_name, raw_data, groups, decisions, removed_ids, failed_blocks=None, takeaways=None, roadmap=None, assessment=None):
    """Last-write-wins persistence of the shared dedup state."""
    conn = connect()
    try:
        conn.execute(
            """
            INSERT INTO project_data (project_id, file_name, raw_data, groups, decisions, removed_ids, failed_blocks, takeaways, roadmap, assessment, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(project_id) DO UPDATE SET
                file_name=excluded.file_name,
                raw_data=excluded.raw_data,
                groups=excluded.groups,
                decisions=excluded.decisions,
                removed_ids=excluded.removed_ids,
                failed_blocks=excluded.failed_blocks,
                takeaways=excluded.takeaways,
                roadmap=excluded.roadmap,
                assessment=excluded.assessment,
                updated_at=excluded.updated_at
            """,
            (
                project_id,
                file_name or "",
                json.dumps(raw_data or []),
                json.dumps(groups or []),
                json.dumps(decisions or {}),
                json.dumps(removed_ids or []),
                json.dumps(failed_blocks or []),
                json.dumps(takeaways or {}),
                json.dumps(roadmap or {}),
                json.dumps(assessment or {}),
                now(),
            ),
        )
        conn.commit()
    finally:
        conn.close()
```

- [ ] **Step 4: Pass it through `_save_data`** in `api_handlers.py` (append after the `roadmap` arg at `api_handlers.py:145`):

```python
        body.get("roadmap", {}),
        body.get("assessment", {}),
```

- [ ] **Step 5: Verify round-trip** in a scratch DB:

```bash
cd dedup-v2
DATA_DIR=$(mktemp -d) python3 -c "
import db
db.init_db()
uid=db.create_user('a@b.co','A','h','s'); pid=db.create_project('P',uid)
db.save_project_data(pid,'',[],[],{},[],[],{},{}, {'project':'X','rows':[{'fieldId':'f1','title':'t','block':'B','client':3.4,'atscale':4.0}]})
d=db.get_project_data(pid); print(d['assessment']); assert d['assessment']['rows'][0]['client']==3.4
print('OK')
"
```
Expected: prints the dict then `OK`.

- [ ] **Step 6: Commit**

```bash
git add db.py api_handlers.py
git commit -m "Assessment: persist project_data.assessment column"
```

---

## Task 2: Deck builder + endpoint accept JSON scores

**Files:**
- Modify: `deck_builder.py` (add helper near `parse_self_assessment` ~line 133; change `build_deck` ~line 561-614)
- Modify: `server.py` (`/api/deck` handler ~line 363-400)
- Test: `python3 -c` assert (below)

**Interfaces:**
- Consumes: `scores` = `{ "<building block name>": [ {"rating": float|None, "atscale": float|None}, ... ] }`, each list in deck row order.
- Produces: `bb_avgs_from_scores(scores) -> {bb: {"client_avg": float, "atscale_avg": float}}` (averages over present values, 1 decimal); `build_deck(template_file, scores, client_name, segment=None, date=None, roadmap=None, takeaways=None) -> bytes`.

- [ ] **Step 1: Add the pure helper** in `deck_builder.py` after `parse_self_assessment` (after `deck_builder.py:133`):

```python
def bb_avgs_from_scores(scores):
    """Per-block {client_avg, atscale_avg} from the JSON scores payload.
    Averages ignore missing (None) values; a block with no values is omitted."""
    out = {}
    for bb, rows in (scores or {}).items():
        rv = [r['rating']  for r in rows if r.get('rating')  is not None]
        av = [r['atscale'] for r in rows if r.get('atscale') is not None]
        if not rv and not av:
            continue
        out[bb] = {
            'client_avg':  round(sum(rv) / len(rv), 1) if rv else 0.0,
            'atscale_avg': round(sum(av) / len(av), 1) if av else 0.0,
        }
    return out


def _scores_for_bb(scores, bb_name):
    """Find the scores list for a slide's building block, matching keys fuzzily."""
    for key, rows in (scores or {}).items():
        if _match_bb_name(key, bb_name):
            return rows
    return None
```

- [ ] **Step 2: Add the name matcher** `_match_bb_name` next to the helper. It reuses the normalization already used by `_match_bb`. Add:

```python
def _match_bb_name(a, b):
    """Loose equality between two building-block names (case/punct/space-insensitive)."""
    norm = lambda s: re.sub(r'[^a-z0-9]+', '', (s or '').lower())
    return norm(a) == norm(b)
```

- [ ] **Step 3: Rewrite `build_deck` to use scores.** Replace the signature line and the `parse_self_assessment` call:

```python
def build_deck(template_file, scores, client_name, segment=None, date=None, roadmap=None, takeaways=None):
    """Generate the filled deck. Returns the .pptx as bytes.

    `template_file` is a path or binary file-like. `scores` is the JSON payload:
    {block: [{rating, atscale}, ...]} in deck row order.
    """
    prs = Presentation(template_file)
    bb_avgs = bb_avgs_from_scores(scores)
```

- [ ] **Step 4: Update the per-slide loop** in `build_deck`. Replace the block starting at `avgs = bb_avgs.get(bb_name)` (`deck_builder.py:590-607`) with:

```python
        avgs = bb_avgs.get(bb_name)
        rows = _scores_for_bb(scores, bb_name)
        if avgs is None or not rows:
            continue
        ca, aa = avgs['client_avg'], avgs['atscale_avg']
        y_list = SLIDE_Y_CENTERS[slide_num]
        n = min(len(rows), len(y_list))

        update_grades_and_labels(slide, aa, ca, client_name)

        spTree = slide.shapes._spTree
        for el in [s._element for s in slide.shapes if is_placeholder_dot(s)]:
            spTree.remove(el)

        for i in range(n):
            y_top = y_list[i] - DOT_WIDTH / 2
            if rows[i].get('rating') is not None:
                add_dot(slide, score_to_x(rows[i]['rating']), y_top, CLIENT_COLOR)
            if rows[i].get('atscale') is not None:
                add_dot(slide, score_to_x(rows[i]['atscale']), y_top, ATSCALE_COLOR)
```

- [ ] **Step 5: Update the CLI `__main__`** (bottom of file, ~`deck_builder.py:619`) so the module still imports/runs. Find the `argparse` block and its `build_deck(...)` call; adapt the CLI to load the xlsx into scores via the existing `parse_self_assessment`, so the command line still works:

```python
    topics_by_bb, _ = parse_self_assessment(args.xlsx)
    scores = {bb: [{'rating': t['rating'], 'atscale': t['atscale']} for t in rows]
              for bb, rows in topics_by_bb.items()}
    data = build_deck(args.template, scores, args.client, date=args.date)
```
(Adjust variable names to the actual argparse dest names in the file.)

- [ ] **Step 6: Test the helper**:

```bash
cd dedup-v2
python3 -c "
import deck_builder as d
s={'Sales Enablement':[{'rating':3.0,'atscale':4.0},{'rating':2.0,'atscale':None}]}
a=d.bb_avgs_from_scores(s)
assert a['Sales Enablement']['client_avg']==2.5, a
assert a['Sales Enablement']['atscale_avg']==4.0, a
assert d._match_bb_name('Sales Enablement','sales  enablement')
print('OK')
"
```
Expected: `OK`.

- [ ] **Step 7: Update the `/api/deck` handler** in `server.py` (replace the xlsx block `server.py:375-390`). Read `scores` instead of `xlsx_b64`:

```python
                scores = payload.get('scores') or {}
                if not scores:
                    self._send_json(400, {"error": "assessment scores required."})
                    return
                template = os.path.join(DIR, 'templates', 'revenue_audit_template.pptx')
                tk = payload.get('takeaways') or {}
                print(f"[deck] takeaways blocks received: {list(tk.keys())}", flush=True)
                t0 = time.time()
                deck = deck_builder.build_deck(
                    template, scores, client,
                    segment=(payload.get('segment') or None),
                    date=(payload.get('date') or None),
                    roadmap=(payload.get('roadmap') or None),
                    takeaways=(payload.get('takeaways') or None))
```
Remove the now-unused `import base64` / `xlsx` lines in that handler.

- [ ] **Step 8: Commit**

```bash
git add deck_builder.py server.py
git commit -m "Assessment: deck accepts JSON scores instead of xlsx"
```

---

## Task 3: typeform-loader — assessment builder + remove debug UI

**Files:**
- Modify: `js/typeform-loader.js` (add `tfBuildAssessment`; delete `renderTypeformPanel`, `tfRenderAverages`, `tfInspectQuestion`, `tfDiagnostics`, `tfCompactResponses`, `tfFlatFields`, and their DOM)
- Modify: `js/project.js` (`renderIssuesTab` import zone ~`js/project.js:1464-1483`) — remove the Typeform panel block

**Interfaces:**
- Consumes: existing `api.typeformForm()`, `api.typeformResponses()`, `tfBuildQuestionMap()`, `tfProjectOf()`, `tfComputeAverages()`.
- Produces: `tfFetchTypeform()` → `{form, items, qmap}` (async); `tfBuildAssessment(items, projectValue, qmap)` → `{ blocks: [ {block, rows:[{fieldId, title, client}]} ], project }` where `client` is the deduped average (1 decimal) or `null`.

- [ ] **Step 1: Add `tfFetchTypeform`** in `js/typeform-loader.js` (uses the existing fetch logic; returns data instead of rendering):

```javascript
async function tfFetchTypeform() {
  const [formRes, respRes] = await Promise.all([api.typeformForm(), api.typeformResponses(1000)]);
  if (!formRes || formRes.available === false) throw new Error((formRes && formRes.error) || 'Typeform not configured.');
  if (!respRes || respRes.available === false) throw new Error((respRes && respRes.error) || 'Could not fetch responses.');
  const form = formRes.data || {};
  const items = Array.isArray((respRes.data || {}).items) ? respRes.data.items : [];
  const qmap = tfBuildQuestionMap(Array.isArray(form.fields) ? form.fields : []);
  return { form, items, qmap };
}
```

- [ ] **Step 2: Add `tfBuildAssessment`** — turns averages into ordered per-block rows:

```javascript
// Ordered per-building-block rows with the client average (Typeform) per question.
function tfBuildAssessment(items, projectValue, qmap) {
  const res = tfComputeAverages(items, projectValue, qmap);   // {blocks:{bn:{questions:[{title,avg,values}]}}}
  // Keep the form's question order per block via qmap.questions.
  const byTitle = {};
  Object.keys(res.blocks).forEach(bn => res.blocks[bn].questions.forEach(q => { byTitle[bn + ' ' + q.title] = q.avg; }));
  const blocksInOrder = [];
  const seen = {};
  qmap.questions.forEach(q => {
    if (q.type !== 'opinion_scale' && q.type !== 'rating' && q.type !== 'number') return;
    let entry = seen[q.block];
    if (!entry) { entry = seen[q.block] = { block: q.block, rows: [] }; blocksInOrder.push(entry); }
    const client = byTitle[q.block + ' ' + q.title];
    entry.rows.push({ fieldId: q.id, title: q.title, client: (client == null ? null : client) });
  });
  return { project: projectValue, blocks: blocksInOrder };
}
```

- [ ] **Step 3: Return the deduped average keyed for lookup.** Confirm `tfComputeAverages` (already present) returns `blocks[bn].questions[i].avg` as the deduped 1-decimal average — it does (Task history). No change needed; this step is a read-only verification of the interface used in Step 2.

- [ ] **Step 4: Delete the debug UI functions** from `js/typeform-loader.js`: remove `renderTypeformPanel`, `tfRenderAverages`, `tfInspectQuestion`, `tfDiagnostics`, `tfCompactResponses`, `tfFlatFields`, and `importFromTypeform`. Keep: `tfNumeric`, `tfAnswerValue`, `tfProjectOf`, `tfBuildQuestionMap`, `tfComputeAverages`, `tfDistinctProjects`, `tfEsc`, plus the new `tfFetchTypeform`/`tfBuildAssessment`.

- [ ] **Step 5: Remove the Typeform panel from the dedup import zone** in `js/project.js`. Delete the block added earlier (the `<div style="margin-top:24px;…">🔗 Import from Typeform…</div>` through its closing `</div>`, `js/project.js:1485-1495` region) so only the Excel/CSV import remains.

- [ ] **Step 6: Verify (manual, local)**:

```bash
cd dedup-v2
TYPEFORM_TOKEN=$TYPEFORM_TOKEN TYPEFORM_FORM_ID=$TYPEFORM_FORM_ID python3 server.py
```
Open http://localhost:7724, open a project → the **Deduplication** import zone shows only the Excel/CSV importer (no Typeform panel), and the browser console shows no errors (`tfFetchTypeform`/`tfBuildAssessment` are defined).

- [ ] **Step 7: Commit**

```bash
git add js/typeform-loader.js js/project.js
git commit -m "Assessment: typeform-loader exposes assessment builder, debug UI removed"
```

---

## Task 4: Assessment stage + interactive rating screen

**Files:**
- Modify: `js/project.js` (`STAGES`/`STAGE_BUILT` ~15-21; `state` ~23-49; `openProject` hydrate ~121-141; `saveProjectData` ~166-191; `renderStage` ~275-301; add `renderAssessment` + drag handlers)
- Modify: `css/style.css` (append rating-axis styles)

**Interfaces:**
- Consumes: `tfFetchTypeform()`, `tfBuildAssessment()` (Task 3).
- Produces: `state.assessment = { project, atscale: {fieldId: number}, blocks: [{block, rows:[{fieldId,title,client}]}] }`; `buildScoresPayload()` → `{block: [{rating, atscale}]}` for the deck (Task 5 consumes it).

- [ ] **Step 1: Add the stage** in `STAGES` (between `takeaways` and `roadmap`) and `STAGE_BUILT`:

```javascript
const STAGES = [
  { key: 'dedup',      label: 'Deduplication' },
  { key: 'takeaways',  label: 'Key Takeaways' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'roadmap',    label: 'Roadmap' },
  { key: 'deck',       label: 'Final Deck' },
];
const STAGE_BUILT = { dedup: true, takeaways: true, assessment: true, roadmap: true, deck: true };
```

- [ ] **Step 2: Add assessment state** to the `state` object:

```javascript
  // Assessment module: chosen Typeform project, cached client rows per block,
  // and manual Atscale values keyed by Typeform field id.
  assessment: { project: '', blocks: [], atscale: {} },
  asBlockIdx: 0,
  asTypeform: null,        // {items, qmap} cached after fetch, not persisted
```

- [ ] **Step 3: Hydrate on load** in `openProject` (after the roadmap hydration, ~`js/project.js:138`):

```javascript
    const asmt = d.assessment || {};
    state.assessment = {
      project: asmt.project || '',
      blocks: Array.isArray(asmt.blocks) ? asmt.blocks : [],
      atscale: asmt.atscale || {},
    };
    state.asBlockIdx = 0;
    state.asTypeform = null;
```

- [ ] **Step 4: Persist on save** — add to the `saveProjectData` payload (after the `roadmap` object, `js/project.js:184`):

```javascript
    assessment: {
      project: state.assessment.project,
      blocks: state.assessment.blocks,
      atscale: state.assessment.atscale,
    },
```

- [ ] **Step 5: Route the stage** in `renderStage` (add before the `deck` branch, ~`js/project.js:293`):

```javascript
  if (state.stage === 'assessment') {
    document.getElementById('actionRow').style.display = 'none';
    renderAssessment();
    return;
  }
```

- [ ] **Step 6: Add the rating styles** to `css/style.css`:

```css
/* Assessment rating rows */
.as-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--border);}
.as-title{flex:0 0 42%;font-size:13px;}
.as-axis{position:relative;flex:1 1 0;height:24px;cursor:pointer;}
.as-track{position:absolute;top:11px;left:0;right:0;height:2px;background:var(--border);}
.as-tick{position:absolute;top:6px;width:1px;height:12px;background:var(--border);}
.as-dot{position:absolute;top:2px;width:18px;height:18px;border-radius:50%;transform:translateX(-50%);}
.as-dot-client{background:#DDC7C7;}
.as-dot-atscale{background:#BDD3F3;border:1px solid #6f93c8;cursor:grab;}
.as-dot-atscale:active{cursor:grabbing;}
.as-val{flex:0 0 84px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;color:var(--muted);}
```

- [ ] **Step 7: Implement `renderAssessment`** (project picker + block tabs + rows). Add to `js/project.js`:

```javascript
async function renderAssessment() {
  const panel = document.getElementById('mainPanel');
  const a = state.assessment;

  // If no project chosen yet, or no cached blocks, show the fetch/pick UI.
  if (!a.project || !a.blocks.length) {
    panel.innerHTML = `
      <div class="tk-wrap">
        <h2 class="tk-title">Assessment</h2>
        <p class="tk-sub">Pull the self-assessment responses from Typeform, pick the project,
           then position the Atscale score on each row.</p>
        <button class="btn-primary" id="asFetchBtn" onclick="assessmentFetch()">Fetch responses</button>
        <div id="asPick" style="margin-top:14px;"></div>
      </div>`;
    return;
  }
  renderAssessmentBoard();
}

async function assessmentFetch() {
  const btn = document.getElementById('asFetchBtn');
  const pick = document.getElementById('asPick');
  btn.disabled = true; pick.textContent = 'Fetching…';
  try {
    const { items, qmap } = await tfFetchTypeform();
    state.asTypeform = { items, qmap };
    const projects = tfDistinctProjects(items);
    pick.innerHTML = `
      <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:4px;">Project</label>
      <select id="asProject" class="filter-select" style="min-width:260px;">
        <option value="">— Select a project —</option>
        ${projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
      </select>
      <button class="btn-primary" style="margin-left:10px;" onclick="assessmentPick()">Load</button>`;
  } catch (e) {
    pick.innerHTML = `<span style="color:var(--red)">${escapeHtml(e.message)}</span>`;
  } finally { btn.disabled = false; }
}

function assessmentPick() {
  const sel = document.getElementById('asProject');
  const project = sel ? sel.value : '';
  if (!project || !state.asTypeform) return;
  const built = tfBuildAssessment(state.asTypeform.items, project, state.asTypeform.qmap);
  state.assessment.project = project;
  state.assessment.blocks = built.blocks;   // [{block, rows:[{fieldId,title,client}]}]
  state.asBlockIdx = 0;
  saveProjectData(true);
  renderAssessmentBoard();
}
```

- [ ] **Step 8: Implement `renderAssessmentBoard`** (tabs + rows with dots):

```javascript
function renderAssessmentBoard() {
  const panel = document.getElementById('mainPanel');
  const a = state.assessment;
  const blocks = a.blocks;
  const idx = Math.min(state.asBlockIdx, blocks.length - 1);
  const blk = blocks[idx];

  const tabs = blocks.map((b, i) =>
    `<button class="tk-tab ${i === idx ? 'active' : ''}" onclick="state.asBlockIdx=${i};renderAssessmentBoard()">${escapeHtml(b.block)}</button>`
  ).join('');

  const rows = blk.rows.map(r => {
    const at = a.atscale[r.fieldId];
    const clientPct = r.client == null ? null : ((r.client - 1) / 4) * 100;
    const atPct = at == null ? null : ((at - 1) / 4) * 100;
    const ticks = [0, 25, 50, 75, 100].map(p => `<div class="as-tick" style="left:${p}%"></div>`).join('');
    return `
      <div class="as-row">
        <div class="as-title">${escapeHtml(r.title)}</div>
        <div class="as-axis" data-field="${escapeHtml(r.fieldId)}" onpointerdown="asAxisDown(event)">
          <div class="as-track"></div>${ticks}
          ${clientPct == null ? '' : `<div class="as-dot as-dot-client" style="left:${clientPct}%"></div>`}
          ${atPct == null ? '' : `<div class="as-dot as-dot-atscale" style="left:${atPct}%"></div>`}
        </div>
        <div class="as-val">C ${r.client == null ? '–' : r.client.toFixed(1)} · A ${at == null ? '–' : at.toFixed(1)}</div>
      </div>`;
  }).join('');

  const cAvg = avgOf(blk.rows.map(r => r.client));
  const aAvg = avgOf(blk.rows.map(r => a.atscale[r.fieldId]));
  panel.innerHTML = `
    <div class="tk-wrap">
      <h2 class="tk-title">Assessment — ${escapeHtml(a.project)}</h2>
      <div class="tk-tabs">${tabs}</div>
      <div style="font-size:12px;color:var(--muted);margin:10px 0;">
        Block average — client ${cAvg == null ? '–' : cAvg.toFixed(1)} · Atscale ${aAvg == null ? '–' : aAvg.toFixed(1)}
        · <span style="color:#DDC7C7">●</span> client (fixed) <span style="color:#6f93c8">●</span> Atscale (drag)
      </div>
      ${rows}
    </div>`;
}

function avgOf(xs) {
  const v = xs.filter(x => x != null);
  return v.length ? v.reduce((a, c) => a + c, 0) / v.length : null;
}
```

- [ ] **Step 9: Implement drag handlers** (`asAxisDown` sets/drags the blue dot; continuous decimal in [1,5]):

```javascript
let _asDrag = null;   // {field, axisEl}

function asScoreFromEvent(axisEl, e) {
  const rect = axisEl.getBoundingClientRect();
  let pct = (e.clientX - rect.left) / rect.width;
  pct = Math.max(0, Math.min(1, pct));
  return 1 + pct * 4;                 // 1..5, continuous
}

function asAxisDown(e) {
  const axisEl = e.currentTarget;
  const field = axisEl.getAttribute('data-field');
  _asDrag = { field, axisEl };
  state.assessment.atscale[field] = round1(asScoreFromEvent(axisEl, e));
  axisEl.setPointerCapture(e.pointerId);
  axisEl.addEventListener('pointermove', asAxisMove);
  axisEl.addEventListener('pointerup', asAxisUp, { once: true });
  renderAssessmentBoard();
}

function asAxisMove(e) {
  if (!_asDrag) return;
  const el = document.querySelector(`.as-axis[data-field="${CSS.escape(_asDrag.field)}"] .as-dot-atscale`);
  const axis = document.querySelector(`.as-axis[data-field="${CSS.escape(_asDrag.field)}"]`);
  const score = round1(asScoreFromEvent(axis, e));
  state.assessment.atscale[_asDrag.field] = score;
  if (el) el.style.left = ((score - 1) / 4 * 100) + '%';   // move without full re-render
}

function asAxisUp() {
  _asDrag = null;
  saveProjectData();          // debounced persist
  renderAssessmentBoard();    // refresh averages + value labels
}

function round1(x) { return Math.round(x * 10) / 10; }
```

- [ ] **Step 10: Verify (manual, staging).** Push to `dev`, open the staging URL, go to a project → **Assessment** → Fetch responses → pick the project → confirm: pink dots sit at the client averages; clicking/dragging on a row places/moves the blue dot with a live decimal value; block averages update; switching block tabs works; reloading the project keeps the Atscale values.

```bash
git add js/project.js css/style.css
git commit -m "Assessment: interactive rating step (fixed client + draggable Atscale)"
git push origin dev
```

---

## Task 5: Rewire the deck step (drop Excel, send scores)

**Files:**
- Modify: `js/project.js` (`renderDeck` ~1224-1257; `generateDeck` ~1310-1354; add `buildScoresPayload`; remove `onDeckFile`/`_deckXlsx`)

**Interfaces:**
- Consumes: `state.assessment` (Task 4).
- Produces: `buildScoresPayload()` → `{ "<block>": [ {rating, atscale}, ... ] }` in row order.

- [ ] **Step 1: Add `buildScoresPayload`** in `js/project.js`:

```javascript
// Assessment → deck scores: per building block, rows in order with client rating
// (Typeform) and Atscale (manual). Missing values pass as null.
function buildScoresPayload() {
  const a = state.assessment;
  const out = {};
  (a.blocks || []).forEach(b => {
    out[b.block] = b.rows.map(r => ({
      rating:  r.client == null ? null : r.client,
      atscale: a.atscale[r.fieldId] == null ? null : a.atscale[r.fieldId],
    }));
  });
  return out;
}
```

- [ ] **Step 2: Replace `renderDeck`** — remove the file input, enable generation when assessment data exists:

```javascript
function renderDeck() {
  const panel = document.getElementById('mainPanel');
  document.getElementById('actionRow').style.display = 'none';
  const hasScores = (state.assessment.blocks || []).length > 0;
  panel.innerHTML = `
    <div class="deck-wrap">
      <h2 class="tk-title">Generate the deck</h2>
      <p class="tk-sub">The Diagnosis Synthesis slides are filled from the Assessment step
         (client dots from Typeform, Atscale dots you positioned). The deck downloads as a .pptx.</p>
      <div class="deck-form">
        <label class="deck-field">
          <span>Client name</span>
          <input id="deckClient" type="text" placeholder="e.g. Horizons Optical" value="${escapeHtml(PROJECT.name || '')}">
        </label>
        <div class="deck-row">
          <label class="deck-field">
            <span>Date <em>(optional)</em></span>
            <input id="deckDate" type="text" placeholder="e.g. June 2026">
          </label>
        </div>
        <button class="btn-primary" id="deckGenBtn" onclick="generateDeck()" ${hasScores ? '' : 'disabled'}>Generate deck</button>
        <span class="action-hint" id="deckHint">${hasScores ? 'Ready to generate.' : 'Complete the Assessment step first.'}</span>
      </div>
    </div>`;
}
```

- [ ] **Step 3: Update `generateDeck`** — drop the xlsx guard/field, send `scores`:

```javascript
async function generateDeck() {
  const client = document.getElementById('deckClient').value.trim();
  const btn = document.getElementById('deckGenBtn');
  const hint = document.getElementById('deckHint');
  if (!client) { hint.textContent = 'Enter a client name first.'; return; }
  const scores = buildScoresPayload();
  if (!Object.keys(scores).length) { hint.textContent = 'Complete the Assessment step first.'; return; }

  btn.disabled = true; hint.textContent = 'Generating…';
  try {
    const res = await fetch('/api/deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        client,
        segment: null,
        date: document.getElementById('deckDate').value.trim(),
        scores,
        roadmap: buildRoadmapPayload(),
        takeaways: buildTakeawaysPayload(),
      }),
    });
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { msg = (await res.json()).error || msg; } catch {} throw new Error(msg); }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.href = url; el.download = m ? m[1] : 'deck.pptx';
    document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url);
    hint.textContent = '✓ Deck downloaded.';
  } catch (err) {
    hint.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
```

- [ ] **Step 4: Delete `onDeckFile` and the `_deckXlsx` variable** (`js/project.js:1222`, `1259-1274`) — no longer referenced.

- [ ] **Step 5: Verify end-to-end (staging).** Push to `dev`. On staging: complete Assessment (fetch + set a few Atscale dots) → go to **Final Deck** → enter a client name → **Generate deck**. Open the downloaded `.pptx`: each Diagnosis Synthesis slide shows pink dots at the client scores and blue dots at the Atscale scores in the correct rows; per-block grades match; rows without an Atscale show only the pink dot.

```bash
git add js/project.js
git commit -m "Assessment: deck step sends JSON scores, Excel upload removed"
git push origin dev
```

---

## Self-Review notes
- **Spec coverage:** flow/placement (Task 4 Step 1), computation reuse (Task 3), rating UI (Task 4), persistence (Task 1 + Task 4 Steps 3-4), deck JSON scores + Excel removal (Task 2 + Task 5), cleanup of debug UI (Task 3). Edge cases: count mismatch capped via `min` (Task 2 Step 4); missing client/atscale → dot skipped (Task 2 Step 4, Task 5 Step 1); block-name fuzzy match (`_match_bb_name`, Task 2).
- **Open follow-up (not blocking):** a visible warning when a block's row count ≠ template rows is described in the spec; if desired, add a small notice in `renderAssessmentBoard` comparing `blk.rows.length` to the known slide row counts — optional, deferred.
