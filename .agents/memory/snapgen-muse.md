---
name: SnapGen MUSE product requirements
description: Requested image/video packages, selling price, and documentation identity safeguards.
---

The user wants both MUSE AI Image and MUSE AI Video in the existing Telegram
bot. MUSE Image costs Rp500 per generated image; MUSE Video costs Rp1,000
per generated video.

**Why:** The user selected “Gambar dan video” and supplied “1000” when asked for
the selling price per result, then revised the image price with “untuk muse
gambar harga 500”.

**How to apply:** Keep image and video choices distinct and use the existing
saldo and failed-delivery refund rules. This selling-price decision does not
authorize owner-funded live generation tests or establish video durations.

Do not treat a public model-status listing as an API request contract. Verify
that any documentation actually describes the existing api.snapgen.ai service.

**Why:** Official snapgen.ai status lists MUSE image and video, while searches
also return docs.snapgen.org using a different API format. The official
docs.snapgen.ai introduction identifies api.snapgen.ai and x-api-key auth;
the similarly named documentation host must not be assumed interchangeable.

**How to apply:** Require provider-specific endpoint and payload evidence before
adding paid submits; do not guess a MUSE endpoint from other model families.
