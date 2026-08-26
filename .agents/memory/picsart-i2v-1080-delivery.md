---
name: Picsart I2V 1080 delivery
description: Delivery policy for selected Picsart I2V models: native generation first, then a separate 1080 export.
---

Seedance 2.0 Mini, Seedance 2.0 Fast, Seedance 2.0 Standard, and Wan 3.0 should
deliver a separate 1080 export rather than the native generated file. The three
Seedance variants are intentionally generated at 480P and delivered at 1080×1920
for their fixed 9:16 product output.

**Why:** This preserves lower native-generation settings while giving customers a
consistent 1080 product deliverable. The export must finish before delivery; a
failed export refunds rather than sending an unexpected raw video.

**How to apply:** Keep the export model allowlist explicit. Do not apply it to
unvalidated I2V models merely because they return MP4 URLs. Validate the first live
run for a newly added source model.