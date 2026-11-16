---
name: Picsart Seedance 2.5 Flash references
description: Official Flash fields, live edit evidence, and a provider-credit billing caveat.
---

The official Picsart Seedance 2.5 Flash API documentation supports output duration up to 30 seconds and lists `imageUrls` (up to 10), `videoUrls` (up to 5), and `audioUrls` (up to 5), with a per-reference video/audio ceiling of 30.2 seconds. The documented task type values are `auto`, `reference`, `edit`, and `extend`.

The user chose 30-second Flash output at Rp6,000 for text-only and all reference modes. A live Playground edit with a 15-second source and an image reference accepted `omniReferenceTaskType=edit`, `duration=-1`, and `aspectRatio=adaptive`; it returned a 14.72-second 480×854 H.264 video with AAC audio. The quote and completed job both reported 90 provider credits at 3 credits per unit with `usageAmount=30`, so provider billing units did not match the roughly 15-second rendered duration.

A second live edit with a 10.042-second solo clip and the same image reference returned a 9.728-second 480×854 H.264/AAC video. Its quote and completed job reported 63 provider credits at 3 credits per unit with `usageAmount=21`. The selected source shows mostly hand gestures rather than a full-body dance.

An exact-face identity prompt with audio generation enabled was accepted for polling but failed with `422 bytedance_output_audio_sensitive`; the provider returned no usage amount. A subsequent audio-off job was accepted, but the workspace lost the local polling process before a result or provider task ID was saved. Each attempt was capped at 63 credits, but actual deductions are unknown.

The captured AI Playground model-v1 HAR confirms only the original 5-second, 15-credit text-to-video contract and one `imageUrls` reference; it does not contain Flash video/audio requests. The live test confirms image+video edit mode, but not standalone video-only or audio-only references or regular 30-second text-to-video.

**Why:** The public API and Playground gateway are distinct request surfaces, and edit quotes reported more billing units than rendered seconds. Losing the local poller after provider acceptance leaves the result and credit usage unknown, so an automatic replay could double-spend.

**How to apply:** Keep the model-v1 options quote before any submit and use its actual credit amount for account preflight and approval caps; do not estimate edit cost from output duration. Persist accepted provider job IDs before polling and provide a resume path after process restarts; never replay an ambiguous accepted job. Keep customer price at Rp6,000 unless the user changes it. Never claim video/audio Playground support is live-verified unless a real quote or authorized completed job confirms it. Preserve the bot's stricter aggregate reference-duration limits separately from the documented per-file ceiling.
