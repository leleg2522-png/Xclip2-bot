# Automatic 1080p video finishing

The user switched automatic finishing from Renderful to Flora AI.
`upscaleGeneratedVideo` now uses the existing Railway `flora_key_pool`,
admin-managed through `/addflorakey` and `/florapoolstatus`.
It no longer depends on the exhausted Renderful pool.

The account's live `/models?type=video` catalog must expose
`video-upscaler-topaz`, `video_url`, and `upscale_factor` in the required range.
Do not substitute a more expensive Magnific, Astra, or Starlight model.
Use `model` (not `model_id`) in `/generate`, with the key's workspace/project,
type `video`, a non-empty prompt, and only the verified minimal video parameters.

Measure source bytes with ffprobe. Choose an integer factor large enough to
meet 1080p (e.g. 480p → 3×, 768p → 2×). Reject sources that would require a
factor above the live model's limit. An already-HD result needs no paid run.
After polling the same run, download and validate its actual dimensions,
duration, and aspect ratio. Downsample the AI-upscaled output to a 1080p short
edge with FFmpeg, preserve audio from the source, and publish the final MP4
through the bot's own media endpoint. Do not stretch a low-resolution result.

Rotate only on a definite pre-acceptance authentication/credit rejection.
Network timeouts, missing run IDs, accepted tasks, post-submit credit failures,
poll failures, and output errors must never replay the paid finishing job.
A post-submit insufficient-credit error disables the affected key for future
jobs but does not retry this job. Logs use safe event names, not credentials
or private media URLs.

Existing generation prices and provider contracts remain unchanged.
The caller's policy remains unchanged: optional finishing falls back to native
output with an accurate label; mandatory-1080p routes refund on failure.
ChinaAPI's direct/native routes do not gain an automatic finishing pass.
The separate ByteDance 1K/Rp500 and Topaz 4K menus remain unchanged.

Verified: authenticated live catalog plus offline tests including real FFmpeg
landscape/portrait output and original audio preservation.
No paid Flora generation was submitted as part of this switch.
No local Telegram polling or Railway deployment was started.

Run `pnpm run test:flora-upscale` and `pnpm run build` from `telegram-bot`.
