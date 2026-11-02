---
name: Paid provider post-submit failover
description: Prevent duplicate paid generations when provider credentials fail after a job has been accepted.
---

For paid asynchronous providers, account failover is allowed only before a job submission is accepted. Once a provider returns a job ID, preserve that ID for diagnostics; if polling or token refresh loses authentication, mark the credential unusable and refund the user instead of replaying upload and submit on another account.

**Why:** Retrying a complete orchestration after the provider already accepted a job can spend credits twice and create an orphaned result while the user is charged only once.

**How to apply:** Keep pre-submit account acquisition, upload, and submit retries distinct from post-submit polling. Convert post-submit authentication sentinels into a non-retryable error that bypasses generic account failover.

Preserve the original post-submit error as a nested cause, but keep the
non-retryable wrapper message distinct from raw provider diagnostics. Log only
a redacted description of that cause, never Axios headers/configs or media URLs.

**Why:** Generic account failover matches message text such as credit/auth
errors. Putting the underlying text back into an accepted-job wrapper can
accidentally enable another paid submit. Conversely, dropping the cause hides
the actual gateway failure and makes unrelated failures appear identical.

**How to apply:** Preserve the accepted ID and stable wrapper, inspect the same
job with read-only result requests, and test that nested credit/auth errors do
not trigger account rotation. A successful fresh upload/public CDN GET proves
only that sample's accessibility, not that an earlier job or vendor fetch worked.