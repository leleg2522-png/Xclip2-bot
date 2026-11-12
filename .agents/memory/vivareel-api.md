---
name: Vivareel API base URL
description: Conflicting documentation hostnames and the authenticated route verified during preflight.
---

Use the documented examples on `https://vivareel.ai/api/developer/v1` as the first route to verify, rather than assuming the `api.vivareel.com` hostname is usable.

**Why:** The documentation/search introduction referenced `api.vivareel.com`, which failed DNS in the workspace, while the examples' `vivareel.ai` route returned HTTP 200 for an authenticated model-catalog read. The documentation page is `/dev/docs`, not `/docs`.

**How to apply:** Verify `/models` with the account's key before a paid request. Read actual model names, availability, capability limits, and point pricing from that response; do not submit the example model name blindly. A failing metadata hostname is not evidence that the key is invalid.

Treat catalog point pricing as an estimate until the finished task reports its cost.

**Why:** A completed Wan 3.0 text-to-video run requested 30 seconds at 480P. The catalog advertised 7 points per second, but the task reported both `points_cost` and `billing_points` as 120, not the 210-point catalog estimate. The reason for the difference was not established.

**How to apply:** Quote the catalog with that caveat, then report the completed task's cost. Do not infer a universal resolution discount from this one observation or claim that an account balance was verified when only task-cost fields were read.

Check the delivered file for watermarks even when the request sets `watermark: false`.

**Why:** The successful Wan 3.0 sample still displayed a small VR mark in its lower-right corner despite that requested setting.

**How to apply:** Mention observed branding when delivering a test. Do not advertise watermark-free output based only on the request parameter.
