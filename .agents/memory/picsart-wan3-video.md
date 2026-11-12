---
name: Wan 3.0 provider and crop
description: Regular Wan 3.0 uses Vivareel with mandatory logo cropping; keep Uncensored separate.
---

Use Vivareel for regular Wan 3.0 instead of Picsart, with automatic logo cropping before delivery.

**Why:** The user requested “ganti wan 3,0 yg dari picsart jadi pake dari vivareel ai” and selected “Otomatis crop logo” after reviewing a portrait crop comparison.

**How to apply:** Keep the existing Rp6,000 package and reference-image choices. Without video references, output remains 30 seconds; reference-video mode must respect the upstream combined-duration limit instead. Crop is mandatory, including the output's framing loss; never silently deliver the branded source if cropping fails. Refund the actual charge on failed delivery. Do not revert regular Wan to Picsart or change the separate Wan Uncensored provider or pricing.

Generate at 480p, crop the logo, then require Renderful 1080p before delivery.

**Why:** After the 720p test, the user changed the requirement: “gw ingin resolusi 480p dan juga dia di upscale ke renderfull”. The prior request to avoid Renderful is superseded for regular Wan.

**How to apply:** Request 480p from Vivareel, crop before upscaling, and give Renderful the cropped video rather than the branded original. Require actual Renderful finishing; do not substitute local resizing or deliver native/cropped 480p after any failure. Keep duration and audio and refund if final delivery fails. Customer-facing labels describe 1080p delivery, not native 1080p.

Video-reference input belongs to regular Wan 3.0 and must retain the same mandatory finishing.

**Why:** After a successful upstream video-reference test, the user approved adding video references to the bot with “ya” in response to the explicit offer to preserve 480p → crop → Renderful 1080p.

**How to apply:** Do not remove video input or silently force it back to image-only. Respect the reference-plus-output duration constraint and show the resulting duration before generation; never bypass crop or Renderful simply because a reference was supplied.