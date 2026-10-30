# ProjectBoard: CLAUDE.md

Read this at the start of every session (or run `/start`). It holds the rules, the things that must not break, and the traps, and points to everything else. **What's happening now** (current state, waiting on, open questions) lives only in `PROJECT_STATUS.md`; **what to do next** lives only in `TODO.md`.

## What this is

A PWA for the symmetry board at The Hangout climbing gym, Portland (near Weymouth, UK): a wooden wall with 188 LED-lit holds on a 19 × 13 grid (A–S × 1–13). Climbers browse **problems** (boulders) and **circuits** (long sport-style routes), **cast** a problem to light its holds via a Raspberry Pi, **tick** sends, save **favourites** and climb the points **leaderboard**. It has real users.

| | |
|---|---|
| **Live** | https://symmetryboard.co.uk, from `main` |
| **Staging** | https://dev-projectboard.rosslewismckechnie.workers.dev, from `dev` |
| **Old address** | https://rlmck.github.io/projectboard, a permanent "we've moved" page served from the `legacy` branch |
| **Repo** | https://github.com/rlmck/projectboard (public, permanently) |
| **Local path** | `C:\Users\rossl\Documents\ProjectBoard\` (the repo root; there's no subfolder) |

**Which document to trust:**
- **Now:** `PROJECT_STATUS.md` (current state, decisions, waiting on, open questions, the last 5 sessions). Older sessions: `docs/log/<yyyy-mm>.md`.
- **To-do:** `TODO.md`, Ross's one ordered list (top item = now). Asked "what's on my to-do list?", show the top 3; the rest only if asked. He adds, removes and reorders by asking; edit it, then ship it.
- **Architecture, data model, auth, caching, deploy mechanics, known issues:** `docs/codebase-overview.md`. Read it at the start of a session. It was checked against the live database.
- **Hosting, rollout and the install flow:** `docs/rollout-plan.md`.
- **The cast contract:** `docs/cast-contract.md`. **Circuits Phase 2 spec:** `docs/circuits-phase2.md`.
- **The Pi:** `pi/README.md` (what runs, deploy, rollback, wiring, LED mapping); the listener and kiosk plan with the R8 acceptance tests: `docs/pi4-listener-kiosk-plan.md`.
- **PB Console** (the laptop's admin console, `console/`): `console/README.md`; its plan: `docs/console-plan.md`.
- **Security findings:** `docs/security-findings.md`, **local only, never committed**. Read it before touching RLS, grants, casting or sign-up.
- **Local only, on Ross's laptop:** `docs/changelog.md` (feature history to Sep 2026), `docs/project-notes.md` (the original DTB system, the hardware), `docs/pi4-led-audit.md` (the verified LED spec, 16 Oct 2026: read it before LED driver work), `db/README.md` (every DB script).

---

## Working rules

1. **Read this file, `PROJECT_STATUS.md`, `TODO.md` and `docs/codebase-overview.md` at the start of every session** (`/start`).
2. **Deploying (Ross, 29 Oct 2026; replaces the 19 Oct two-confirmation rule).**
   - **By default, ship:** when a task is done and the checks pass (`bash build.sh --check`, plus `console/tests` or `pi/tests` when those changed), commit and push `main` in one step, without asking (`/ship`). Stage only the files the task changed, by name. Then, if a shipped file in `app/` changed, confirm the live `sw.js` shows the new `CACHE` stamp (`bash build.sh --stamp HEAD`); if the session can't reach the live site, say so rather than skipping it silently.
   - **"Staging first"** (Ross says so): commit, push to `dev` only, give him the staging URL (`/staging`). There's no rule about keeping `dev` and `main` level; `dev` is just the staging branch.
   - **Do the whole job, end to end (Ross, 30 Oct 2026).** When Ross asks for something, finish it, including its migration and its Pi deploy: don't hand back admin steps or ask again. Report what's live, how to test it, and which docs changed.
     - **DB migrations:** write the next `db/NN_*.sql` (one transaction, idempotent, guarded, ending in count-only checks), then apply it yourself: `python db/apply.py db/NN_x.sql --dry-run` (runs it all, rolls back), then without `--dry-run`. `db/apply.py` reads `db/.env` itself and never prints it. Then update `db/README.md`. When the task asks to see a mapping or counts first, show them in the report.
     - **Pi deploys:** `/pi-deploy`: busy check (wait if someone cast in the last 5 minutes), then `bash pi/deploy.sh`, which needs no password since `/etc/sudoers.d/pb-deploy` (30 Oct 2026), then `pb-status`.
   - **Still gated, needing Ross's explicit OK each time:** deleting user data, force pushes, and anything touching secrets.
   - **Rollback = `git revert` + push** (`/rollback`), never the Cloudflare dashboard.
   - Work locally on `main`. Claude Code web sessions start on an assigned `claude/<slug>` branch: ship by pushing it to `main` the same way (rebased, a fast-forward).
   - The claude.ai project chat commits to `main` too, so fetch and pull before you start and before you push.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Don't install frameworks** (React, Vue, …) or add a build step beyond `build.sh`'s checks and stamp without being asked.
6. **Don't change the Supabase schema** (tables, policies, grants, functions) without being asked. Flag the need and wait.
7. **Check what already exists before writing new code.** Read the relevant script(s) and `index.html` fully. The scripts share one global scope, so a symbol may be defined in a file you don't expect: grep across all `.js` files.
8. **The Supabase anon key is safe to commit.** It's a public key. Don't replace it with an environment variable.
9. **Keep the structure:** `app/index.html` (markup) + `app/tokens.css` + `app/styles.css` + eleven ordered classic scripts, all flat in `app/`. **Not ES modules**, and don't convert them without being asked. Don't add subfolders inside `app/`: it's copied to the site one-to-one, so a subfolder changes live URLs (`build.sh` refuses one).
10. **When in doubt about behaviour, ask.** Don't invent product decisions.
11. **Styling values (colours, fonts, radii, shadows, sizes) live only in `app/tokens.css`.** Components in `styles.css` use `var(--token)`, never a literal. Any change to `tokens.css` must be checked in both the phone views and the wall-screen mode (`/?wall`).

---

## Never break these

- **The `legacy` branch and GitHub Pages.** Never delete the branch, never disable Pages, never touch either unless asked. Old installs and old links depend on them.
- **The repo stays public and is never renamed.** Free Pages needs a public repo, and the github.io redirect follows the repo name.
- **Nothing secret is ever committed.** `docs/security-findings.md` never gets a `.gitignore` exception. `db/.env` (direct-Postgres URL + service key) is never read into a session, printed, pasted or committed. Pi credentials stay out of the repo. The pre-commit hook (`.githooks/pre-commit`, on with `git config core.hooksPath .githooks`) refuses service-role keys, `db/.env` values, `psk=`/`password=` lines, `secrets.env` and `pi/config.env`: if it refuses, fix the cause, never `--no-verify`. Test it with `bash .githooks/test-pre-commit.sh` (fake keys only). It doesn't cover the chat's commits through GitHub.
- **`build.sh` is the deploy gate.** Cloudflare runs it; if it fails, nothing deploys and live keeps the last good version. It checks the three-places rule and runs the syntax check. Never weaken a check to get a build through.
- **The three-places rule.** A new deployable file lives in `app/`, and goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page). Exceptions (shipped, not precached): `sw.js`, `_headers`, `_redirects`, `ProjectBoard.png` and the manifest `screenshot-*.png` (`NOT_PRECACHED` in `build.sh`). A new committed PNG also needs a `!app/…` exception in `.gitignore` (which ignores `*.png`). A new script also keeps the load order in `index.html`, which is the order the syntax check uses.
- **`CACHE` is stamped by `build.sh`, never by hand.** `app/sw.js` holds `const CACHE = 'pb-local'` (so local preview works); the build writes `pb-` + a hash of the shipped files' git blob ids into `public/sw.js`, so it changes on exactly the deploys that change app code or data. That pushes the update to already-open clients and keeps each precache one consistent version (the worker's mixed-version guard falls back to it on weak Wi-Fi). `bash build.sh --stamp <ref>` prints the stamp a commit gets.
- **The CSP in `_headers`.** No inline scripts and no `on*=` handlers, ever. Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.
- **Never cache or precache a redirect in `sw.js`.** Cloudflare 307s `/index.html` → `/` and `/x.html` → `/x`. The app shell is cached under `./` only.
- **Staging shares the live database.** Problems, ticks and casts made on staging are real, and admins bypass the cast geofence there. Delete test data, and don't cast by accident.
- **db/12: never re-run step 1.** See `db/README.md`.

---

## Session rules

This repo is the single source of truth shared by Claude Code and the claude.ai project chat, which reads and commits through GitHub (to `main`). The chat can't see local-only files (`docs/*` except the committed ones, `db/`, `pi/_old/`, `reference/`), so `PROJECT_STATUS.md` and the committed docs must stand on their own.

- **Start of every session (`/start`):** `git fetch` and `git pull --ff-only` on `main` (the chat may have committed), check the hook is on, read `PROJECT_STATUS.md` and `TODO.md`, summarise. Read `docs/cast-contract.md` too if the work touches casting, Supabase Realtime or the Pi.
- **End of every session (`/wrap`):** a Session log entry at the top of `PROJECT_STATUS.md` (date, Claude Code or chat, what changed, what's left, new questions); keep the 5 newest there and move older ones word for word to `docs/log/<yyyy-mm>.md`; update Current state, Decisions, Waiting on and Open questions; in `TODO.md`, remove what's done and add what Ross agreed to (keep the order). Keep the status file under 15 KB. Then ship both.
- **Any change to the cast channel, event or payload** updates `docs/cast-contract.md` in the same commit, with a Change history line.
- **`PROJECT_STATUS.md` and `TODO.md` may be edited from the chat**, so never assume your local copy is current: pull first.
- **Never record personal data about users** in these files. The repo is public: no personal circumstances, no secrets either, and nothing copied from `docs/security-findings.md`. A local-only doc is checked for both before it's ever committed.
- **The Supabase MCP server is read-only and scoped to this project** (`project_ref=uqirowyfqwiceyjznosl&read_only=true&features=database`, in Ross's local Claude config, not the repo). Use it to check the live schema and data instead of guessing. **Never paste live query results into repo files** (nicknames, user ids, attempt or tick rows, any row data): describe what you found (counts, column names, yes/no) rather than copying values. **Migrations go through `db/apply.py`** (direct Postgres, working rule 2), never the MCP, which stays read-only.
- **Claude Code config is committed:** `.claude/settings.json` (what's allowed and denied: no force push, no reading `db/.env` or `secrets.env`, no `rm -rf`) and the slash commands in `.claude/commands/` (`/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`). Per-machine settings stay in the gitignored `.claude/settings.local.json`.

---

## Where things are

**The layout:**
```
app/       the website: exactly the files that are deployed, flat. build.sh copies it into public/.
tools/     generators, dev tools and the cast test bench (never deployed)
print/     the A5 poster and QR (never deployed)
pi/        the board's Pi 4: cast listener, idle patterns, health checks, night mode, systemd units, deploy.sh (pi/README.md)
console/   PB Console, the laptop's local admin console (bash console/start.sh; never deployed)
docs/      the committed docs (overview, rollout, cast contract, console plan, circuits Phase 2, Pi plan, log/); the rest local only
.githooks/ the pre-commit secret scan and its test
.claude/   settings.json and commands/ (the rest is per-machine)
build.sh  wrangler.jsonc   at the root, because the Cloudflare dashboard runs them from there
```

**App logic: eleven classic scripts in `app/`, sharing one global scope**, loaded by `index.html` in this order, after the vendored `supabase-js-2.116.0.js`. Every top-level `let`/`const`/`function` is visible everywhere, so **a name may be declared only once across all eleven**, and top-level code can't use later files. `bash build.sh --check` joins them in `index.html`'s order and runs `node --check` (by hand: `cd app && cat state.js core.js problems.js admin.js account.js authoring.js circuits.js challenge.js leaderboard.js wall.js app.js > ../all.js && node --check ../all.js`, then delete `all.js`).

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel, grade ladders, **all shared mutable state** |
| `core.js` | Escaping, toast, search helpers, hold order/roles, dot and shape overlays, `boardPct` hit-testing, fullscreen, saved lists (`saveList`/`savedList`), **routing** |
| `problems.js` | Problem list/filters, detail, swipe and shuffle, info modal, **`castByName` + geofence**, board data loaders |
| `admin.js` | The `#admin` hub: users, promote/demote, delete (RPCs) |
| `account.js` | Ticks, favourites, filter pills, **auth**, display-name modal, profile |
| `authoring.js` | Create/edit problem, the `#outlines` hold-outline editor, circuit helpers |
| `circuits.js` | Circuits list, detail (swipe, info), Play preview, create, delete |
| `challenge.js` | Challenges (db/31): the `#challenge` view (rules, the phone-timed attempt, summary, save + retry), your best and history, the challenge boards on Ranks |
| `leaderboard.js` | `#leaderboard` (Points, or a challenge board via the tabs) |
| `wall.js` | The **wall-screen mode** (`/?wall`, the kiosk): list + board + cast, read-only Ranks, Get the app QR, idle slides, night screen, offline note (overview §4.7a). Off unless `WALL` (`state.js`) |
| `app.js` | **Loaded last:** event wiring, service worker, install flow, boot |

What each view does in detail (fullscreen viewer, create, the outline editor, circuits, challenges, the wall mode): overview §4.

**Other tracked files:**
- **Shipped (`app/`):** `index.html`, `privacy.html` (keep its claims true), `tokens.css` (every design value, loaded before `styles.css` by both pages), `styles.css`, `sw.js`, `manifest.json`, the icons, and the offline fallback board, a snapshot of the live one written by `tools/snapshot_board.py`: `board-fallback.jpg`, `hold_map.json`, `mirror_map.json`, `hold_shapes.json`. Plus Cloudflare's `_headers` and `_redirects`. (`ProjectBoard.png`, the old drawing, is still in `build.sh` but unused.)
- **`app/supabase-js-2.116.0.js`:** vendored and pinned. Never a CDN URL. To upgrade, see overview §4.1.
- **Hosting config:** `build.sh` (the allowlist, the checks, the CACHE stamp), `wrangler.jsonc`, `app/_headers`, `app/_redirects`, `.gitattributes`.
- **Tools (`tools/`, not deployed):** `snapshot_board.py` (refreshes the fallback board from live), `register_shapes.py`, `register_leds.py`, `make_icons.py`, `make_qr.py`, `idle_preview.py`, `cast-test.html` + `serve.py`, `led_map.json` (the Pi wiring contract), and the retired `register_holds.py`/`register_mirror.py` + `hold_positions.json` (history; they can't write into `app/`).
- **`print/`:** the A5 poster and QR, not deployed. The QR encodes `/scan`; change where it lands in `app/_redirects`, never by reprinting.

**Local only (gitignored):** `db/`, `pi/_old/` (the June 2026 Pi 3 listener, the 26 Oct stopgap, and `problems.csv`, which holds setters' nicknames), `pi/config.env` (the laptop's copy of the Pi's settings), `docs/*` except the committed docs, `console/.env.local`, `console/audit.log` and `console/data/`, `backups/`, `reference/original-pi-codebase/dtb/` (Gareth's original code; two register scripts read it by path). Gareth's SD-card image, the old reverse-engineering, old LED test scripts and old audits are archived outside the repo in `Documents\_Archive\ProjectBoard\ProjectBoard-archive\`.

**Deploy:** Cloudflare Workers static assets (build `bash build.sh`, deploy `npx wrangler deploy`; Node is in the build image). Push `main` → production. Push `dev` → a preview build at the staging URL (not promoted). `build.sh` checks, wipes and rebuilds `public/` from its allowlist of files in `app/`, and stamps `CACHE`; anything unlisted never ships. Preview locally with `python -m http.server` inside `app/` (the worker runs as `pb-local`). Details: overview §9 and `docs/rollout-plan.md`.

---

## Data traps

- **Problem holds are stored INVERTED.** The migration wrote start/finish back to front. The true order is
  ```js
  order = [finish_hold, ...intermediate_holds, ...start_holds]
  // order[0], order[1] = starts (green, LOW on the wall); order[last] = finish (red, HIGH); the rest = intermediates (blue)
  ```
  Always use `problemHoldOrder()` + `classifyHolds()`. `saveProblem` re-inverts on the way in, and a lone start is duplicated so there are always two. This order is exactly Gareth's original list, so the Pi side reads it the same way. Fixing it for good means a data migration **and** a Pi change together.
- **A problem's name is UNIQUE and is the cast key** (the Pi looks it up by name). Names are stored clean, with no embedded grade. Name and grade are independent: never strip a grade in `displayName` or rewrite a name in grade-edit.
- **Grade ladders are also CHECK constraints** (db/29): changing `GRADE_ORDER` or `SPORT_GRADE_ORDER` needs a matching db script, or saves of the new grade fail with `23514`.
- **Grades are stored lowercase** (`5, 5+, 6a, 6a+ … 7c+, 8a`) and **displayed** as capitalised Font grades via `fontGrade()`. Storage, `GRADE_ORDER`, filters and search all stay lowercase. Unknown grades (2 problems are `Project`) sort last.
- **Circuits are different:** a separate lowercase sport ladder (`4, 5a … 8b`, never capitalised), stored in **natural climbing order, not inverted**, as one `hold_sequence` with duplicates allowed, plus `start_count` (1–2) and `loops`.
- **Board orientation: row 1 is at the BOTTOM.** `holdN` is row-major from the bottom-left: `hold1` = A1, `hold19` = S1, `hold20` = A2, `hold247` = S13. `holdN` numbering doesn't map cleanly to visual rows on this hand-set board.
- **Hold labels were fixed by db/32 (28 Oct 2026):** three labels at the top were shifted (K9/N13 drawn in the wrong places, I12 drawn though it isn't a hold: its LED 116 is behind the board). Found with `pb-ledmap` (`pi/README.md` → "LED mapping"); every other hold's LED was checked OK on the wall. Gareth's `dicholdlist.txt` is the cross-check for positions.
- **Hold positions** come from the live `board_config.hold_map`. The bundled `hold_map.json` is only the offline fallback, a **snapshot of the live board** taken with the photo, mirror map and outlines by `tools/snapshot_board.py`: never edit those four files by hand, and re-run the snapshot (then ship: the build re-stamps `CACHE`) whenever the live board changes. There's no in-app position editor any more (`#calibrate` was replaced by the outline editor on 16 Sep 2026): don't re-derive positions from a uniform grid.
- **Mirroring is a lookup table** (`board_config.mirror_map`, fallback `mirror_map.json`), keyed by hold id. Never grid arithmetic: the board is staggered. Since db/32 (28 Oct 2026) the live table differs from Gareth's `MirrorDic.txt` in 5 entries among real holds (E3, E4, E5, O5, O6); feed the Pi listener the **live** table.
- **Hold outlines fit one board version.** The live copy is `board_config.hold_shapes` (db/28), edited and published from the in-app outline editor (`#outlines`, Admin → Trace Holds); `app/hold_shapes.json` is the shipped fallback. `shapesUsable()` falls back to dots unless the live board's `updated_at` matches `__meta.board_updated_at`. **Publishing writes `hold_shapes` alone and must never touch `updated_at`** — bumping the version retires the outlines being published. If the board is ever re-mapped, re-trace (`register_shapes.py`, deploy, then the editor's *Load the shipped copy*), Publish, then run `snapshot_board.py` so the offline fallback matches.
- **Create rules:** the top 25% of the board (by the live map's hold y-span) is the finish zone: exactly one finish, no starts, other holds allowed. Everywhere else, holds cycle start (the first two) → hold → off. A problem needs 1–2 starts, at least one intermediate and one finish.
- **Colours:** start green, intermediate blue, finish red, feet orange.
- **The feet rule is `problems.feet_mode`** (`any` / `orange` / `black`, db/33): Any feet lights nothing; Orange only lights the B2 sign (LED 25), Black only the B1 sign (LED 26), never mirrored. `hold2`/`hold21` are those signs, **never holds**: never put them in a hold list (the listener skips them; contract §6.5).
- **Challenges** (db/31): a timed competition on a circuit, protocol stored as data in `challenges.protocol`; the only one is the **Pat Burner**. Attempts are `challenge_attempts` (phone-timed, self-reported; `total_seconds` and `ended_early` are set by a trigger, never by the phone; reps capped at 1200 s; started within 14 days). Boards come only from `challenge_leaderboard()` / `challenge_compare()` (opted-in via `is_public`, best attempt, earlier wins a tie); admins delete with `admin_delete_attempt()`, logged as `delete_attempt`. A circuit used by a challenge is admin-only to edit and can't be deleted (RESTRICT). Details: overview §4.6a.
- **Points come only from the `leaderboard()` RPC.** Never re-implement the formula in JS. **Only benchmarks score** (db/27). Only admins mark a benchmark (detail ⋮ menu), and once a problem is one, only admins can edit or delete it (RLS). Details: overview §4.6.
- **`.icon-btn { display:flex }` beats `[hidden]`**, so every hideable icon button needs an explicit `#id[hidden]{display:none}`.
- **A write blocked by RLS "succeeds"**: an update or delete whose policy hides the row returns no error and 0 rows. Add `.select()` and check the count.

---

## Supabase

| | |
|---|---|
| Project ID | `uqirowyfqwiceyjznosl` (London) |
| URL | `https://uqirowyfqwiceyjznosl.supabase.co` |
| Anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA` |

- **Tables, policies and functions:** overview §5. RLS is on everywhere and is the real gate; the app's admin-only UI is just UX.
- **DB scripts** live in local `db/`, numbered and idempotent. Since 30 Oct 2026 Claude applies them with `python db/apply.py` (dry run first; working rule 2). 01–33 are applied. The index and warnings are in `db/README.md`. A new script takes the next number.
- **Admin** = `profiles.is_admin`. It's set in the Supabase dashboard or in-app through `admin_set_admin()`, which only an existing admin can call and which refuses changing your own flag. **Nobody can promote themselves.**
- **Who can do what:** browsing and casting need no login. Ticking, favourites and creating need sign-in. Admins edit (grade, holds) and delete any problem; an owner can delete their own problem only while nobody else has ticked it. Details: overview §5–6.
- **Accounts are nickname + passphrase, with no personal data** (under-18s use the app; db/30). No email, no Google, no real names. Supabase Auth gets a placeholder email `u-<16 base32>@users.invalid`: **keep that pattern in step between `account.js` (`PLACEHOLDER_DOMAIN`) and db/30**, and never turn on anything that sends email (Confirm email, reset, security notifications). `profiles` is readable only by its owner: use `setter_names()`, `leaderboard()` and `admin_list_users()`. Nickname rules live in one place, db/30 `nickname_check()`. A lost passphrase is reset by an admin through the Edge Function `supabase/functions/admin-reset-passphrase`, the **only** place the service-role key is used. Turnstile guards sign-in and sign-up (site key public in `account.js`; **the secret key never goes in the repo or chat**). Comments are off (db/30).
- **Direct Postgres** for reviews and PB Console's Data phase: `db/.env` → `SUPABASE_DB_URL` (session pooler), via `pg8000`, run by scripts that read it themselves. Default to read-only. How to connect: overview §5.

---

## The cast contract

```javascript
await channel.httpSend('cast_problem',
  { problem_name: 'Good Bug', mirror: true,     // mirror only when the mirrored view is shown
    source: 'wall', signed_in: false },         // where from + signed in or not (never who): Activity log only
  { timeout: 10000 });
// channel: sb.channel('board:HangoutPortland'), never subscribed: the app holds no socket
```

- `castByName()` in `problems.js` is the only cast path. It runs the geofence check first (lenient; admins bypass), then sends only if the caller's `stillShowing()` says the tapped problem and orientation are still on screen. **Reuse both for the circuit cast.**
- `httpSend` resolving means the **Realtime server** accepted the broadcast, not the Pi. There's no end-to-end confirmation, so never report board-level success.
- **Test casting without the Pi:** `python tools/serve.py`, open `http://localhost:8000/tools/cast-test.html`. It lists every cast on the channel, and *Run checks* drives the local app through the cast cases using fake problem names.
- **The Pi 4 listener** (`pi/listener/pb_listener.py`, `pi/README.md`) looks the name up in `problems`, applies the **live** mirror map, uses `problemHoldOrder()`'s order, and lights the LEDs (WS2801 on SPI0, 1 MHz, mode 0, RGB; hold → LED is a formula, contract §6.4). Between casts it shows an idle pattern; night mode is 23:00–08:00. It's deployed with `bash pi/deploy.sh` (gated: `/pi-deploy`; restarts clear the board, so deploy when the gym is closed). Never commit the Wi-Fi keyfile, `secrets.env` or `pi/config.env`.

---

*Rewritten 11 September 2026 as rules and pointers; the Status, Next and Waiting-on sections moved to `PROJECT_STATUS.md` on 29 October 2026, with the ship-by-default deploy rule, the build gate and the stamped CACHE. Maintained by Ross (rlmck).*
