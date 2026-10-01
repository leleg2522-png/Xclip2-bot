---
name: Picsart video delivery exceptions
description: Native delivery default and the limited automatic 1K finishing exception.
---

Deliver Picsart videos in their native form by default. Do not use the old
media-platform video resize/export workflow. Exception: Wan 3.0, the public
Seedance 2.5 route, and MiniMax H3 should automatically attempt the Renderful
ByteDance 1K finishing pass before delivery, without an extra user step or a
provider-facing label. If it fails, send the native result instead and label
that result accurately; never discard a successfully generated video.

The separate Flora MiniMax H3 15-second 480p and Wan 3.0 30-second 480p
options deliberately deliver native 480p. Matching a model name is not enough
to apply the automatic 1K exception; it belongs to the original public routes.

Seedance 2 Mini Video Edit and Seedance 2 Fast Video Edit stay separate from
each other and from their image-to-video variants. Each Video Edit route
requires a reference video, accepts up to five optional reference images, and
has model-specific payload metadata. Seedance 2 Video Edit follows the same
five-image limit. Never merge or silently substitute these routes.

**Why:** The user previously disabled all separate export/upscale stages, then
explicitly requested a seamless automatic 1K pass for only these three models.
The exception should not silently expand to other models or revive the old
export workflow. The user subsequently added separate Flora options explicitly
at 480p, preserving the existing routes.

**How to apply:** Keep the original generation resolution unchanged and run the
finishing pass only after a successful generation. Public labels should describe
the delivered quality, not falsely claim native 1K. Keep delivery-based charging
and refunds unchanged; an accepted
upscale job must not be resubmitted after polling or delivery failure.