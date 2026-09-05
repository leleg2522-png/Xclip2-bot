---
name: XclipAI referral scheme
description: Agreed referral rules for the Telegram bot — rates, payout target, anti-abuse invariants.
---

Rule: referral bonus is **10% of EVERY top-up** by the invited user, forever, credited straight to the inviter's main saldo (no separate commission wallet). Link format: `t.me/<bot>?start=ref_<telegramId>`.

**Why:** user explicitly changed the lifetime commission rate to 10%. Bonus remains tied to real payments (not signups) to make fake-account abuse unprofitable.

**How to apply:** keep these invariants when touching top-up/referral code:
- `users.referred_by` is set only once, at account INSERT; self-referral blocked.
- Bonus is credited in the SAME transaction that flips a topup order to PAID; idempotent via `referral_bonuses.order_id UNIQUE` + ON CONFLICT DO NOTHING.
- Bonus only cairs on real PAID status (KlikQRIS), never at invoice creation.
- `/referral` reply is sent WITHOUT parse_mode because the link contains underscores (Markdown breaks).
