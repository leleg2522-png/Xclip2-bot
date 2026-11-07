---
name: Telegram bot TSX eval imports
description: Dynamic-import interop when running the Telegram bot's TypeScript modules through `tsx -e`.
---

When invoking bot modules with `pnpm --dir telegram-bot exec tsx -e`, dynamic imports expose transpiled CommonJS exports under `.default` (for example, `const { EpisodeDirector } = (await import("./src/episode-director.ts")).default`).

**Why:** A one-off director invocation failed before making a provider request because the expected named exports were undefined.

**How to apply:** For ad hoc microdrama generation, confirm the runtime export shape before invoking the LLM or any paid provider.
