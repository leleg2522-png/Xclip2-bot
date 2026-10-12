# Native video menu

Four additional image-to-video choices are independent of the existing routes.
The customer-facing menus, tariff list and generation captions use model names,
not the supplier name.

| Model | Duration | Native tier | Customer price |
| --- | --- | --- | --- |
| MiniMax H3 | 15 seconds | 2K | Rp2.000 |
| HappyHorse 1.1 | 15 seconds | 480p | Rp2.000 |
| Wan 3.0 | 30 seconds | 480p | Rp2.000 |
| Seedance 2.0 | 15 seconds | 480p | Rp2.000 |

These prices are explicitly requested customer prices, **not** estimates of
supplier cost. Normal supplier pricing can exceed the customer charge.
The two new Kling choices were cancelled and replaced; existing models from
other providers are unchanged. H3's gateway payload uses `size: "2K"` with
`input_reference`; HappyHorse I2V uses `832*480`/`480*832` and `input_reference`.
Both use integer `duration: 15`. These contracts are documented at
https://dash.chinaapi.ai/docs/api/video/ and present in authenticated discovery.
Do not substitute H3-Max, which does not support 2K. H3 reference-image sizing
is independent from output tier; never parse the label `2K` as a two-pixel edge.
Seedance 2.0's model-specific catalog lists a 15-second maximum; do not copy
the 30-second Seedance 2.5 reference-mode setting.

## Runtime setup

- Keys are selected from `chinaapi_key_pool` in the existing Railway bot
  database. `CHINAAPI_API_KEY` is optional: if provided at startup it is imported
  once by uniqueness, without reactivating a disabled key. No environment-key
  fallback bypasses an empty or disabled pool.
- Keep Railway's `RAILWAY_PUBLIC_DOMAIN`, or set `PUBLIC_BASE_URL` to the bot's
  public **HTTPS** origin. Reference photos use the existing `/dl/:token`
  media route so Telegram bot credentials are never sent upstream.
- `ffprobe` must be installed; the existing Dockerfile already installs ffmpeg.
- Fund the supplier account sufficiently for generation. The unlimited-key usage
  counter and compatibility subscription limits do not prove free-wallet balance.

## Safety and delivery

**One key = one generation attempt, permanently.** After free catalog discovery,
the key is durably consumed before submitting a paid request. Success, failure,
timeout, process crash and delivery failure never make it available again.
Polling and downloading that same task still use its original key.

Keys are leased atomically across bot instances while preparing a request.
Unused preparation leases expire after one hour for crash recovery; a consumed
key never expires back into availability. Ownership tokens protect a newer
preparation lease from an old job's cleanup.
Polling has both an attempt limit and a 40-minute elapsed deadline.

Before an accepted task, the bot can try at most five different keys after a
definite authentication/quota rejection or a model-catalog mismatch. A submit
with a timeout, missing task ID, ambiguous response or accepted task is never
repeated. Invalid/exhausted keys are disabled. A used key cannot be restored,
including by duplicate import or an environment seed at startup.
Several keys belonging to the same account can still share one wallet.

### Private admin commands

- `/chinaapi`: open the admin menu with **Tambah API Key**, **Cek Jumlah Key**
  and **Batal** buttons. Counts include total, available, reserved, used and disabled.
- `/addchinakey` or `/addchinaapikey`: send without arguments to enter keys in
  the next message, or include keys inline. Batch comma/space/newline entry is supported.
  The input message is deleted after
  reading, and keys are never echoed. Only private admin chats are allowed.
- `/chinapool`, `/chinaapipool` or `/chinaapistatus`: counts and key IDs/statuses,
  without credential values.
- `/nonaktifchinakey ID`: disable a key without deleting its record.
- `/restorechinakey ID`: reactivate only an unused, inactive key after resolving
  the issue. Consumed keys and active leases cannot be restored.

For authorized external Railway schema setup, use
`pnpm run setup:china-pool -- --apply`. It confirms the existing bot database,
creates only the new pool table/index, and imports the existing secret if present.
It does not start Telegram polling or deploy the bot.

The wizard accepts a 9:16 or 16:9 ratio, a photo (including image documents), and
a prompt. It crops the reference to the selected ratio, pins maximum duration
and minimum native tier, accepts only one paid task, polls that task, and downloads its
authenticated content. No automatic upscale, model substitution or shorter clip
fallback is used. The temporary reference link is removed after processing.

Before delivery the downloaded file is probed for actual duration, dimensions
and aspect ratio. Failed generation, invalid output and failed delivery trigger
one full customer refund. An uncertain refund is reported for reconciliation
instead of blindly crediting again.

## Verification

Run `pnpm run test:china-video`, `pnpm run test:china-admin` and `pnpm run build` from this directory.
The tests are offline and do not spend credits or connect to the production DB.
Wan 3.0's 30-second 480p generation was live-verified separately. The other three
model contracts are based on the current official gateway documentation and
model catalog, and still need explicit-budget live verification.

Adding these files does not deploy or restart the separately hosted Railway bot.
