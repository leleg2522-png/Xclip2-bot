---
name: Picsart Kling 4 API evidence
description: Captured Kling 4 T2V completion, I2V quote acceptance, native settings, and verification limits.
---

# Kling 4 contracts

## Public duration selection

Both public Kling 4 modes offer 10, 15, or 30 seconds; do not keep the bot
restricted to the originally captured 30-second package.

**Why:** The user requested “tambahkan pilihan durasi untuk kling 4 jadi kasih
opsi durasi 10 detik 15 detik atau 30 detik”.

**How to apply:** Preserve the duration selection across reference collection,
submission, and result captions. Short-duration credit quotes are not proof
of a completed generation. In addition to the captured 30-second completion,
an authorized 10-second text-only Flash test completed through the separately
supplied Decodo datacenter pool: 30 quoted/used credits and a verified native
720p video. This does not verify I2V uploads, 15-second completion, Railway
runtime configuration, or 1080p finishing. Keep mandatory 1080p finishing for
customer delivery at all durations.

The user requested both image-to-video and text-to-video as new bot features,
separate from Kling Motion Control P5.

**Why:** The request was “tambahkan kling 4 dari har ini image to video dan juga
teks to video”.

**How to apply:** Keep these workflows separate from the Alriz-backed public
Kling MC V3 Pro P5 package.

## Approved public price

Both Kling 4 modes cost **Rp3.500 for 10 seconds**, **Rp4.000 for 15 seconds**,
and **Rp8.000 for 30 seconds**.

**Why:** The user answered `8000` for the original 30-second package, then set
“harga 10 detik 3,5 k 15 detik 5k” after requesting duration choices. The user
subsequently revised the 15-second price: “harga 15 detik jadi 4k saja”.

**How to apply:** Keep the same duration-based prices for image-to-video and
text-to-video; charge and fully refund the selected duration's price when
generation or delivery fails.

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

The later capture supplied to inspect combined video/image references still
submits only one `image_list` item and image-only Drive metadata. A GET of an
MP4 appears separately, but that MP4 is not referenced by the generation
request. Uploaded project history also records image references only.

**Why:** A video preview being loaded in the browser does not prove that the
model receives it as a reference.

**How to apply:** Do not claim video-reference support is unsupported globally,
but require a submitted request that actually includes the reference video
before implementing that mode. Do not invent video payload fields.

## Flash naming and reference evidence

A later completed text-only capture identifies the UI's Kling 4 Flash as
`kling-v4-omni` on the Omni workflow, native 720p, 30 seconds, and 90 credits.
It does not submit any reference images or videos. Do not infer a separate
Flash model ID from the UI name.

**Why:** Multiple uploads under different filenames were byte-identical copies
of that same text-only capture; re-uploading it did not add reference evidence.
The user wants the public name “Kling 4 1080p”, removal of the separate Omni
choice, and support for up to five images plus video references.

**How to apply:** Obtain an actual reference-bearing submit payload before
implementing video fields. If another upload appears unchanged,
compare its content first and request just the submit Request Payload as an
alternative; do not ask repeatedly for the same HAR.

A distinct later capture completed image-to-video using the same Flash backend
with one `image_list` entry and matching metadata `imageUrls`. This verifies
single-image generation, not a completed five-image or video-reference run.

**Why:** The user's requested public replacement is Flash under the label
“Kling 4 1080p”, without a separate Omni offering. The bot can collect up to
five images using the evidenced list field, but video-reference fields remain
unknown and must not be invented.

**How to apply:** Preserve the Flash backend and duration-based prices for both public
Kling 4 modes, the five-image input cap, and mandatory Renderful 1080p finishing.
Keep the separate Omni choice inaccessible, including from old menu buttons.
Treat video references as blocked pending a submitted payload containing them;
do not mistake additional uploads or an MP4 preview for a reference in submit.

## Mandatory 1080p delivery for all Kling 4 packages

Kling 4 Omni, Kling 4 Image to Video, and Kling 4 Text to Video must finish
through Renderful at 1080p before delivery. Their approved prices are unchanged.

**Why:** The user requested “gw ingin hasil nya di upscale dulu di renderfull
agar 1080p”, then explicitly added “kling 4 juga”.

**How to apply:** Keep upstream generation at native 720p and advertise delivered
1080p, not native 1080p. If finishing fails or returns its native fallback, do
not send the 720p video; refund the full charge. Failed delivery must also refund
without falling back to 720p or resubmitting either paid job. Do not extend this
rule to the older Kling Omni v3 or Motion Control packages.
