---
name: Picsart MiniMax H3
description: Undocumented Picsart gateway contract for MiniMax H3 image-to-video and first/last-frame generation.
---

MiniMax H3 Max uses the Picsart gateway workflow
`minimax/h3-max/image-to-video`. The captured HAR originally showed a 15-second
480p request, but the product is intentionally configured to generate from a
768p base before 4K delivery. It uses `image_url` as the first frame, balanced
prompt expansion, and the safety checker.
Completed polling responses expose the media URL as `result.video.url`, not the
older `result.video_url` shape used by several other Picsart workflows.

Reference-to-video is a separate verified gateway workflow using model
`minimax-h3-max-r2v`. It accepts one image in `reference_image_urls` plus one
video in `reference_video_urls`, with matching `imageUrls`/`videoUrls` metadata.
The HAR verifies 15 seconds, 768p, both portrait and landscape ratios, 15
credits, and the same `result.video.url` completion shape.

An optional last frame is represented by `end_image_url`; this matches the
authoritative H3 input schema. The Picsart HAR did not include an actual
two-frame submit, so never claim that path was live-verified through Picsart
until a controlled job confirms it.

**Why:** The browser capture exposes the private Picsart route and payload, while
the H3 schema resolves the otherwise-missing final-frame field. Keeping the
verification boundary explicit prevents untested provider behavior from being
treated as proven.

**How to apply:** Keep MiniMax H3 on p500, preserve native 768p generation, and
use the existing gateway media preparation workflow to deliver 4K at the exact
portrait or landscape dimensions. Never retry an accepted paid job through
another account; refund any failed delivery.