---
name: Telegram bot self-hosted result links
description: How the bot delivers large video/image results and the durable constraints around it
---
The bot (telegram-bot/, standalone) delivers AI results to users by downloading them server-side and either uploading inline to Telegram (when ≤~48MB) or serving them from its OWN server via a random-token download link (`/dl/:token`) on its Railway domain.

**Why link delivery exists:** (1) hides the upstream provider — the user only ever sees our domain, never the Picsart/CDN URL; (2) bypasses Telegram's ~50MB bot-upload cap (a download has no such limit).

**Key constraints / decisions:**
- The user explicitly rejected the earlier ffmpeg transcode/metadata-strip approach ("gaperlu ffmpeg"). So result files are now redistributed raw — provider-identifying *container metadata* (if any) is NOT stripped. Only the visible URL is hidden. Do not re-add ffmpeg without the user asking.
- Files live in `os.tmpdir()` with a 24h TTL Map + hourly sweeper, but Railway tmpdir is **ephemeral** — it's wiped on redeploy/restart, so links do NOT reliably survive 24h. Message wording is intentionally vague ("link berlaku sementara"). To make links durable, you'd need object storage (e.g. App Storage / signed URLs) + a persistent token index, not the in-memory Map.
- Public base URL resolution: `PUBLIC_BASE_URL` env override, else `RAILWAY_PUBLIC_DOMAIN` (auto-set by Railway), else localhost.
- Format/MIME for the link is derived via the existing `detectVideoType(buf, sourceUrl)` / `detectMime(buf)` helpers, not hardcoded.
