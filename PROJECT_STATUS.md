# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-07)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh`: `pb-acfbd791ce` since 7 Nov. Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (Filter sheet, 4 Nov 2026):** a filter icon (pink + count when not default) and one-tap pills per list; the icon opens a Filter sheet (phone) or panel (wall): Sort (New default; circuits without Popular), Grade slider, quick filters. Problems and circuits, phone and wall (§4.2a). **Holds** (4 Nov): pick holds on the board to see only items that use them all, as set. **Wall search + Clear** (4 Nov): the wall searches like the phone (on-screen keyboard over the board); `✕ Clear` on every row when anything isn't default. Tried on the touchscreen (Ross, 7 Nov).
- **Deploying:** ship by default, end to end (Decisions); `build.sh` is the build gate, a pre-commit hook scans for secrets; `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are checked on the wall** (Ross, by 7 Nov), the feet rule both ways too, and the geofence centre on site.
- **The Pi 4 is back on a new SD card (1 Nov 2026)** after the old card died on 31 Oct: it set itself up unattended (`pi/firstboot/README.md`; the rest in `pi/` or the laptop's gitignored `pi/secrets.env`; new Tailscale key, hotspot password and wall key, db/36). Casting works again. Trixie Lite, Tailscale `projectboard` (key expiry off); the listener with self-healing and watchdogs. R8 tests still to do. Idle pattern **`wave`**, 15 min after the last cast (`pb-idle`). Wi-Fi: random MAC per join, `pb-netwatch` v2, rescue hotspot `projectboard-rescue`.
- **The wall screen casts on the pick (2 Nov 2026, TODO 8):** a clean tap on a problem lights it, Mirror flips and lights that side, the benchmark slide and a Create save light theirs; no cast button. One cast at a time, the latest tap next; scrolls and drags never cast. **Circuits:** a tap lights all the circuit's holds (`show_circuit`, §8.7); Start circuit runs it. Tried on the touchscreen, Mirror included (Ross, 7 Nov).
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs the run itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8.
- **The circuit LED look is "map and next hold" (5 Nov 2026, replacing Pulse and fade and the track lighting):** the circuit blue at 0.2, the start holds blinking green in the countdown, only the hold to go to green in the run (a match blinks twice), the finish red at 0.6 on the final lap, a top of three red blinks and a fade. `cast_circuit` takes `laps` (0 endless, 1–10); the app still sends `loop` (laps on the phone and wall: TODO 5). Tracks kept (PB Console), not lit. Contract §8.3. Seen on the wall and right (Ross, 7 Nov); circuit casts from phones and the wall too.
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen and picks up a deploy at its next idle (within the hour) or each morning. **The touchscreen has a picture again** (the 4 Nov hardware fault is fixed; Ross, 7 Nov).
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Tried on the touchscreen and phones (Ross, 7 Nov).
- **Opening hours (7 Nov 2026; replaced night 23:00–08:00, lately 23:00–15:00):** one per-day schedule in the Pi's `config.env` (`HOURS_MON`…`HOURS_SUN`, London time): Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00 (30 min either side of the gym's hours). Day inside; outside, the LEDs go dark, casts are ignored and the wall screen is off (kiosk stopped, HDMI powered down; the wall page's own night screen is gone). Switches on the minute, no reboot; a boot applies it at once. PB Console: the hours as a table in Config; **Stay on until HH:MM** (today, ends itself) and End override on Board, amber on the overview while on. `pi/README.md` → Opening hours. Deployed 7 Nov 17:30, checked both ways with an override.
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"); the Pi is in the junction box (31 Oct). Power in at six points, two YU0510 5 V 10 A supplies (both needed). No relays or level shifter fitted (3.3 V data works); the relay module and the 74AHCT125 have arrived. A USB webcam shows the back of the board on Tailscale only.
- **PB Console** (`console/`, `bash console/start.sh`): health, services, board controls, logs, config, Pi deploy (drift check), release, LED map, test cast, **circuit tracks** (1 Nov, direct Postgres), Activity (4 Nov), the R8 checklist, backups, runbook; warnings can be dismissed until they change (`console/README.md`). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship to `main` once checks pass; "staging first" = `dev` only; rollback = `git revert` + push. `CACHE` is stamped from the shipped files' blob ids, so docs-only pushes don't re-download the app. Details: CLAUDE.md, working rule 2.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN for new accounts; accounts made before keep their 4-word passphrase (no switch offered) and sign in through the same field. No lockout, rate limit or weak-PIN blocking, by design. No personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a forgotten PIN or passphrase is reset by an admin (activity check, logged), giving a new PIN or new words to match. Google sign-in removed. The gym is the data controller.
- Points only for benchmark climbs (db/27).
- **Opening hours (7 Nov 2026):** the board and the wall screen follow one per-day schedule; no bank holidays; a one-evening "stay on until" from PB Console; `NIGHT_FORCE` stays for tests.
- **Board sets, Specific feet (7 Nov 2026, planned):** a new set per rearrange, the old archived (ticks kept); hands only on wooden holds; Specific feet never lit. `docs/board-setup-plan.md`.
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
- **Ross: test the opening hours** (live 7 Nov): see the 2026-11-07 session entry's checklist.
- Ross (low priority): delete the local passphrase hand-out file in the archive (then empty the Recycle Bin) once all 7 migrated accounts have signed in.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Is the problem name still the cast key once names become editable?
5. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-07, Claude Code (opening hours for the LEDs and the wall screen; status tidy).**
  - **Changed:** `mode.py` works out day/night from `HOURS_MON`…`HOURS_SUN` (London time, past-midnight hours allowed) and a stay-on file; `NIGHT_START`/`NIGHT_END` gone. `pb-mode.timer` on the minute; listener checks every 10 s; `kiosk.service` won't start at night (ExecCondition). Helper: `HOURS_*` keys, `stay-on HH:MM|end`, `night-hours` gone. PB Console: hours table (Config), Stay on until / End override (Board), an Opening hours check (amber while overridden), night check by the hours. Wall page: its night screen removed. Docs: `pi/README.md`, `console/README.md`, contract, overview, CLAUDE.md. Waiting on: Ross's confirmed tests cleared.
  - **Tested:** pi (160) and console (112) tests, build check; the wall page in Chrome (list, idle slides); on the Pi: night at 17:30 (kiosk stopped, screen off), Stay on 17:45 (kiosk up, LEDs idle), End (back to night, file gone), the console probe's night check.
  - **Live:** Pi deployed 17:30; the app `fd01950`, CACHE `pb-acfbd791ce`.
  - **Left: Ross to test:** (1) Sun 09:30: screen on, LEDs idle, a cast lights; 15:00: LEDs fade, screen off, a phone cast does nothing. (2) PB Console → Board → Stay on until (e.g. 30 min ahead) at night: screen and LEDs on, the overview shows it amber; End override puts it back. (3) Config → Opening hours: change one day, Apply, Board → Now shows it. (4) The wall screen opening at 15:30 Mon shows the list, not a night page.

- **2026-11-07, chat (plan: board setup flow, board sets, Specific feet).** Planned in `docs/board-setup-plan.md` (new; TODO 16): decisions, phases, a dry run on the current board. A quick auto-trace test matched 166 of the 188 hand-traced outlines closely. Nothing built. **Left:** Ross: a full-board photo, footholds included.

- **2026-11-05, Claude Code (the circuit LED look "map and next hold", and `laps`; replaces TODO 6).**
  - **Changed:** `circuit.py` rewritten to Ross's look (§8.3): trace, ghost, track, amber, red let-go and green run-up gone; `check_track()`/`led_track` kept. `cast_circuit` gains `laps` (bad → ignored; absent → from `loop`, then `loops`; `loops` false → 1 lap); `trace_s` ignored. Config: `CIRCUIT_MAP_LEVEL`/`CIRCUIT_FINISH_LEVEL` in, the track keys out. Simulator rewritten as a port. PB Console sends `laps`; Activity reads the new line. The app drops `trace_s` and its 3 s wait (else 3 s behind the Pi).
  - **Tested:** pi/console tests, build check; the simulator matches `circuit.py` (6000 frames), runs in Chrome.
  - **Live:** `fe8b40e`, CACHE `pb-1be624474b`; Pi deployed 09:00.
  - **Left:** Ross: watch it on the webcam (Waiting on). Next: laps on the phone and wall (TODO 6). Night is 23:00–15:00 on the Pi (`NIGHT_END=15:00`, since 4 Nov).

- **2026-11-04, Claude Code (wall search and the Clear pill, phone and wall).**
  - **Changed:** wall rows get the phone's search (same state and matching) on Create's keyboard, now shared (`wallKbOpen(target)`), docked over the board for a search. A tap outside closes it and never casts; panel, page change, Clear, idle close it. `✕ Clear` pinned right on all four rows (the phone had none since the Filter sheet) = `clearFilters`, now clearing the wall's search. Overview §4.2a/§4.7a.
  - **Tested:** build; Chrome wall and phone 390 px, casts stubbed: filtering, rail in Easy, empty list, panel, taps while open never cast, idle, Create's name.
  - **Live:** `fb622d4`, CACHE `pb-2e83db5fe9`.
  - **Left:** Ross: try it on the touchscreen and a phone.

- **2026-11-04, Claude Code (the hold filter, problems and circuits, phone and wall).**
  - **Changed:** the Filter's Holds section: items using all picked holds, any role, as set. Phone: a row (thumbnail, names) opens a hold picker (whole board, live count, chips, Clear holds, Show N); pinch or expand → the fullscreen viewer, taps pick. Wall: the board beside the open panel is the picker; no Mirror, casts or `show_circuit`; idle clears. Badge +1; Reset/Clear filters clear it. Overview §4.2a/§4.7a/§4.8.
  - **Tested:** build; Chrome 390×844 and 1280×720 `?wall`, broadcast stubbed: 1–3 holds match a recount, faded hold, chips, Clear, Reset, viewer, circuits, drag ≠ tap, no casts, idle.
  - **Live:** `25ca555`, CACHE `pb-c900459de0`.
  - **Left:** Ross: try it with real fingers on a phone and the touchscreen.
