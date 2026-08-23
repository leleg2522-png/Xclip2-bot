---
name: Freebeat MiniMax H3
description: Constraints for the Freebeat-backed MiniMax H3 Image-to-Video flow.
---

Freebeat's web history identifies MiniMax H3 as `hailuo-3` with a 15-second, 768p, 16:9, no-watermark Image-to-Video result. Its current public CLI package does **not** list this model; it only lists Hailuo 2.3 Pro, despite exposing generic batch submit and poll endpoints.

**Why:** The UI-visible Freebeat catalog and the published CLI catalog are currently out of sync. Replacing the H3 configuration with the CLI's Hailuo 2.3 model would silently deliver a different product.

**How to apply:** Keep the H3 label and web-observed request profile distinct from Freebeat CLI catalog entries. Use the generic official batch API with the configured Freebeat API key, and validate a real low-risk generation after deployment before changing model ID, duration, resolution, or aspect ratio.