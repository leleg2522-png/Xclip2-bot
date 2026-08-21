---
name: Paid provider post-submit failover
description: Prevent duplicate paid generations when provider credentials fail after a job has been accepted.
---

For paid asynchronous providers, account failover is allowed only before a job submission is accepted. Once a provider returns a job ID, preserve that ID for diagnostics; if polling or token refresh loses authentication, mark the credential unusable and refund the user instead of replaying upload and submit on another account.

**Why:** Retrying a complete orchestration after the provider already accepted a job can spend credits twice and create an orphaned result while the user is charged only once.

**How to apply:** Keep pre-submit account acquisition, upload, and submit retries distinct from post-submit polling. Convert post-submit authentication sentinels into a non-retryable error that bypasses generic account failover.