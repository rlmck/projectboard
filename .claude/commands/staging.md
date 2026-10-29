---
description: Staging first - check, commit and push to dev only, give the staging URL
---
Ross said "staging first": push to `dev` only. Live is untouched.

1. Same gate as `/ship`: nothing gated in the change (else ask), `bash build.sh --check` and the relevant test suites pass, stage only this task's files by name, commit (the secret scan runs; never `--no-verify`).
2. `git fetch origin`. If `origin/dev` isn't an ancestor of `HEAD` (`git merge-base --is-ancestor origin/dev HEAD` fails), dev has diverged and pushing would need a force push: **stop and ask Ross** (force pushes are gated).
3. `git push origin HEAD:dev`. Don't push `main`.
4. When `app/` changed, poll `curl -s https://dev-projectboard.rosslewismckechnie.workers.dev/sw.js | grep "const CACHE"` until it equals `bash build.sh --stamp HEAD` (up to 10 min).
5. Give Ross the staging URL, https://dev-projectboard.rosslewismckechnie.workers.dev, and what to look at there. Remind him staging shares the **live database**. The commit stays on local `main` unshipped: the next `/ship` (or his "ship it") pushes it live.

$ARGUMENTS
