---
name: Kling Motion package routing and legacy Edanbot
description: P2/P3/P4 follow P5; older backend notes are legacy-only and supplier identities stay hidden.
---

# Current Kling Motion routing

P2/P3 use the HAR-verified Edan Bot generation flow and model key
`kling-motion-26-pro--secondary`. Deliver the provider result directly without
Renderful finishing; keep the public package labels and prices separate. P4 and
P5 remain on Kling V3 Standard with mandatory 1080p finishing.

**Why:** The user explicitly switched P2/P3 to the newly supplied Edan Bot HAR
and then clarified that Renderful upscaling is not needed for those packages.
This supersedes the earlier P2/P3-to-P5 routing decision only for P2/P3.

**How to apply:** Keep P2/P3 native output claims limited to “resolution follows
the model result”; do not promise 1080p without new evidence. Preserve full
refunds on generation or delivery failure and never replay ambiguous/accepted
paid submissions. Keep P4/P5 and Xclip Motion finishing policies unchanged.

## Edan Bot flow

**Hard rule:** never let any user-facing string (reply/caption/error/filename) leak `edanbot`/`roboneo`/`wavespeed`/`openart`/`meitu`/`meitudata`, and never send the raw `result_url` as a link — always re-upload bytes.

## Model variants
- P2 and P3 both submit the HAR-verified public model key `kling-motion-26-pro--secondary`.
- The HAR response's internal model/provider fields are implementation details and must remain hidden from customers.

**Why:** The latest supplied HAR completed a Kling MC generation with this key; older HAR evidence used a different key.

**How to apply:** Submit `kling-motion-26-pro--secondary` for both P2 and P3 while preserving their separate public labels and prices; the prompt entered after the reference video goes in `fields.prompt` (a `-` means empty prompt). Customer-facing text must not expose the key or supplier.

**Rule:** A HAR containing only job polling and result downloads cannot establish a provider-selection parameter for generation.

**Why:** The supplied HAR showed a completed Dropshot job but no upload or generate POST; its internal model identifier differed from its public model key.

**How to apply:** Distinguish the public submit key from the internal response model. Compare the existing integration before claiming a backend change, and do not invent a provider field or a direct Dropshot API from a CDN result URL. Require a sanitized upload/generate capture to investigate forced provider routing.

## API flow (single shared account)
- Auth: `EDANBOT_COOKIE` secret. It is the value of a Flask **signed** `session=` cookie. Normalize: prepend `session=` if missing (users often paste only the value → 401 without the prefix).
- **Never route edanbot via Decodo proxy:** on Railway the proxy answers 407 (proxy auth) for these calls. Use a plain no-proxy axios client. The cookie is signed, not IP-bound, so direct calls work from any IP.
- Steps: `POST /api/uploads` (multipart field `file`, once per image + once per video) → returns `.asset` object; `POST /api/generate` JSON `{model:<P2/P3 variant key>, fields:{prompt, image_url:<asset>, video_url:<asset>, reference_video_duration, character_orientation:'video', keep_original_sound:true}}` → `{job_id, credits}`; poll `GET /api/jobs/{job_id}` until `status:'completed'` (result_url) / `'failed'` / non-empty `.error`.
- Headers: cookie + `user-agent`, `referer: https://edanbot.digital/dashboard`, `origin: https://edanbot.digital`.

## Multi-user safety
Results never cross users: each generate returns a unique `job_id` and is polled per-id. The shared edanbot account only shares the **credit pool** (~200 credits per generation) and provider concurrency — not result ownership.

## Cookie pool
Cookies now live in a DB table `edanbot_cookie_pool` (Railway PG) mirroring the other key pools: pick first `available`, validate via `/api/user/info` before use, mark `dead` on 401/403 (upfront or mid-flow), fall back to `EDANBOT_COOKIE` env only if pool empty. Admin commands: `/addedancookie` (newline-separated, `session=` prefix optional), `/edanpool`.

## Fragility
Cookie dies on logout/expiry → all P2 generations 401. Recovery: user re-grabs the `session` cookie for edanbot.digital from browser DevTools and updates `EDANBOT_COOKIE`.
