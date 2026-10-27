---
name: Picsart Heygen and Banana 2.1 verification
description: Separate public motion route and evidence distinguishing captured video/image results from non-billable T2I options
---

Keep Heygen photo-to-video and Xclip Motion as separate customer models. Heygen
stays on Heygen Video 1. The user's current Xclip Motion requirement is a
Wan 3.0 480p generation backend, with uploaded reference videos accepted for
3–15 seconds, followed by mandatory Renderful/ByteDance finishing to 1080p.

**Why:** The user requested replacing Xclip Motion's backend with Wan 3.0 480p
and then accepted a 15-second maximum after the Flora runtime explicitly rejected
a whole 30-second reference: “oke berarti 15 detik saja maks nya”.
The user raised Xclip Motion's separate price to Rp3.500 (“harga nya naikan jadi
3,5k”), including its mandatory upscale; this supersedes the earlier Rp2.500
price only for Xclip Motion. The Wan backend supersedes the earlier Kling V3
Standard generation direction only for Xclip Motion.
The user subsequently requested: “hasil xclipmotion di upscale dulu ke 1080p
di renderfull baru di kasih ke user”. This supersedes native 480p delivery,
not the Wan backend or the accepted 15-second reference cap.

**How to apply:** Require both media for Xclip Motion, and only a photo for
Heygen. Xclip Motion uses reference-following duration rather than the old fixed
15-second Heygen settings. Do not retain unsupported Heygen aspect-ratio controls.
Keep the public Motion label and price independent from the separate P5
product. Reject overlong references instead of silently discarding part of them.
Do not restore 30-second acceptance or introduce segmentation without a new
request. Only the Xclip Motion generation backend changes: Kling P2/P3/P5 and
Heygen keep their separate backend and finishing policies. Advertise delivered
1080p, not native 1080p. If upscale fails or returns the original 480p fallback,
do not deliver it; refund the full Xclip Motion price. Do not charge the separate
Rp500 upscaler fee for this included finishing step.

Place Xclip Motion in the Kling Motion Control submenu, not directly in the main
Generate Video list. Heygen stays separate.

**Why:** The user explicitly chose to move Xclip Motion to that submenu.

**How to apply:** Preserve this grouping when reorganizing menus.

Heygen must be finished with Renderful/ByteDance to the public 1K tier
before delivery; advertise delivered 1080p without claiming native resolution.

**Why:** The user explicitly requested this finishing step and 1080p bot copy.

**How to apply:** Only a successfully
upscaled, delivered result completes the charge; failed finishing must refund
fully rather than silently deliver native quality. Xclip Motion now also requires
this mandatory 1080p finishing, per the user's later request. Do not apply the
video finishing requirement to Banana image routes.

Banana 2.1 has distinct evidence for its two modes: the HAR completed image-to-image
at the 4K setting; text-to-image was verified only through the non-billable options
endpoint using a currently valid bot token, not through a paid generation.

**Why:** With an empty image list, options returned HTTP 201 with
`text-to-image.gemini-nano-banana-2.1.4k`, two estimated credits, and no job ID.
The expired HAR token returned 401; incomplete metadata headers returned
`missing_headers`, neither of which established model incompatibility.

**How to apply:** Do not claim a real T2I result was generated during this check.
When testing captured workflow capabilities, preserve platform/touchpoint metadata
alongside authentication before interpreting validation errors.

## Banana provider migration scope

Only Banana Pro, Banana Lite and Banana 2 are in the shared provider migration.
These packages use SnapGen AI for both text-to-image and image-to-image.
The separate Banana 2.1 package remains unchanged.

**Why:** The user clarified: “yg di ganti banana pro banana lite dan banan 2
banana 2,1 mah tidak”, superseding the earlier “semua model banana” wording.
The latest request restores SnapGen: “buat banana pro dan banana lite dan juga
banan2 kembali ke snapgen ai”, superseding the previous Picsart migration.

**How to apply:** Preserve the three public package names and their individual
prices, while routing all three through the shared SnapGen Banana 2 backend.
Do not change the separate
Banana 2.1 package's price or wizard as part of this migration.

## Shared Banana package backend

Banana Pro and Lite must follow Banana 2's backend, for both text-to-image and
image-to-image. Keep the public packages separate; Banana 2.1 remains excluded.

**Why:** The user requested: “buat agar nano banana pro dan lite memeakai backend
yg sama dengan banan 2”.

**How to apply:** Future Banana 2 backend changes should also apply to Pro/Lite
unless the user separates them again. Do not restore a distinct Pro backend
solely because the public package is named Pro.
