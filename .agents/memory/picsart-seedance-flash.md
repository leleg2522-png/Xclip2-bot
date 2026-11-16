---
name: Picsart Seedance 2.5 Flash references
description: Official Flash fields, live edit evidence, and a provider-credit billing caveat.
---

The official Picsart Seedance 2.5 Flash API documentation supports output duration up to 30 seconds and lists `imageUrls` (up to 10), `videoUrls` (up to 5), and `audioUrls` (up to 5), with a per-reference video/audio ceiling of 30.2 seconds. The documented task type values are `auto`, `reference`, `edit`, and `extend`.

The user chose 30-second Flash output at Rp6,000 for text-only and all reference modes. A live Playground edit with a 15-second source and an image reference accepted `omniReferenceTaskType=edit`, `duration=-1`, and `aspectRatio=adaptive`; it returned a 14.72-second 480×854 H.264 video with AAC audio. The quote and completed job both reported 90 provider credits at 3 credits per unit with `usageAmount=30`, so provider billing units did not match the roughly 15-second rendered duration.

The captured AI Playground model-v1 HAR confirms only the original 5-second, 15-credit text-to-video contract and one `imageUrls` reference; it does not contain Flash video/audio requests. The live test confirms image+video edit mode, but not standalone video-only or audio-only references or regular 30-second text-to-video.

**Why:** The public API and Playground gateway are distinct request surfaces, and the edit quote's 30 units were not the output duration. Neither provider billing nor support for other modalities should be inferred from docs or the old 5-second HAR.

**How to apply:** Keep the model-v1 options quote before any submit and use its actual credit amount for account preflight and approval caps; do not estimate edit cost from output duration. Keep customer price at Rp6,000 unless the user changes it. Never claim video/audio Playground support is live-verified unless a real quote or authorized completed job confirms it. Preserve the bot's stricter aggregate reference-duration limits separately from the documented per-file ceiling.
