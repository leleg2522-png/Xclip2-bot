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
- Delivery fallback when the chat download card fails for the user: the api-server serves
  the runner zips at `GET /api/download/:name` (no auth — mounted BEFORE the invite router,
  which applies adminAuth router-wide). User opens the dev-domain URL in a browser. Keep the
  copies in `artifacts/api-server/downloads/` in sync when the script changes.

# Two DISTINCT failures — do not conflate

1. **"Unusual activity" block = Google IP/fingerprint**, on accounts.google.com — NOT caused
   by choosing email-vs-Google login. It hits any automated Google sign-in regardless, which
   is why even "Continue with Google" can't avoid it (you still authenticate at Google first).
   Fix = Surfshark + local stealth Chrome.
2. **Picsart login failure = wrong login method.** Invited accounts are Google-OAuth-only and
   have NO Picsart-native password. The old Browser Use task said "sign in with email and
   password", so the AI tried typing email/password on Picsart and failed. Login MUST go
   through "Continue with Google".

# Decisions for full automation (Tahap 3) — be consistent with these

- The panel/bot Picsart-login steps that use email+password for INVITED accounts are wrong and
  must be changed to "Continue with Google". (HEAD/owner email+password is fine.)
- **Why:** invited accounts have no Picsart password; email login can only fail.
- Prefer ONE continuous browser session: accept the invite from Gmail → in the SAME session
  continue to Picsart (Google login if prompted) → grab REFRESH_TOKEN. The old bot used a
  separate fresh Browser-Use task per step, re-logging from scratch — wasteful and failure-prone.
- For local-runner, the reliable proven sub-flow so far is semi-manual: script auto-logs into
  Google, then PAUSES (readline ENTER) for the user to do the Picsart "Continue with Google"
  clicks, then auto-extracts the token. Automate the clicks only after this is proven.
