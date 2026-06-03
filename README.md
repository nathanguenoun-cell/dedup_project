# Deduplication Platform

Collaborative, multi-user deduplication tool for operating partners. Pure Python
stdlib backend (no dependencies) + static frontend. 3-stage pipeline:
local similarity pre-filter → semantic LLM grouping → union-find clustering.

## Run locally

```bash
cd dedup-v2
# Mock mode (fake LLM responses, for UI testing):
python3 server.py
# Real mode:
ANTHROPIC_API_KEY=sk-ant-... python3 server.py
```

Open http://localhost:7724 → create an operating-partner account → create a project →
import an Excel/CSV → run analysis → review duplicates → export the clean CSV.

## Deploy on Railway

1. Push this folder to a Git repo and create a Railway project from it
   (Nixpacks auto-detects Python; start command `python3 server.py`).
2. **Add a Volume** mounted at `/data` (the SQLite DB must persist across deploys).
3. Set environment variables:
   | Variable | Value | Purpose |
   |---|---|---|
   | `DATA_DIR` | `/data` | where `dedup.db` lives (the mounted Volume) |
   | `DEDUP_SECRET` | a long random string | stable session-signing secret |
   | `COOKIE_SECURE` | `1` | mark the session cookie `Secure` (Railway serves HTTPS) |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | enables real LLM calls (omit → mock mode) |
   | `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | optional model override |
   | `VOYAGE_API_KEY` | `pa-...` | **semantic embeddings** (recommended) — catches duplicates worded differently |
   | `OPENAI_API_KEY` | `sk-...` | alternative embeddings provider (used only if `VOYAGE_API_KEY` is unset) |
   | `EMBEDDING_MODEL` | `voyage-3.5` / `text-embedding-3-small` | optional embeddings model override |

   Railway injects `PORT` automatically; the server binds it on `0.0.0.0`.

   **Embeddings** power semantic candidate detection (Stage 0/1). Without an embeddings
   key the app still works but falls back to lexical-only matching (lower recall). Voyage
   is Anthropic's recommended embeddings partner.

## Architecture

- `server.py` — HTTP server, static files, `/api/*` routing, `/api/messages` LLM proxy, `/api/embeddings` proxy.
- `db.py` — SQLite schema + helpers (`users`, `projects`, `project_members`, `project_data`).
- `auth.py` — pbkdf2 password hashing + signed session cookies.
- `api_handlers.py` — auth + project endpoints.
- `js/` — `api.js`, `router.js`, `auth.js`, `dashboard.js`, `project.js` + the dedup pipeline.

### Duplicate-detection pipeline (per building block)
0. **Embeddings** (`embeddings.js` → `/api/embeddings`) — dense semantic vector per issue.
1. **Candidates** — pairs = embedding-cosine ∪ lexical (`stage1-prefilter.js`); semantic
   recall catches duplicates with different wording, lexical is the fallback/complement.
2. **Clustering** (`stage2-llm.js`) — one LLM call per block groups issues into clusters.
3. **Verification** (`verify.js`) — low-confidence or large clusters are re-checked and
   split/trimmed by a second LLM call (precision).
4. **Finalize** (`stage3-cluster.js`) — dedupe membership, pick the richest row as keeper.
