# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-04)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh`: `pb-2e83db5fe9` since 4 Nov. Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (Filter sheet, 4 Nov 2026):** a filter icon (pink + count when not default) and one-tap pills per list; the icon opens a Filter sheet (phone) or panel (wall): Sort (New default; circuits without Popular), Grade slider, quick filters. Problems and circuits, phone and wall (§4.2a). **Holds** (4 Nov): pick holds on the board to see only items that use them all, as set. **Wall search + Clear** (4 Nov): the wall searches like the phone (on-screen keyboard over the board); `✕ Clear` on every row when anything isn't default. Not yet tried on the touchscreen.
- **Deploying:** ship by default, end to end (Decisions); `build.sh` is the build gate, a pre-commit hook scans for secrets; `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4 is back on a new SD card (1 Nov 2026)** after the old card died on 31 Oct: it set itself up unattended (`pi/firstboot/README.md`; the rest in `pi/` or the laptop's gitignored `pi/secrets.env`; new Tailscale key, hotspot password and wall key, db/36). Casting works again. Trixie Lite, Tailscale `projectboard`; the listener with self-healing, watchdogs and night mode 23:00–08:00 (seen both ways 27 Oct; `pi/README.md`). R8 tests still to do. Idle pattern **`wave`**, 15 min after the last cast (`pb-idle`). Wi-Fi: random MAC per join, `pb-netwatch` v2, rescue hotspot `projectboard-rescue`.
- **The wall screen casts on the pick (2 Nov 2026, TODO 8):** a clean tap on a problem lights it, Mirror flips and lights that side, the benchmark slide and a Create save light theirs; no cast button. One cast at a time, the latest tap next; scrolls and drags never cast. **Circuits:** a tap lights all the circuit's holds (`show_circuit`, §8.7); Start circuit runs it. Not yet tried on the touchscreen.
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs Ross's "Pulse and fade" look itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8. Not yet seen on the real wall.
- **Circuit tracks (1 Nov 2026):** `circuits.led_track` (db/37). A cast starts with a 3 s route trace, then the countdown; in the run a dim ghost of the holds and the move's track in dim pink sit under Pulse and fade. Edited in PB Console. Pat Burner has Ross's track. Contract §8.6. Not yet seen on the wall.
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen and picks up a deploy at its next idle (within the hour). **No picture on the touchscreen (4 Nov 2026; touch works): hardware, confirmed;** the adapter chain and the proposed fix are TODO 3. Not yet tried by hand.
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Not yet tried on the wall.
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"); the Pi is in the junction box (31 Oct). Power in at six points, two YU0510 5 V 10 A supplies (both needed). No relays or level shifter fitted (3.3 V data works); the relay module and the 74AHCT125 have arrived. A USB webcam shows the back of the board on Tailscale only.
- **PB Console** (`console/`, `bash console/start.sh`): health, services, board controls, logs, config, Pi deploy (drift check), release, LED map, test cast, **circuit tracks** (1 Nov, direct Postgres), Activity (4 Nov), the R8 checklist, backups, runbook; warnings can be dismissed until they change (`console/README.md`). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship to `main` once checks pass; "staging first" = `dev` only; rollback = `git revert` + push. `CACHE` is stamped from the shipped files' blob ids, so docs-only pushes don't re-download the app. Details: CLAUDE.md, working rule 2.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN for new accounts; accounts made before keep their 4-word passphrase (no switch offered) and sign in through the same field. No lockout, rate limit or weak-PIN blocking, by design. No personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a forgotten PIN or passphrase is reset by an admin (activity check, logged), giving a new PIN or new words to match. Google sign-in removed. The gym is the data controller.
- Points only for benchmark climbs (db/27).
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
- **Ross, for the new card** (in and working since 1 Nov): Tailscale → disable key expiry for the new `projectboard`; a backup image of the working card; the wall tests below again on the new card.
- **Ross: try wall Create on the touchscreen** (the tab should show; tabs Problems · Circuits · Ranks · Create · Get the app since 2 Nov), and a phone with live LEDs (live 30 Oct): the wall's Create tab (keyboard, Save, it lights on save), a phone's Create and an admin Edit at the gym, a cast while setting (Show on board).
- **Ross: cast Pat Burner on the wall** (live 1 Nov): the trace, the ghost and the pink track; whether the dim levels (0.12, 0.2) read on the strip.
- **Ross: try a circuit cast on the wall before opening** (live 30 Oct), from a phone and from the wall screen's Circuits page: the countdown, the look at each speed, Stop, a loop, the top of a run done once, a match (Pat Burner moves 6/7); whether the amber `(255,110,0)` reads as amber on the strip.
- **Ross: try the wall's tap-to-cast on the touchscreen** (live 2 Nov): tap, scroll and fling, fast taps, Mirror (the first mirrored-cast check), a phone cast then a wall tap, the 15-minute LED idle; on Circuits, a tap lights the holds (colours as the screen), Start circuit replaces it.
- **Ross: test the feet rule on the wall** (the listener is deployed, 30 Oct): Orange-only lights B2 only, Black-only B1 only, Any neither; the same mirrored.
- **Ross: try search and Clear on the touchscreen** (live 4 Nov, once it has a picture): typing, a tap on the list closes the keyboard without lighting anything, Done, ×, Clear; Clear on a phone.
- Ross: an on-site check of the cast geofence centre (a non-admin phone by the board and at the far end of the gym).
- **Ross: try PIN accounts on a real iPhone** (live 2 Nov): create one in Safari (number pad, a mismatch), the Home Screen note, add to Home Screen and sign in there; an older passphrase account still signs in; an admin's **Give a new PIN** on a PIN account (4 digits) and on a passphrase account (4 words). Delete any test accounts after.
- Ross: delete the local passphrase hand-out file in the archive (then empty the Recycle Bin) once all 7 migrated accounts have signed in.
- Ross: what the wall screen does at night (keep it blank, or let the kiosk show the dimmed QR?), and whether 23:00 is always after the gym closes.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Is the problem name still the cast key once names become editable?
5. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

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

- **2026-11-04, Claude Code (the Filter sheet, problems and circuits, phone and wall).**
  - **Changed:** grade tabs and the Sort/Grade/Clear pills gone; a filter icon in each row opens one Filter sheet (phone) or panel (wall): Sort, Grade, Quick filters (in step with the row), a Holds slot, Reset, Show N. Circuits gain sorts (New default) and a grade range. Empty lists offer Clear filters. Fixes admin Edit grade (a duplicate `grade-modal` id opened the list's sheet). Overview §4.2a/§4.3/§4.7a.
  - **Tested:** build; Chrome 390×844, 1280×720 `?wall`, no casts: sorts, slider, toggles, badge, Reset, empty, circuits.
  - **Live:** `3ac8028`, CACHE `pb-8733480f5d`.
  - **Left:** Ross: try it on a phone and the touchscreen. Next: the hold filter.

- **2026-11-04, Claude Code (Create: pinch in and out of the viewer).**
  - **Changed:** problem Create/Edit pinches like detail: a spread opens the viewer, pinching to fit closes it (also after the expand button), a double-tap closes only when both taps miss every hold; on a hold it still cycles twice; taps never hide the bar; no landscape auto-open. New hint. Circuit create shares the viewer, not the gestures: unchanged. Overview §4.8.
  - **Tested:** build; Chrome, synthetic touch pointers: holds, name, grade, Undo and bar counts survive; detail as before. Real fingers not yet.
  - **Live:** `cc4c74a`, CACHE `pb-a39886ca6c`.
  - **Left:** Ross: try it with real fingers. The hint shows only the first 3 viewer opens ever.

- **2026-11-04, Claude Code (PB Console: the Activity dashboard, TODO 17).**
  - **Changed:** Activity = the approved prototype (`tools/activity-dashboard-prototype.html`, kept as reference) on real data, cross-filtered, with a Log view; old charts gone. The console keeps its own cast history (`console/data/`, gitignored) as the journal expires; nicknames, ticks and accounts live from Postgres. UK time. `console/README.md` → Activity.
  - **Tested:** console tests (13 new); Chrome: filters, toggles, keyboard, no CSP errors, Log agrees, no-`db/.env` view.
  - **Left:** Ross: a look. Cast history starts 1 Nov (the new card).
