---
name: Telegram bot session resets ("login mulu")
description: Why in-memory Telegram logins kept wiping, and the guardrails that prevent it
---

# In-memory sessions get wiped by process crashes

The bot stores login/session state in an in-memory `Map` (no DB persistence). Any
uncaught error in a command handler crashes the Node process; Railway then
restarts it and **every** in-memory session is lost, so users are forced to
`/login` again — perceived as "login mulu" (forced to log in repeatedly).

**Why:** the entrypoint called `bot.launch()` with no `bot.catch()` and no
`process.on('unhandledRejection' | 'uncaughtException')`. A single failing reply
took down the whole bot.

**Trigger seen in the wild:** replying with `parse_mode: 'Markdown'` while
interpolating free-text account labels (emails containing `_`) → Telegram 400
"can't parse entities" → unhandled rejection → crash.

**How to apply:**
- Keep the global guards (`bot.catch` + the two `process.on` handlers) in place.
- Never interpolate user/free-text into a `parse_mode: 'Markdown'` reply without
  escaping the legacy control chars `_ * [ ] ``` `` ``` (helper: `mdEscape`).
- If forced logouts must survive legitimate redeploys too, the real fix is to
  persist sessions in the DB keyed by Telegram user id (not yet implemented).
- Any list reply (pool, credits) must be chunked: Telegram caps a single message
  at 4096 chars and the pool is 150+ accounts. Use `replyLong()` (packs lines
  under a safe limit, sends multiple messages) instead of one `ctx.reply`.

# A pg Pool with no 'error' listener also crashes the process

Separate from handler errors: the `pg` `Pool` emits an `'error'` event when an
**idle** pooled client's socket dies (managed DBs like Railway recycle idle TCP
connections). With **no** `db.on('error', ...)` listener, Node treats it as an
unhandled `'error'` event and crashes the process — same "login mulu" outcome.

**Why it bit us:** a Kling generation polls the DB every ~5s for up to ~15 min.
Over that window the connection gets dropped → `Connection terminated
unexpectedly` / `stream has been aborted` (both are pg connection-drop errors,
not query errors), surfacing as a generation failure.

**How to apply:**
- Always attach `db.on('error', ...)` and set `keepAlive: true` on the Pool.
- Wrap `db.query` in a retry helper that retries **only** on transient
  connection-drop signatures; rethrow real query/logic errors immediately.
- Retry is only safe for idempotent statements (SELECT / token UPDATE /
  `ON CONFLICT` upsert / DELETE-by-id). A bare `INSERT ... RETURNING` (e.g.
  `addRefreshToken`) must **bypass** the retry — a post-commit drop would
  duplicate the row. Duplicates ≠ account loss, but avoid them.
- **Never couple transient DB/network errors to account discard/dead logic.**
  Accounts are removed only on `PICSART_SUBMIT_FAILED`+credit-pattern
  (`discardAccount` DELETE) or oauth refresh HTTP 400/401/403 (mark `dead`).
  A dropped connection must never reach either gate.

# Signal handlers that call bot.stop() can crash on shutdown

`Telegraf.stop()` throws `Error: Bot is not running!` **synchronously** if
`bot.launch()` never fully completed (e.g. startup delayed by a network/DB
outage) or if it was already stopped. Called bare inside
`process.once('SIGTERM'|'SIGINT', () => bot.stop(sig))`, that throw becomes an
uncaughtException during shutdown — noisy, and the exact "crash on restart"
pattern that wipes in-memory logins.

**How to apply:** always wrap `bot.stop(sig)` in try/catch inside the signal
handler; a shutdown attempt must never throw.
