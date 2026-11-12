---
name: Seedance reference numbering
description: Dreamina-style image-reference semantics requested by the user, and the boundary between local ordering tests and provider-level evidence.
---

The requested experience is Dreamina-style: “image 1 @1 image 2 @2”.
The numbers must address the actual uploaded images, not merely decorate
filenames or upload acknowledgements.

**Why:** The user explicitly clarified this distinction and requested the same
experience for Flora and Picsart.

**How to apply:** Keep displayed numbers, prompt tokens and the submitted image
array consistent. Never silently reorder or drop images; numbering is for images
and must not change when video/audio references are added.

Local tests of labels, validation and ordered payloads do not establish that a
provider follows mention tokens in generated results.

**Why:** Controlled counterbalanced generations established literal `@1`/`@2`
behavior on Flora Seedance 2 Reference. That evidence cannot establish the same
behavior on Picsart or every other Seedance variant.

**How to apply:** Distinguish implemented bot behavior from observed provider
behavior in delivery summaries. Require provider/model-specific output evidence
before claiming native mention support. See [Flora API evidence](flora-ai-api.md)
for the verified two-image experiment.
