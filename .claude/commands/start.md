---
description: Start a session - pull, turn on the secret scan, read the status, summarise
---
Start of session (CLAUDE.md → Session rules). Keep it cheap: everything read here stays in the context for the whole session (`docs/token-audit.md`).

1. `git fetch origin`, then make sure you're on `main` (a Claude Code web session stays on its `claude/<slug>` branch) and run `git pull --ff-only`. If it isn't a fast-forward, stop and tell Ross what diverged.
2. `git config core.hooksPath` must print `.githooks`; if not, run `git config core.hooksPath .githooks` (the pre-commit secret scan).
3. Read `PROJECT_STATUS.md` and `TODO.md`. **Don't re-read `CLAUDE.md`**: it's already loaded into every session. If the pull changed it, read only `git diff ORIG_HEAD -- CLAUDE.md`.
4. Check the live `CACHE` in one command: `curl -s https://symmetryboard.co.uk/sw.js | grep "const CACHE"` against `bash build.sh --stamp origin/main`. Different means a deploy is still building, or the last Cloudflare build failed: say which you think, and why.
5. Summarise for Ross in under 15 lines: the branch and anything unpushed or uncommitted, live vs main, the top 3 of `TODO.md`, anything in **Waiting on** he can act on, and the open questions that block the next item. Then ask what this session's one feature is, unless he already said.
6. **Once the feature is known**, read only the reference sections it touches, never the big docs whole: `grep -n '^##' docs/codebase-overview.md` (131 KB) for its map, then Read those sections with offset/limit. The same for `docs/cast-contract.md` (casting, Realtime, the Pi) and `pi/README.md` (Pi or LED work).

$ARGUMENTS
