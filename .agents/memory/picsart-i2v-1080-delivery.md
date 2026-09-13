---
name: Picsart I2V native delivery
description: Delivery policy after all separate export and upscale stages were disabled.
---

All Picsart video models must deliver the native generation result directly.
Do not submit the result to the media-platform video resize/export workflow.

Seedance 2 Mini Video Edit and Seedance 2 Fast Video Edit stay separate from
each other and from their image-to-video variants. Each Video Edit route
requires a reference video, accepts up to five optional reference images, and
has model-specific payload metadata. Seedance 2 Video Edit follows the same
five-image limit. Never merge or silently substitute these routes.

**Why:** The user explicitly disabled every separate export/upscale stage.

**How to apply:** Public labels must state native output quality. Current native
outputs include Seedance/Wan 480p, PixVerse and Omni 1.2 360p, Veo Lite/Kling Omni
720p, and MiniMax H3 768p. Keep delivery-based charging and refunds unchanged.