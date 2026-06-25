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
