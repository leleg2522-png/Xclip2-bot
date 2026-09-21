---
name: Picsart VPS egress proxy
description: Durable security and deployment rules for routing Picsart traffic through the private VPS proxy
---

# Picsart VPS egress proxy

**Rule:** Route only the Picsart client through the authenticated HTTPS CONNECT proxy. Keep Telegram, Edanbot, ByteDance Upscaler, and unrelated providers on their existing network paths.

**Why:** The proxy is a dedicated Picsart egress path. Applying it globally would couple unrelated providers to one VPS and could break routes that intentionally require direct connections.

**How to apply:** The bot derives a URL-safe proxy credential from `PICSART_VPS_PROXY_PASSWORD`; configure the same secret in every runtime that hosts the bot. Replit Secrets do not automatically propagate to Railway.

**Rule:** Never reuse the VPS root password as the proxy password, and rotate any credential pasted into chat before use.

**Why:** Proxy credentials are used frequently by the application and should not grant administrative access to the VPS.

**How to apply:** Store root and proxy credentials separately in secret managers. The primary Squid proxy runs on the Premium Intel VPS at `168.144.141.146:3129` and accepts authenticated HTTPS CONNECT traffic only. The previous VPS is rollback-only.

**Compatibility note:** Squid is the primary proxy because it is more reliable for multipart uploads. Its NCSA password file must be generated from the same deterministic SHA-256-derived credential used by the bot. Never add a direct-upload fallback: all Picsart traffic must retain VPS egress.

**Rule:** Keep Squid egress pinned to the VPS IPv4 address; do not allow automatic IPv6 selection for Picsart/Cloudflare endpoints.

**Why:** Squid intermittently selected Cloudflare IPv6 destinations and production upload/poll tunnels ended with `socket hang up`. Pinning `tcp_outgoing_address` to the VPS IPv4 produced 50/50 successful TLS tunnels, all on IPv4, plus two successful 25 MB uploads.

**How to apply:** Preserve the Squid IPv4 outgoing-address rule and the Linux IPv4 resolver preference when editing proxy networking. After changes, verify the `HIER_DIRECT` address family in Squid access logs, not just HTTP success.