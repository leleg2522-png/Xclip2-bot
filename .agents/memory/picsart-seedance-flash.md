---
name: Picsart Seedance 2.5 Flash references
description: Official Flash API fields, documented limits, and the boundary of live Playground evidence.
---

The official Picsart Seedance 2.5 Flash API documentation supports output duration up to 30 seconds and lists `imageUrls` (up to 10), `videoUrls` (up to 5), and `audioUrls` (up to 5), with a per-reference video/audio ceiling of 30.2 seconds. The documented task type values are `auto`, `reference`, `edit`, and `extend`.

The user chose 30-second Flash output at Rp6,000 for text-only and all reference modes. The captured AI Playground model-v1 HAR confirms only the original 5-second, 15-credit text-to-video contract and one `imageUrls` reference; it does not contain Flash video/audio requests. The public API docs establish model fields and limits, but not by themselves that the Playground gateway route has identical behavior for every modality.

**Why:** The public API and Playground gateway are distinct request surfaces, and the 30-second price is a user-set product decision; neither should be silently inferred from the old 5-second HAR.

**How to apply:** Keep the model-v1 options quote before any submit and use its actual credit amount for account preflight. Keep customer price at Rp6,000 unless the user changes it. Never claim video/audio Playground support is live-verified unless a real quote or authorized completed job confirms it. Preserve the bot's stricter aggregate reference-duration limits separately from the documented per-file ceiling.
