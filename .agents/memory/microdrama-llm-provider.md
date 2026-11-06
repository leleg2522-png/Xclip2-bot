---
name: Microdrama LLM provider choice
description: User selected Botelexkey and its claude-fable-5.1 alias for the microdrama brain, replacing BUAT SIMPEL.
---

Use Botelexkey with its `claude-fable-5.1` model alias as the requested
microdrama LLM provider, superseding the earlier BUAT SIMPEL choice.

**Why:** The user supplied `https://botelexkey.store/#models` and explicitly
requested “coba ganti LLM ke sini pake model ai claude fable 5,1”.

**How to apply:** Change only the microdrama/director LLM, not the video model.
The provider's public catalog lists this alias; that does not independently
verify the identity of its upstream model or successful director/vision output.
Use a separate credential for this provider; never forward BUAT SIMPEL's key
to the new domain. Preserve explicit failures rather than silently reverting
to the old provider or another model.

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

When supplied artwork suffers identity or style drift, obtain approval of the corrected opening frame before animating it again.

**Why:** A redraw changed a semi-realistic graphite character into a large-eyed anime character despite identity-preservation wording. The user explicitly requested following the original image, then approved a direct source-artwork crop as the replacement animation frame.

**How to apply:** Inspect whether reference crops retain the complete face. Prefer a direct source-artwork crop when the composition allows it; it preserves the actual face rather than asking a renderer to reconstruct it. Disclose tighter framing and source-resolution limits. A frame correction is not permission to submit another paid video automatically.

The user wants the AI director to be a personal agent for each user, not a shared creative context.

**Why:** The user said “si agent ai nya tuh jadi agent ai pribadi setiap user agar ga ada keliru atau aneh”.

**How to apply:** Scope personalization and conversation continuity per user, keep projects and approved references separate, and enforce ownership in code rather than relying on LLM instructions. Public access is explicitly requested, but billing and usage safeguards still need a separate decision.

The public episode price is Rp2,000 per minute, with one free, user-triggered regeneration for every 10-second clip.

**Why:** The user explicitly chose one regeneration per clip with no additional charge, accepted subsidized pricing, then changed the tariff to “2k per menit”.

**How to apply:** Show each clip for approval before proceeding; cap user-triggered regeneration at one per clip, with no additional saldo deduction. Budget worst-case provider spend before enabling public access. The user knowingly chose to subsidize provider costs; do not repeatedly ask them to justify pricing below provider cost.

Public personal-agent usage must be funded through the existing bot saldo, not unlimited owner-funded usage.

**Why:** Asked how users should pay, the user explicitly selected “Pakai saldo bot”.

**How to apply:** Integrate with existing saldo and full-refund-on-failed-delivery rules. The agent chat/story-revision allowance remains unresolved: the earlier answer “3” was not clarified or confirmed as three story revisions. Do not impose that limit or enable unrestricted public LLM use from this ambiguous answer.

Treat a successful HTTP status or short LLM probe as insufficient proof that the director workload works.

**Why:** BUAT SIMPEL returned HTTP 200 with non-JSON response bodies and later HTTP 524 for full non-streaming action-storyboard requests while a minimal completion succeeded. A provider-listed alternative alias completed the six-shot plan through streaming; the exact cause of the original alias failures was not established.

**How to apply:** Validate the actual director response and its full schema before any paid media submit. Prefer streaming for long creative requests when supported, consume content separately from reasoning deltas, and preserve sanitized failure diagnostics. Do not infer an invalid credential from a long-request timeout. A successful demonstration using another alias does not authorize changing the bot's default model. Never silently substitute a handwritten plan while claiming the selected LLM produced it.

Preserve fictional assistant output separately from transport diagnostics so a
local validation failure can be investigated and revalidated without another
billed LLM request.

**Why:** A complete Botelexkey storyboard was initially rejected because its
action description modestly exceeded an internal verbosity cap, not because
the API or credential failed. The original response could be validated after
revisiting that internal cap, without rewriting the story or resubmitting it.

**How to apply:** Distinguish provider requirements from local size budgets.
Keep bounds explicit and tested; never silently truncate creative decisions,
relax ownership/billing safeguards, or claim a short probe verifies the full
director and vision workflow. Do not retain credentials, request authorization
headers or private reasoning in diagnostic output.
