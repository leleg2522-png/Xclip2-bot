---
name: Picsart Seedance 2.5 API
description: Reverse-engineered submit/poll shape for the Picsart AI Playground Seedance 2.5 video model
---

# Picsart Seedance 2.5 (ByteDance) video API

## Official documentation versus historical capture

The public compatibility documentation now specifies up to **30 images,
10 videos, and 10 audios** for Seedance 2.5, including audio-only input.
The earlier ten-image limit was a bot restriction, not the model maximum.
The unified API uses `imageUrls`, `videoUrls`, and `audioUrls`; the compatibility
API uses `content` items with `image_url` / `video_url` / `audio_url` and roles
`reference_image` / `reference_video` / `reference_audio`.
`generate_audio` controls output audio, not uploading reference audio.
Unified docs label reference video and audio with a 30-second maximum but
do not clarify whether this is per file or cumulative. Compatibility docs
state input video duration is billed in addition to output duration.

**Why:** Official parameter documentation is broader than the historical HAR
and the public bot's deliberately restricted inputs. Do not mistake tested
inputs or bot limits for the provider's full capabilities.

**How to apply:** Consult
https://picsart.com/api-platform/models/seedance-2.5/advanced and
https://picsart.com/api-platform/models/seedance-2.5/api .
These public API-key docs do not prove that every feature works unchanged
on the bot's authenticated Playground gateway. Verify that gateway's behavior
before enabling new input modalities, and account for input-video costs.
Keep the user's selected 480p → external 1080p finishing route unless asked
to change it; documented draft-to-final rendering is a different paid flow.

## Multimodal reference scope

The user asked to adopt the documented image/video/audio references for public
Seedance 2.5. Treat videos as references for generating a new video, not as
authorization to restore the removed Video Edit or Extend products.
Keep the selected ratio for reference generation rather than letting automatic
task inference turn a reference video into an edit or extension.

**Why:** The user's request is multimodal reference generation; their earlier
removal of Seedance Video Edit still applies. Docs warn that automatic task
inference can select a different task and fail after a paid submit.

**How to apply:** Use explicit `omni_reference_task_type: reference` for
reference inputs. Until actual gateway limits are verified, apply conservative
aggregate 30-second video and 30-second audio budgets separately, and a 100MB
combined upload budget (19MB/file). Keep these conservative application limits
distinct from claims about the upstream model. Do not change the Rp6,000 tariff
automatically when accounting for upstream input-video costs.

## Draft versus text-file prompts

Picsart's documented `draft: true` is a paid 480p video preview, followed
optionally by a separately billed 1080p render using `draft_task` within
seven days. It is not a TXT document input or an increased prompt allowance.
The parameter pages document text strings (`prompt` or `content[].text`),
not `text_url`/TXT attachments, and do not state a maximum prompt length.

**Why:** “Draft” can be confused with a script document. The prompting blog
mentions scripts, but this does not establish a TXT upload API contract.

**How to apply:** To support TXT documents in Telegram, read the document
locally and send its decoded contents through the existing text parameter.
Do not claim a file bypasses the model's text limit, or that the bot's
20,000-character validation is an officially verified Picsart limit.

## Historical Playground contract

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

**How to apply:** The user explicitly requested returning public Seedance 2.5
from Alriz to Picsart. Use this verified Picsart contract without importing
Alriz-specific 1080p or start/end-frame assumptions. Keep already accepted jobs
on their original provider. The supplied HAR verifies image references but
not a submitted reference video; do not present unverified input roles as tested.
