---
name: Freebeat Windows Bridge
description: Durable decision for running Freebeat web-only generations through a local Windows browser while the Telegram bot remains the billing and job authority.
---

The outbound-polling Windows Bridge is now a legacy completion path only. Do not
route new public Seedance 2.5 orders to it. Keep it available long enough to finish
or refund jobs that were already queued before the backend switch.

**Why:** Freebeat's browser-only Seedance 2.5 flow worked from the user's browser but
server-side replay from Replit/Railway was rejected before provider acceptance. The
Bridge avoids browser/IP-context mismatch without requiring port forwarding.

**How to apply:** Do not create new Bridge jobs from the public menu. For existing
legacy jobs, preserve durable leasing, acceptance tracking, no-resubmit behavior,
and exactly-once refunds.