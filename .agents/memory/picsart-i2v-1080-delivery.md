---
name: Picsart I2V 1080 delivery
description: Delivery policy for selected Picsart I2V models: native generation first, then a separate 1080 export.
---

Seedance 2.0 Mini, Seedance 2.0 Fast, Seedance 2.0 Standard, Seedance 2 Mini
Video Edit, Seedance 2 Fast Video Edit, and Wan 3.0 should deliver a separate
1080 export rather than the native generated file. Seedance is intentionally
generated at 480P, then delivered at 1080×1920 for 9:16 or 1920×1080 for 16:9.

Seedance 2 Mini Video Edit and Seedance 2 Fast Video Edit stay separate from
each other and from their image-to-video variants. Each Video Edit route
requires a reference video and has model-specific payload metadata. Never
merge or silently substitute these routes.

**Why:** This preserves lower native-generation settings while giving customers a
consistent 1080 product deliverable. The export must finish before delivery; a
failed export refunds rather than sending an unexpected raw video.

**How to apply:** Keep the export model allowlist explicit. Deliver only after
the export succeeds; export failure must refund rather than fall back to the
native 480P file. Do not apply this policy to unvalidated models merely because
they return MP4 URLs. Validate the first live run for a newly added source model.