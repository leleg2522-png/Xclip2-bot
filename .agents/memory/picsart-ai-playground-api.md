---
name: Picsart AI Playground internal API
description: Reverse-engineered (undocumented) endpoints + flow for generating video/image via picsart.com/ai-playground, used by the telegram-bot Picsart backend
---

# Picsart AI Playground internal API (undocumented, reverse-engineered from HAR)

Host: `https://api.picsart.com`, uploads on `https://upload.picsart.com`, result media on `https://cdn-editing-temp.picsart.com`.

## Auth — session/cookie based (the fragile part)
- Requests carry NO stable API key. Auth is the logged-in browser **session cookie** (and possibly a bearer token). Chrome "Save as HAR" **sanitizes** cookies + `authorization`, so they never appear in a plain HAR — must grab via "Copy as cURL" instead.
- **Why it matters:** the bot must impersonate a real logged-in Picsart session. The cookie/token **expires** (hours–days). When it dies, every call 401s and the user must re-capture and update the stored credential. This is inherent to the API-interception approach; there is no service-account path.
- Required custom headers on every call: `deviceid: <a.c....>`, `platform: website`, `x-touchpoint: com.picsart.ai-playground`, `origin: https://picsart.com`, `referer: https://picsart.com/`. `deviceid` is tied to the captured session.

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
