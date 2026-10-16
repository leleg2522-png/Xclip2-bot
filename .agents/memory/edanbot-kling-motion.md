---
name: Kling Motion package routing and Edanbot
description: P2/P3 Edan Bot native delivery, P4 Standard, P5 Alriz 2.6 Pro, and preserved finishing policies.
---

# Current Kling Motion routing

P2/P3 use the HAR-verified Edan Bot generation flow and model key
`kling-motion-26-pro--secondary`. Deliver the provider result directly without
Renderful finishing; keep the public package labels and prices separate. P4
remains on Kling V3 Standard. P5 uses Alriz `mc-kling-2.6-pro`.
Both P4 and P5 retain mandatory 1080p finishing.

**Why:** The user explicitly switched P2/P3 to the newly supplied Edan Bot HAR
and then clarified that Renderful upscaling is not needed for those packages.
This supersedes the earlier P2/P3-to-P5 routing decision only for P2/P3.
The user later requested: “gw ingin kling mc p5 di ganti kling mc 2,6 pro dari alriz”.
That change applies to P5 only, not P4 or P2/P3; it does not request removal
of P5's existing finishing.

**How to apply:** Keep P2/P3 native output claims limited to “resolution follows
the model result”; do not promise 1080p without new evidence. Preserve full
refunds on generation or delivery failure and never replay ambiguous/accepted
paid submissions. Keep P4/P5 and Xclip Motion finishing policies unchanged.

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

## Edan Bot flow

**Hard rule:** never let any user-facing string (reply/caption/error/filename) leak `edanbot`/`roboneo`/`wavespeed`/`openart`/`meitu`/`meitudata`, and never send the raw `result_url` as a link — always re-upload bytes.

## Model variants
- P2 and P3 both submit the HAR-verified public model key `kling-motion-26-pro--secondary`.
- The HAR response's internal model/provider fields are implementation details and must remain hidden from customers.

**Why:** The latest supplied HAR completed a Kling MC generation with this key; older HAR evidence used a different key.

**How to apply:** Submit `kling-motion-26-pro--secondary` for both P2 and P3 while preserving their separate public labels and prices; the prompt entered after the reference video goes in `fields.prompt` (a `-` means empty prompt). Customer-facing text must not expose the key or supplier.

## API flow (single shared account)
- Auth: `EDANBOT_COOKIE` secret. It is the value of a Flask **signed** `session=` cookie. Normalize: prepend `session=` if missing (users often paste only the value → 401 without the prefix).
- **Never route edanbot via Decodo proxy:** on Railway the proxy answers 407 (proxy auth) for these calls. Use a plain no-proxy axios client. The cookie is signed, not IP-bound, so direct calls work from any IP.
- Steps: `POST /api/uploads` (multipart field `file`, once per image + once per video) → returns `.asset` object; `POST /api/generate` JSON `{model:<P2/P3 variant key>, fields:{prompt, image_url:<asset>, video_url:<asset>, reference_video_duration, character_orientation:'video', keep_original_sound:true}}` → `{job_id, credits}`; poll `GET /api/jobs/{job_id}` until `status:'completed'` (result_url) / `'failed'` / non-empty `.error`.
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
Cookie dies on logout/expiry → all P2 generations 401. Recovery: user re-grabs the `session` cookie for edanbot.digital from browser DevTools and updates `EDANBOT_COOKIE`.
