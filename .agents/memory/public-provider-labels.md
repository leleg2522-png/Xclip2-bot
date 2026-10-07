---
name: Public provider labels
description: Customer-facing Telegram copy must be model-led and never expose the underlying generation supplier.
---

All user-facing Telegram messages for generated media must name only the advertised
model (for example, Seedance 2.5 I2V), not the internal provider, bridge, account
pool, or workstation that serves it.
Automatic upscale/finishing is also internal: use neutral processing messages
and avoid narrating a separate finishing stage. Describe actual delivered
resolution accurately without claiming a native generation resolution.

**Why:** Provider routing is an operational detail and revealing it undermines the
intended product presentation.
The user explicitly wants automatic upscaling to remain invisible to customers.

**How to apply:** Check model buttons, price lists, setup prompts, queue/progress
messages, result captions, and refund/failure notices when adding or changing a
provider. Admin-only setup and operational logs may retain internal names.

## Kling P4 naming

The public name “Kling MC V3 Pro P4” intentionally identifies the Flora route for
Kling Motion Control 2.6 Pro; do not treat the V3/2.6 mismatch as a bug or silently
upgrade its upstream model to Kling 3.

**Why:** The user explicitly requested the 2.6 Pro backend with this public name
and chose Flora for P4.

**How to apply:** Keep the requested customer label separate from the upstream
model identity when updating the catalog or changing integration code.