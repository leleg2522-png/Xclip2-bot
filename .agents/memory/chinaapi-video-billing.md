---
name: ChinaAPI video discovery and billing
description: Live model discovery, model-specific video parameters, and why key usage is not an account wallet balance.
---

Use authenticated model discovery and current dashboard pricing rather than
treating the public marketing directory as the complete ChinaAPI catalog.

**Why:** The marketing directory listed older Wan variants while the
authenticated `/v1/models` catalog also exposed Wan 3.0 standard and Prime.
Provider labels in model metadata alone do not establish the upstream contract.

**How to apply:** Copy exact IDs from live discovery. Read the selected model's
dashboard page and pricing data before estimating a job; catalog presence is not
proof of a successful generation. Request fields differ between video families,
so do not carry another model's image or resolution fields across unchanged.

Key usage and OpenAI-compatible billing limits are not reliable account-wallet
balances for an unlimited ChinaAPI key.

**Why:** `/api/usage/token/` returned nominal available key quota alongside
`unlimited_quota: true`; the compatibility subscription endpoint returned very
large placeholder spending limits, not the account's actual free-credit balance.
Nominal key availability even became negative after a successful generation
while the unlimited flag remained true.

**How to apply:** Do not label nominal key quota or subscription limits as the
user's remaining free wallet. Account-balance certainty requires the actual
wallet view; a negative unlimited-key counter does not establish account debt.
Keep any user-authorized trial bounded by its live price and never
top up, switch models, reduce requested duration, or repeat accepted paid jobs
without permission. Use the published quota conversion instead of assuming units.

Wan 3.0 standard pricing is per generated second and resolution tier, not a
flat per-video price; omitting resolution risks the native 1080P default.

**Why:** The dashboard publishes a 720P base rate with different 480P/1080P
multipliers. Its live gateway rejects `metadata.resolution` for standard Wan 3.0
and explicitly requires the top-level `size` field instead.

**How to apply:** For standard Wan 3.0 I2V, send a first-frame URL through
`input_reference`, an explicit integer `duration`, and an asterisk-separated
`size` appropriate to the requested tier. Do not assume the paid-account
discount applies to a free account. Download completed media and measure native
duration and dimensions instead of trusting request acceptance or advertised specs.

Treat the Wan 3.0 `size` value as resolution-tier selection rather than a
guarantee of exact output width.

**Why:** A first-frame request using `832*480` returned native 854×480 video,
preserving the source image's 16:9 shape, with the requested 30-second duration.

**How to apply:** Validate the delivered resolution tier and media duration.
Do not re-encode an otherwise correct native result simply to force the
requested width; report the measured dimensions.

For the four additional ChinaAPI bot choices, the user set the customer price
to “2k semua” and requested maximum duration with the lowest native resolution.

**Why:** These are explicitly chosen product settings, not a cost-plus pricing
formula; normal supplier cost can exceed the customer price.

**How to apply:** Keep Rp2.000 per generation for these four choices unless the
user changes it. Do not silently increase the price, shorten duration, upscale
the output, or change other suppliers' prices to compensate for margin.

Seedance 2.0's model-specific catalog duration limit takes precedence over the
generic video guide's shared request-shape description.

**Why:** The guide says 2.0 shares 2.5's request shape, but the flagship 2.0
catalog specifically lists 4–15 seconds; the 30-second reference-mode paragraph
is about 2.5, not proof of a 30-second 2.0 first-frame generation.

**How to apply:** Keep the 2.0 first-frame route at its 15-second catalog maximum
unless model-specific evidence establishes a different limit. Do not substitute
2.5 while displaying 2.0.

The ChinaAPI pool is shared by all four new models in the existing Railway bot
database, not in the invite panel's local Replit database.

**Why:** The user specifically requested “pool api di DB railway nya”.

**How to apply:** Keep pool management on the bot's Railway database. Disabled
pool credentials must not be silently reused through environment-key fallback.
Do not treat several keys from one account as separate funded wallets.

ChinaAPI keys are single-use, not reusable round-robin credentials: “apikey nya
hanya 1 kali pakai”.

**Why:** The user clarified this after the original reusable pool was built.
An ambiguous submit may have accepted a paid job, so returning its key to the
pool risks violating the one-use rule.

**How to apply:** Persist consumption before one generation submit. Never restore
or re-import a consumed key as available after success, failure, timeout or a
restart. The same job's polling/download may continue with its original key.

ChinaAPI key entry and pool counts must be manageable through the Telegram bot,
following the existing Picsart workflow.

**Why:** The user requested “buat seperti picsart bisa masukin key lewat bot dan
cek api key ada berapa”.

**How to apply:** Keep bot-based entry and counts available; database setup scripts
alone do not satisfy this requirement. Preserve the single-use rule in that UI.
