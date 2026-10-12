---
name: Flowy API documentation mismatch
description: Distinguish the public Studio model catalog from narrower docs and curated REST models; verify limits, quotes and wallet context.
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

The Studio Generate Video page has a larger, dynamic provider-model catalog
than the two engines described in the Canvas Video Node documentation.
Public catalog browsing does not require an API key, even though the separate
curated REST model-list endpoint does.

**Why:** The public Generate Video page visibly showed H3 Max and H3 Max Turbo.
Its public catalog returned explicit image-to-video variants for both, plus
H3 Max reference-to-video. A plain markdown fetch omitted the hydrated model
list, so an empty text extraction was not evidence of absent models.

**How to apply:** For current availability, inspect the actual Studio catalog.
The browser's anonymous catalog uses the genstudio service route
`/api/public/models?modality=video`, with pagination; it is distinct from
`/api/v1/models?type=video`. Do not assume provider model IDs from this public
catalog are accepted by the curated direct-generation REST endpoint, or that
catalog presence proves free-plan eligibility, pricing or a successful run.
Distinguish text-, image- and reference-to-video variants explicitly.

Build REST URLs from the live OpenAPI server URL plus its path, not from the
URL where the OpenAPI document itself is fetched.

**Why:** The spec is served beneath `/api/v1/openapi.json`, but its declared
server URL ends in `/genstudio-svc-v2/api`; the paths already begin with `/v1`.
Using the document directory as the API base incorrectly duplicates `/v1`.

**How to apply:** The official model list is `/api/v1/models`, not
`/api/v1/v1/models`. A missing-key 401 alone does not establish that a guessed
route exists. The live generation endpoint supports `?estimate=true`, which
validates/prices a request without dispatching, reserving or charging credits;
use that after authenticated model discovery before any authorized paid test.

Model discovery can fail while resolving metadata for an unrelated provider
model; distinguish that server-side failure from a rejected Flowy API key.

**Why:** A video-list request returned HTTP 500 because Flowy's fal adapter
received an upstream 401 while resolving a Kling model. No model list was
returned, so the response could not establish H3 availability. The separate
quick-tool catalog and Motion Control quote still succeeded with the Flowy key.

**How to apply:** Identify which service returned the authorization error.
Do not ask the user to replace their Flowy key merely because an error body
mentions an upstream provider's invalid key. Treat a failed catalog as
inconclusive, not as evidence that a model is unsupported; do not bypass the
catalog by submitting a paid generation.
Check quick tools independently instead of assuming a broken direct-generation
catalog means that every Flowy API route is unusable.

Successful discovery, quotes, uploads and run acceptance do not prove that
the provider can finish a Motion Control generation or video upscale.

**Why:** A regular Motion Control test and a separate short 2x video upscale
test passed those stages but then returned a generic failed-run message. In
both cases the wallet returned to its original available balance with no
reserved credits. The generic failure did not identify the underlying cause.

**How to apply:** Confirm terminal status and a downloadable output before
calling the generation path operational. Verify wallet reservations and balance
after failure, and do not attribute a generic run error to an earlier fal
catalog error without evidence. Never automatically resubmit an accepted paid
run merely because it later fails.

Uploaded duration and dimensions must be measured from the actual media, not
supplied optimistically; tool pricing and limits trust the declared source facts.

**Why:** The upload schema explicitly says the server stores supplied dimensions
and duration without probing the file, and tools consume those facts.

**How to apply:** Reuse real media inspection before upload and quote. Never
understate duration, dimensions or other billed source facts.
For video upscale, quote the actual duration, dimensions and chosen factor.
The catalog's representative per-run estimate is not the cost of every video;
longer clips and larger factors can consume most of the workspace wallet.

Multiple keys for one workspace share its wallet; a fresh key does not create
fresh credits.

**Why:** Flowy bills a key's workspace wallet by default and exposes available
and reserved credits through its balance endpoint.

**How to apply:** Preflight the correct wallet before paid work, distinguish
account-bound from workspace-bound credentials, and do not assume rotating keys
restores credits.

## Gemini Omni via Studio

Flowy's Studio Gemini Omni Flash 1.1 image-to-video path has evidence of a
completed portrait 4K video with audio. A download and ffprobe inspection
confirmed 2160×3840, 24 fps, and approximately 11.63 seconds, despite the
request selecting 10 seconds. Its quote was 450 credits; that is not a
verified final wallet debit.

**Why:** An uploaded HAR on 2026-10-12 captured two equivalent submissions:
one failed with upstream invalid-input HTTP 422, and one completed after
approximately four minutes and twenty-four seconds. The completed output
was independently downloaded and inspected without submitting another job.
This distinguishes genuine media delivery from mere catalog or job acceptance.

**How to apply:** Treat Studio integration as feasible but not uniformly
reliable. Do not assume the curated API-key route supports the same provider
model merely because Studio does. Measure actual output duration; do not promise
exactly the selected duration or automatically retry an accepted failed run.

The Studio route requires a browser access token rather than a workspace API
key. Sanitized HAR request headers can omit authentication while the auth-session
response still contains a usable access token. Treat the entire HAR as sensitive;
never print, present, or persist that token in project memory.

**Why:** An authorized independent generation using the HAR's Studio session and
original managed image completed and delivered another verified portrait 4K
video with audio. The workspace API key authenticated model discovery and a
450-credit estimate, but both documented reference forms (asset ID and URL)
were rejected before dispatch with missing required `image_url`. The same API
key was refused by the Studio endpoint. These are different authentication and
request contracts, not evidence that the model cannot generate.

**How to apply:** Use the verified Studio contract only with authorized session
access and account/workspace checks. Do not describe API-key I2V as operational
until its reference mapping is verified. A successful estimate does not validate
the actual reference-to-provider mapping. Studio profile credits can be zero
even when workspace-billed generation succeeds; do not confuse account-profile
credits with the selected workspace's wallet.

## Studio session renewal

Do not treat the browser-session expiry as the Studio access-token lifetime.
The inspected HAR JWT declares a 24-hour lifetime, while the browser session
response's `expires` is approximately thirty days out. Neither proves that a
copied access token renews itself. The captured session response does not supply
a refresh token, and browser-cookie authentication is absent from the HAR.

**Why:** Inspection of the token's time claims and session response confirmed
different expiry windows. Anonymous browser-session retrieval returned no session.
The official OAuth discovery metadata advertises the refresh-token grant, and
Flowy's Create a session documentation permits exchanging an authorized OAuth
access token for a Studio access/refresh pair. It explicitly rejects workspace
API keys for that exchange.

**How to apply:** Prefer an authorized OAuth connection for long-lived Studio
automation. Refresh the OAuth grant and obtain/renew Studio access using the
documented session contract; follow actual returned expiry values rather than
assuming every new session lasts twenty-four hours. This path is documented,
not yet end-to-end verified in this project. Creating a Studio session grants
full account privileges, beyond OAuth scopes; obtain informed approval and keep
all session/refresh credentials server-side. Renew authentication for polling
the original job, never by replaying an accepted paid generation.
