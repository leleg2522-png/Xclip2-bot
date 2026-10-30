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

**Why:** This demonstrates Indonesian spoken dialogue in actual output, not merely the presence of an audio track. It does not establish frame-perfect lip-sync, multi-character consistency, or voice identity across longer episodes.

**How to apply:** Native dialogue is a viable option for a short prototype; still inspect synchronization and voice continuity before promising production readiness. The tested key can quote and generate even though the account-balance endpoint returns a permission-specific 403; that response alone does not mean the generation key is invalid.
