---
name: Browser Use Cloud v2 residential proxy
description: How to enable/region a residential proxy on Browser Use Cloud v2 tasks to avoid "unusual activity" login blocks
---

# Residential proxy on Browser Use Cloud v2

When a login automation hits "blocking automated login due to unusual activity"
(Google/Picsart anti-bot), the cause is usually a **proxy-region mismatch**, not
a missing proxy.

- One-off tasks (`POST /api/v2/tasks` with no `sessionId`) already run through a
  **US residential proxy by default**.
- To region the proxy, add to the create-task body:
  `sessionSettings: { proxyCountryCode: "<cc>" }` (camelCase, 2-letter code).
- Providing `sessionSettings` overrides defaults — the proxy is only enabled if
  `proxyCountryCode` is set, so always include it when you pass sessionSettings.

**Why:** An Indonesian account logging in from a US datacenter/proxy IP looks
anomalous → Google/Picsart issues an "unusual activity" challenge the agent
cannot pass. Matching the proxy country to the account's real region makes the
login look normal.

**How to apply:** Set `proxyCountryCode` to the account's country. In this repo
it is wired via env `BROWSER_USE_PROXY_COUNTRY` (default `id`) in
`artifacts/api-server/src/lib/browser-use.ts`. If a country code is rejected,
the create call fails fast with a 422 (does NOT consume agent-task quota), so an
invalid code is distinguishable from a real run by how quickly it errors.
