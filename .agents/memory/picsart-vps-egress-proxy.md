---
name: Picsart Decodo ISP egress
description: Rules for hiding Railway behind static Decodo ISP proxy endpoints
---

# Picsart Decodo ISP egress

**Rule:** Route every Picsart refresh, upload, submit, and poll request through the static Decodo ISP proxy. Fail closed when Decodo credentials are missing; never silently expose Railway with direct egress.

**Why:** Self-hosted VPS CONNECT tunnels were intermittently reset, while direct Railway egress exposed the hosting IP. Decodo's ISP endpoints provide managed intermediary IPs without the VPS tunnel dependency.

**How to apply:** Use one stable Decodo endpoint for all accounts and all retries; do not automatically rotate ports. A user-requested network replacement may switch to another verified Decodo endpoint, which then remains fixed. Safe pre-submit upload retries reuse the same ISP IP. Never resubmit because a poll failed. Credentials belong only in runtime secrets.

**Rule:** When the user asks to change only the Decodo network, limit the change to the proxy endpoint; do not bundle polling or model changes.

**Why:** The user requested “ganti jaringan decodo saja” after timeouts affected multiple Picsart models.

**How to apply:** Verify that the replacement has a different egress IP and can reach Picsart without submitting a paid generation, then preserve the existing model and polling behavior.