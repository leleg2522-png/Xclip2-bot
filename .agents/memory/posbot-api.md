---
name: Posbot API documentation mismatch
description: Prefer downloadable Markdown documentation; real status and transaction endpoints allow result retrieval without a portal session.
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

Use the downloadable Markdown at
`https://posbot.web.id/posbot_motion/api/web/dev/docs/download` instead of relying
on the landing page's inline snippets. The Markdown was accessible without a
portal session, including when requested with the API Bearer key.

**Why:** The landing page advertises `/jobs/{job_id}`, while the detailed
documentation correctly describes `/status/<job_code>` and account-scoped
`/transactions`. Both detailed endpoints were live-verified with the user's API
key; transactions recovered an accepted job whose acknowledgement was lost.
Requiring the user to log in to the portal was unnecessary.

**How to apply:** GET `/api/v1/transactions` with pagination and optional model/job
search to recover the account's job codes, then GET
`/api/v1/status/<job_code>` to obtain `status`, `progress` and `result_url`.
Poll every 5–10 seconds as documented. Retrieve the completed media through the
backend and deliver it to the mapped customer chat; never send customers to the
provider portal. `notify_telegram: false` is documented for suppressing provider
notifications to the API account owner; it is not a substitute for customer
delivery.
