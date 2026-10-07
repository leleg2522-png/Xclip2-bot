---
name: Picsart Heygen and Banana 2.1 verification
description: Separate public motion route and evidence distinguishing captured video/image results from non-billable T2I options
---

Keep Heygen photo-to-video and Xclip Motion as separate customer models, although
both use Heygen Video 1 upstream.

**Why:** The user requested a separate “xclip motion” model for the captured
photo + reference-video flow. The HAR completed both flows: photo-only used 15
credits and photo + video used 30 credits for 15-second outputs. Both returned
native 768×1344 videos; these are observations, not a universal rate formula.

**How to apply:** Require both media for Xclip Motion, and only a photo for
Heygen. Do not silently remove the video reference or swap either route to Kling.
Keep the requested public Motion label rather than exposing its internal supplier.

Banana 2.1 has distinct evidence for its two modes: the HAR completed image-to-image
at the 4K setting; text-to-image was verified only through the non-billable options
endpoint using a currently valid bot token, not through a paid generation.

**Why:** With an empty image list, options returned HTTP 201 with
`text-to-image.gemini-nano-banana-2.1.4k`, two estimated credits, and no job ID.
The expired HAR token returned 401; incomplete metadata headers returned
`missing_headers`, neither of which established model incompatibility.

**How to apply:** Do not claim a real T2I result was generated during this check.
When testing captured workflow capabilities, preserve platform/touchpoint metadata
alongside authentication before interpreting validation errors.
