---
name: Picsart Heygen and Banana 2.1 verification
description: Separate public motion route and evidence distinguishing captured video/image results from non-billable T2I options
---

Keep Heygen photo-to-video and Xclip Motion as separate customer models. Heygen
stays on Heygen Video 1; Xclip Motion now uses Flora Kling V3 Standard Motion.

**Why:** The user explicitly changed Xclip Motion to Kling MC V3 Standard via
Flora, retained mandatory upscale delivery, and lowered its price to Rp2.500.
The original Heygen photo-only route remains unchanged.

**How to apply:** Require both media for Xclip Motion, and only a photo for
Heygen. Xclip Motion uses reference-following duration rather than the old fixed
15-second Heygen settings. Do not retain unsupported Heygen aspect-ratio controls.
Keep the public Motion label and its
price independent from the separate P5 product, even though they share Standard.

Place Xclip Motion in the Kling Motion Control submenu, not directly in the main
Generate Video list. Heygen stays separate.

**Why:** The user explicitly chose to move Xclip Motion to that submenu.

**How to apply:** Preserve this grouping when reorganizing menus.

Heygen and Xclip Motion must be upscaled with ByteDance to the public 1K tier
before delivery; advertise delivered 1080p without claiming native resolution.

**Why:** The user explicitly requested this finishing step and 1080p bot copy.

**How to apply:** Only a successfully
upscaled, delivered result completes the charge; failed finishing must refund
fully rather than silently deliver native quality. Do not apply this video
finishing requirement to Banana image routes.

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

## Banana Renderful migration scope

Only Banana Pro, Banana Lite and Banana 2 are in the Renderful migration.
Banana 2.1 is explicitly excluded.

**Why:** The user clarified: “yg di ganti banana pro banana lite dan banan 2
banana 2,1 mah tidak”, superseding the earlier “semua model banana” wording.

**How to apply:** Do not include Banana 2.1 in broader Banana backend changes
without a new user request. Existing package prices remain unchanged unless
the user separately requests a price change.
