---
name: Standalone Telegram bot package
description: Installation behavior for the Telegram bot package under the imported pnpm project.
---

The `telegram-bot` package is intentionally outside the root pnpm workspace. From that directory, use `pnpm install --ignore-workspace --frozen-lockfile` before running its tests or TypeScript build.

**Why:** A normal install from the nested directory resolves the parent workspace and can report success without creating the bot's local `node_modules`, leaving `tsx` and Node type definitions unavailable.

**How to apply:** When validating or operating the bot, install from `telegram-bot` in standalone mode; do not add it to the root workspace unless the project architecture is intentionally changed.