---
name: Microdrama LLM provider choice
description: User selected BUAT SIMPEL for the automatic microdrama brain.
---

Use BUAT SIMPEL as the LLM provider for the proposed automatic microdrama workflow.

**Why:** The user explicitly said “nah iya gw ingin menggunakan mereka untuk otak nya” after reviewing BUAT SIMPEL's public API information.

**How to apply:** Preserve this provider choice when scoping or implementing the microdrama workflow. This does not select a specific underlying model or authorize paid generation.

The microdrama workflow belongs in the existing XclipAI Telegram bot, not a standalone web app.

**Why:** The user selected “Bot Telegram XclipAI” when asked where the workflow should run.

**How to apply:** Scope the user-facing workflow inside the existing bot.

Release the initial microdrama feature to admins only.

**Why:** The user selected “Khusus admin dulu (recommended)” when asked who should have initial access.

**How to apply:** Enforce the bot's existing admin authorization on commands and callbacks. Do not expose the feature publicly or add customer saldo charges without a separate decision.

The intended output is an AI drama episode from 1 minute minimum to 20 minutes maximum, not a twenty-second finished product.

**Why:** After discussing longer episodes, the user revised the duration explicitly: “1 menit minimal sampai 20 menit”.

**How to apply:** Accept episode durations of 1–20 minutes. Treat shorter clips as technical tests or constituent shots; do not present the two-clip prototype as the finished episode workflow.

The user wants the LLM to act as a professional director, handling prompts and image consistency, not merely writing dialogue.

**Why:** The user clarified: “gw ingin si LLM nya jadi sutradara profesional masalah prompt dll konsistensi gambar dan lain nya”.

**How to apply:** Center future design on episode-level creative direction, shot prompts and visual continuity. Distinguish the requested outcome from unverified guarantees: prompt text alone cannot enforce face/voice identity, and automated visual review needs tested vision capability.
