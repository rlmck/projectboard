---
description: Start a session - pull, turn on the secret scan, read the status, summarise
---
Start of session (CLAUDE.md → Session rules).

1. `git fetch origin`, then make sure you're on `main` (a Claude Code web session stays on its `claude/<slug>` branch) and run `git pull --ff-only`. If it isn't a fast-forward, stop and tell Ross what diverged.
2. `git config core.hooksPath` must print `.githooks`; if not, run `git config core.hooksPath .githooks` (the pre-commit secret scan).
3. Read `CLAUDE.md`, `PROJECT_STATUS.md` and `docs/codebase-overview.md`. If the work touches casting, Realtime or the Pi, read `docs/cast-contract.md` too; for Pi or LED work, `pi/README.md`.
4. Check the live `CACHE`: `curl -s https://symmetryboard.co.uk/sw.js | grep "const CACHE"` against `bash build.sh --stamp origin/main`. Different means a deploy is still building, or the last Cloudflare build failed: say which you think, and why.
5. Summarise for Ross in under 15 lines: the branch and anything unpushed or uncommitted, live vs main, the top of **Next**, anything in **Waiting on** he can act on, and the open questions that block the next item. Then ask what this session's one feature is, unless he already said.

$ARGUMENTS
