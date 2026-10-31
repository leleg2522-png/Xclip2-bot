---
name: DeAPI account-scoped model discovery
description: Missing API models can be Premium-gated rather than absent from DeAPI.
---

Do not equate the models visible to one DeAPI API key with the provider's full catalogue.
Check both the public model page and a non-billable price request before saying a model is unavailable.

**Why:** The tested key showed only LTX and MiniMax video models, but the official public catalogue listed Seedance 2.5. A price request for its documented slug returned "This model is not available on your plan", confirming an account-plan restriction, not provider absence. The public page says access requires a first top-up.

**How to apply:** Distinguish provider offering from current key access. Use the official documented slug, never guess one or submit a paid job just to test access. Do not recommend another provider merely because a model is omitted from a free-tier list.

## MiniMax Indonesian dialogue evidence

MiniMax H3 Turbo generated two linked microdrama clips with native Indonesian speech. Independent Whisper transcription recognized both requested lines accurately; sampled frames preserved the single character and setting across a last-frame-to-next-first-frame continuation.

**Why:** This demonstrates Indonesian spoken dialogue in actual output, not merely the presence of an audio track. A subsequent two-character argument also preserved distinct faces/clothing in sampled frames, produced shoulder contact, and transcribed all requested lines. This does not establish frame-perfect lip-sync, correct speaker assignment, complex fight choreography, or voice identity across longer episodes.

**How to apply:** Native dialogue is a viable option for a short prototype; still inspect synchronization and voice continuity before promising production readiness. The tested key can quote and generate even though the account-balance endpoint returns a permission-specific 403; that response alone does not mean the generation key is invalid.

Do not promise rapid turnaround from the short output duration. Two sequential high-resolution ten-second clips took over twenty minutes in one test due to queue and processing delays.

**Why:** Provider throughput varied substantially between tests; chaining a last-frame continuation also prevents those two dependent scenes from running in parallel.

**How to apply:** Separate automation from speed guarantees. For faster episode pipelines, consider independent scenes generated in parallel from approved character references; do not describe dependent continuation scenes as parallelizable.

## Bot credential management

Manage DeAPI credentials as a pool in the bot's Railway database.

**Why:** The user explicitly requested “buatkan pool api untuk de api di DB”. A database-managed pool avoids requiring hosting-variable changes for each additional key.

**How to apply:** Preserve database-managed credential selection when changing the microdrama renderer. Keep accepted jobs tied to their original account; adding or disabling a pool key must not move an existing paid job to another account.

## Generation rate limits versus credit balance

A successful price quote does not establish that a video submit has available quota. A repeated HTTP 429 after a minute-scale cooldown may be a daily limit, not exhausted credits.

**Why:** An authorized animation revision was rejected twice with 429 despite a two-minute delay while its price quote succeeded. Official limits documentation lists separate price/status buckets and both minute and rolling-day generation windows; Basic MiniMax H3 is documented at three video requests per day.

**How to apply:** Consult https://docs.deapi.ai/limits-and-quotas and the effective response headers rather than hard-coding a short cooldown or assuming a midnight reset. Retain Retry-After and daily-reset diagnostics on rejected submits. Do not infer the account tier or exhausted balance from HTTP 429 alone, or rotate an already accepted job to another account.
