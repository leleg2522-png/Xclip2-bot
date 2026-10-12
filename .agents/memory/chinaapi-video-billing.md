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
