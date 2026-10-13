# Automatic 1080p finishing — Renderful AI

Automatic finishing uses Renderful's ByteDance video upscaler again.
Keys come from the existing Railway `renderful_key_pool`, not Flora or a
single Renderful environment key. No migration or new key credits are created.

`generateRenderful1080` downloads and measures source bytes. Already-HD source
needs no paid request. Otherwise publish the bytes through our own `/dl/:token`
link, then submit `video-to-video`, `bytedance-video-upscaler`, `1080p` through
the direct, proxy-free Renderful client. Never give the provider a Telegram
file URL containing the bot token. Poll the same accepted task for up to twenty
minutes; never replay accepted or ambiguous submissions.

Only definite pre-acceptance auth/credit rejections may rotate keys. A polling
auth rejection can disable a key for future use but never submits another job.
Pool exhaustion, timeout, invalid output, and publication failure retain the
caller's existing optional-native or mandatory-1080p-refund policy.

The shared media validation/normalization utilities retain their historical
Flora filenames. They verify actual resolution, aspect and duration, preserve
original audio, and downsample only a proven >=1080p output. They never stretch
native fallback and label it HD. Source and normalized output have 250MB limits.

Generation models, customer prices, native ChinaAPI routes, the standalone
Rp500 ByteDance menu, and the independent Topaz 4K tool remain unchanged.

Offline verification: `test:renderful-upscale`, `test:bytedance-upscale`,
`test:flora-upscale` (shared real FFmpeg media checks), and existing caller tests.
No paid Renderful generation, local Telegram polling, or Railway deployment
is performed by this code change.
