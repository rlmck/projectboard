---
description: Roll back - git revert a commit on main and push (never the Cloudflare dashboard)
---
Roll back live by reverting, never through the Cloudflare dashboard (CLAUDE.md working rule 2). The commit to undo: $ARGUMENTS

1. `git fetch origin`, on `main`, `git pull --ff-only`. Uncommitted changes? Stop and ask (don't stash or discard them).
2. No commit named? Show the last 10 of `git log --oneline origin/main` and ask which one. Show `git show --stat <commit>` and say in a line what reverting it takes away.
3. A database migration can't be reverted by git. If the commit went with one, say so, and say whether the reverted code still works against the migrated database. If the database needs undoing too, write a compensating `db/NN_*.sql` (the next number; one transaction, idempotent, guarded, count-only checks) and apply it yourself with `python db/apply.py` (`--dry-run` first, then for real), as CLAUDE.md working rule 2 says; then update `db/README.md`. If undoing it would delete user data, that stays gated: stop and ask Ross first.
4. `git revert --no-edit <commit>` (a merge needs `-m 1`: ask first). A conflict: `git revert --abort` and tell Ross what clashed.
5. `bash build.sh --check` must pass, then `git push origin HEAD:main`. Never a force push or a reset of `main` on GitHub.
6. `bash tools/wait-live.sh live` once (timeout 660000 ms), as `/ship` does, and report it.
