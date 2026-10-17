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

## Approved public price

Both Kling 4 modes cost **Rp8.000 per video** for the 30-second package.

**Why:** The user answered `8000` when asked the selling price for both modes.

**How to apply:** Keep the same selling price for image-to-video and
text-to-video; preserve full refunds when generation or delivery fails.

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

## Kling 4 Omni public package

Kling 4 Omni is a separate product from both regular Kling 4 and the existing
Kling Omni v3. Its approved selling price is **Rp8.500 per video**.

**Why:** The user requested “tambahkan kling 4 omni” and explicitly set the
price to `8500`. The supplied Omni capture shows 30-second, 720p requests with
a photo reference, but omits all gateway response bodies. HTTP 200 polling
alone does not establish a completed video or its actual credit usage.

**How to apply:** Preserve the separate model and price. Do not describe Omni
generation as live-verified from this capture, infer its credit cost from
regular Kling 4, or assume the v3 audio and multi-shot controls apply to v4.
Use the provider's options quote for credit preflight, and never submit paid
test jobs without authorization.
