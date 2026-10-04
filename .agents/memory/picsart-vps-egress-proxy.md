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

**Rule:** A successful unauthenticated connectivity check from Replit does not establish that authenticated generation or polling from Railway is healthy.

**Why:** Picsart timeouts continued in Railway after the user confirmed redeployment to an endpoint that responded quickly during Replit connectivity checks.

**How to apply:** Report these checks as basic connectivity only, not proof of a fix. Confirm the effective endpoint using credential-free startup diagnostics; investigate the Railway path if timeouts persist instead of indefinitely changing proxy ports.

**Rule:** Decodo ISP country selection uses the documented username parameters, not the static session port. Verify the actual country before claiming that a location change worked.

**Why:** Changing ports selected different egress IPs without specifying a country. A read-only test with country-sg returned SG; country availability depends on the purchased IP list.

**How to apply:** Use the documented user-username-country-XX format while keeping credentials private, and confirm the country through Decodo's geolocation endpoint. A Countries usage export shows past traffic, not current IP entitlement. Do not treat an unauthenticated Picsart response as proof that a generation will succeed.