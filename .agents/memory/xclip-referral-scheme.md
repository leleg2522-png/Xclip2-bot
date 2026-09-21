---
name: XclipAI referral scheme
description: Agreed referral rules for the Telegram bot — rates, payout target, anti-abuse invariants.
---

Rule: referral bonus is **10% of the invited user's FIRST paid top-up only**, credited straight to the inviter's main saldo (no separate commission wallet). Later top-ups never pay another referral bonus. Link format: `t.me/<bot>?start=ref_<telegramId>`.

**Why:** lifetime commission would make the service financially unsustainable. The invited user must not be told that their first top-up generated a commission.

**How to apply:** keep these invariants when touching top-up/referral code:
- `users.referred_by` is set only once, at account INSERT; self-referral blocked.
- Bonus is credited in the SAME transaction that flips a topup order to PAID; a unique first-top-up claim per `referred_id` prevents later or concurrent top-ups from paying another bonus.
- Bonus only cairs on real PAID status (KlikQRIS), never at invoice creation.
- The invited user's payment confirmation contains no referral or commission information.
- `/referral` reply is sent WITHOUT parse_mode because the link contains underscores (Markdown breaks).
