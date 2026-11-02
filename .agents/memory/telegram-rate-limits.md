---
name: Telegram rate limit retry safety
description: Distinguish rejected Telegram requests from ambiguous sends and prevent error-reply loops.
---

Honor Telegram's explicit 429 `retry_after` with bounded retries for reference
reads and notification sends. Never apply the same retry rule to send timeouts
or transport errors, and never include paid generation inside a notification
retry callback.

**Why:** A 429 confirms rejection, while a send timeout can occur after successful
delivery. Retrying that timeout can duplicate messages. A failed error
notification can itself hit 429, so replying again from the global error handler
increases traffic instead of helping.

**How to apply:** Distinguish a reference-resolution failure from a failure to
notify the user about it; one log does not prove the other's cause. The global
handler should log a concise 429 without another reply and await any other
fallback reply so its rejection stays contained. Do not log raw Telegram file
URLs: they include the bot token.
