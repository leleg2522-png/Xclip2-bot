---
name: Posbot API documentation mismatch
description: Live API acknowledgement differs from the public developer example; parsing failures must never trigger another paid submission.
---

Treat Posbot's public developer examples as illustrative, not a verified
response schema. A live accepted generation returned `job_code` and `status_url`,
whereas the public sample showed `job_id`.

**Why:** A paid request was accepted and debited despite the client failing to
extract the identifier shown in the documentation. A missing parsed identifier
does not establish that submission failed.

**How to apply:** Preserve the safe acknowledgement fields before interpreting
them, support the actual job-code/status-link contract, and never resubmit merely
because acknowledgement parsing failed. Obtain model availability and pricing
from the authenticated catalog rather than the landing-page marketing.
