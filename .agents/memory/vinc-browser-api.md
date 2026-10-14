---
name: Vinc browser generation API
description: Browser-session requirement, captured generation flow, and limits of T2V evidence for an I2V integration.
---

Vinc's captured browser generation flow is quote → generate → creative result
registration → observations. Treat its endpoints as a browser integration, not
as an established public API-key contract.

**Why:** The inspected HAR omitted cookies and authorization headers even on
authenticated Supabase requests. An independent read-only request to
`/api/generate/live` without login returned 401. A task's returned `pollToken`
does not establish reusable account authentication or a session-renewal method.

**How to apply:** Obtain an authorized session through secure credentials tooling
before claiming the bot can submit. Verify session expiry and renewal separately.
After acceptance, preserve the job and resume its polling; do not renew access
by replaying the paid generation.

The captured completed generation was Seedance 2.5 **text-to-video**. Catalog
entries for Seedance 2.5 image-to-video and reference-to-video are not evidence
that those modes were successfully generated or that their upload flow is known.

**Why:** Both submitted inputs lacked images; one job was rejected under content
policy, and another reached completed status with an independently readable MP4.

**How to apply:** Verify I2V inputs, reference upload and terminal output before
adding that capability. Keep quote prices distinct from final billing, and
preserve content-policy failures rather than treating them as auth failures.

HAR video bodies from HTTP 206 responses can contain only trailing byte ranges
and cannot necessarily be probed as standalone MP4 files.

**Why:** The captured video bodies lacked the initial file bytes; probing the
complete existing output succeeded while probing the captured tails did not.

**How to apply:** Check Content-Range before drawing conclusions from embedded
media. When authorized, inspect the complete existing result without starting
another generation.
