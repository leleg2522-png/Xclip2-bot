---
name: Picsart Kling 4 API evidence
description: Captured Kling 4 T2V completion, I2V quote acceptance, native settings, and verification limits.
---

# Kling 4 contracts

The user requested both image-to-video and text-to-video as new bot features,
separate from Kling Motion Control P5.

**Why:** The request was “tambahkan kling 4 dari har ini image to video dan juga
teks to video”.

**How to apply:** Keep these workflows separate from the Alriz-backed public
Kling MC V3 Pro P5 package.

## Evidence and limits

The supplied browser capture contains a completed text-to-video job using
`/gw-v2/workflows/kling-text-to-video`, model_name `kling-v4`, duration `"30"`,
resolution `"720p"`, and aspect_ratio `"16:9"`. Completion has
`response.result.url`; actual reported duration is about 30 seconds and usage
is 90 credits. Drive metadata uses model `kling-v4` and its JSON SDK payload
uses numeric duration `30`.

Read-only, authenticated `/options` checks accepted both the text-to-video and
image-to-video workflows with the same model/settings, quoting 90 credits
(3 credits per second). The image-to-video quote accepts an `image` URL field.
This is not evidence of a completed image-to-video generation or upload flow.

**Why:** Quote acceptance and completed generation are different levels of
evidence; conflating them previously hid reference-hosting compatibility issues.

**How to apply:** Preserve the distinction when reporting verification. Do not
submit paid jobs solely to test an integration without the user's authorization.

## Quote request headers

Quote checks must use the normal Picsart browser headers, not authorization alone.

**Why:** Minimal-header requests returned HTTP 400 for both workflows; requests
with deviceid, platform, and AI Playground touchpoint headers succeeded.

**How to apply:** Reuse the existing authenticated Picsart request conventions
and required Decodo ISP egress; do not interpret a minimal-header HTTP 400 as
proof that the model or workflow is unsupported.
