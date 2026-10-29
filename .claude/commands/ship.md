---
description: Ship - check, commit and push main (live) in one step
---
Ship the finished work to live (CLAUDE.md working rule 2: no extra confirmation needed, unless the change includes something gated).

1. **Gated? Stop and ask instead** if the change includes a DB migration to apply, a Pi deploy, deleting data, a force push, or anything touching secrets.
2. `git fetch origin`. On `main` (or a web session's branch), behind `origin/main`? `git pull --ff-only` (or rebase a web branch) first.
3. Run the checks; any failure stops the ship, and you report the output:
   - `bash build.sh --check` (the syntax check and the three-places rule, exactly what Cloudflare runs);
   - `python -m unittest discover -s console/tests` if `console/` changed; `python -m unittest discover -s pi/tests` if `pi/` changed.
4. Stage **only the files this task changed**, by name (never `git add -A`), and commit with a message that says what and why, ending with the attribution lines the system asks for. The pre-commit hook scans for secrets: if it refuses, fix the cause; never `--no-verify`.
5. `git push origin HEAD:main`.
6. If any shipped file in `app/` changed, the CACHE changes: wait about 2 minutes, then poll `curl -s https://symmetryboard.co.uk/sw.js | grep "const CACHE"` (every 30 s, up to 10 min) until it equals `bash build.sh --stamp HEAD`. If it never does, the Cloudflare build probably failed: live keeps the last good version; say so. If the session can't reach the site, say that rather than skipping silently. No `app/` change: the CACHE stays, say so.
7. Report: the commit, what's live, the CACHE seen.

$ARGUMENTS
