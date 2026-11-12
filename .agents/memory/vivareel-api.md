---
name: Vivareel API base URL
description: Conflicting documentation hostnames and the authenticated route verified during preflight.
---

Use the documented examples on `https://vivareel.ai/api/developer/v1` as the first route to verify, rather than assuming the `api.vivareel.com` hostname is usable.

**Why:** The documentation/search introduction referenced `api.vivareel.com`, which failed DNS in the workspace, while the examples' `vivareel.ai` route returned HTTP 200 for an authenticated model-catalog read. The documentation page is `/dev/docs`, not `/docs`.

**How to apply:** Verify `/models` with the account's key before a paid request. Read actual model names, availability, capability limits, and point pricing from that response; do not submit the example model name blindly. A failing metadata hostname is not evidence that the key is invalid.
