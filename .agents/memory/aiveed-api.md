---
name: Aiveed API checks
description: Live image-test caveats, rate limits, and output resolution verification.
---

Do not equate Aiveed's requested image resolution with actual delivered pixels.
A Banana 2.1 text-to-image test requested `1K` but delivered a valid 768×768 PNG,
with 8 credits charged. This proves image generation works, not true 1024px output
or any other model/resolution.

**Why:** The first successful image test exposed a mismatch between the resolution
label and the downloaded image metadata.

**How to apply:** Inspect downloaded metadata before promising resolution.
Check live public model/pricing endpoints; the developer dashboard itself
requires login, while API docs are public on api.aiveed.io.

Use conservative polling and honor HTTP 429 retry_after. The tested key allowed
10 requests/minute, and three-second polling hit the limit. An accepted job
continued and completed despite the polling rejection.

**Why:** A polling error is not evidence of a failed generation and must never
trigger another paid submit.

**How to apply:** Keep the existing job ID, wait the requested cooldown, then
resume reads. Supply Idempotency-Key on generation. Do not infer production
rate limits from this single key.
