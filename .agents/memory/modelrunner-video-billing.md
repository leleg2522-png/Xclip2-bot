---
name: ModelRunner video billing
description: Fractional finished-video durations and reliable success and cost checks for ModelRunner.
---

Treat duration-based quotes as estimates, not exact charges, even when the request specifies a whole number of seconds.

**Why:** A live Seedance 2.5 text-to-video test requested 30 seconds at 480p but returned a 30.08-second MP4. Its settled charge matched 30.08 times the published per-second rate rather than exactly 30 times that rate.

**How to apply:** Fetch current rates from the public pricing API, leave headroom when checking funds, probe the finished file, and use the request's settled `totalPrice` as the charge source of truth. Do not silently cap recorded provider spend at the original estimate.

Do not treat `COMPLETED` alone as successful generation.

**Why:** ModelRunner explicitly normalizes some provider failures to `COMPLETED`; request detail/list expose these as `billingStatus: failed`, while result retrieval returns HTTP 422.

**How to apply:** Poll the returned status URL, then retrieve the result and verify actual output and errors; use request detail billing status for settlement. Keep polling/retrieval separate from submission, and never resubmit a paid job merely because its result retrieval failed.
