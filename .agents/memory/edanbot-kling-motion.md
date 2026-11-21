---
name: Kling Motion package routing and Edanbot
description: P1 uses Picsart, P2/P3 use Edanbot Motion 2.6 Pro up to 30s, and P4/P5 remain Alriz-native.
---

# Current Kling Motion routing

P1 uses Picsart Motion Control and remains limited to 16-second reference
videos. P2/P3 use Edanbot's `kling-motion-26-pro` contract and accept up to
30-second references. Keep their public package labels and prices separate.
The Edanbot request uploads both files, sends the full uploaded asset objects,
actual reference duration, `character_orientation: "video"`, and
`keep_original_sound: true`, then polls the accepted job. P4/P5 use Alriz
`mc-kling-2.6-pro` and the same database key pool; keep the customer-facing P5
name **Kling MC V3 Pro P5**. P4/P5 deliver the native Alriz result directly
without Renderful finishing.

**Why:** The owner later provided an Edanbot HAR and requested that P2/P3 use
its Kling Motion Control backend. That newer direction supersedes the earlier
request to share P1's Picsart route. The user separately requested Alriz for
P4/P5 and clarified that those packages need no Renderful finishing.

**How to apply:** Keep P2/P3 on Edanbot with their 30-second cap and separate
labels/prices. Use the managed Edanbot cookie pool; never copy session cookies
from HAR files into source. Rotate only after explicit pre-acceptance 401/403
responses, preserve full refunds on generation/delivery failure, and never
replay ambiguous or accepted paid submissions. Do not add finishing back to
P4/P5. Keep Xclip Motion's separate finishing policy unchanged.

## Alriz credential management

Alriz credentials must be managed through the bot's Railway database pool,
not through a required runtime environment variable or environment fallback.

**Why:** The user requested: “itu apikey nya masukan jadi pool agar gw gausah
masukin lagi di variables”.

**How to apply:** Preserve database-managed key entry and rotation when changing
P5. A one-time secure import is fine, but do not make deployment Variables a
requirement again. Key rotation must still stop after any accepted or ambiguous
paid submit.

## Alriz dashboard versus API readiness

A job shown as finished in the Alriz dashboard may still be `PROCESSING` or
`SAVING` in the API before its downloadable result is published.

**Why:** During a live test the user saw completion in the dashboard while both
the API detail and list still reported pending states; the result endpoint
returned HTTP 409 / `JOB_002` until publication finished.

**How to apply:** Keep polling the same accepted job through `SAVING`. Check its
result endpoint when reconciling dashboard reports, and do not resubmit or call
the generation failed solely because the download link is not ready yet.

## Alriz reference-hosting compatibility

Do not equate a successful Alriz test using existing CDN references with a
successful test of the bot's own reference-hosting path.

**Why:** A live CDN-reference test succeeded, but a subsequent bot submission
was rejected with `GEN_002` / “File type not supported” despite accessible,
correctly identified JPEG and MP4 bytes. The bot URLs lacked filename extensions.
URL-based file-type detection is a suspected compatibility issue, not a
confirmed upstream implementation detail.

**How to apply:** Publish P5 references with their actual file extensions and
matching MIME types, preserve legacy download links for other callers, and test
real GET/HEAD responses. Do not claim an upstream failure is resolved solely
from a mocked generation test or replay an already accepted paid job to check.

## Edanbot separation

**Hard rule:** never let any user-facing string (reply/caption/error/filename) leak `edanbot`/`roboneo`/`wavespeed`/`openart`/`meitu`/`meitudata`, and never send the raw `result_url` as a link — always re-upload bytes.

Edanbot serves the separate Kling v3 Pro image-to-video flow and Kling Motion
P2/P3; those products use distinct model requests.

**Why:** P2/P3's Edanbot route is based on the owner's supplied Motion Control
HAR; the existing Kling v3 Pro image-to-video flow remains separate.

**How to apply:** Keep Edanbot cookie-pool and direct no-proxy handling shared
as appropriate, but preserve separate request builders and model identifiers.
Do not change P1's Picsart route or P4/P5's Alriz route when editing either
Edanbot flow.

## Edanbot API flow
- Auth: `EDANBOT_COOKIE` secret. It is the value of a Flask **signed** `session=` cookie. Normalize: prepend `session=` if missing (users often paste only the value → 401 without the prefix).
- **Never route edanbot via Decodo proxy:** on Railway the proxy answers 407 (proxy auth) for these calls. Use a plain no-proxy axios client. The cookie is signed, not IP-bound, so direct calls work from any IP.
- Upload and poll through the same cookie-backed API, but keep each product's verified payload separate. Kling Motion P2/P3 use the `kling-motion-26-pro` model contract described above; Kling v3 Pro I2V uses its own model payload.
- Headers: cookie + `user-agent`, `referer: https://edanbot.digital/dashboard`, `origin: https://edanbot.digital`.

## Multi-user safety
Results never cross users: each generate returns a unique `job_id` and is polled per-id. The shared edanbot account only shares the **credit pool** (~200 credits per generation) and provider concurrency — not result ownership.

## Cookie pool
Cookies live in `edanbot_cookie_pool`. The bot tries available cookies in order,
marks a cookie dead after a pre-acceptance 401/403, and falls back to the
`EDANBOT_COOKIE` environment secret only when the pool has no available rows.
Admin commands: `/addedancookie` (newline-separated, `session=` prefix optional)
and `/edanpool`.

## Fragility
Cookie dies on logout/expiry → Edanbot-backed image-to-video requests 401. Recovery: user re-grabs the `session` cookie for edanbot.digital from browser DevTools and updates `EDANBOT_COOKIE`.

## Separate Kling v3 Pro image-to-video product

The user explicitly requested: “hapus kling v3 standar dan gantikan dengan kling v3 pro dari edanweb ini”, with the public name “Kling v3 Pro 1080”.

**Why:** This replaces the old Standard image-to-video offering, not the separate Kling v3 Turbo or any Motion Control package. Similar Kling naming must not cause unrelated routes to be migrated.

**How to apply:** Keep that replacement scoped to the former Standard offering. The submitted HAR verifies the Edanweb `kling-3` image-to-video flow at 9:16, 15 seconds, 1080p, audio enabled, with start/end images; this is distinct from Edanweb motion-control models.
