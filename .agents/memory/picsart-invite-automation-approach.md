---
name: Picsart invite automation — local-run approach that defeats the block
description: Why/when to run the Picsart invite+token automation locally on the user's Windows PC instead of Browser Use Cloud
---

# Defeating Picsart/Google "unusual activity" block

**The winning approach:** run the browser automation LOCALLY on the user's Windows PC,
through their Surfshark VPN (device-wide tunnel = clean IP), using a real Chrome in
stealth mode (`playwright-extra` + `puppeteer-extra-plugin-stealth`, `channel: "chrome"`,
`--disable-blink-features=AutomationControlled`).

**Why:** Browser Use Cloud failed — its residential proxy IPs (ID/US/UK) were all flagged
with "unusual activity" (Cloudflare/Google bot detection). The user's Surfshark VPN gives a
clean IP that works manually. Surfshark is device-level (no standalone proxy endpoint), so
it CANNOT be fed to a cloud service — the only way to use it is to run automation on the PC
with Surfshark on. Confirmed working: automated Google login at accounts.google.com
succeeded through Surfshark (2026-06-23).

**How to apply:**
- The automation lives in top-level `local-runner/` (standalone npm project, NOT in the pnpm
  workspace — workspace globs are artifacts/*, lib/*, scripts, so it's excluded). User runs
  it via `run.bat` after a one-time Node.js install.
- Key account facts: HEAD/owner logs into Picsart via email+password (easy). Invited accounts
  log in via Google Workspace ("Continue with Google"), custom domains (e.g. gmuile.com,
  oemails.com), NO 2FA, and ALL share the same password.
- Log into Google directly at accounts.google.com FIRST (canonical, robust), then go to
  Picsart and click "Continue with Google" — it auto-completes since the Google session
  exists. Do NOT rely on loose `text=google` selectors on Picsart's page: a footer/promo
  link sends you to the Google Workspace Marketplace listing instead of the OAuth flow.
- Iteration loop: agent cannot test locally. Ship single files (zipped, since .js can't be
  presented) for the user to drop in; they run and report console output/screenshots.
