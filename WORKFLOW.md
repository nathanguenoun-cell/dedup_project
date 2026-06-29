# Dev / Test / Prod workflow

Two tracks so new features never break production:

| Branch | Railway service | URL | DB (Volume) | Purpose |
|---|---|---|---|---|
| `main` | **dedup** (existing) | prod URL | `/data` real data | Live, what partners use |
| `dev`  | **dedup-staging** (new) | staging URL | `/data` throwaway data | Build + test features |

`dev` auto-deploys to staging. `main` auto-deploys to prod. You only merge
`dev → main` once a feature works on staging.

---

## One-time Railway setup (do this once, in the Railway dashboard)

1. Open your Railway project → **New** → **GitHub Repo** → pick the same
   `dedup_project` repo. This creates a second service.
2. Rename it to **dedup-staging** (Settings → Service name).
3. **Settings → Source → Branch**: set it to `dev` (NOT main). This is the key
   step — it makes staging track the `dev` branch.
4. **Add a Volume** mounted at `/data` (Settings → Volumes). This is a *separate*
   volume from prod, so test data never touches real data.
5. **Variables**: copy the same env vars as prod (`DATA_DIR=/data`, `DEDUP_SECRET`,
   `COOKIE_SECURE=1`, API keys, etc.). Use a **different** `DEDUP_SECRET` and,
   if you want to avoid burning API credits, you can omit `ANTHROPIC_API_KEY`
   to run staging in mock mode.
6. (Optional) Set `ENV_NAME=staging` so the app shows a "STAGING" banner.
7. Deploy. You now have a staging URL that updates every time you push to `dev`.

> Prod (`main` → dedup service) is unchanged. Don't touch its branch or volume.

---

## Daily flow (every feature)

```bash
# 1. Start from the latest dev
git checkout dev
git pull

# 2. Build your feature, committing as you go
#    (optionally on a feature branch: git checkout -b feat/x, then merge to dev)

# 3. Test locally first (fast loop)
python3 server.py            # http://localhost:7724  (mock mode, no API cost)
# or with real LLM:  ANTHROPIC_API_KEY=sk-ant-... python3 server.py

# 4. Push to dev → Railway auto-deploys to the STAGING url
git push

# 5. Test on the staging URL like a real user. If broken, fix on dev and push again.

# 6. When it works, ship to production:
git checkout main
git pull
git merge dev
git push                     # Railway auto-deploys to PROD
git checkout dev             # go back to dev for the next feature
```

## Rules of thumb
- **Never commit directly to `main`.** All work happens on `dev` first.
- A feature is "done" only after it works on the **staging URL**, not just locally.
- If a deploy breaks prod: `git revert <bad-commit>` on main and push — Railway
  redeploys the previous good state. The Volume DB is untouched by reverts.
- Keep `dev` and `main` close: merge to `main` often so they don't drift.
</content>
