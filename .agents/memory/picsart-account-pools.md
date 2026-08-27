---
name: Picsart account pools (p500 / p100)
description: How Picsart accounts are split into credit-tier pools and routed per model in xclip bot
---

# Picsart account pools

Accounts are split by their **current credit balance AT ADD-TIME** (owner's explicit choice: "berdasarkan pas di add itu 500 kredit atau 5-100"). The pool tag is captured once and never moves afterward as credits deplete.

- `poolFromCredits(credits)`: `credits >= POOL_500_MIN_CREDITS` (200) → `'p500'`, else → `'p100'`. The two sellers deliver ~500 vs 5-100, so an account arriving with only ~50 credits correctly lands in p100.
- **Why credit-at-add, not tier:** owner has accounts (even from the premium seller) that sometimes arrive with only ~50 usable credits; they want those treated as low-pool by their actual value at purchase, not by tierCredits.
- `tier_credits` is still stored for reference but does NOT drive the pool.
- Pool is captured **only for NEW accounts at add-time** (`categorizeAccount` after `/addpicsartkey`). Existing/legacy accounts stay `pool IS NULL`.
- **NULL pool = wildcard**: a legacy NULL account matches *every* pool request (`pool = $req OR pool IS NULL`). This is a deliberate backward-compat transition policy so routing never starves the ~259 pre-existing uncategorized accounts. Downside accepted: a legacy account that is actually tier-500 can still be consumed by p100 requests until it is (re)categorized.
- New accounts are inserted with provisional `pool='p100'` (NOT null), so a NEW account whose categorization API call fails stays scoped to p100 instead of becoming an all-pools wildcard. The wildcard exception is for legacy rows only.

**Model → pool routing:** Kling Motion Control = any pool; Runway, Sora, Gemini Omni = p100; Wan 3.0 Prime—including the public Seedance 2.5 alias—= any pool, so both p100 and p500 accounts are eligible.

**Why:** the owner clarified that “5–100 dan p500” refers to the two account pools. Separately, both Wan 3.0 and its public Seedance 2.5 alias may accept up to 5 reference images while drawing from either pool.

**How to apply:** route Wan 3.0 Prime and its public Seedance 2.5 alias through the unfiltered/any-pool account selector. Their shared upload wizard and provider payload must cap reference images at 5.

**p500 excludes legacy wildcards**: `acquireAccount` only picks `c.pool = 'p500'` accounts for p500 requests — legacy NULL-pool accounts are excluded. This prevents old ~50-credit accounts from being assigned to expensive models. NULL wildcards still apply for null and p100 pool requests.

**Why:** user buys from two sellers delivering different credit tiers and wants to manage credit per generation-model.

## Sticky assignment is per (user_id, pool)
`picsart_user_accounts` PK migrated from `user_id` to composite `(user_id, pool)`. A user can hold one sticky account per pool key (`'any'` for Kling, `'p100'` for the rest). Legacy rows default to pool `'any'`.

**Migration must be one-time & guarded**, not repeated DDL on every boot. The guard reads the live PK columns from `pg_index`/`pg_attribute` and only DROP/ADD the PK when it isn't already `user_id,pool`. Repeated DROP/ADD PRIMARY KEY on every startup takes an exclusive lock, rebuilds the unique index, and can interleave/fail across concurrent bot instances.

## Known non-fix
`acquireAccount` is select→pick→upsert without a transaction/lock — a single user firing two generations at once can momentarily double-assign. Pre-existing in the original single-pool design; harmless (both get valid accounts, no corruption), left as-is.

## Checking credits safely
`/guard/credits` (Bearer access token) returns `response.credits` (remaining) and `response.tierCredits` (tier) and does NOT rotate tokens — zero-risk. Only accounts with a still-valid access token can be checked without a refresh; checking expired ones requires `oauth2/refresh` which rotates the refresh token (owner is wary of mass-refreshing many accounts at once).
