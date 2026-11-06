---
name: Workspace dependency recovery
description: Recovery approach when package registry access fails for a workspace-wide install.
---

If a root pnpm install fails because a package tarball is blocked or unavailable, a root offline install may fail for the same missing package. An offline install filtered to the artifact(s) needed for the immediate work, including their workspace dependencies, can still restore enough dependencies to build and run those workflows.

**Why:** A registry 403 affected a tarball that was not cached; both the normal root install and root offline install failed, while a filtered offline install restored the required artifacts.

**How to apply:** Use this as a scoped recovery when registry access is unavailable. Confirm which workflows are needed, install only their dependency closure, then restart and inspect those workflows; do not treat it as proof that every workspace package is installed.
