---
description: Ship - check, commit and push main (live) in one step
---
Ship the finished work to live (CLAUDE.md working rule 2: no extra confirmation needed, unless the change includes something gated).

1. **Gated? Stop and ask instead** if the change includes deleting data, a force push, or anything touching secrets. (Migrations and Pi deploys are part of the job: CLAUDE.md working rule 2.)
2. `git fetch origin`. On `main` (or a web session's branch), behind `origin/main`? `git pull --ff-only` (or rebase a web branch) first.
3. Run the checks; any failure stops the ship, and you report the output:
   - `bash build.sh --check` (the syntax check and the three-places rule, exactly what Cloudflare runs);
   - `python -m unittest discover -s console/tests` if `console/` changed; `python -m unittest discover -s pi/tests` if `pi/` changed.
4. Stage **only the files this task changed**, by name (never `git add -A`), and commit with a message that says what and why, ending with the attribution lines the system asks for. The pre-commit hook scans for secrets: if it refuses, fix the cause; never `--no-verify`.
5. `git push origin HEAD:main`.
6. If any shipped file in `app/` changed, the CACHE changes: run `bash tools/wait-live.sh live` **once** (timeout 660000 ms). It polls inside one command until the live `sw.js` shows `bash build.sh --stamp HEAD`; never poll with repeated curls, each one is a full model round trip over the whole context. Exit 1 = timed out: the Cloudflare build probably failed and live keeps the last good version; say so. Exit 2 = the site couldn't be reached: say that rather than skipping silently. No `app/` change: the CACHE stays, say so (don't poll).
7. If the push changed anything the Pi gets (`pi/`, `app/hold_map.json`, `app/board-fallback.jpg`): `python console/autodeploy.py` once. It deploys main now if the board is free (outside the opening hours, or 15 quiet minutes inside them); if it says `waiting`, the scheduled task retries every 10 minutes, so don't wait for it. Report what it said.
8. Report: the commit, what's live, the CACHE seen, and the Pi deploy (done, or waiting and why).

$ARGUMENTS
