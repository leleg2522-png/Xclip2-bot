---
name: Picsart Seedance 2.5 API
description: Reverse-engineered submit/poll shape for the Picsart AI Playground Seedance 2.5 video model
---

# Picsart Seedance 2.5 (ByteDance) video API

Reverse-engineered from an AI Playground HAR. Follows the same access-token / `commonHeaders()` pattern as the other Picsart workflow models.

- **Submit:** `POST api.picsart.com/gw-v2/workflows/seedance/submit` → `{response:{id}}`
  - Body: `{"params":{ "model":"seedance_2_5", "content":[ optional {"type":"video_url","video_url":{"url":...},"role":"reference_video"}, {"type":"image_url","image_url":{"url":...},"role":"reference_image"} × up to 10, {"type":"text","text":<prompt>} ], "ratio":"9:16"|"16:9"|..., "duration":15|30, "resolution":"480p"|"720p", "generate_audio":true, "output_format":"mp4", "options":{"drive":{name, attributes:{model:"seedance-2.5", aiSDKPayload:<stringified>, appId:"com.picsart.ai-playground", appType:"miniapp"}, folder:{path:"AI Playground"}}}}}`
  - Note the underscore in the model id (`seedance_2_5`) vs the hyphen in `attributes.model` (`seedance-2.5`).
- **Poll:** `GET api.picsart.com/gw-v2/workflows/seedance/{id}/result`
  - Statuses seen: `ACCEPTED` → `IN_PROGRESS` (with `progress.percent`) → `COMPLETED`.
  - On COMPLETED, video is at `response.result.video_url` (NOT `.url` or `.videoUrl` — differs from Kling/Runway/Sora/Gemini).
  - Options probe reports 120 credits for 30s 480p with audio and 210 credits for 30s 720p with audio.
- **Reference upload:** images and video use `POST upload.picsart.com/v2/files` (multipart, `type=editing-temp`).
- **Options probe:** `POST /gw-v2/workflows/seedance/options`; the HAR verifies both 480p and 720p with 30s audio.

**How to apply:** This HAR documents a historical Picsart contract only. The user
subsequently asked to switch the public Seedance 2.5 offering to Alriz and
expose every supported parameter. Do not route new public orders to Picsart,
Wan or the legacy bridge; keep legacy completion paths for jobs already in
flight. The supplied HAR verifies image references but not a submitted video.
