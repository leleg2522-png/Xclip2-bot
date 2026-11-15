---
name: Picsart Seedance 2.5 Flash references
description: Official Flash API fields, documented limits, and the boundary of live Playground evidence.
---

The official Picsart Seedance 2.5 Flash API documentation lists `imageUrls` (up to 10), `videoUrls` (up to 5), and `audioUrls` (up to 5), with a per-reference video/audio ceiling of 30.2 seconds. The documented task type values are `auto`, `reference`, `edit`, and `extend`.

The captured AI Playground model-v1 HAR confirms that one `imageUrls` reference is accepted by the Flash options and submit requests. It does not contain Flash video/audio reference requests. The public API documentation establishes the field names and limits, but not by itself that the Playground gateway route has identical behavior for every modality.

**Why:** The public API and Playground gateway are distinct request surfaces; matching field names do not replace runtime evidence.

**How to apply:** Keep the model-v1 options quote before any submit, and never claim video/audio Playground support is live-verified unless a real quote or authorized completed job confirms it. Preserve the bot's stricter aggregate reference-duration limits separately from the documented per-file ceiling.
