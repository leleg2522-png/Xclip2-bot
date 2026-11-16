---
name: Genjutsu character swap product
description: User-approved scope and customer flow for the separate Genjutsu Telegram feature.
---

Genjutsu is a separate customer menu, not a replacement for the general Seedance 2.5 Flash flow. It requires one source video followed by one character photo, uses an automatic character-replacement prompt, and asks for explicit Generate confirmation at Rp6,000.

For the character-swap flow, duration must automatically follow the reference
video, not a manually fixed number or a 30-second reference-generation preset.

**Why:** The user explicitly corrected: “Harus nya durasi auto mengikuti refrensi video”.

**How to apply:** Use Flash edit mode with automatic duration (`-1`) and
adaptive ratio. Describing a test source as approximately 5.5 seconds does not
authorize hardcoding that duration. Keep the ordinary non-edit Flash flow separate.

**Why:** The user requested a Genjutsu-style feature backed by Seedance 2.5 Flash and chose “Menu Genjutsu terpisah” after reviewing this flow and price.

**How to apply:** Keep ordinary Flash's optional mixed references and text-to-video intact. Genjutsu delivers 1080p with hidden Renderful finishing, keeps supplier names and source resolution out of customer messages, and refunds failed generation/finishing/delivery. Ask the model to preserve source motion, camera, and scene; restore audio separately as described below. Never promise Higgsfield-identical quality or guaranteed identity consistency.

Genjutsu must generate visuals without model-created audio, then restore audio from the user's source video after finishing. If the source is silent, deliver silent video; never keep the generated soundtrack as a fallback.

**Why:** After the live job failed on generated-audio moderation, the user selected “Pakai audio asli video”.

**How to apply:** Disable audio generation explicitly only for Genjutsu, preserve the original audio's timing and content in the final media, and refund if restoration fails. Do not change the general Flash audio settings or run another paid test without new permission.

The audio-off edit contract is live-verified: `generateAudio:false` produced silent visuals, finishing completed, and the restored AAC decoded identically to the source. A portrait result may be 1080×1922 rather than exactly 1080×1920 because the provider preserves the source aspect ratio.

**Why:** Native portrait dimensions can be 480×854, so proportional 1080-short-edge delivery need not have a 1920 long edge. Requiring exactly 1080×1920 would reject a valid finished result.

**How to apply:** Validate 1080 on the short edge and preserve the actual aspect ratio; do not promise exact 1920 height or assume that disabling audio prevents every possible moderation failure.

Completing generation, audio restoration, and finishing does not establish successful character likeness. The user rejected the completed sample because the character did not resemble the reference sufficiently.

**Why:** Clothing/style resemblance and technical delivery were incorrectly summarized as success without establishing facial identity fidelity.

**How to apply:** Treat the image as the sole identity source and the video as performance guidance, explicitly prohibit retaining/blending the source face, and preserve the exact image/video roles. Describe prompt and payload checks as local verification only, never as proof of improved likeness. New paid comparisons require fresh permission.

An authorized repeat with explicit identity-first instructions still did not produce adequate reference likeness on visual review, despite successful video/audio delivery.

**Why:** Stronger natural-language instructions alone did not resolve the observed character mismatch.

**How to apply:** Do not present further prompt-only edits as a confirmed identity lock. Investigate model-supported identity conditioning or a dedicated character-swap method before recommending more paid attempts; changing providers or adding a new processing stage requires discussing that change with the user.

Wan 3.0's Vivareel image-and-video reference capability is not verified character replacement. In a controlled comparison using the same film clip and character photo, the output showed the film scene first and the photo's office setting later, rather than replacing the performer within the film.

**Why:** Accepting both reference types and completing a job does not prove that a model supports in-place character swapping.

**How to apply:** Do not migrate Genjutsu to this route based on reference-input support alone. Inspect the entire output, not only a source-length excerpt: the model can introduce the image-derived character only in later, separate scenes.

Standard P2 reference generation can retain the film setting while applying the
reference character's appearance, but this is not proof of timeline-preserving
character replacement or an exact identity lock.

**Why:** In a controlled comparison, its 30-second result stayed in the film
setting with the white-blazer character, unlike Wan's separate office scenes,
but expanded a roughly 5.5-second source and changed performance timing.

**How to apply:** Separate scene retention, reference likeness, and motion/timing
fidelity when judging results. Do not replace the Genjutsu production route or
promise Higgsfield-equivalent replacement based on reference-mode acceptance
or this partial visual improvement alone.
