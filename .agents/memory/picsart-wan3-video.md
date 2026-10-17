---
name: Picsart Wan 3.0 video
description: Wan 3.0 uses native 1080p requests and direct delivery; historical completed capture verified only 480p.
---

Wan 3.0 uses the standard model through the Picsart gateway v3 video workflow.
The captured successful submission uses model `wan3.0-video`, resolution
`480P`, duration `30`, `ratio: "9:16"`, one `reference_image`, audio and thinking
enabled, and watermark disabled. The Drive metadata model is `wan-3.0-video`.

The capture contains generation and polling only. Completion uses `result.url`
and reports 60 credits. That evidence applies to 480p only, not the current
1080p request or its credit cost.

**Why:** A newer successful HAR superseded the former Prime contract. The user
subsequently requested “wan3,0 ubah resolusi nya jadi 1080 p di backend picsart
nya jadi ga perlu upscale ke renderfull”.

**How to apply:** Request `1080P` in both the generation payload and Drive metadata,
keep the existing price and p500 pool, and deliver Picsart's result directly,
without Renderful. Do not change the separate Flora Wan Uncensored route.
Do not claim live 1080p generation is verified without a completed result.
The successful historical HAR run is 9:16; it does not independently verify 16:9.