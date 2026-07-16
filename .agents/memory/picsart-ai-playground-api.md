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
- **Refresh (the mechanism the bot uses):** `POST https://api.picsart.com/oauth2/refresh` with JSON body `{"refresh_token":"rt:..."}` and header `x-app-authorization: Bearer <STATIC app token>`. Returns `{response:{access_token, refresh_token:"" (EMPTY), id_token, scope, token_type:"Bearer", expires_in:1799, refresh_token_expires_in, active}}`. The browser variant sends empty `{}` body + the rt in a `REFRESH_TOKEN` cookie and NO x-app-authorization; the body+x-app-auth path is the clean server path (verified 200 from Replit, no Cloudflare/cf_clearance needed).
- **Token is REUSABLE but ALSO ROTATES each call (verified live):** every successful refresh returns a NEW rt via `Set-Cookie: REFRESH_TOKEN=rt:...` (len ~178); the response BODY's `refresh_token` field is empty. The old rt is reusable for a FEW calls, but eventually reuse-detection kills it (verified: a token reused several times started returning 400 on refresh). So the safe design is to ALWAYS capture the rotated `REFRESH_TOKEN` from Set-Cookie and advance to it for the next refresh, mirroring the browser. Account MUST be dedicated to the bot (concurrent use elsewhere rotates the token out from under it). Re-prompt the user for a new rt when a refresh returns 400/401/403.
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
- Kling Motion Control: submit `/workflows/kling-motion-control/submit`, poll `/workflows/kling-motion-control/{id}/result`. Per HAR Jul 2026 the playground moved to `model_name:"kling-v2-6"` with `mode:"pro"`; `options.drive.attributes` shape also changed to `{model:"kling-motion-control", aiSDKPayload:"<JSON string: prompt, resolution 1080p, renderingSpeed pro, characterOrientation video, keepOriginalSound yes, imageUrls[], videoUrl>", appId:"com.picsart.ai-playground", appType:"miniapp"}` (old tool/subType/service/textScript attrs gone). Model strings on this endpoint rotate — recapture HAR when a generate starts failing.
- Grok Imagine (x-ai) video: poll `/workflows/x-ai/v1/videos/generations/{id}/result` (different nested shape). Each workflow/model has its own sub-path + payload schema; capture per model before relying on it.

## Grok Imagine — image-to-video (implemented in bot)
- Model string `grok-imagine-video-1.5-preview`. **Always image-to-video** (requires a reference image); toolId `image-to-video.grok-imagine-video-1.5-preview.720p` (fixed 720p).
- Submit: POST `/workflows/x-ai/v1/videos/generations/submit` with `{params:{model, prompt, image:{url}, duration(NUMBER), aspect_ratio}}`. (Browser also nests an `options.drive{...}` library-save block; omitted — not needed for generation, mirrors Seedance.)
- Result: GET `/workflows/x-ai/v1/videos/generations/{id}/result` → **`response.result.url`** (NOT `video_url` like Seedance), credits at `response.usage.credits`, status ACCEPTED→COMPLETED. Pricing ~5 credits/sec (durations 10/12/15 seen).

## Kling V3 image-to-video (implemented in bot) — distinct from text-to-video
- Endpoint family `/workflows/kling-image-to-video/{submit, {id}/result}` (DIFFERENT from `kling-text-to-video`). ONE submit endpoint serves BOTH sub-modes.
- Submit: POST `/workflows/kling-image-to-video/submit` with `{params:{prompt, aspect_ratio, duration(STRING e.g. "15"), model_name:"kling-v3", image:<startUrl>, image_tail?:<endUrl>, mode:"pro", multi_shot:false, shot_type:"customize"}}`.
  - **image-to-video** = `image` only (single ref photo).
  - **start frame + end frame** = `image` (start) + `image_tail` (end).
  - Browser also sends `static_mask` (product-lock mask) + `options.drive{...}` library-save block — BOTH OMITTED in bot (mask not needed; drive mirrors Seedance omission). Verified COMPLETED without them is the captured browser run's shape; bot omits the extras.
- Result: GET `/workflows/kling-image-to-video/{id}/result` → status ACCEPTED/IN_PROGRESS→COMPLETED (watch FAILED), **`response.result.url`** (.mp4), `response.result.duration`, credits `response.usage.credits`, progress `response.progress.percent`. Verified live: 15s pro = 45 credits.
- Pricing pre-check reuses `/workflows/kling-text-to-video/options` (same body) → toolId `text-to-video.kling-v3.pro`; pro ~3 credits/sec (10s=30, 15s=45). `image` field is `image_url` STRING here (NOT `{url}` object like Grok).
- The earlier `pichar_baru` HAR only had `kling-text-to-video` (t2v: submit `{prompt, aspect_ratio, duration(STRING), model_name:"kling-v3", sound:"on", mode:"4k", multi_shot, shot_type}`, toolId `text-to-video.kling-v3.4k.audio`). NOT used by the bot.

## Other endpoints
- Credits: `GET /guard/credits` → `{credits, tierCredits, addonCredits, renewDate}`.
- Library list: `GET /cloud-storage/v1/me/files?...`; spaces: `GET /cloud-storage/v1/me/storages`.

