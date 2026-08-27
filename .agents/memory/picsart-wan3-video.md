---
name: Picsart Wan 3.0 Prime video
description: Verified Wan 3.0 Prime gateway contract and the product's separate exact-ratio 1080 export policy.
---

Wan 3.0 now uses the Prime model through the Picsart gateway v3 video workflow.
The captured successful submission uses model `wan3.0-video-prime`, resolution
`480P`, duration `30`, `ratio: "9:16"`, a `reference_image`, and disabled audio,
thinking, and watermark. The gateway Drive metadata identifies
`wan-3.0-video-prime`.

The Prime capture contains generation and polling only; it does not contain a
1080 export. The product performs its own separate video edit/export after the
Prime job completes.

**Why:** Prime replaces the old Wan model while preserving the 30-second product.
“1080p” remains an export step, not the native Prime generation setting.

**How to apply:** Route Wan Prime through the p500 account pool, then export exact
1080×1920 / 1920×1080 output only after its 480P job completes. A real `16:9`
Prime submission was not present in the capture, so validate that ratio live.