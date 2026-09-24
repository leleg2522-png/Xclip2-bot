---
name: edanbot Kling Motion (hidden suppliers)
description: Hidden Kling Motion variants, observed upstream routing, and fragile session-cookie auth
---

# Kling Motion variants = edanbot.digital (hidden)

The Telegram bot's Kling Motion P2 and P3 models are internally powered by **edanbot.digital**. Both now submit the latest HAR-verified public model key `kling-motion-26-pro`, which resolves internally to Kling Motion 2.6 Pro.

**Hard rule:** never let any user-facing string (reply/caption/error/filename) leak `edanbot`/`roboneo`/`wavespeed`/`openart`/`meitu`/`meitudata`, and never send the raw `result_url` as a link — always re-upload bytes.

## Model variants
- P2 and P3 both use public model key `kling-motion-26-pro`.
- The latest HAR reported `provider: "dropshot"` for this key; upstream routing is not a permanent contract and must remain hidden from customers.

**Why:** The user explicitly replaced both public P2 and P3 backends with the newly supplied HAR flow and model key.

**How to apply:** Submit `kling-motion-26-pro` for both P2 and P3 while preserving their separate public labels and prices; the prompt entered after the reference video goes in `fields.prompt` (a `-` means empty prompt). Customer-facing text must not expose the key.

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
