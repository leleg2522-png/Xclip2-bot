---
name: Leonardo AI image-to-video endpoint
description: Correct REST endpoint and parameters for image-to-video on Leonardo AI, confirmed working
---

## Correct endpoint (confirmed via live API test)
`POST https://cloud.leonardo.ai/api/rest/v1/generations-image-to-video`

**Why:** `/generations/image2video` returns 405 (allowed: GET, DELETE). The correct path uses a hyphen and is a top-level resource.

## Request body
```json
{
  "prompt": "...",
  "imageId": "<uploadInitImage id>",
  "imageType": "UPLOADED",
  "resolution": "RESOLUTION_1080",
  "duration": 5,
  "height": 1080,
  "width": 1920,
  "model": "KLING2_1"
}
```

## imageType values
- `"UPLOADED"` — for images uploaded via `/init-image` (S3 presigned URL flow)
- `"GENERATED"` — for images from a prior `/generations` call

## Available model tokens (from API validation error, May 2026)
`MOTION2`, `MOTION2FAST`, `KLING2_1`, `KLING2_5`, `VEO3`, `VEO3FAST`, `VEO3_1`, `VEO3_1FAST`

**Kling 2.6 does NOT exist on Leonardo AI.** The next version after 2.5 is not yet available.

## Response
Returns `motionVideoGenerationJob.generationId` (not `sdGenerationJob.generationId`).

## Polling
`GET /generations/{generationId}` → `generations_by_pk.generated_images[0].motionMP4URL`
Status field: `PENDING` → `COMPLETE`

## Cost
~$0.613 per 5-second Kling 2.1 Pro video (as of May 2026).

## Aspect ratio → dimensions
- 16:9 → 1920×1080
- 9:16 → 1080×1920
- 1:1  → 1080×1080
