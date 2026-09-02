---
name: Picsart I2V 1080 delivery
description: Delivery policy for selected Picsart I2V models: native generation first, then a separate 1080 export.
---

Seedance 2.0 Mini, Seedance 2.0 Fast, Seedance 2.0 Standard, Grok Imagine,
Seedance 2 Mini
Video Edit, Seedance 2 Fast Video Edit, Seedance 2 Video Edit, and Wan 3.0 should deliver a separate
1080 export rather than the native generated file. Seedance is intentionally
generated at 480P, then delivered at 1080×1920 for 9:16 or 1920×1080 for 16:9.

Seedance 2 Mini Video Edit and Seedance 2 Fast Video Edit stay separate from
each other and from their image-to-video variants. Each Video Edit route
requires a reference video, accepts up to five optional reference images, and
has model-specific payload metadata. Seedance 2 Video Edit follows the same
five-image limit. Never merge or silently substitute these routes.

**Why:** This preserves lower native-generation settings while giving customers a
consistent 1080 product deliverable. The export must finish before delivery; a
failed export refunds rather than sending an unexpected raw video.

**How to apply:** Keep the export model allowlist explicit. Deliver only after
the export succeeds; export failure must refund rather than fall back to the
native 480P file. Do not apply this policy to unvalidated models merely because
they return MP4 URLs. Validate the first live run for a newly added source model.

Gemini Omni Flash 1.2 is a customer-selectable exception: keep native generation
unchanged, then export either 1080p or 4K. The 4K targets are 2160×3840 for 9:16
and 3840×2160 for 16:9. Its 4K submit and polling must use the `/gw-v2` media
platform workflow; the same non-gateway endpoint returned unauthorized responses
in the validating HAR.

**Why:** Resolution selection changes both the charged product and the validated
export route. Treating 4K as a label over the old 1080 export would overcharge
customers without producing the requested file.

**How to apply:** Preserve the chosen resolution through wizard state, charging,
status copy, export dimensions, and delivery caption. Do not silently fall back
from 4K to 1080p; refund if the selected export fails.