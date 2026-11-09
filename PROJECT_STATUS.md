# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-09)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh`: `pb-f4b05cd6a2` since 8 Nov. Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (4 Nov 2026):** the Filter sheet (phone) or panel (wall): Sort, Grade slider, quick filters, pick Holds; `✕ Clear` (overview §4.2a).
- **Deploying:** ship by default, end to end (Decisions); `build.sh` is the build gate, a pre-commit hook scans for secrets; `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are checked on the wall** (Ross, by 7 Nov), the feet rule both ways too, and the geofence centre on site.
- **The Pi 4 is on a new SD card (1 Nov 2026)** after the old one died: it set itself up unattended (`pi/firstboot/README.md`; secrets in the laptop's gitignored `pi/secrets.env`; db/36 new wall key). Trixie Lite, Tailscale `projectboard`; the listener with self-healing and watchdogs; R8 tests still to do. Idle pattern **`wave`** 15 min after the last cast. Wi-Fi: random MAC, `pb-netwatch` v2, rescue hotspot.
- **The wall screen casts on the pick (2 Nov 2026, TODO 8):** a clean tap on a problem lights it, Mirror flips and lights that side, the benchmark slide and a Create save light theirs; no cast button. One cast at a time, the latest tap next; scrolls and drags never cast. **Circuits:** a tap lights all the circuit's holds (`show_circuit`, §8.7); Start circuit runs it. Tried on the touchscreen, Mirror included (Ross, 7 Nov).
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs the run itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8.
- **The circuit LED look is "map and next hold" (5 Nov 2026):** the circuit dim blue, starts blinking green in the countdown, only the next hold green in the run, the finish red on the final lap, three red blinks at the top. `cast_circuit` takes `laps`; the app still sends `loop` (TODO 5). Contract §8.3. Seen on the wall (Ross, 7 Nov).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen and picks up a deploy at its next idle (within the hour) or each morning. **The touchscreen has a picture again** (the 4 Nov hardware fault is fixed; Ross, 7 Nov).
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Tried on the touchscreen and phones (Ross, 7 Nov).
- **Opening hours (7 Nov 2026):** one per-day schedule in the Pi's `config.env` (`HOURS_MON`…`HOURS_SUN`, London time): Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00. Outside, the LEDs go dark, casts are ignored and the wall screen is off. PB Console: the hours table (Config), **Stay on until HH:MM** and End override (Board). `pi/README.md` → Opening hours.
- **Holds in the database (9 Nov 2026, db/41):** the `holds` table gives each hold's name, kind, LED and mirror partner to the Pi (cached) and the app; `tools/check_holds.py` checks it. Specific feet exists in the database only (UI: session 3, `docs/board-setup-plan.md`).
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
- **Board setup, Specific feet (7, 9 Nov 2026):** Specific feet = footholds only, never lit. No rearrange now: a dry run on the current board, no archive; hand holds keep ids and names. Sessions: holds table (done), setup flow, Specific feet UI. Footholds FT1, FT2…, left to right, bottom row up. `docs/board-setup-plan.md`.
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
- **Ross:** the db/41 checks (9 Nov report); the full-board photo.
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

- **2026-11-09, Claude Code (holds in the database + Specific feet backend; board setup session 1 of 3).**
  - **Changed:** db/41: `holds` table (name, kind, LED, position, outline, mirror) seeded from the live board with the formula's LEDs; `board_config` edits copied in by a trigger. `feet_mode` + `specific` with `feet_holds` (footholds only, never lit), owner Edit and `wall_create_problem` updated. The Pi lights LEDs from the table (cached on the Pi); the app reads names and pairs from it. Nothing visible changed. Contract §5, §6, §9.1; `docs/board-setup-plan.md`.
  - **Tested:** `tools/check_holds.py`; db/41 test (fails on the old schema); pi 178 + console 112 tests; all 297 live problems (both ways) and 11 circuits: identical LEDs; on the Pi: cache after restart, test casts on the webcam; the app (phone, `/?wall`).
  - **Live:** db/41, Pi, app, 9 Nov.
  - **Left:** Ross: the report's checks; the photo. Footholds named **FT1, FT2…** later (F1… clashed with column F).

- **2026-11-08, Claude Code (Move a problem into Circuits, admins; TODO 12).**
  - **Changed:** the problem ⋮ menu's **Move to Circuits** (admins, not benchmarks) opens the circuit Create screen pre-filled (`#move/<id>`; overview §4.8c): holds in `problemHoldOrder()` order, 1 start if the stored pair is one hold, the name, loop off, a sport grade from `FONT_TO_SPORT` (`state.js`) beside the Font grade, "Does this order look right?", a feet-rule note. Save → confirm with the tick and favourite counts → db/40 `admin_move_problem_to_circuit()`: one transaction (circuit with the setter kept; ticks, favourites, problem deleted; logged). Found: middle holds are stored in first-tapped order, not climbing order.
  - **Tested:** db/40 behaviour test (rolled back; fails before 40): anon/non-admin refused, every refusal changes nothing, the move and the Hangout setter. Chrome, writes stubbed: menu visibility, pre-fill, notes, name clash, confirm, discard, landing on the circuit.
  - **Live:** db/40 applied 8 Nov; the app `eb6cac8`, CACHE `pb-f4b05cd6a2`.
  - **Left:** Ross: try it on a phone with a throwaway problem (the report's list).

- **2026-11-08, Claude Code (no scroll bars on the wall screen).**
  - **Changed:** one rule in `styles.css` under `body.wall` (`scrollbar-width: none` + `::-webkit-scrollbar` hidden, every element, plus the page) hides every scroll bar in wall mode: the problem and circuit lists, the Filter panel, the Cast sheet, any modal, and new ones automatically. Overflow untouched, so drag and momentum scroll as before; no new values.
  - **Tested:** build check; Chrome on `/?wall`: Problems list (with the keyboard open), Circuits list, Filter panel, Create: every scrollable area has no bar and no gutter, and the lists still scroll; the phone view unchanged (page bar still there). No real casts sent.
  - **Live:** `26e2799`, CACHE `pb-3116114eba`.
  - **Left:** Ross: check it on the touchscreen.

- **2026-11-08, Claude Code (one Edit for problems and circuits; owners can edit; TODO 9 names).**
  - **Changed:** the detail ⋮ Edit opens the Create screen pre-filled (problems: holds, name, grade, feet rule; circuits: sequence, start count, loop, name, grade; never the setter), replacing Edit holds / Edit grade. Owners may edit their own while nobody else has ticked it (circuits: nobody else's run), never a benchmark, a challenge's circuit or The Hangout's; db/39 (applied) adds that to RLS plus column guards. Leaving with changes asks first. Names stay the cast key (contract §10; open question 4 closed): no Pi change. Phone only; the wall's Create unchanged.
  - **Tested:** db/39 behaviour test (rolled back; fails on the old schema); Chrome 390 px, writes stubbed: each role, benchmark, challenge circuit, duplicate names, discard, the wall's Create; a renamed cast on `cast-test.html` (its checks pass).
  - **Live:** `446cf22`, CACHE `pb-7ed312f8da`.
  - **Left:** Ross: try it on a phone and the board (the report's list). Not asked on the phone's own back gesture.

- **2026-11-08, chat (deploy policy kept; release workflow parked).** Ross confirmed all the earlier Waiting-on tests (cleared by Claude Code on 7 Nov). Discussed a release workflow: features on `dev`, bundled releases, a "What's new" popup on phones (new features only, never bug fixes), a PB Console switch to point the kiosk at staging, and a phone message when the board is off ("back Mon 15:30"). **Decided: park it, keep shipping straight to `main`** (Decisions). Added to `TODO.md`: the parked workflow (Not now) and the board-off message (item 7). Nothing built. **Left:** Ross: test the opening hours (Waiting on).
