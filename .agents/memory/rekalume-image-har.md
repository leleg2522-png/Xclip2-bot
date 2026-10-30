---
name: Rekalume image HAR evidence
description: Verified image-edit results and limitations of the uploaded sanitized Rekalume browser capture.
---

The uploaded Rekalume HAR demonstrates completed Nano Banana Pro image-edit jobs at 1024×1024 for 8 credits and 4096×4096 for 15 credits. This is historical browser evidence, not a new live generation or proof of text-to-image.

**Why:** The actual embedded output PNG dimensions confirm both resolutions. The job metadata's `size` stayed `1024x1024` even for the real 4K output, so metadata alone is misleading.

**How to apply:** Verify downloaded output dimensions rather than trusting `params.size`. The capture has no request Authorization/Cookie headers or cookies. Unauthenticated live account/history calls returned 401; do not claim the capture alone is reusable authentication or replay paid generation without fresh authorized access.
