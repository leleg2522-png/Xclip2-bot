# Native video menu

Four additional image-to-video choices are independent of the existing routes.
The customer-facing menus, tariff list and generation captions use model names,
not the supplier name.

| Model | Duration | Native tier | Customer price |
| --- | --- | --- | --- |
| Kling Omni | 15 seconds | 720p / std | Rp2.000 |
| Kling V3 | 15 seconds | 720p / std | Rp2.000 |
| Wan 3.0 | 30 seconds | 480p | Rp2.000 |
| Seedance 2.0 | 15 seconds | 480p | Rp2.000 |

These prices are explicitly requested customer prices, **not** estimates of
supplier cost. Normal supplier pricing can exceed the customer charge.
Seedance 2.0's model-specific catalog lists a 15-second maximum; do not copy
the 30-second Seedance 2.5 reference-mode setting.

## Runtime setup

- Add `CHINAAPI_API_KEY` as a secret in the bot's hosting environment. Replit
  secrets are not automatically copied to a separate Railway service.
- Keep Railway's `RAILWAY_PUBLIC_DOMAIN`, or set `PUBLIC_BASE_URL` to the bot's
  public **HTTPS** origin. Reference photos use the existing `/dl/:token`
  media route so Telegram bot credentials are never sent upstream.
- `ffprobe` must be installed; the existing Dockerfile already installs ffmpeg.
- Fund the supplier account sufficiently for generation. The unlimited-key usage
  counter and compatibility subscription limits do not prove free-wallet balance.

## Safety and delivery

The wizard accepts a 9:16 or 16:9 ratio, a photo (including image documents), and
a prompt. It crops the reference to the selected ratio, pins maximum duration
and minimum native tier, submits once, polls the accepted job, and downloads its
authenticated content. No automatic upscale, model substitution or shorter clip
fallback is used. The temporary reference link is removed after processing.

Before delivery the downloaded file is probed for actual duration, dimensions
and aspect ratio. Failed generation, invalid output and failed delivery trigger
one full customer refund. An uncertain refund is reported for reconciliation
instead of blindly crediting again.

## Verification

Run `pnpm run test:china-video` and `pnpm run build` from this directory.
The tests are offline and do not spend credits or connect to the production DB.
Wan 3.0's 30-second 480p generation was live-verified separately. The other three
model contracts are based on the current official gateway documentation and
model catalog, and still need explicit-budget live verification.

Adding these files does not deploy or restart the separately hosted Railway bot.
