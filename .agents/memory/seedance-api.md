---
name: Picsart Seedance 2.5 API
description: Reverse-engineered submit/poll shape for the Picsart AI Playground Seedance 2.5 video model
---

# Picsart Seedance 2.5 (ByteDance) video API

Reverse-engineered from an AI Playground HAR. Follows the same access-token / `commonHeaders()` pattern as the other Picsart workflow models.

- **Submit:** `POST api.picsart.com/gw-v2/workflows/seedance/submit` → `{response:{id}}`
  - Body: `{"params":{ "model":"seedance_2_5", "content":[ {"type":"image_url","image_url":{"url":...},"role":"reference_image"} × up to 5, {"type":"text","text":<prompt>} ], "ratio":"9:16"|"16:9"|..., "duration":15|30, "resolution":"480p"|"720p", "generate_audio":true, "output_format":"mp4", "options":{"drive":{name, attributes:{model:"seedance-2.5", aiSDKPayload:<stringified>, appId:"com.picsart.ai-playground", appType:"miniapp"}, folder:{path:"AI Playground"}}}}}`
  - Note the underscore in the model id (`seedance_2_5`) vs the hyphen in `attributes.model` (`seedance-2.5`).
- **Poll:** `GET api.picsart.com/gw-v2/workflows/seedance/{id}/result`
  - Statuses seen: `ACCEPTED` → `IN_PROGRESS` (with `progress.percent`) → `COMPLETED`.
  - On COMPLETED, video is at `response.result.video_url` (NOT `.url` or `.videoUrl` — differs from Kling/Runway/Sora/Gemini).
  - Options probe reports 120 credits for 30s 480p with audio and 210 credits for 30s 720p with audio.
- **Ref image upload:** same `POST upload.picsart.com/v2/files` (multipart, `type=editing-temp`) as other models; returns a `cdn-editing-temp.picsart.com` url.
- **Options probe:** `POST /gw-v2/workflows/seedance/options`; the HAR verifies both 480p and 720p with 30s audio.

**How to apply:** The native contract supports 480p and 720p, but the public Seedance
2.5 route intentionally exposes only 30s 480p, 9:16, audio enabled, using p500 accounts. Keep the
legacy Wan/bridge paths available only for unrelated or already-queued work.
