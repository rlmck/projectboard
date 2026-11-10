# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-10)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh` (see the newest session entry for the current stamp). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (4 Nov 2026):** the Filter sheet (phone) or panel (wall): Sort, Grade slider, quick filters, pick Holds; `✕ Clear` (overview §4.2a).
- **Deploying:** ship by default, end to end (Decisions); `build.sh` is the build gate, a pre-commit hook scans for secrets; `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs, about 0.25–0.45 s) and is used daily. Every hold's LED is checked on the wall (28 Oct, `pb-ledmap`; db/32 fixed three labels); mirrored casts and the feet rule are checked too (Ross, by 7 Nov), and the geofence centre on site.
- **The Pi 4 is on a new SD card (1 Nov 2026)** after the old one died: it set itself up unattended (`pi/firstboot/README.md`; secrets in the laptop's gitignored `pi/secrets.env`; db/36 new wall key). Trixie Lite, Tailscale `projectboard`; the listener with self-healing and watchdogs; R8 tests still to do. Idle pattern **`wave`** 15 min after the last cast. Wi-Fi: random MAC, `pb-netwatch` v2, rescue hotspot.
- **The wall screen casts on the pick (2 Nov 2026):** a clean tap lights a problem, Mirror flips it, the benchmark slide and a Create save light theirs; one cast at a time; scrolls never cast. **Circuits:** a tap lights all its holds (`show_circuit`, §8.7); Start circuit runs it. Tried on the touchscreen (Ross, 7 Nov).
- **Circuits can be cast (30 Oct 2026)** from phones and the wall: Cast → speed and Loop → a 5 s countdown, the move count and Stop, while the Pi runs it (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8.
- **The circuit LED look is "map and next hold" (5 Nov 2026):** the circuit dim blue, starts blinking green in the countdown, only the next hold green in the run, the finish red on the final lap, three red blinks at the top. `cast_circuit` takes `laps`; the app still sends `loop` (TODO 5). Contract §8.3. Seen on the wall (Ross, 7 Nov).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen and picks up a deploy at its next idle (within the hour) or each morning. **The touchscreen has a picture again** (the 4 Nov hardware fault is fixed; Ross, 7 Nov).
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Tried on the touchscreen and phones (Ross, 7 Nov).
- **Opening hours (7 Nov 2026):** one per-day schedule in the Pi's `config.env` (`HOURS_MON`…`HOURS_SUN`, London time): Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00. Outside, the LEDs go dark, casts are ignored and the wall screen is off. PB Console: the hours table (Config), **Stay on until HH:MM** and End override (Board). `pi/README.md` → Opening hours.
- **Holds in the database (9 Nov 2026, db/41, db/42):** the `holds` table holds each hold's name, kind, LED, position, outline and mirror partner (`board_config`'s are copies since db/42); the Pi and the app read it; `tools/check_holds.py` checks it. **Board setup** (Admin → Board Setup): photo + cartoon → corners → line up → trace → mirror pairs → publish, with Undo; **Ross published the new board on 10 Nov** (188 hand holds, 50 footholds). **Edit holds** (10 Nov): add/delete/pair footholds and turn a hold with its mirror partner (the drawing too), one publish. Specific feet exists in the database only (UI: session 3, `docs/board-setup-plan.md`).
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"); the Pi is in the junction box (31 Oct). Power in at six points, two YU0510 5 V 10 A supplies (both needed). No relays or level shifter fitted (3.3 V data works); the relay module and the 74AHCT125 have arrived. A USB webcam shows the back of the board on Tailscale only.
- **PB Console** (`console/`, `bash console/start.sh`): health, services, board controls, logs, config, Pi deploy (drift check), release, LED map, test cast, **circuit tracks** (1 Nov, direct Postgres), Activity (4 Nov), the R8 checklist, backups, runbook; warnings can be dismissed until they change (`console/README.md`). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship to `main` once checks pass; "staging first" = `dev` only; rollback = `git revert` + push. `CACHE` is stamped from the shipped files' blob ids, so docs-only pushes don't re-download the app. Details: CLAUDE.md, working rule 2. **Confirmed 8 Nov 2026: keep shipping straight to `main`;** the bundled-release idea (staging first, What's new) is parked in `TODO.md` → Not now.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN for new accounts; accounts made before keep their 4-word passphrase (no switch offered) and sign in through the same field. No lockout, rate limit or weak-PIN blocking, by design. No personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a forgotten PIN or passphrase is reset by an admin (activity check, logged), giving a new PIN or new words to match. Google sign-in removed. The gym is the data controller.
- Points only for benchmark climbs (db/27).
- **Move to Circuits (8 Nov 2026):** admins only; a move, not a copy: the problem, its ticks and favourites are deleted in one transaction with the circuit's creation (Ross OK'd the deletes for this feature); benchmarks can't be moved; the setter is kept; a name clash asks for a rename (db/40).
- **Editing (8 Nov 2026):** one Edit (the Create screen) for problems and circuits; the owner may edit while nobody else has ticked it (circuits: nobody else's run), never a benchmark, a challenge's circuit or The Hangout's; the setter is never editable; the name stays the cast key (db/39, contract §10).
- **Opening hours (7 Nov 2026):** the board and the wall screen follow one per-day schedule; no bank holidays; a one-evening "stay on until" from PB Console; `NIGHT_FORCE` stays for tests.
- **Board setup, Specific feet (7, 9 Nov 2026):** Specific feet = footholds only, never lit. No rearrange now: a dry run on the current board, no archive; hand holds keep ids, names and LEDs. Sessions: holds table (done), setup flow 2a (done), Specific feet UI; **2b (camera LED mapping) dropped (Ross, 10 Nov 2026):** every LED is verified, rotations don't move LEDs, footholds have none; parked on `parked/2b-camera-led-mapping`. Footholds FT1, FT2…, left to right, bottom row up; **footholds mirror foot ↔ foot where the reflection finds a partner, never hand ↔ foot**. `docs/board-setup-plan.md`.
- **Feet rule (30 Oct 2026):** every problem is Any feet (default), Orange feet only or Black feet only (`problems.feet_mode`, db/33). Any lights no sign; Orange lights B2 (LED 25), Black lights B1 (LED 26), never mirrored; `hold2`/`hold21` are never in a hold list. Migrated: both signs or none → Any, one sign → that rule. Cast contract §6.5.
- **Circuits (30 Oct 2026):** no mirrored circuits and no circuits Done filter for now (future releases); "done" means done both sides and is for problems only. No Play preview.
- **Who cast (30 Oct 2026):** never in the public broadcast. Members' casts go to a private, insert-only `cast_log` (db/34) that only PB Console reads (direct Postgres), for nicknames on Activity. `privacy.html` says so.
- Star ratings from the old system are gone from the app (30 Oct 2026); `problems.stars` / `ticks.stars` stay in the table, unused.
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, phone-timed, score = total seconds held, best attempt per user, earlier wins a tie, opt-in board, compare up to 3; self-reported, admins delete attempts; reps capped at 1200 s; offline saves retried for 14 days; a generic `challenges` table with the protocol as data.
- The Pi side was rewritten from scratch for the Pi 4 and lives in `pi/` (committed).
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- **The Hangout (30 Oct 2026):** the gym's setter, text only (no profile, no Ranks, no points); the wall creates as it with no sign-in, proven by the Pi's wall key. Live LEDs while setting: geofenced on phones, admins too; a cast overrides (Show on board). Comments stay off.
- The Supabase MCP server (read-only, this project only) may be used to check live schema and data; results never go into repo files; migrations go through `db/apply.py`.

## To-do
The ordered to-do list (next steps, backlog, and what not to build yet) lives in `TODO.md`. Top item = now.

## Waiting on
- **Ross:** Edit holds: add the 5 missing footholds, turn any turned holds, publish (plan → Next steps; 10 Nov checklist); then **Claude: `tools/snapshot_board.py` + ship** (the offline copy is still the pre-10-Nov board). Sign in as Pablo with the new PIN once (reset 10 Nov). The db/41 checks (9 Nov report).
- **Parked branch `parked/2b-camera-led-mapping`:** camera LED mapping (2b), unfinished, never shipped; only for a full rearrange or another gym (`TODO.md` → Not now). Its db/43 is live and harmless.
- **Ross: test the opening hours** (live 7 Nov): see the 2026-11-07 session entry's checklist.
- Ross (low priority): delete the local passphrase hand-out file (and empty the Recycle Bin) once all 7 migrated accounts have signed in.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-10, Claude Code (Edit holds; a sign-in reset; TODO 13).**
  - **Sign-in:** an admin's own older account was made a PIN account at their request (the same password form and `pin` flag as a PIN sign-up; logged as `reset_passphrase`; sessions signed out); no other account changed.
  - **Changed:** Admin → Board Setup → **Edit holds** (`app/holdedit.js`): add (Tap to trace / Draw), pair, delete footholds; turn a hold with its partner the other way, the drawing too (background filled, stripe edges straight); draft, Undo/Redo, one publish. No migration. `bsFootNameList()` shared with setup. Plan, overview §4.8d, CLAUDE.md (14 scripts).
  - **Found:** 5 footholds missed beside F3, M2, G1, N1 and on J1 (inside its outline) (plan).
  - **Tested:** `tools/holdedit_score.js` (live + bundled board); payload through the real publish + undo (rolled back); Chrome 390 px, writes stubbed; trace scores unchanged; pi + console tests.
  - **Left:** Ross: footholds, publish; then snapshot + ship. Next: Specific feet (plan).

- **2026-11-10, Claude Code (2b parked; TODO 13).**
  - **Changed:** Ross dropped camera LED mapping (2b). The uncommitted 2b work (app `ledmap.js` + setup step, Pi `map_leds`/`map_state`/`holds_changed`, contract §11, tests, docs) is on **`parked/2b-camera-led-mapping`**; the laptop is clean. Plan, TODO 13 (next: the admin hold editor, then Specific feet), Not now. New session rule: nothing left uncommitted (CLAUDE.md).
  - **Found:** db/43 was live (9 Nov); kept, harmless. The Pi runs `main`'s listener.
  - **Live:** docs only.
- **2026-11-10, Claude Code (board setup: prior-guided trace + Tap to trace; TODO 13).**
  - **Found:** the final cartoon is a fresh drawing, not an edit of today's image; blind, 31 hand holds got no shape. **F6, N6 turned; D6, P5 not on the cartoon.**
  - **Changed:** the trace fits today's outlines onto the cartoon (`tracePriorFit`); Review shows only exceptions: Looks right, Accept all unflagged, **Tap to trace**, Use fitted shape, a turn handle. Old drafts: Start again. Trace 3.5× faster. Plan, overview §4.8d.
  - **Tested:** final cartoon 181 auto-accepted, 7 to check, 50 footholds (~156 actions → ~13); `tools/trace_prior_score.js` passes; Chrome 390 px (stubbed); pi + console tests.
  - **Live:** `27ca236`, CACHE `pb-360d13ebdc`.
  - **Left:** Ross: Start again, final cartoon (plan); D6/P5.
- **2026-11-10, Claude Code (board setup: line up by four holds; TODO 13).**
  - **Changed:** today's image is cropped, so the first run's "Today's board" corners tab became a **Line up** step: four hand holds tapped on today's image, then on the cartoon; their homography is `bsMatch()`'s first guess (plan, overview §4.8d).
  - **Tested:** Chrome, phone width, writes stubbed, today's = fallback minus its bottom 30%: 188/188 holds matched their own shape; refusals; draft.
  - **Live:** `5093768`, CACHE `pb-6305d7e765`.
  - **Left:** Ross: run the flow. Session 2b is uncommitted on the laptop (line-up merged in), not shipped.
- **2026-11-09, Claude Code (board setup 2a: the admin flow, no LED mapping; TODO 13).**
  - **Changed:** db/42: `holds` is the source of positions, outlines, pairs (`board_config`'s are copies); `admin_publish_board` (hand holds keep id, name, LED), `admin_undo_board` + `board_versions`, `admin_set_hold_outlines`. Admin → **Board Setup** (`setup.js`, `trace.js`; overview §4.8d). No event or Pi change.
  - **Tested:** db/42 test (fails before 42); the flow in Chrome at phone width (writes stubbed), its payload through the real publish + undo (rolled back); auto-trace median IoU 0.923 (bar 0.91), 0 missed; pi + console tests; app views and `/?wall`.
  - **Live:** db/42 + the app, 9 Nov. Nothing published: the board is unchanged.
  - **Left:** Ross: photo, cartoon, run the flow; then snapshot + ship. 2b, 3.
