---
name: Picsart PixVerse v6
description: PixVerse v6 image-to-video gateway contract, configured for direct 720p generation.
---

PixVerse v6 uses the Picsart gateway route (`/gw-v2/workflows/pixverse/v2/image-to-video`),
not the generic workflow route. The HAR verified model `v6` at 360p, 15 seconds,
and generated audio. The product is now explicitly configured to request 720p
directly without a separate export.

**Why:** The successful request requires the gateway context headers and Drive
metadata in addition to core generation parameters. PixVerse has no ratio field:
the source image aspect ratio determines its output shape.

**How to apply:** For 9:16 or 16:9 product choices, center-crop and upload a
matching input frame, request 720p, and deliver the native result directly. Do
not run a separate export. The available HAR does not independently verify 720p,
so keep failures explicit and refundable.