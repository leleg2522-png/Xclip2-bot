---
name: Picsart account pools (p500 / p100)
description: How Picsart accounts are split into credit-tier pools and routed per model in xclip bot
---

# Picsart account pools

Accounts are split by **tier**, not remaining credit balance, because balance drops as accounts get used while `tierCredits` is stable.

- `poolFromTier(tierCredits)`: `tierCredits === 500` → `'p500'` (premium seller), else → `'p100'` (low-tier seller).
- Pool is captured **only for NEW accounts at add-time** (`categorizeAccount` after `/addpicsartkey`). Existing/legacy accounts stay `pool IS NULL`.
- **NULL pool = wildcard**: a legacy NULL account matches *every* pool request (`pool = $req OR pool IS NULL`). This is a deliberate backward-compat transition policy so routing never starves the ~259 pre-existing uncategorized accounts. Downside accepted: a legacy account that is actually tier-500 can still be consumed by p100 requests until it is (re)categorized.
- New accounts are inserted with provisional `pool='p100'` (NOT null), so a NEW account whose categorization API call fails stays scoped to p100 instead of becoming an all-pools wildcard. The wildcard exception is for legacy rows only.

**Model → pool routing** (in `runWithAccount(userId, poolFilter, fn)`): Kling Motion Control = `null` (any pool); Runway, Sora, Gemini Omni = `'p100'`.

**Why:** user buys from two sellers delivering different credit tiers and wants to manage credit per generation-model.

## Sticky assignment is per (user_id, pool)
`picsart_user_accounts` PK migrated from `user_id` to composite `(user_id, pool)`. A user can hold one sticky account per pool key (`'any'` for Kling, `'p100'` for the rest). Legacy rows default to pool `'any'`.

**Migration must be one-time & guarded**, not repeated DDL on every boot. The guard reads the live PK columns from `pg_index`/`pg_attribute` and only DROP/ADD the PK when it isn't already `user_id,pool`. Repeated DROP/ADD PRIMARY KEY on every startup takes an exclusive lock, rebuilds the unique index, and can interleave/fail across concurrent bot instances.

## Known non-fix
`acquireAccount` is select→pick→upsert without a transaction/lock — a single user firing two generations at once can momentarily double-assign. Pre-existing in the original single-pool design; harmless (both get valid accounts, no corruption), left as-is.

## Checking credits safely
`/guard/credits` (Bearer access token) returns `response.credits` (remaining) and `response.tierCredits` (tier) and does NOT rotate tokens — zero-risk. Only accounts with a still-valid access token can be checked without a refresh; checking expired ones requires `oauth2/refresh` which rotates the refresh token (owner is wary of mass-refreshing many accounts at once).
