# Assessment step — Typeform scores + manual Atscale → deck

**Date:** 2026-07-20
**Status:** Approved design (pre-implementation)

## Context & goal

The Revenue Audit deck has, per building block, ~20 sub-block "topic" rows, each
shown with two assessment dots: **pink = client self-assessment** and **blue =
Atscale**. Today those scores come from an uploaded Excel `Dashboard` sheet
([deck_builder.py:100](../../../deck_builder.py) `parse_self_assessment`), and
dots are placed **by row order** — `topics[i]` → `SLIDE_Y_CENTERS[slide][i]`
([deck_builder.py:604](../../../deck_builder.py)).

We now source the **client** score from a connected **Typeform** form (already
wired: [js/typeform-loader.js](../../../js/typeform-loader.js) computes the
average client score per question, grouped by building block), and let the user
set the **Atscale** score manually in a new in-app screen that reproduces the
rating slides. Both feed the deck; the Excel upload is removed.

Key fact that makes this clean: the deck has **163 dot rows** (20 per slide, 23
on slide 10) and Typeform has **163 numeric questions** → 1:1 mapping, **by order
within each building block** (the form was built to mirror the deck).

## Scope

In scope:
- New **Assessment** stage between **Key Takeaways** and **Roadmap**.
- Move the Typeform fetch + per-question averaging out of the dedup import zone
  into the Assessment step; remove the Typeform debug UI (diag banner, question
  inspector, raw JSON dumps, averages tables).
- Interactive rating screen: per building block, one row per sub-block with a
  1→5 axis, a fixed pink dot at the Typeform client average, and a draggable blue
  dot (continuous/decimal) for Atscale.
- Persist the assessment (chosen Typeform project + per-sub-block client/atscale).
- Change deck generation to accept JSON scores instead of an Excel upload.

Out of scope:
- Changing the dedup → Key Takeaways → Roadmap flow itself.
- Any second Typeform series for Atscale (Atscale is manual only).

## Design

### 1. Flow & placement
Add an `assessment` stage to the stepper in
[js/project.js](../../../js/project.js) (`STAGES`), ordered:
`dedup → keyTakeaways → assessment → roadmap → deck`. The Typeform panel
currently in the dedup import zone ([js/project.js](../../../js/project.js)
`renderIssuesTab`) moves into the Assessment step. Its debug tooling is deleted.

### 2. Data source & computation (reuse)
Reuse [js/typeform-loader.js](../../../js/typeform-loader.js):
`tfComputeAverages()` already returns, per building block, an ordered list of
questions with a client average (1 decimal, deduped one value per response). The
Assessment step:
1. Fetches the form + responses (existing `/api/typeform/*` endpoints).
2. Lets the user pick the **project** (existing `hidden.t` dropdown).
3. Builds per building block an ordered row list `{fieldId, title, client}` from
   the averages, and merges any previously saved `atscale` values.

### 3. Rating screen (reproduce slides)
One tab per building block (pattern mirrors the Key Takeaways per-block tabs).
Each row:
- Left: the sub-block title.
- A horizontal **1→5 axis** (reuse the deck's mental model; pink `#DDC7C7`,
  blue `#BDD3F3` — `CLIENT_COLOR`/`ATSCALE_COLOR` from deck_builder).
- **Pink dot**: fixed at the client average (decimal), not draggable.
- **Blue dot**: draggable via pointer events, continuous decimal value in [1,5].
  No blue dot until the user first clicks/drops on the row; first click places it
  at the clicked position.
- Per-block averages (client + Atscale) shown and recomputed live.

### 4. Persistence
New JSON column `project_data.assessment` (idempotent `ALTER TABLE`, same pattern
as `takeaways`/`roadmap` in [db.py](../../../db.py)). Shape:
```json
{
  "project": "<typeform hidden.t value>",
  "rows": [
    {"fieldId": "4YKaHx8dxbVP", "title": "Process for headcount planning",
     "block": "Sales Hiring & Ramp-Up", "client": 3.4, "atscale": 4.0}
  ]
}
```
`client` is cached from Typeform (so the deck is reproducible without re-fetch);
`atscale` is the manual value (absent until set). Saved through the existing
`PUT /api/projects/{id}/data` path (`_save_data` in
[api_handlers.py](../../../api_handlers.py), `save_project_data` in
[db.py](../../../db.py)).

### 5. Deck generation
- `/api/deck` ([server.py](../../../server.py)) accepts `scores` (JSON) instead of
  `xlsx_b64`. Shape: `{ "<building block name>": [ {"rating": 3.4, "atscale": 4.0}, … ] }`,
  each list in row order.
- `build_deck(...)` ([deck_builder.py:561](../../../deck_builder.py)) replaces
  `parse_self_assessment(xlsx)` with the provided `scores`; computes `bb_avgs`
  server-side (mean rating / mean atscale per block, 1 decimal); maps each block
  name to its slide via the existing `_match_bb`; places pink=rating,
  blue=atscale **by order** (unchanged placement loop). Rows without an `atscale`
  get only the pink dot.
- Frontend deck step: remove the Excel upload; build the `scores` payload from the
  saved `assessment`.

### 6. Cleanup
Remove from the dedup import zone: the Typeform "Fetch responses" panel and all
debug UI (`diag`, inspector, `Debug — raw structure` dumps, averages tables).
Keep the reusable computation (`tfComputeAverages`, `tfProjectOf`, question map)
in `typeform-loader.js`; it now serves the Assessment step.

## Edge cases
- **Row/topic count mismatch**: if a Typeform building block has more/fewer
  questions than the slide's dot rows (`SLIDE_Y_CENTERS`), cap at the minimum and
  show a warning in the Assessment step. (build_deck already caps with `min`.)
- **No responses for the project / no client average**: render the row without a
  pink dot; it still accepts an Atscale.
- **Atscale not set**: allowed. Deck generation proceeds; such rows get no blue
  dot. Block Atscale average is computed over the rows that have one.
- **Building block name mismatch** between Typeform group titles and
  `SLIDE_BB_MAP`: handled by the existing fuzzy `_match_bb`.

## Verification
- Fetch a real Typeform project in the Assessment step → pink dots land at the
  computed client averages; drag blue dots → values update; block averages
  recompute.
- Reload the project → saved Atscale values and client cache persist.
- Generate the deck → open the PPTX: each building-block slide shows pink dots at
  client scores and blue dots at the Atscale scores in the correct rows; per-block
  grades match; no Excel upload was required.
- A block with a count mismatch shows the warning and still generates (capped).
