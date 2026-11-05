---
name: SnapGen MUSE product requirements
description: Requested image/video packages, selling price, and documentation identity safeguards.
---

The user wants both MUSE AI Image and MUSE AI Video in the existing Telegram
bot. MUSE Image costs Rp500 per generated image; MUSE Video costs Rp500
per generated video.

**Why:** The user selected “Gambar dan video” and supplied “1000” when asked for
the selling price per result, then revised the image price with “untuk muse
gambar harga 500” and the video price with “harga 500 per video”.

**How to apply:** Keep image and video choices distinct and use the existing
saldo and failed-delivery refund rules. This selling-price decision does not
authorize owner-funded live generation tests or establish video durations.

Do not treat a public model-status listing as an API request contract. Verify
that any documentation actually describes the existing api.snapgen.ai service.

**Why:** Official snapgen.ai status lists MUSE image and video, while searches
also return docs.snapgen.org using a different API format. The official
docs.snapgen.ai introduction identifies api.snapgen.ai and x-api-key auth;
the similarly named documentation host must not be assumed interchangeable.

**How to apply:** Require provider-specific endpoint and payload evidence before
adding paid submits; do not guess a MUSE endpoint from other model families.

Do not substitute Vela Image for MUSE Image based on legacy "Meta AI" naming.

**Why:** Inspection of SnapGen's public frontend found an image helper named
Meta AI that explicitly labels its result `vela-ai-image` and posts to
`/vela/generate`. A separate Muse video helper uses the browser's
`/video-gen/meta` route. These names do not establish a MUSE image UAPI contract.

**How to apply:** Verify both the actual model identity and API-key endpoint
before spending credits. Browser-session forms are not proof that an equivalent
UAPI route accepts the same fields.

Use the official documentation download when individual documentation pages
cannot be read: `https://docs.snapgen.ai/downloads/docs-content.zip`.

**Why:** The documentation is client-rendered; its own header exposes this
archive of original Markdown. It supplied the actual MUSE UAPI contract after
ordinary page fetching and public application bundles did not.

**How to apply:** Read the archive's MUSE video resource. It specifies
`POST /uapi/v1/video-gen/muse`, multipart form fields `prompt`,
`model=muse-ai-video`, `duration=10`, and `orientation`. Optional reference
fields accept up to ten images combined; output resolution is not selectable.
Do not copy the illustrative 20-credit response into pricing assumptions:
the live accepted test returned an estimate of 1 credit. Always use actual API
billing fields. The archive documents Vela Image separately, not MUSE Image.

## Vela image-to-video

The official Vela UAPI is `POST /uapi/v1/video-gen/vela`, multipart with
`model=vela-ai-video`, `duration=5`, `resolution=480p|720p`, `orientation`,
`prompt`, and repeated `files`. The first uploaded image is the start frame;
the second is the optional end frame. Keep Vela separate from MUSE.

**Why:** The user requested Vela I2V, then explicitly requested a live test.
One 720p, five-second, single-image test was accepted with an estimate of one
credit, but failed with `HIGH_TRAFFIC_ERROR` and `used_credit=0`. This proves
request acceptance, not completed Vela output. The provider advised retrying
after 30 minutes; that is not authorization to resubmit.

**How to apply:** Do not promise successful Vela generation from this test or
assume the illustrative 40-credit documentation response is the actual charge.
SnapGen account balance is nested in `user_credit.available_credit` and
`user_credit.locked_credit`, not a numeric `user_credit` value.
