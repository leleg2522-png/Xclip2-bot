---
name: NovAI Seedance API verification
description: Working API host and the difference between listed models, trial eligibility and completed generation.
---

Use `https://aiapi-pro.com/v1` for NovAI checks. Its public catalog lists
`doubao-seedance-2.5`, but a catalog listing is not generation verification.

**Why:** Their Seedance tutorial uses `api.aiapi-pro.com`, which failed DNS
resolution during testing, while the main-domain API responded. The model
page advertises trial 480p/5s generation, but an authenticated submission was
rejected with HTTP 403 `permission_denied`: "Trial credit cannot be used for
video models." No generation job was accepted.

**How to apply:** Prefer live API entitlement and pricing checks over public
trial claims. A funded-account test must complete and return a valid video
before treating this provider as verified Seedance 2.5 generation. Do not
switch the bot's existing route based solely on the catalog or tutorial.
