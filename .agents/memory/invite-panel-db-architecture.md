---
name: invite-panel two-DB architecture
description: Why the invite-panel splits panel state (local) from the configurable Railway target DB, and how the target connection string is stored
---

# Invite-panel: local vs target DB split

The invite automation panel talks to **two** Postgres databases:

- **Local pool** = Replit Postgres (`DATABASE_URL`). Owns the panel's own
  state: `invite_jobs` and `app_settings`. Always available so the panel works
  out of the box with zero config.
- **Target pool** = the bot's Railway Postgres. Owns `picsart_credentials`,
  the pool that successful refresh tokens get inserted into. Its connection
  string is **operator-configurable from the panel UI** (PUT `/settings/db`),
  stored encrypted in `app_settings.railway_db_url`, with `RAILWAY_DATABASE_URL`
  env as a fallback.

**Why the split (not one DB):** the target Railway DB string must be settable
from the UI, but you cannot store "which DB to use" inside that same target DB
(chicken-and-egg). So the setting lives in the always-present local DB. This
also means the panel never breaks just because the Railway string is missing or
wrong — only token-pooling (`insertRefreshToken`) needs the target.

**How to apply / gotchas:**
- The target connection string contains a DB password → it is AES-encrypted
  (crypto.ts) at rest in `app_settings`, and API responses only ever return a
  **masked** URL (password → `****`). Never return the raw string to the client.
- `getTargetPool()` is cached by URL and recreated (old pool `end()`-ed) when
  the setting changes; it runs `CREATE TABLE IF NOT EXISTS picsart_credentials`
  (no-op if the bot already created it).
- Saving via PUT runs a real `SELECT 1` connection test first, then surfaces any
  target-init/schema failure as `ok:false` rather than silently succeeding.
- Do NOT store the DB connection string or the encryption key as a tracked
  shared env var — those land in plaintext in `.replit` (git-tracked).
  Connection string belongs in the panel setting (encrypted); secrets belong in
  Replit Secrets.
