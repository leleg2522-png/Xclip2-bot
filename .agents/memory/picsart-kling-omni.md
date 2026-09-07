---
name: Picsart Kling Omni video
description: Verified Kling v3 Omni image-to-video gateway contract captured from a successful AI Playground HAR.
---

Kling Omni uses the Picsart gateway workflow `kling-omni-video` with model
`kling-v3-omni`. The verified successful request is image-to-video, 9:16,
12 seconds, Standard mode, single-shot customize mode, native 720p, and audio on.
It accepts one image through `image_list`; matching Drive metadata uses
`imageUrls`, `referType: "feature"`, and `keepOriginalSound: "yes"`.

Completion exposes the MP4 at `result.url`. The successful 12-second job used
48 credits. Options also reported 40 credits for 10 seconds and 60 credits for
15 seconds, but those durations were not the submitted successful job.

**Why:** This contract is distinct from the older Kling v3 Standard and Turbo
workflows, so reusing their endpoint or payload would silently submit the wrong
model.

**How to apply:** Keep Kling Omni as a separate native-720p I2V product using one
reference image, with customer-selectable 9:16 or 16:9 ratio, then prepare exact
1080×1920 or 1920×1080 output before delivery. The public price is Rp4,000.
Use only the p100 account pool (accounts categorized with 5–100 credits). Never
resubmit an accepted paid job after an authentication failure. Do not add video-
reference payload fields until a real submitted HAR captures their names.