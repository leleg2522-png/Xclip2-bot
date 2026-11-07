---
name: Botelex stream interruptions
description: Observed behavior of incomplete Botelex streaming responses and safe retry handling.
---

Botelex can return HTTP 200 while its text stream ends before a complete response is available. Treat a retry as a new model call that may consume quota; never silently replay it. If a complete response was saved and only local validation failed, prefer a narrow local correction and revalidation over another generation call.

**Why:** A Botelex drama-writing request ended with `LLM_STREAM_INCOMPLETE` despite HTTP 200, and no raw answer was saved. A later response was saved but failed only because its continuity note exceeded the local limit.

**How to apply:** For Botelex streaming generation, distinguish transport acceptance from completed output. Keep explicit approval before a new call after an incomplete stream, and use saved text for local validation recovery when possible.
