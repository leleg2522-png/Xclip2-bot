---
name: Picsart PixVerse v6
description: HAR-verified PixVerse v6 image-to-video gateway contract and ratio behavior.
---

PixVerse v6 uses the Picsart gateway route (`/gw-v2/workflows/pixverse/v2/image-to-video`),
not the generic workflow route. Its verified native settings are model `v6`, quality
`360p`, 15 seconds, and generated audio; there is no supported `365p` setting in
the capture.

**Why:** The successful request requires the gateway context headers and Drive
metadata in addition to core generation parameters. PixVerse has no ratio field:
the source image aspect ratio determines its output shape.

**How to apply:** For 9:16 or 16:9 product choices, center-crop and upload a
matching input frame, then use the separate 1080 export only after PixVerse has
completed. Validate each ratio with one controlled live run after deployment;
HAR construction tests do not prove upstream acceptance.