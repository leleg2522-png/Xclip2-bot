---
name: Freebeat MiniMax H3
description: Constraints for the Freebeat-backed MiniMax H3 Image-to-Video flow.
---

Freebeat's web history identifies MiniMax H3 as `hailuo-3` / model ID `131` with a 15-second, 768p, 16:9, no-watermark Image-to-Video result. Its current public CLI package does **not** list this model; it only lists Hailuo 2.3 Pro, despite exposing generic batch submit and poll endpoints.

**Why:** The UI-visible Freebeat catalog and the published CLI catalog are currently out of sync. The public generic batch API rejected H3 with an invalid-user error, while a successful web capture uses the Freebeat web proxy's `createAiVideo` and `list` routes with browser-session headers. Replacing H3 with the CLI's Hailuo 2.3 model would silently deliver a different product.

**How to apply:** Keep H3 separate from Freebeat CLI catalog entries. Use pooled, pinned web sessions for the proxy submit/poll flow; do not reuse raw values from a HAR. Keep one claimed session through submit and polling, and never resubmit an ambiguous accepted job. Validate a real low-risk generation after deployment before changing model ID, duration, resolution, or aspect ratio.