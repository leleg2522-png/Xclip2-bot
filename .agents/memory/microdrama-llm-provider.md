---
name: Microdrama LLM provider choice
description: User selected BUAT SIMPEL for the automatic microdrama brain.
---

Use BUAT SIMPEL as the LLM provider for the proposed automatic microdrama workflow.

**Why:** The user explicitly said “nah iya gw ingin menggunakan mereka untuk otak nya” after reviewing BUAT SIMPEL's public API information.

**How to apply:** Preserve this provider choice when scoping or implementing the microdrama workflow. This does not select a specific underlying model or authorize paid generation.

The microdrama workflow belongs in the existing XclipAI Telegram bot, not a standalone web app.

**Why:** The user selected “Bot Telegram XclipAI” when asked where the workflow should run.

**How to apply:** Scope the user-facing workflow inside the existing bot. Admin-only versus public access and billing still require a decision.
