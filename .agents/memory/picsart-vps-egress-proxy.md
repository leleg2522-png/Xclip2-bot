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

**Rule:** Use the previous VPS as the upload-only transient fallback, never a direct Railway-to-Picsart fallback.

**Why:** Even healthy IPv4 Cloudflare tunnels may occasionally close with `socket hang up`. Retrying through an independent VPS path avoids repeating the same network fault while preserving Railway IP isolation.

**How to apply:** First upload attempt uses the Premium VPS; one safe pre-submit retry uses the previous VPS. Submit and polling remain on the primary VPS, and no post-submit request may create a second paid job.

**Compatibility note:** Squid is the primary proxy because it is more reliable for multipart uploads. Its NCSA password file must be generated from the same deterministic SHA-256-derived credential used by the bot. Never add a direct-upload fallback: all Picsart traffic must retain VPS egress.

**Rule:** Keep IPv6 disabled at kernel level on the dedicated Picsart proxy VPS; Squid configuration and resolver preference alone do not prevent IPv6 Cloudflare tunnels.

**Why:** Squid still selected Cloudflare IPv6 destinations despite `tcp_outgoing_address` and `/etc/gai.conf`; production upload/poll tunnels then ended with `socket hang up`. Kernel-level IPv6 disable produced 50/50 successful TLS tunnels and two successful 25 MB uploads, all on IPv4.

**How to apply:** Preserve `/etc/sysctl.d/99-picsart-ipv4-only.conf`, the Squid IPv4 outgoing-address rule, and resolver preference. After changes or reboot, verify both sysctl disable flags and the `HIER_DIRECT` address family in Squid access logs.