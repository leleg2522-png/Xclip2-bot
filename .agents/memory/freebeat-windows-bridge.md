---
name: Freebeat Windows Bridge
description: Durable decision for running Freebeat web-only generations through a local Windows browser while the Telegram bot remains the billing and job authority.
---

Use an outbound-polling Windows Bridge for Freebeat web generation. The logged-in
browser session stays only in the persistent local browser profile; Railway receives
only Bridge enrollment credentials, job metadata, and final result URLs.

**Why:** Freebeat's browser-only Seedance 2.5 flow worked from the user's browser but
server-side replay from Replit/Railway was rejected before provider acceptance. The
Bridge avoids browser/IP-context mismatch without requiring port forwarding.

**How to apply:** Queue paid work durably in the bot database, lease it to one Bridge,
and record provider acceptance before polling. Never resubmit after acceptance. Refund
exactly once on pre-accept failure, delivery failure, or an expired undelivered job.