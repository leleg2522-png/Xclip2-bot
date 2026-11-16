---
name: Genjutsu character swap product
description: User-approved scope and customer flow for the separate Genjutsu Telegram feature.
---

Genjutsu is a separate customer menu, not a replacement for the general Seedance 2.5 Flash flow. It requires one source video followed by 1–10 reference images, uses an automatic character-replacement prompt, and asks for explicit Generate confirmation at Rp6,000.

Genjutsu accepts exactly one video and at most ten reference images, with at least one image required.

**Why:** The user requested: “Buat agar genjutsu bisa masukin image refrensi nya maks 10 jadi input video nya satu”.

**How to apply:** Let the user finish collecting images explicitly before confirmation. Preserve all accepted references and their order through submission; never silently send only the first image. Keep the duration packages, backend choice, and existing pricing unchanged unless separately requested. Local checks of multiple-image payloads are not evidence of live generation quality.

Use ordinary Seedance 2.5, not Flash, as Genjutsu's backend.

**Why:** After comparing the results, the user said: “Yaudah backend nya pake seedance 2,5 biasa aja”.

**How to apply:** Keep this change scoped to Genjutsu; do not reroute the ordinary
Flash menu or P2. Standard reference-mode sample quality does not establish
the quality of automatic-duration edit mode; do not claim that edit route has
been live-verified based on the earlier reference-generation sample.

Genjutsu has two reference-duration packages: 15 seconds accepts **3–15 seconds**,
and 30 seconds accepts **3–30 seconds**. The package is a reference cap, not
permission to stretch every result to that maximum.

**Why:** The user explicitly requested both packages and both lower/upper limits.
Their earlier instruction that output duration follows the reference still applies.

**How to apply:** Require package selection before uploads, validate actual
file duration against it, and retain the selection through confirmation and
submission. Keep prices unchanged unless the user requests new prices.

The 3-second user minimum must coexist with the edit provider's 4-second
technical minimum without lengthening the delivered clip or changing its audio.

**Why:** Rejecting all sub-4-second references would contradict the user's
explicit 3-second minimum for both packages.

**How to apply:** Prepare short inputs without changing performance timing,
retain the original source separately, and restore original duration and audio
for delivery. Do not treat technical preparation as permission to expand a story.

The user wants Genjutsu's automatic prompt kept simple: “ganti karakter video
refrensi dengan karakter image refrensi”, plus negative instructions.

**Why:** The user explicitly replaced the earlier elaborate identity-lock prompt
with this short instruction.

**How to apply:** Do not expand it back into a long identity/performance prompt
without asking. Flash's documented parameter list has no separate negative
prompt field; disclose inline exclusions as text instructions, not native
negative conditioning or a guaranteed identity lock.

For owner-run Genjutsu experiments, show and review the raw model output before
paying for finishing. Do not automatically upscale a test whose character swap
has not been accepted.

**Why:** The user explicitly said: “Hasil nya jgn langsung di upscale kalo belum bener bener fix”.

**How to apply:** Pause experimental runs after native generation, ask the owner
to assess the character swap, and resume finishing only after approval. This is
a test-stage gate, not permission to silently downgrade public customer delivery.

For the character-swap flow, duration must automatically follow the reference
video, not a manually fixed number or a 30-second reference-generation preset.

**Why:** The user explicitly corrected: “Harus nya durasi auto mengikuti refrensi video”.

**How to apply:** Use standard Seedance 2.5 edit mode with automatic duration (`-1`) and
adaptive ratio. Describing a test source as approximately 5.5 seconds does not
authorize hardcoding that duration. Keep the ordinary non-edit Flash flow separate.

**Why:** The user chose “Menu Genjutsu terpisah” and later selected ordinary Seedance 2.5 after comparing raw samples.

**How to apply:** Keep ordinary Flash's optional mixed references and text-to-video intact. Genjutsu delivers 1080p with hidden Renderful finishing, keeps supplier names and source resolution out of customer messages, and refunds failed generation/finishing/delivery. Ask the model to preserve source motion, camera, and scene; restore audio separately as described below. Never promise Higgsfield-identical quality or guaranteed identity consistency.

Genjutsu must generate visuals without model-created audio, then restore audio from the user's source video after finishing. If the source is silent, deliver silent video; never keep the generated soundtrack as a fallback.

**Why:** After the live job failed on generated-audio moderation, the user selected “Pakai audio asli video”.

**How to apply:** Disable audio generation explicitly only for Genjutsu, preserve the original audio's timing and content in the final media, and refund if restoration fails. Do not change the general Flash audio settings or run another paid test without new permission.

The earlier Flash audio-off edit contract was live-verified: `generateAudio:false` produced silent visuals, finishing completed, and the restored AAC decoded identically to the source. This is historical Flash evidence, not live verification of the new standard-edit backend. A portrait result may be 1080×1922 rather than exactly 1080×1920 because the provider preserves the source aspect ratio.

**Why:** Native portrait dimensions can be 480×854, so proportional 1080-short-edge delivery need not have a 1920 long edge. Requiring exactly 1080×1920 would reject a valid finished result.

**How to apply:** Validate 1080 on the short edge and preserve the actual aspect ratio; do not promise exact 1920 height or assume that disabling audio prevents every possible moderation failure.

Completing generation, audio restoration, and finishing does not establish successful character likeness. The user rejected the completed sample because the character did not resemble the reference sufficiently.

**Why:** Clothing/style resemblance and technical delivery were incorrectly summarized as success without establishing facial identity fidelity.

**How to apply:** Treat the image as the sole identity source and the video as performance guidance, explicitly prohibit retaining/blending the source face, and preserve the exact image/video roles. Describe prompt and payload checks as local verification only, never as proof of improved likeness. New paid comparisons require fresh permission.

An authorized repeat with explicit identity-first instructions still did not produce adequate reference likeness on visual review, despite successful video/audio delivery.

A short replacement prompt with inline negative instructions also changed the
clothing and hair without adequately replacing the original facial identity.

**Why:** Neither stronger identity-first wording nor a minimal replacement
instruction with exclusions resolved the observed character mismatch.

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
