---
name: Picsart Wan 3.0 video
description: Verified Wan 3.0 workflow request and post-generation 1080-width export behavior from a captured Picsart HAR.
---

Wan 3.0 uses the Picsart v3 video workflow. A verified production submission uses
model `wan3.0-video`, resolution `480P`, duration `30`, and `ratio: "9:16"`.
The raw completed video is 480×832 at 30 fps and 30 seconds.

Picsart then performs a separate video edit/export operation. The captured UI used
`resize.width: 1080` and `resize.height: 1872`; its completed downloaded file was
verified as 1080×1872, 30 fps, and 30 seconds. This preserves the provider's raw
480×832 frame shape, which is not an exact 9:16 frame.

**Why:** “1080p” is an export/upscale step, not the native Wan generation setting.
Charging and user copy should reflect that distinction.

**How to apply:** For a product promise of exact 9:16/16:9 output, submit standard
export dimensions (1080×1920 / 1920×1080) after the 480P generation rather than
copying the captured 1080×1872 size. A real `16:9` submission was not present in
the capture, so validate that ratio with its own HAR after release.