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
The user approved reading TXT files into the normal prompt flow, not enabling
Picsart's paid draft-to-final video feature.

**How to apply:** To support TXT documents in Telegram, read the document
locally and send its decoded contents through the existing text parameter.
Do not claim a file bypasses the model's text limit, or that the bot's
20,000-character validation is an officially verified Picsart limit.

## Playground storage limit for long prompts

A real paid Playground test with exactly 20,000 ASCII prompt characters was
accepted, then failed during result polling with `save_to_drive_failed_bad_request`:
`'attributes' Attribute value must not exceed 20000 characters`.
The original request duplicated the prompt inside Drive `aiSDKPayload`, alongside
other metadata. Acceptance therefore does not establish successful long-prompt
generation or delivery.

A subsequent real paid T2V test completed with the same full 20,000-character
ASCII prompt in `content[].text` after removing the duplicate `prompt` from
Drive `aiSDKPayload`. The result was a native 30-second video with audio,
and mandatory external 1080p finishing also completed while preserving audio.
This verifies that contract, not a universal model prompt maximum or every
reference modality.

**Why:** The storage failure occurs after paid submission. Treating the bot's
20,000-character input limit as an end-to-end verified allowance can consume
provider credits without producing a deliverable.

**How to apply:** Keep the full generation prompt in `content[].text`, not a
duplicate inside Drive metadata, and validate serialized attributes before
paid submission. Do not silently truncate prompts or replay accepted jobs.
Verify finishing separately before claiming delivered 1080p.

## Separate Edan Bot reference evidence

### Approved public product

Keep the original Picsart Seedance 2.5 product unchanged and offer the Edan
route as a separate **Seedance 2.5 P2** product: **30 seconds, Rp4,500,
native 720p delivery without Renderful finishing**. Do not expose the provider
name to customers or introduce 10/20-second tariffs without approval.

**Why:** The user selected “Tambahkan opsi Edan Bot” rather than replacing
Picsart, then specified “30 detik 4,5k” and “720p langsung”.

**How to apply:** Keep provider selection, tariffs and delivery policies
separate. The original Picsart route still requires 1080p finishing and retains
its existing price; P2 must not inherit that finishing or change the old route.

### Captured evidence and limits

A separate Edan Bot capture shows a completed Seedance 2.5 job submitted with
one uploaded image and one uploaded video reference. The request selected
30 seconds, 720p and 16:9. This is evidence for Edan's contract, not a direct
Picsart Playground submit or proof of the output file's measured resolution.

Edan uses `/api/uploads` for images, `/api/reference-uploads/media` for videos
(multipart `file`, `model`, `duration`), then `/api/generate` with
`model: seedance-2.5` and `fields.reference_images` / `fields.reference_videos`,
alongside `prompt`, `aspect_ratio`, `duration`, and `resolution`.
Polling is `/api/jobs/{job_id}`; the capture reaches `completed` with result
and download URLs. Some earlier reference uploads returned HTTP 500; a later,
different video succeeded. This does not establish a universally reliable
upload flow.

**Why:** Edan's browser API, internal credit amounts and reference-field names
are different from the Picsart gateway used by the original bot route.

**How to apply:** Do not put Edan `reference_images` / `reference_videos` into
Picsart's payload, infer Edan's upstream provider, or swap the existing
Picsart route merely because this capture was supplied. The user has approved
the separate P2 option above, not a replacement.

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
on their original provider. The historical Picsart HAR verifies image references
but not a submitted reference video. The separate completed Edan capture above
does not establish a live direct-Picsart video-reference test.
