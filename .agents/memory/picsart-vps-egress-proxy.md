---
name: Picsart direct egress
description: Decision to connect Picsart directly from Railway instead of through retained VPS proxies
---

# Picsart direct egress

**Rule:** Connect all Picsart refresh, upload, submit, and poll requests directly from Railway. Do not attach either retained VPS proxy to the Picsart HTTP client.

**Why:** Both proxy paths produced intermittent `socket hang up` failures in production. The user explicitly accepted that Picsart can see Railway's egress IP in exchange for removing the proxy dependency.

**How to apply:** Keep `proxy: false` with no custom proxy agents. Safe pre-submit upload retries and safe GET polling retries remain enabled, but both attempts use direct Railway egress. The VPS servers may remain available administratively but are not application fallbacks.