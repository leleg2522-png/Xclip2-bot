---
name: Flowy API documentation mismatch
description: Prefer the live public schema and authenticated catalogs over stale reference examples; validate motion limits and wallet context before migration.
---

Flowy's rendered reference pages can lag behind its live public OpenAPI.
Use the live schema plus authenticated model/tool catalogs as the integration
contract, not only copied examples from the documentation site.

**Why:** The live public schema exposed model discovery, quick-tool catalog,
non-reserving quotes, tool runs and signed asset uploads that the rendered
reference omitted. The Motion Control page also inconsistently says 3–30s
reference inputs while labeling its models “up to 10s”.

**How to apply:** Before promising a duration or migrating Xclip Motion, inspect
the account's actual catalog, input limits and price quote. Do not treat the
generic generation request's documented 4–10s default clamp as the proven limit
of every curated model or the separate Motion Control tool. A public schema is
not a successful authenticated or paid generation test.

Uploaded duration and dimensions must be measured from the actual media, not
supplied optimistically; tool pricing and limits trust the declared source facts.

**Why:** The upload schema explicitly says the server stores supplied dimensions
and duration without probing the file, and tools consume those facts.

**How to apply:** Reuse real media inspection before upload and quote. Never
understate duration, dimensions or other billed source facts.

Multiple keys for one workspace share its wallet; a fresh key does not create
fresh credits.

**Why:** Flowy bills a key's workspace wallet by default and exposes available
and reserved credits through its balance endpoint.

**How to apply:** Preflight the correct wallet before paid work, distinguish
account-bound from workspace-bound credentials, and do not assume rotating keys
restores credits.
