---
name: Renderful ByteDance Upscaler
description: Product and reliability rules for the Renderful-backed ByteDance video upscaler.
---

The public product is ByteDance Upscaler 1K at Rp500 per delivered video. API
keys must live in the Railway `renderful_key_pool`, not a single environment
secret. Map the public 1K tier to the provider's supported `1080p` resolution.

**Why:** The user explicitly chose 1K and required the provider key pool to be
stored in Railway. An accepted generation may already be billable, so retrying
after submit could double-charge upstream.

**How to apply:** Rotate and disable exhausted keys only when upload or submit
has not returned a task id. After task acceptance, never resubmit through another
key. Charge only for a delivered result; all failure paths refund Rp500. Public
buttons, progress, results, and errors may say only ByteDance Upscaler 1K; keep
Renderful, API responses, endpoints, and pool status in admin/log surfaces.
ByteDance upload, submit, and polling must bypass the legacy Decodo proxy and
connect directly from Railway; proxy authentication failures otherwise surface
as HTTP 407 before the provider receives the request. The current official
OpenAPI exposes no upload route: host input bytes through the bot's temporary
public `/dl/:token` link and submit that as `video_url`; never expose a Telegram
file URL because it contains the bot token.