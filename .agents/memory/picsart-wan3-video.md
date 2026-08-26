---
name: Picsart Wan 3.0 video
description: Verified Wan 3.0 workflow request and post-generation 1080-width export behavior from a captured Picsart HAR.
---

Wan 3.0 uses the Picsart v3 video workflow. A verified production submission uses
model `wan3.0-video`, resolution `480P`, duration `30`, and `ratio: "9:16"`.
The raw completed video is 480×832 at 30 fps and 30 seconds.

Picsart then performs a separate video edit/export operation with
`resize.width: 1080` and `resize.height: 1872`; the completed downloaded file was
verified as 1080×1872, 30 fps, and 30 seconds.

**Why:** “1080p” is an export/upscale step, not the native Wan generation setting.
Charging and user copy should reflect that distinction.

**How to apply:** For vertical 30-second Wan output, generate at 480P then await the
separate resize/export result before delivering. A real `16:9` submission was not
present in the capture, so validate that ratio with its own HAR before exposing it.