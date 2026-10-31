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

The personal AI director is intended for all users, superseding the initial admin-only rollout.

**Why:** When asked whether the personal agent should be admin-only or available to everyone, the user explicitly selected “Semua pengguna”.

**How to apply:** Design public access with strict per-user ownership and isolation. Settle user pricing and usage limits before enabling unrestricted paid-provider calls; choosing a public audience does not authorize free unlimited generation or an invented customer tariff. Keep provider/key management admin-only.

The intended output is an AI drama episode from 1 minute minimum to 20 minutes maximum, not a twenty-second finished product.

**Why:** After discussing longer episodes, the user revised the duration explicitly: “1 menit minimal sampai 20 menit”.

**How to apply:** Accept episode durations of 1–20 minutes. Treat shorter clips as technical tests or constituent shots; do not present the two-clip prototype as the finished episode workflow.

The user wants the LLM to act as a professional director, handling prompts and image consistency, not merely writing dialogue.

**Why:** The user clarified: “gw ingin si LLM nya jadi sutradara profesional masalah prompt dll konsistensi gambar dan lain nya”.

**How to apply:** Center future design on episode-level creative direction, shot prompts and visual continuity. Distinguish the requested outcome from unverified guarantees: prompt text alone cannot enforce face/voice identity, and automated visual review needs tested vision capability.

The user wants the AI director to be a personal agent for each user, not a shared creative context.

**Why:** The user said “si agent ai nya tuh jadi agent ai pribadi setiap user agar ga ada keliru atau aneh”.

**How to apply:** Scope personalization and conversation continuity per user, keep projects and approved references separate, and enforce ownership in code rather than relying on LLM instructions. Public access is explicitly requested, but billing and usage safeguards still need a separate decision.

The user set the public episode price at Rp1,500 per minute and chose one free, user-triggered regeneration for every 10-second clip.

**Why:** The user answered the episode tariff question with Rp1,500 and explicitly chose one regeneration per clip with no additional charge.

**How to apply:** Show each clip for approval before proceeding; cap user-triggered regeneration at one per clip, with no additional saldo deduction. Budget worst-case provider spend before enabling public access. The historical MiniMax quote for one 10-second video alone exceeds Rp1,500 per minute at six shots per minute, before images, transcription, LLM, or regeneration. Confirm any intentional subsidy or revise the tariff.

Public personal-agent usage must be funded through the existing bot saldo, not unlimited owner-funded usage.

**Why:** Asked how users should pay, the user explicitly selected “Pakai saldo bot”.

**How to apply:** Integrate with existing saldo and full-refund-on-failed-delivery rules. The agent chat/revision pricing or allowance remains unresolved; do not enable unrestricted public LLM use or infer unlimited free chat from the saldo payment choice.
