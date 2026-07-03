---
name: XclipAI saldo billing & KlikQRIS top-up
description: Pay-per-generate charge/refund rules and QRIS top-up settlement design for the XclipAI Telegram bot
---

# Pay-per-generate (saldo) billing

The bot charges Rupiah `saldo` per generation instead of a monthly subscription. Login is by Telegram ID; email/password is only used once to LINK an old account.

## Charge/refund rule (LOCKED — do not weaken)
- Charge only if the result was **actually delivered**. ANY failure (generation error OR delivery failure) = **full refund**.
- Refunding saldo → cash is **not allowed** (saldo is one-way).

## How every `run*` generation function must be structured
Each of the 8 run* flows follows this exact shape:
1. `beginCharge(dbUserId, amount)` at the very top — synchronously adds the user to the in-flight `generating` Set (the in-flight lock) AND atomically deducts saldo via `UPDATE ... WHERE saldo >= amount`. If it fails (insufficient saldo or already in-flight) it releases nothing it didn't take and the handler returns.
2. `let refund = true;`
3. `const delivered = await sendResult(...)`. Only when `delivered === true`: set `refund = false`, then `incrementKlingUsage` + `markGenSuccess` (note: `runImageGen` does NOT call `markGenSuccess`).
4. `finally { if (refund) addSaldo(...) + "↩️ Saldo dikembalikan"; generating.delete(dbUserId); }` — the lock is ALWAYS cleared in finally so it can never leak.

**Why:** guarantees no double-charge, no charge-without-delivery, no refund-after-delivery, and no stuck in-flight lock.

# KlikQRIS top-up settlement (polling, no webhook)

Endpoints: `POST https://klikqris.com/api/qris/create` (send `callback_url:''`), `GET https://klikqris.com/api/qris/status/{order_id}`. Headers: `x-api-key` + `id_merchant`. `order_id = XCLIP-<telegramId>-<Date.now()>`. Credit user the round `amount`; user pays `total_amount` (has a unique code appended). `qris_image` is a base64 data URL; expiry ~5 min.

## Settlement design (survived architect review — earlier naive version failed)
- **`markTopupPaidAndCredit` uses `WHERE status <> 'PAID'`, NOT `= 'PENDING'`.** This is deliberate: a payment can land AFTER we locally marked the order EXPIRED. Crediting from any non-PAID status recovers late payments while staying anti-double (only one call can flip to PAID + credit, in one transaction).
- Poller runs every 15s with a reentrancy guard (`topupPollerRunning`) and an immediate `void pollPendingTopups()` at startup to resume pending orders after a redeploy.
- Local forced-expiry only after `expires_at + 10min` grace (fallback `created_at + 30min` when the gateway omits `expired_at`) so slow settlement isn't cut off and orders never stay PENDING forever.
- `/cekbayar` reconciles the most recent **non-PAID** order in the last hour (not just latest PENDING) so a user whose order was locally expired can still recover a late payment.

**Why:** the first version hard-expired by local clock and only credited PENDING → late/slow payments were permanently stranded. The gateway status must stay authoritative for crediting.

## Deploy reminder
`KLIKQRIS_API_KEY` + `KLIKQRIS_MERCHANT_ID` must be set on **Railway** (bot deploys there, not Replit) or `/topup` is disabled at startup.
