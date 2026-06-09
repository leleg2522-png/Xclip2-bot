---
name: Picsart AI Playground internal API
description: Reverse-engineered (undocumented) endpoints + flow for generating video/image via picsart.com/ai-playground, used by the telegram-bot Picsart backend
---

# Picsart AI Playground internal API (undocumented, reverse-engineered from HAR)

Host: `https://api.picsart.com`, uploads on `https://upload.picsart.com`, result media on `https://cdn-editing-temp.picsart.com`.

## Auth — refresh-token exchange (VERIFIED live against the API)
- Two tokens (from signin `POST /user-account/auth/signin` body `{username,password,redirectAfterEmailConfirmation}` → `{token:{access_token, refresh_token, expires_in:1799, refresh_token_expires_in:2591999}}`):
  - **access_token**: JWT Bearer, scope `user-global`, lives ~30 min (`expires_in` 1799s).
  - **refresh_token**: `rt:...` string (~178 chars), lives ~30 DAYS (`refresh_token_expires_in` ~2591999s).
- **Refresh (the mechanism the bot uses):** `POST https://api.picsart.com/oauth2/refresh` with JSON body `{"refresh_token":"rt:..."}` and header `x-app-authorization: Bearer <STATIC app token>`. Returns `{response:{access_token, refresh_token, id_token, scope, token_type:"Bearer", expires_in:1799, refresh_token_expires_in, active}}`. The browser sends an empty `{}` body (rt rides in an httpOnly cookie) but the API ALSO accepts the rt in the JSON body — that is the clean path for a server.
- **The refresh token is REUSABLE — it does NOT rotate.** Calling refresh twice with the same rt both return 200. So: user pastes their `rt:` once, bot exchanges it for a fresh access_token on demand for ~30 days. No rotation bookkeeping needed; just re-prompt the user when the rt finally expires (or any refresh returns 400 `invalid_arguments` / `Refresh token should be present`).
- **`x-app-authorization`** is a STATIC, public app-level JWT (iat 2023, no exp, empty scope) — a constant, same for every user. Captured once from any HAR `/oauth2/refresh` request; hardcode it as the app token. It is NOT the user's token.
- Normal API calls (upload/submit/poll/credits) use `authorization: Bearer <access_token>` (the user token), NOT x-app-authorization.
- Required custom headers on every call: `deviceid: <a.c....>`, `platform: website`, `x-touchpoint: com.picsart.ai-playground`, `origin: https://picsart.com`, `referer: https://picsart.com/`. `deviceid` can be any stable value of that shape; the captured one works.
- **Verified:** refresh→access_token→`GET /guard/credits` returned 200 with a real balance, proving the whole chain works from a plain server (Replit), no browser/cookie needed.

## Flow (i2v / video-to-video example: Kling Motion Control)
1. **Upload media** → `POST https://upload.picsart.com/v2/files`, multipart form fields `file` (binary) + `type`. Returns `{response:{url, download_url}}` pointing at `cdn-editing-temp.picsart.com/editing-temp/{uuid}.ext`.
2. (optional, board only) `POST /cloud-storage/v1/me/files` with `{name, sourceUrl, content, preview, attributes}` to save into the user's library. Not required for generation.
3. (optional, cost preview) `POST /workflows/{model}/options` with same `params` → returns `{response:{monetization, usageAmount, credits}}`.
4. **Submit** → `POST /workflows/{model}/submit` with `{"params":{prompt, image_url, video_url, character_orientation, mode, keep_original_sound, model_name, options:{...}}}`. Returns `{response:{id}}`.
5. **Poll** → `GET /workflows/{model}/{id}/result`. Returns `{response:{status, result, usage}}`. status goes `ACCEPTED` → `COMPLETED` (watch for `FAILED`). On COMPLETED: `result:{url, mimeType, duration}`. Web polls aggressively (~every 0.2–1s).
6. **Download** the `result.url` (.mp4/.png on cdn-editing-temp).

## Endpoint path differs per model family — do NOT hardcode one shape
- Kling Motion Control: submit `/workflows/kling-motion-control/submit`, poll `/workflows/kling-motion-control/{id}/result`, `model_name:"kling-v3"`.
- Grok Imagine (x-ai) video: poll `/workflows/x-ai/v1/videos/generations/{id}/result` (different nested shape). Each workflow/model has its own sub-path + payload schema; capture per model before relying on it.

## Other endpoints
- Credits: `GET /guard/credits` → `{credits, tierCredits, addonCredits, renewDate}`.
- Library list: `GET /cloud-storage/v1/me/files?...`; spaces: `GET /cloud-storage/v1/me/storages`.
