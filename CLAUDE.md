# ProjectBoard: CLAUDE.md

Read this at the start of every session. It holds the rules, the things that must not break, and the traps. Everything else lives in the documents it points to.

## What this is

A PWA for the symmetry board at The Hangout climbing gym, Portland (near Weymouth, UK): a wooden wall with 189 LED-lit holds on a 19 × 13 grid (A–S × 1–13). Climbers browse **problems** (boulders) and **circuits** (long sport-style routes), **cast** a problem to light its holds via a Raspberry Pi, **tick** sends, save **favourites** and climb the points **leaderboard**. It has real users.

| | |
|---|---|
| **Live** | https://symmetryboard.co.uk, from `main` |
| **Staging** | https://dev-projectboard.rosslewismckechnie.workers.dev, from `dev` |
| **Old address** | https://rlmck.github.io/projectboard, a permanent "we've moved" page served from the `legacy` branch |
| **Repo** | https://github.com/rlmck/projectboard (public, permanently) |
| **Local path** | `C:\Users\rossl\Documents\ProjectBoard\` (the repo root; there's no subfolder) |

**Which document to trust:**
- **Architecture, data model, auth, caching, deploy mechanics, known issues:** `docs/codebase-overview.md`. Read it at the start of a session. It was checked against the live database.
- **Hosting, rollout and the install flow:** `docs/rollout-plan.md`.
- **Security findings:** `docs/security-findings.md`, **local only, never committed**. Read it before touching RLS, grants, casting or sign-up.
- **Local only, on Ross's laptop:** `docs/changelog.md` (the full feature history), `docs/project-notes.md` (hardware, the Pi, the original DTB system, the Circuits Phase 2 spec), `db/README.md` (every DB script).
- **The Pi 4 / LED rebuild:** `docs/pi4-led-audit.md`, **local only**. It's the verified spec (16 Oct 2026) for driving the LED strip and the wall touchscreen from a new Pi 4; status, open items and install-day steps are at the top. Read it before any Pi or LED work.

---

## Working rules

1. **Read this file and `docs/codebase-overview.md` at the start of every session.**
2. **Commit and push are separate steps, each needing Ross's explicit confirmation (Ross, 19 Oct 2026; this permanently replaces the old push-straight-to-live rule).** When a task is done, show a summary of every change and ask before committing on `dev`. After the commit, ask separately before pushing, and say which branches the push covers (`dev` only for staging, or `main` too). Keep `dev` and `main` level (fast-forward `main` to `dev`); the claude.ai project chat commits to `main` (see Session rules). Pushing to `main` deploys to real users, so run the syntax check before every push, and after a deploy that changes app code or data confirm the live `sw.js` shows the new `CACHE`.
   Claude Code web sessions start on an assigned `claude/<slug>` branch: carry the work to `dev` and `main` only with the same two confirmations. If the live site is unreachable from the session (the environment's network policy blocks it), say so rather than skipping the `CACHE` check silently.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Don't install frameworks** (React, Vue, …) or add a build step without being asked.
6. **Don't change the Supabase schema** (tables, policies, grants, functions) without being asked. Flag the need and wait.
7. **Check what already exists before writing new code.** Read the relevant script(s) and `index.html` fully. The scripts share one global scope, so a symbol may be defined in a file you don't expect: grep across all `.js` files.
8. **The Supabase anon key is safe to commit.** It's a public key. Don't replace it with an environment variable.
9. **Keep the structure:** `app/index.html` (markup) + `app/tokens.css` + `app/styles.css` + eleven ordered classic scripts, all flat in `app/`. **Not ES modules**, and don't convert them without being asked. Don't add subfolders inside `app/`: it's copied to the site one-to-one, so a subfolder changes live URLs.
10. **When in doubt about behaviour, ask.** Don't invent product decisions.
11. **Styling values (colours, fonts, radii, shadows, sizes) live only in `app/tokens.css`.** Components in `styles.css` use `var(--token)`, never a literal. Any change to `tokens.css` must be checked in both the phone views and (once it exists) the wall-screen mode.

---

## Never break these

- **The `legacy` branch and GitHub Pages.** Never delete the branch, never disable Pages, never touch either unless asked. Old installs and old links depend on them.
- **The repo stays public and is never renamed.** Free Pages needs a public repo, and the github.io redirect follows the repo name.
- **Nothing secret is ever committed.** `docs/security-findings.md` never gets a `.gitignore` exception. `db/.env` (direct-Postgres URL + service key) is never printed, pasted or committed. Pi credentials stay out of the repo.
- **The three-places rule.** A new deployable file lives in `app/`, and goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page). Exception: the manifest `screenshot-*.png` files are `build.sh` only. A new committed PNG also needs a `!app/…` exception in `.gitignore` (which ignores `*.png`). A new script also keeps the load order in `index.html`.
- **Bump `CACHE` in `sw.js` on every deploy that changes app code or data** (not only `ASSETS` or the fetch logic). It pushes the update to already-open clients, and it keeps each precache one consistent version: the worker's mixed-version guard falls back to it on weak Wi-Fi.
- **The CSP in `_headers`.** No inline scripts and no `on*=` handlers, ever. Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.
- **Never cache or precache a redirect in `sw.js`.** Cloudflare 307s `/index.html` → `/` and `/x.html` → `/x`. The app shell is cached under `./` only.
- **Staging shares the live database.** Problems, ticks and casts made on staging are real, and admins bypass the cast geofence there. Delete test data, and don't cast by accident.
- **db/12: never re-run step 1.** See `db/README.md`.

---

## Session rules

This repo is the single source of truth shared by Claude Code and the claude.ai project chat, which reads and commits through GitHub (to `main`). The chat can't see local-only files (`docs/*` except the committed ones, `db/`, `pi/_old/`, `reference/`), so `PROJECT_STATUS.md` and `docs/cast-contract.md` must stand on their own.

- **Start of every session:** `git pull` (on `dev`, also `git pull --ff-only origin main` in case the chat committed there), then read `PROJECT_STATUS.md`. Read `docs/cast-contract.md` too if the work touches casting, Supabase Realtime or the Pi.
- **End of every session:** add a Session log entry to `PROJECT_STATUS.md` (date, Claude Code or chat, what changed, what's left, new questions), and update Current state, Decisions, Waiting on, Open questions and Feature backlog if anything changed.
- **Any change to the cast channel, event or payload** updates `docs/cast-contract.md` in the same commit, with a Change history line.
- **`PROJECT_STATUS.md` may be edited from the chat**, so never assume your local copy is current: pull first.
- **Never record personal data about users** in these files. The repo is public: no personal circumstances, no secrets either, and nothing copied from `docs/security-findings.md`.
- **The Supabase MCP server is read-only and scoped to this project** (`project_ref=uqirowyfqwiceyjznosl&read_only=true&features=database`, in Ross's local Claude config, not the repo). Use it to check the live schema and data instead of guessing. **Never paste live query results into repo files** (nicknames, user ids, attempt or tick rows, any row data): the repo is public. Describe what you found (counts, column names, yes/no) rather than copying values. **Migrations are still applied by Ross in the SQL editor**; the MCP can't apply them and must not be reconfigured to.

---

## Where things are

**The layout:**
```
app/      the website: exactly the files that are deployed, flat. build.sh copies it into public/.
tools/    generators, dev tools and the cast test bench (never deployed)
print/    the A5 poster and QR (never deployed)
pi/       the board's Pi 4: cast listener, health checks, night mode, systemd units, deploy.sh (see pi/README.md)
docs/     codebase-overview.md + rollout-plan.md + cast-contract.md (the rest is local only)
build.sh  wrangler.jsonc   at the root, because the Cloudflare dashboard runs them from there
```

**App logic: eleven classic scripts in `app/`, sharing one global scope**, loaded by `index.html` in this order, after the vendored `supabase-js-2.116.0.js`. Every top-level `let`/`const`/`function` is visible everywhere, so **a name may be declared only once across all eleven**, and top-level code can't use later files. Check with `cd app && cat state.js core.js problems.js admin.js account.js authoring.js circuits.js challenge.js leaderboard.js wall.js app.js > ../all.js && node --check ../all.js`, then delete `all.js`.

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel, grade ladders, **all shared mutable state** |
| `core.js` | Escaping, toast, search helpers, hold order/roles, dot and shape overlays, `boardPct` hit-testing, fullscreen, **routing** |
| `problems.js` | Problem list/filters, detail, swipe, info modal, **`castByName` + geofence**, board data loaders |
| `admin.js` | The `#admin` hub: users, promote/demote, delete (RPCs) |
| `account.js` | Ticks, favourites, filter pills, **auth**, display-name modal, profile |
| `authoring.js` | Create/edit problem, the `#outlines` hold-outline editor, circuit helpers |
| `circuits.js` | Circuits list, detail (swipe, info), Play preview, create, delete |
| `challenge.js` | Challenges (db/31): the `#challenge` view (rules, the phone-timed attempt, summary, save + retry), your best and history, the challenge boards on Ranks (compare, admin delete) |
| `leaderboard.js` | `#leaderboard` (Points, or a challenge board via the tabs) |
| `wall.js` | The **wall-screen mode** (`/?wall`, the kiosk): its list + board + cast, read-only Ranks, Get the app QR, idle slides, night screen, offline note (overview §4.7a). Off unless `WALL` (`state.js`) |
| `app.js` | **Loaded last:** event wiring, service worker, install flow, boot |

**Other tracked files:**
- **Shipped (`app/`):** `index.html`, `privacy.html` (keep its claims true), `tokens.css` (every design value, loaded before `styles.css` by both pages), `styles.css`, `sw.js`, `manifest.json`, the icons, and the offline fallback board, a snapshot of the live one written by `tools/snapshot_board.py`: `board-fallback.jpg`, `hold_map.json`, `mirror_map.json`, `hold_shapes.json`. Plus Cloudflare's `_headers` and `_redirects`. (`ProjectBoard.png`, the old drawing, is still in `build.sh` but unused.)
- **`app/supabase-js-2.116.0.js`:** vendored and pinned. Never a CDN URL. To upgrade, see overview §4.1.
- **Hosting config:** `build.sh` (the deploy allowlist, copying from `app/`), `wrangler.jsonc`, `app/_headers`, `app/_redirects`, `.gitattributes`.
- **Tools (`tools/`, not deployed):** `snapshot_board.py` (refreshes the fallback board from live), `register_shapes.py`, `register_leds.py`, `make_icons.py`, `make_qr.py`, `cast-test.html` + `serve.py`, `led_map.json` (the Pi wiring contract), and the retired `register_holds.py`/`register_mirror.py` + `hold_positions.json` (history; they can't write into `app/`).
- **`print/`:** the A5 poster and QR, not deployed. The QR encodes `/scan`; change where it lands in `app/_redirects`, never by reprinting.

**Local only (gitignored):** `db/`, `pi/_old/` (the June 2026 Pi 3 listener, the 26 Oct stopgap, and `problems.csv`, which holds setters' nicknames), `pi/config.env` (the laptop's copy of the Pi's settings), `docs/*` except the three committed docs, `reference/original-pi-codebase/dtb/` (Gareth's original code; two register scripts read it by path). Gareth's SD-card image, the rest of its boot partition, the old reverse-engineering and the old LED test scripts are archived outside the repo in `Documents\_Archive\ProjectBoard\ProjectBoard-archive\`.

**Deploy:** Cloudflare Workers static assets. Push `dev` → a preview build at the staging URL (not promoted). Merge to `main` → production. `build.sh` wipes and rebuilds `public/` from its allowlist of files in `app/`; anything unlisted never ships. Preview locally with `python -m http.server` inside `app/`. Details: overview §9 and `docs/rollout-plan.md`.

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
- **Hold positions** come from the live `board_config.hold_map`. The bundled `hold_map.json` is only the offline fallback, a **snapshot of the live board** taken with the photo, mirror map and outlines by `tools/snapshot_board.py`: never edit those four files by hand, and re-run the snapshot (then bump `CACHE`) whenever the live board changes. There's no in-app position editor any more (`#calibrate` was replaced by the outline editor on 16 Sep 2026): don't re-derive positions from a uniform grid.
- **Mirroring is a lookup table** (`board_config.mirror_map`, fallback `mirror_map.json`), keyed by hold id. Never grid arithmetic: the board is staggered. The live table differs from Gareth's `MirrorDic.txt` in 7 entries (I12 pairs with I11); feed the Pi listener the **live** table.
- **Hold outlines fit one board version.** The live copy is `board_config.hold_shapes` (db/28), edited and published from the in-app outline editor (`#outlines`, Admin → Trace Holds); `app/hold_shapes.json` is the shipped fallback. `shapesUsable()` falls back to dots unless the live board's `updated_at` matches `__meta.board_updated_at`. **Publishing writes `hold_shapes` alone and must never touch `updated_at`** — bumping the version retires the outlines being published. If the board is ever re-mapped, re-trace (`register_shapes.py`, deploy, then the editor's *Load the shipped copy*), Publish, then run `snapshot_board.py` so the offline fallback matches.
- **Create rules:** the top 25% of the board (by the live map's hold y-span) is the finish zone: exactly one finish, no starts, other holds allowed. Everywhere else, holds cycle start (the first two) → hold → off. A problem needs 1–2 starts, at least one intermediate and one finish.
- **Colours:** start green, intermediate blue, finish red, feet orange.
- **Challenges** (db/31, `pb-v110`, live 19 Oct 2026 at `pb-v111`): a timed competition on a circuit, protocol stored as data in `challenges.protocol`; the only one is the **Pat Burner**. Attempts are `challenge_attempts` (phone-timed, self-reported; `total_seconds` and `ended_early` are set by a trigger, never by the phone; reps capped at 1200 s; started within 14 days). Boards come only from `challenge_leaderboard()` / `challenge_compare()` (opted-in via `is_public`, best attempt, earlier wins a tie); admins delete with `admin_delete_attempt()`, logged as `delete_attempt`. A circuit used by a challenge is admin-only to edit and can't be deleted (RESTRICT). Details: overview §4.6a.
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
- **DB scripts** live in local `db/`, numbered and idempotent, applied by hand in the SQL editor. 01–31 are applied (30, nickname accounts, on 18 Oct 2026; 31, challenges, on 19 Oct 2026). The index and warnings are in `db/README.md`. A new script takes the next number.
- **Admin** = `profiles.is_admin`. It's set in the Supabase dashboard or in-app through `admin_set_admin()`, which only an existing admin can call and which refuses changing your own flag. **Nobody can promote themselves.**
- **Who can do what:** browsing and casting need no login. Ticking, favourites and creating need sign-in. Admins edit (grade, holds) and delete any problem; an owner can delete their own problem only while nobody else has ticked it. Details: overview §5–6.
- **Accounts are nickname + passphrase, with no personal data** (under-18s use the app; live 18 Oct 2026, `plan.md`, db/30; all 7 existing accounts were moved across by the local `db/30_go_live.py`). No email, no Google, no real names. Supabase Auth gets a placeholder email `u-<16 base32>@users.invalid`: **keep that pattern in step between `account.js` (`PLACEHOLDER_DOMAIN`) and db/30**, and never turn on anything that sends email (Confirm email, reset, security notifications). `profiles` is readable only by its owner: use `setter_names()`, `leaderboard()` and `admin_list_users()`. Nickname rules live in one place, db/30 `nickname_check()`. A lost passphrase is reset by an admin through the Edge Function `supabase/functions/admin-reset-passphrase`, the **only** place the service-role key is used. Turnstile guards sign-in and sign-up (site key public in `account.js`; **the secret key never goes in the repo or chat**). Comments are off (db/30).
- **Direct Postgres** for reviews: `db/.env` → `SUPABASE_DB_URL` (session pooler), via `pg8000`. Default to read-only. How to connect: overview §5.

---

## The cast contract

```javascript
await channel.httpSend('cast_problem',
  { problem_name: 'Good Bug', mirror: true },   // mirror only when the mirrored view is shown
  { timeout: 10000 });
// channel: sb.channel('board:HangoutPortland'), never subscribed: the app holds no socket
```

- `castByName()` in `problems.js` is the only cast path. It runs the geofence check first (lenient; admins bypass), then sends only if the caller's `stillShowing()` says the tapped problem and orientation are still on screen. **Reuse both for the circuit cast.**
- `httpSend` resolving means the **Realtime server** accepted the broadcast, not the Pi. There's no end-to-end confirmation, so never report board-level success.
- **Test casting without the Pi:** `python tools/serve.py`, open `http://localhost:8000/tools/cast-test.html`. It lists every cast on the channel, and *Run checks* drives the local app through the cast cases using fake problem names.
- **The Pi side is being rebuilt on a new Pi 4** (Gareth's Pi 3B is gone; spec in the local `docs/pi4-led-audit.md`). Its listener must look the name up in `problems`, apply the **live** mirror map, use `problemHoldOrder()`'s order, and light the LEDs (WS2801 on SPI0, 1 MHz, mode 0, RGB; hold → LED is a formula, in the audit §3). The relays (BCM 23/24, LOW = on) must be switched on at boot. The listener is `pi/listener/pb_listener.py`, deployed with `bash pi/deploy.sh` (restarts clear the board: deploy when the gym is closed). Never commit the Wi-Fi keyfile, `secrets.env` or `pi/config.env`.

---

## Status

**The app** has four tabs (Problems · Circuits · Ranks · Profile) and 12 views (`#challenge/<id>` is the newest); the full route list is in overview §4.3. SW `CACHE` is `pb-v118`. **The wall screen** (`/?wall`, `wall.js`, overview §4.7a) is the kiosk's layout for the 1280×720 touchscreen: a grade rail that jumps the list (its ★ filters to benchmarks), the whole list with sticky grade headers, and the chosen problem's name, Mirror and **Light it up** (through `castByName`) over the board on the right, read-only Ranks, a Get the app QR, back to the list with idle slides (the QR and the benchmark of the day) after 20 minutes untouched (`WALL_IDLE_MS`), a dimmed QR at night (23:00–08:00), and an offline note with casting off. It only exists with `?wall`; the phone views are unchanged. **Creating a problem looks and feels like viewing one** (overview §4.8a): same pinned layout and board position, the name typed in place as the title, the grade badge opens a grade sheet, the wall dimmed with every hold bright, the finish zone marked on the board, a start · holds · finish checklist under it, and Undo. Circuit create is still the older form. Fullscreen is a **viewer** (overview §4.8, `core.js`): it opens framed on the route over a blurred copy of the board (or, on the detail views, straight from a pinch on the page's board; pinching all the way back out, or a double-tap, closes it), pinch/drag/double-tap to look around, a minimap, and a bar with previous · mirror · route/whole board · next; it also asks for the browser's own fullscreen. Stretch-to-fill (`pb-v105`) was rejected; the last commit before any fullscreen change is `8629944` (`pb-v104`). The Problems and Circuits lists (and setter names) are **saved on the device** each time they load (`saveList`/`savedList` in `core.js`): they show at once on the next launch while the fresh copy loads, and offline they stay up with a note saying when they were saved; ticks and favourites aren't saved. The problem detail bar has a **shuffle** toggle (left of the tick, `shuffleStep()` in `problems.js`): with it on, swiping forward jumps to a random unseen problem in the filtered deck, and swiping back retraces the path (`shuffleBack`/`shuffleFwd`, reset on entering the detail view). It's in-memory only, and circuits don't have it. The splash plays a short CSS-only entrance (the mark draws out from its vertex, a ring of holds casts across the wall, the wordmark settles); the timeline and the `prefers-reduced-motion` fallback are commented at the top of `styles.css`, and `app.js` only adds `.hide`. Hold outlines are drawn as smooth curves: the roundness is set in the outline editor and published as `hold_shapes.__meta.smooth`; `SHAPE_SMOOTH` (0.7) in `core.js` is the default for a set without one. The outline editor (`#outlines`, admin, in `authoring.js`) is built for a phone: pinch/pan, drag points with a magnifier, edge handles to add points, a nudge pad, a live app preview, a localStorage draft (`pb-outline-draft`), and **Publish** writes `board_config.hold_shapes` only, never `updated_at`. It hides the bottom nav and handles every gesture on its stage itself (`touch-action: none`). Pinch and double-tap zoom are disabled app-wide (viewport meta + `html { touch-action }` + an iOS gesture guard at the top of `app.js`), and so is text selection outside inputs (`body { user-select: none }`; `.welcome-url` stays selectable for the in-app-browser copy fallback). The browser's pull-to-refresh is off app-wide (`overscroll-behavior-y: none`, except on iOS, which keeps its bounce and has no pull-to-refresh as an installed app); only the Problems and Circuits lists have one, their own (`.list-pull`, wired in `app.js` via `PULL_LISTS`, calling `refreshProblems()` / `refreshCircuits()`), which re-fetches in place. **Circuits look and behave like problems** (18 Sep 2026): the same grade tabs (tap = one, hold = several), cards with the New badge, a pinned detail view you swipe through, traced outlines over a dimmed board, and an Information item in the ⋮ menu. What's circuit-only is the move-number tags on the holds (`seqTagsHtml`) and the Play panel under the board, whose speed is a Slow → Fast slider (0.2–3.0 s per move, in 0.1 s steps). Keep the two sides in step when either changes. A circuit can carry a **challenge** (db/31, `challenge.js`): a link under its board opens `#challenge/<id>` (rules, Start, a count-up clock with a huge **Fell** button, Web Audio beeps, rest countdowns, End early on a double tap, summary, Save). Timing comes only from timestamps, and the running attempt is kept in localStorage (`pb-challenge-run`), so a locked screen or a closed app loses nothing. Leaving the view doesn't stop it: the clock and beeps carry on in every view, and a strip on top of the bottom nav (`#ch-return`, `body.ch-away` adds its 40 px to `--nav-h`) shows the phase and leads back (`pb-v111`). A finished attempt sits in `pb-challenge-pending` until the insert lands (phone-made id, so a retry can't duplicate). Ranks gets a tab per challenge (best attempts, tap up to 3 to compare reps; admins delete an attempt).

**Next:**
- **Pi 4 rebuild** (spec: `docs/pi4-led-audit.md`; plan: local `docs/pi4-listener-kiosk-plan.md`): (a) the LED listener: **live since 26 Oct 2026** (`pi/`, Raspberry Pi OS Lite 64-bit, trixie), with health checks, watchdogs and night mode 23:00–08:00; still to do: the acceptance tests (plan R8), relays and the 74AHCT125 level shifter; (b) the wall touchscreen (wired to the Pi) running the PWA in a Chromium kiosk; (c) the **wall-screen mode** in the PWA: **built and pushed live 27 Oct 2026** (`/?wall`, `wall.js`, `pb-v117`), with the kiosk unit pointing at it (`pi/systemd/kiosk.service`); still to do: deploy the kiosk unit (`bash pi/deploy.sh`, then restart `kiosk`), then check it on the real touchscreen.
- **Circuits Phase 2:** the cast screen (5 s countdown + beeps, speed in 0.1 s steps, loop toggle, big STOP), `cast_circuit`/`stop` broadcasts, writing `circuit_logs` (which also activates the circuits "Exclude Done" pill), and the Pi listener update. Spec: `docs/project-notes.md`.
- **Problem name/setter editing** (holds and grade editing are done).
- **Known bugs** to triage: overview §13.

**Don't build yet:** the feet indicators (B1/B2, parked by Ross), Circuits Phase 3 (PBs, leaderboards), tags, session/logbook tracking beyond ticks, the Flutter migration.

**Waiting on Ross:** for the Pi 4: a photo of the green sockets inside the box, and identifying the 16-wire harness (two 8-way plugs) on install day. Also: checking the geofence centre on-site (cast from a non-admin phone by the board and at the far end of the gym), and deleting `Documents\_Archive\ProjectBoard\ProjectBoard-archive\passphrases-2026-10-18.txt` (then emptying the Recycle Bin) once all 7 migrated accounts have signed in. Done 19 Oct 2026: Always Use HTTPS on (verified: `http://` → 301 → `https://`), the old Google OAuth client deleted. (Email/SMTP is no longer needed.)

---

*Rewritten 11 September 2026: cut from 96 KB to rules and pointers. The same day the repo was tidied into `app/` (the website) and `tools/`, without changing a deployed byte. The old build history is in `docs/changelog.md` (local) and in git. Maintained by Ross (rlmck).*
