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

   Railway injects `PORT` automatically; the server binds it on `0.0.0.0`.

## Architecture

- `server.py` — HTTP server, static files, `/api/*` routing, `/api/messages` LLM proxy.
- `db.py` — SQLite schema + helpers (`users`, `projects`, `project_members`, `project_data`).
- `auth.py` — pbkdf2 password hashing + signed session cookies.
- `api_handlers.py` — auth + project endpoints.
- `js/` — `api.js`, `router.js`, `auth.js`, `dashboard.js`, `project.js` + pipeline
  (`stage1-prefilter.js`, `stage2-llm.js`, `stage3-cluster.js`, `file-loader.js`).