## Seedance 2.0 (image/text-to-video)
- Submit: POST `/workflows/seedance/submit` with `{params:{model:"seedance_2_0", content:[...], ratio, duration(NUMBER), resolution, generate_audio}}`.
- content: i2v = `[{type:"image_url",image_url:{url},role:"reference_image"},{type:"text",text}]`; t2v = text item only.
- Result: GET `/workflows/seedance/{id}/result` → **`response.result.video_url`** (GOTCHA: NOT `result.url` like Kling), credits at `response.usage.credits`, status COMPLETED.
- Pricing pre-check endpoint `/workflows/seedance/options` mirrors the submit body (no `drive` wrapper). Proven combo 9:16/15s/1080p/audio = 180 credits.

- Submit endpoint `/workflows/seedance/submit` (NOT captured in HAR, inferred from Kling pattern) is CONFIRMED working in production (i2v, 9:16/15s/1080p/audio) — full flow upload->submit->poll->video_url verified live.

## Seedance 2.0 regular vs fast (both implemented in bot)
- Same `/workflows/seedance/submit` + `/{id}/result` endpoints for BOTH. Fast = model `seedance_2_0_fast` with image role `reference_image`; regular/premium = model `seedance_2_0` with image role **`first_frame`** (per HAR — the role differs per model string). Result stays at `response.result.video_url`.

## Wan 2.7 (implemented in bot)
- i2v: POST `/workflows/wan/v2/image-to-video/submit` `{params:{media:[{type:"first_frame",url}], resolution:"720P"|"1080P", duration(NUMBER), prompt_extend:true, prompt}}` — NO ratio (follows the image). t2v: POST `/workflows/wan/v2/text-to-video/submit` `{params:{prompt, resolution, ratio, duration, prompt_extend:true}}` (t2v submit shape inferred from its /options call — verify on first live run).
- **Resolution casing gotcha:** wan + happyhorse want UPPERCASE `"720P"/"1080P"`; seedance wants lowercase `"720p"`.
- Result: GET same family `/{id}/result` → `response.result.url`, credits `response.usage.credits`.

## Happy Horse 1.1 (implemented in bot)
- POST `/workflows/happyhorse/v1.1/reference-to-video/submit` `{params:{prompt, media:[{type:"reference_image",url}], resolution:"1080P", ratio, duration, watermark:false}}` — image REQUIRED. Result `/{id}/result` → `response.result.url`. HAR: 15s 1080P = 60 credits (~4 cr/s).

## Runway Gen-4.5 (implemented in bot)
- POST `/workflows/runway-gen4-5-image-to-video/submit` `{params:{promptText, promptImage:[{uri,position:"first"}], ratio, duration}}` — image REQUIRED; **ratio is PIXEL format**: 9:16→`"720:1280"`, 16:9→`"1280:720"`, 1:1→`"960:960"` (NOT "9:16"). Result `/{id}/result` → `response.result.url`. HAR: 10s = 10 credits (cheapest per-second model).

## Image generation (AI Playground) — GPT Image 2 + Nano Banana Pro/2
- GPT Image 2 model string `gpt-image-2`. Text->image: POST `/workflows/openai-images-generate/submit`; multi-image edit (reference photos): POST `/workflows/openai-image-editing/submit` adding `images:[urls]`. Body `{params:{prompt, model, n:1, size, quality:"high", output_format:"png", options.drive{...}}}`. Poll on the SAME workflow path used for submit.
- GPT allowed sizes (from the LIVE API 400 error, authoritative): `1024x1024`, `1536x1024`, `1024x1536`, `auto`. Use 9:16=`1024x1536`, 16:9=`1536x1024`, 1:1=`1024x1024`. **Why:** the HAR showed `1024x1824` but prod rejects it (`size has wrong value 1024x1824`); a captured HAR value can be stale — trust the live API's own error message over both the HAR and generic OpenAI/DALL-E presets.
- Nano Banana Pro/2 both use POST `/workflows/gemini/v2/images/submit` (poll `/workflows/gemini/v2/images/{id}/result`). Body `{params:{prompt, model, count:1, aspectRatio:"9:16"|"16:9"|"1:1", imageSize:"4K"(highest), thinkingConfig, imageUrls?:[...refs], options.drive{...}}}`. Pro = model `gemini-3-pro-image-preview` + `thinkingConfig:{thinkingBudget:128}`; Banana2 = `gemini-3.1-flash-image-preview` + `thinkingConfig:{thinkingLevel:"MINIMAL"}`.
- COMPLETED result shape for image workflows was NOT captured (HAR only had ACCEPTED). Bot uses a defensive extractor: result.url → result.images[0](.url) → result[0] → result.data[0] → recursive first-http-string fallback.

## Video-model input matrix (from HAR)
- **Gemini Omni** (`/workflows/gemini-omni/video/submit`) accepts a reference **video**: `video:{url}` — URL only, NO mimeType. But video ONLY ever appears alongside an `image:{url,mimeType}`, never alone. Treat v2v as photo+video+prompt.
- **Sora 2** (`/openai/v1/videos/submit`) accepts only an image via `input_reference_url` — NO video input. Sora = prompt/photo only.

## Seedream (Jul 2026, live-verified)
- POST `/workflows/seedream/submit` — params `{ prompt, model, count, resolution, aspect_ratio, image:[urls]? }`; poll `/workflows/seedream/{id}/result` → COMPLETED `result.urls[0]`.
- Model `seedream_4_5` max 4K; `seedream_5_0_pro` HANYA 1K/2K (4K ditolak invalid_request). Rasio 1:1/9:16/16:9/3:4/4:3/2:3/3:2/21:9 semua diterima. Multi-referensi i2i via array `image`.
- `/workflows/<x>/options` = pre-check harga gratis (tidak charge) — cocok validasi param tanpa biaya.
