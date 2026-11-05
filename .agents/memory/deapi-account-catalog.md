---
name: DeAPI account-scoped model discovery
description: Missing API models can be Premium-gated rather than absent from DeAPI.
---

Do not equate the models visible to one DeAPI API key with the provider's full catalogue.
Check both the public model page and a non-billable price request before saying a model is unavailable.

**Why:** The tested key showed only LTX and MiniMax video models, but the official public catalogue listed Seedance 2.5. A price request for its documented slug returned "This model is not available on your plan", confirming an account-plan restriction, not provider absence. The public page says access requires a first top-up.

**How to apply:** Distinguish provider offering from current key access. Use the official documented slug, never guess one or submit a paid job just to test access. Do not recommend another provider merely because a model is omitted from a free-tier list.

## MiniMax Indonesian dialogue evidence

MiniMax H3 Turbo generated two linked microdrama clips with native Indonesian speech. Independent Whisper transcription recognized both requested lines accurately; sampled frames preserved the single character and setting across a last-frame-to-next-first-frame continuation.

**Why:** This demonstrates Indonesian spoken dialogue in actual output, not merely the presence of an audio track. A subsequent two-character argument also preserved distinct faces/clothing in sampled frames, produced shoulder contact, and transcribed all requested lines. This does not establish frame-perfect lip-sync, correct speaker assignment, complex fight choreography, or voice identity across longer episodes.

**How to apply:** Native dialogue is a viable option for a short prototype; still inspect synchronization and voice continuity before promising production readiness. The tested key can quote and generate even though the account-balance endpoint returns a permission-specific 403; that response alone does not mean the generation key is invalid.

Do not promise rapid turnaround from the short output duration. Two sequential high-resolution ten-second clips took over twenty minutes in one test due to queue and processing delays.

**Why:** Provider throughput varied substantially between tests; chaining a last-frame continuation also prevents those two dependent scenes from running in parallel.

**How to apply:** Separate automation from speed guarantees. For faster episode pipelines, consider independent scenes generated in parallel from approved character references; do not describe dependent continuation scenes as parallelizable.

## MiniMax Mandarin dialogue evidence

MiniMax H3 Turbo can produce native Mandarin speech. Compare Mandarin dialogue
using normalized characters, not whitespace-separated word matching.

**Why:** A Chinese-family-drama sample's independent Whisper transcription
matched its requested Mandarin line after removing punctuation. Its timestamp
extended to the end of the clip despite an earlier speech-finish instruction.

**How to apply:** Use Mandarin transcription rather than forcing Indonesian.
Check speech timing and clip-end truncation separately from textual accuracy.
A matching transcript does not establish lip synchronization, correct speaker
assignment, or stable voices across a whole episode.

## Bot credential management

The user requested additional standalone LTX and MiniMax video packages from
DeAPI: ten seconds each, selling for Rp500 per video.

**Why:** The user originally requested ten-second LTX and MiniMax packages at
Rp1,000, then changed the selling price: “harga nya 500 deh per video LTX DAN H3 deapi”.
The new Rp500 price supersedes Rp1,000; it is not a resolution requirement.

**How to apply:** Add distinct choices within the existing LTX and MiniMax
families. Preserve existing variants and their prices. Use the existing
database-managed DeAPI pool and failed-delivery refund rules.

Manage DeAPI credentials as a pool in the bot's Railway database.

**Why:** The user explicitly requested “buatkan pool api untuk de api di DB”. A database-managed pool avoids requiring hosting-variable changes for each additional key.

**How to apply:** Preserve database-managed credential selection when changing the microdrama renderer. Keep accepted jobs tied to their original account; adding or disabling a pool key must not move an existing paid job to another account.

On a rate limit, automatically try another DeAPI pool credential without
deleting or marking the rate-limited credential dead. Keep it for use after
the limit resets; rate limiting is not proof the balance is exhausted.

**Why:** The user explicitly requested automatic switching on limits while
retaining the previous credential if its balance remains.

**How to apply:** Distinguish explicit pre-acceptance HTTP 429 rejection from
timeouts and accepted jobs. Only the former allows a fresh submit on another
key. Respect reset headers, preserve accepted-job bindings, and never infer
zero balance from a limit.

Persist the time a key hits a limit and its next eligible time in the Railway
pool so later users and restarted bot processes skip it until reset.

**Why:** The user explicitly requested time marking so new users do not retry
the same limited credential.

**How to apply:** Enforce cooldowns during database selection, not only in
process-local memory. Show times in WIB to admins. Separate model/endpoint
limits from quote limits; never apply a daily reset when the daily quota still
has remaining requests.

## Generation rate limits versus credit balance

A successful price quote does not establish that a video submit has available quota. A repeated HTTP 429 after a minute-scale cooldown may be a daily limit, not exhausted credits.

**Why:** An authorized animation revision was rejected twice with 429 despite a two-minute delay while its price quote succeeded. Official limits documentation lists separate price/status buckets and both minute and rolling-day generation windows; Basic MiniMax H3 is documented at three video requests per day.

**How to apply:** Consult https://docs.deapi.ai/limits-and-quotas and the effective response headers rather than hard-coding a short cooldown or assuming a midnight reset. Retain Retry-After and daily-reset diagnostics on rejected submits. Do not infer the account tier or exhausted balance from HTTP 429 alone, or rotate an already accepted job to another account.

The user confirmed that the DeAPI account used for the artwork-animation demonstration is Basic and has never been topped up.

**Why:** The user explicitly selected “Basic, belum pernah top-up” when generation was blocked by repeated HTTP 429.

**How to apply:** Use Basic limits when explaining this account's capacity, but recheck if the user later tops up or changes accounts. Basic status supports a daily-quota explanation; it does not establish the exact exhausted bucket or reset time without response diagnostics.
