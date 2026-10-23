---
name: Picsart Decodo ISP egress
description: Rules for hiding Railway behind static Decodo ISP proxy endpoints
---

# Picsart Decodo ISP egress

**Current rule:** Keep Decodo ISP primary. The user says there are ten ISP IPs
and requests that they be used in turn when a connection fails. Try the other
ISP endpoints before direct Railway egress; recover ISP automatically.
Do not disable ISP globally as the outage workaround.

**Why:** After being told Picsart would see Railway's IP during fallback, the
user requested a temporary workaround and corrected the implementation:
“jangan nonaktifkan tapi kaya buat agar mereka bisa beralih”.
They subsequently requested: “itu kan kita ada 10 ip ya bergantian saja”.
This supersedes both always-ISP/no-direct-fallback and single-endpoint-only
rules. Rotation is failover on errors, not random IP changes on every request.

**How to apply:** Switch transport, never rerun paid generation orchestration.
Retry safe reads/free requests through direct egress, preserve the same accepted
job ID for polling, and never replay an ambiguous paid submit. Explicit proxy
407 rejection precedes upstream acceptance; multipart bodies must be rebuilt
before retry. Keep a healthy ISP endpoint stable, check alternatives with free
connectivity probes, and use direct only if none is available. Return to ISP
only after a successful connectivity probe, not merely because a cooldown
expired. Preserve existing country targeting and credentials.

**Normal ISP rule (when restored):** Route every Picsart refresh, upload, submit,
and poll through the static Decodo ISP proxy. In ISP mode fail closed when
credentials are missing; do not silently fall back to direct egress.

**Why:** Self-hosted VPS CONNECT tunnels were intermittently reset, while direct Railway egress exposed the hosting IP. Decodo's ISP endpoints provide managed intermediary IPs without the VPS tunnel dependency.

**How to apply:** Keep the selected healthy endpoint stable until it fails,
then rotate within the user's ISP pool under the current rule above. Never
resubmit because a poll failed. Credentials belong only in runtime secrets.

**Rule:** When the user asks to change only the Decodo network, limit the change to the proxy endpoint; do not bundle polling or model changes.

**Why:** The user requested “ganti jaringan decodo saja” after timeouts affected multiple Picsart models.

**How to apply:** Verify that the replacement has a different egress IP and can reach Picsart without submitting a paid generation, then preserve the existing model and polling behavior.

**Rule:** A successful unauthenticated connectivity check from Replit does not establish that authenticated generation or polling from Railway is healthy.

**Why:** Picsart timeouts continued in Railway after the user confirmed redeployment to an endpoint that responded quickly during Replit connectivity checks.

**How to apply:** Report these checks as basic connectivity only, not proof of a fix. Confirm the effective endpoint using credential-free startup diagnostics; investigate the Railway path if timeouts persist instead of indefinitely changing proxy ports.

**Rule:** Decodo ISP country selection uses the documented username parameters, not the static session port. Verify the actual country before claiming that a location change worked.

**Why:** Changing ports selected different egress IPs without specifying a country. A read-only test with country-sg returned SG; country availability depends on the purchased IP list.

**How to apply:** Use the documented user-username-country-XX format while keeping credentials private, and confirm the country through Decodo's geolocation endpoint. A Countries usage export shows past traffic, not current IP entitlement. Do not treat an unauthenticated Picsart response as proof that a generation will succeed.

**Rule:** Ten different static ports do not by themselves prove ten distinct
usable IPs when country or direct-IP targeting is applied.

**Why:** Decodo documents that static ports iterate over purchased IPs, and
country targeting restricts the eligible IPs. The user's total purchased IP
count is not proof that all ten belong to the selected country.

**How to apply:** Preserve targeting, verify distinct egress IPs with free
geolocation checks when connectivity permits, and distinguish proxy rejection
(407) from geographic/provider outage. Never claim a Replit check establishes
Railway's effective configuration or connectivity.

**Rule:** Treat `dc.decodo.com` datacenter proxy credentials and
`isp.decodo.com` ISP credentials as separate product configurations. A supplied
datacenter pool is not authorization to replace the production ISP route.

**Why:** Proxy authentication failed with the previously saved credentials,
while separately supplied datacenter credentials worked. That difference does
not establish a provider outage or prove the production ISP password is wrong.

**How to apply:** Test the exact product endpoint with its securely supplied
credentials. Distinguish basic IP-check success from authenticated Picsart
generation, and obtain approval before switching production from ISP to
datacenter egress.