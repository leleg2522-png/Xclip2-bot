---
name: Picsart Seedance reference audio
description: Reference-audio contract, visual-input restrictions, and interpreting the public SDK documentation without changing the existing provider route.
---

Seedance 2 and 2.5 audio uploads remain on Picsart. The user's clarification was to add reference audio to those existing routes, not move Seedance to Vivareel.

**Why:** The request followed Vivareel-pool work, but the user explicitly clarified that the requested models were the Picsart ones.

**How to apply:** Preserve the selected provider, pricing, finishing and accepted-job safety when changing media inputs.

The public compatibility docs describe `audio_url` content items with `reference_audio` roles for the shared Seedance workflow. Seedance 2.0 permits up to three audio references but not audio as the only media modality; Seedance 2.5 permits up to ten and allows audio-only references.

**Why:** The Seedance 2 playground's references summary mentions images/videos without showing audio, while its API parameter table explicitly includes audio. Do not infer unsupported audio from that abbreviated UI.

**How to apply:** Consult both the unified `audioUrls` table and the compatibility `content` table:
- https://picsart.com/api-platform/models/seedance-2.0/api
- https://picsart.com/api-platform/models/seedance-2.5/advanced

Treat documented per-file duration ceilings separately from the bot's stricter aggregate limits. The bot's conservative total limits are not claims about the provider's complete limits.

**Why:** Public tables describe maximum audio-file duration, which does not establish how multiple files' durations combine. Confusing the two would advertise unsupported behavior or unnecessarily rewrite a deliberate bot restriction.

**How to apply:** Keep customer instructions consistent with bot validation, and require documentation or live evidence before relaxing aggregate limits. Public SDK authentication examples are not a request to replace the existing session-authenticated gateway.
