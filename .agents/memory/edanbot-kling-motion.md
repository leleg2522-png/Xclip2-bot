---
name: edanbot Kling Motion (hidden provider)
description: How the bot's "Kling MC V3 PRO P2" model is really edanbot.digital, and its fragile auth
---

# "Kling MC V3 PRO P2" = edanbot.digital (hidden)

The Telegram bot model shown to users as **"Kling MC V3 PRO P2"** (price key `kling_p2`, Rp4.200) is internally powered by **edanbot.digital**, which itself proxies **roboneo** (`provider:"roboneo"`, model `kling-motion-26-pro` = Kling Motion 2.6 Pro; result videos hosted on meitudata.com).

**Hard rule:** never let any user-facing string (reply/caption/error/filename) leak `edanbot`/`roboneo`/`meitu`/`meitudata`, and never send the raw `result_url` as a link — always re-upload bytes.

## API flow (single shared account)
- Auth: `EDANBOT_COOKIE` secret. It is the value of a Flask **signed** `session=` cookie. Normalize: prepend `session=` if missing (users often paste only the value → 401 without the prefix).
- **Why proxy-safe:** the session cookie is signed, NOT IP-bound — routing edanbot calls through Decodo proxy (freepikHttp) works fine and is safer vs blocks.
- Steps: `POST /api/uploads` (multipart field `file`, once per image + once per video) → returns `.asset` object; `POST /api/generate` JSON `{model:'kling-motion-26-pro', fields:{prompt, image_url:<asset>, video_url:<asset>, reference_video_duration, character_orientation:'video', keep_original_sound:true}}` → `{job_id, credits}`; poll `GET /api/jobs/{job_id}` until `status:'completed'` (result_url) / `'failed'` / non-empty `.error`.
- Headers: cookie + `user-agent`, `referer: https://edanbot.digital/dashboard`, `origin: https://edanbot.digital`.

## Multi-user safety
Results never cross users: each generate returns a unique `job_id` and is polled per-id. The shared edanbot account only shares the **credit pool** (~200 credits per generation) and provider concurrency — not result ownership.

## Cookie pool
Cookies now live in a DB table `edanbot_cookie_pool` (Railway PG) mirroring the other key pools: pick first `available`, validate via `/api/user/info` before use, mark `dead` on 401/403 (upfront or mid-flow), fall back to `EDANBOT_COOKIE` env only if pool empty. Admin commands: `/addedancookie` (newline-separated, `session=` prefix optional), `/edanpool`.

## Fragility
Cookie dies on logout/expiry → all P2 generations 401. Recovery: user re-grabs the `session` cookie for edanbot.digital from browser DevTools and updates `EDANBOT_COOKIE`.
