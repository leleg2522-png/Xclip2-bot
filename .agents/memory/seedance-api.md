---
name: Picsart Seedance 2.5 API
description: Reverse-engineered submit/poll shape for the Picsart AI Playground Seedance 2.5 video model
---

# Picsart Seedance 2.5 (ByteDance) video API

Reverse-engineered from an AI Playground HAR. Follows the same access-token / `commonHeaders()` pattern as the other Picsart workflow models.

- **Submit:** `POST api.picsart.com/workflows/seedance/submit` → `{response:{id}}`
  - Body: `{"params":{ "model":"seedance_2_5", "content":[ {"type":"image_url","image_url":{"url":...},"role":"reference_image"} × up to 5, {"type":"text","text":<prompt>} ], "ratio":"9:16"|"16:9"|..., "duration":15|30, "resolution":"480p", "generate_audio":true, "output_format":"mp4", "options":{"drive":{name, attributes:{model:"seedance-2.5", aiSDKPayload:<stringified>, appId:"com.picsart.ai-playground", appType:"miniapp"}, folder:{path:"AI Playground"}}}}}`
  - Note the underscore in the model id (`seedance_2_5`) vs the hyphen in `attributes.model` (`seedance-2.5`).
- **Poll:** `GET api.picsart.com/workflows/seedance/{id}/result`
  - Statuses seen: `ACCEPTED` → `IN_PROGRESS` (with `progress.percent`) → `COMPLETED`.
  - On COMPLETED, video is at `response.result.video_url` (NOT `.url` or `.videoUrl` — differs from Kling/Runway/Sora/Gemini).
  - Credits used at `response.usage.credits` (observed 120 for a 30s 480p run).
- **Ref image upload:** same `POST upload.picsart.com/v2/files` (multipart, `type=editing-temp`) as other models; returns a `cdn-editing-temp.picsart.com` url.
- **Options probe:** `POST /workflows/seedance/options` shows defaults `ratio:"16:9", duration:5, resolution:"720p", generate_audio:false` — the playground UI overrides these; our bot forces 480p and 15/30.

**How to apply:** Keep this as protocol reference only; the public Seedance 2.5
product is currently routed through the Wan Prime backend and must not silently
switch back to this native contract. If the native model is intentionally restored,
re-capture a real generation HAR before exposing it.
