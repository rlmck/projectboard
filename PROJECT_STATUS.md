# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 12 KB: the 3 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-15)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` (stamp: newest session entry) is also on every script and stylesheet URL since 14 Nov (overview §7). Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (4 Nov 2026):** the Filter sheet (phone) or panel (wall): Sort, Grade slider, quick filters, pick Holds; `✕ Clear` (overview §4.2a).
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs, about 0.25–0.45 s) and is used daily. Every hold's LED, mirrored casts, the feet rule and the geofence centre are checked on site.
- **The Pi 4 is on a new SD card (1 Nov 2026)** (set itself up: `pi/firstboot/README.md`). Trixie Lite, Tailscale `projectboard`; self-healing and watchdogs; R8 tests still to do. Idle pattern **`wave`** 15 min after the last cast. Wi-Fi: random MAC, `pb-netwatch` v2, rescue hotspot.
- **The wall screen casts on the pick (2 Nov 2026):** a tap lights a problem (Mirror flips it), a circuit (`show_circuit`); Start circuit runs it. Tried (Ross, 7 Nov).
- **Circuits can be cast (30 Oct 2026)** from phones and the wall: Cast → speed, Loop or laps → a 5 s countdown, the move count and Stop; the Pi runs it (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8.
- **Circuit LED look "map and next hold" (5 Nov 2026):** contract §8.3. **Laps (14 Nov):** the Cast sheet offers Loop or 1–10 laps for a circuit that loops (none for one that doesn't) and sends `laps`, with `loop` beside it for old listeners (contract §8.1, §8.4).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `/?wall`, the wall key in the fragment) on the 1280×720 touchscreen picks up a deploy at its next idle or each morning.
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall saves as The Hangout (db/35); taps light the board (contract §9).
- **Opening hours (7 Nov 2026):** per day in the Pi's `config.env` (Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00); night outside them. PB Console edits them (`pi/README.md` → Opening hours).
- **Holds in the database (db/41, db/42):** the `holds` table is the source (`board_config` copies it). **Board setup** and **Edit holds** (super admin) publish a whole board with Undo; live since 10 Nov (188 hand holds, 50 footholds). **Specific feet** (10 Nov). **Publish safety (12 Nov, db/45):** a stale publish is refused (CLAUDE.md → Data traps; overview §4.8a, §4.8d).
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"), Pi in the junction box, two 5 V 10 A supplies (both needed); relays and level shifter arrived, not fitted (3.3 V data works). A USB webcam shows the back of the board (Tailscale only).
- **Pi deploys are automatic (10 Nov 2026):** CLAUDE.md working rule 2; since 15 Nov signed, through `pb-install` (`pi/README.md` → Deploying).
- **PB Console** (`console/`, `bash console/start.sh`): Home, Holds, Activity, Advanced (`console/README.md`); weekly backups (Pi settings + a full local DB dump since 15 Nov). Phase 13 (Data) isn't built.

## Decisions
- **Deploying:** CLAUDE.md working rule 2 (ship by default, end to end, gated items, rollback). **Confirmed 8 Nov 2026: keep shipping straight to `main`;** the bundled-release idea is parked in `TODO.md` → Not now.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN (older accounts keep their passphrase, same field); no lockout or weak-PIN blocking, by design; Ranks opt-in; resets by an admin (logged); no Google. The rest: CLAUDE.md → Supabase. The gym is the data controller.
- **Super admin (10 Nov 2026, db/44):** Ross (Pablo) only; everything touching the board is his alone; admins keep the rest (CLAUDE.md → Supabase).
- Points only for benchmark climbs (db/27).
- **Move to Circuits (8 Nov 2026):** admins only; a move, not a copy: the problem, its ticks and favourites are deleted in one transaction with the circuit's creation (Ross OK'd the deletes for this feature); benchmarks can't be moved; the setter is kept; a name clash asks for a rename (db/40).
- **Editing (8 Nov 2026):** one Edit (the Create screen) for problems and circuits; the owner may edit while nobody else has ticked it (circuits: nobody else's run), never a benchmark, a challenge's circuit or The Hangout's; the setter is never editable; the name stays the cast key (db/39, contract §10).
- **Opening hours (7 Nov 2026):** the board and the wall screen follow one per-day schedule; no bank holidays; a one-evening "stay on until" from PB Console; `NIGHT_FORCE` stays for tests.
- **Board setup, Specific feet (7, 9 Nov 2026):** no rearrange now (a dry run on the current board, no archive). Sessions 1, 2a and 3 done; **2b (camera LED mapping) dropped (Ross, 10 Nov 2026)**, parked on `parked/2b-camera-led-mapping`. Footholds and their pairs: CLAUDE.md → Data traps; `docs/board-setup-plan.md`.
- **Feet rule (30 Oct 2026):** CLAUDE.md → Data traps. Migrated problems: both signs or none → Any, one sign → that rule.
- **Circuits (30 Oct 2026):** no mirrored circuits and no circuits Done filter for now (future releases); "done" means done both sides and is for problems only. No Play preview.
- **Who cast (30 Oct 2026):** never in the broadcast; private `cast_log` (CLAUDE.md → Supabase).
- Old star ratings: gone from the app (30 Oct 2026); `stars` columns stay, unused.
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, score = total seconds held; the rest is in CLAUDE.md → Data traps and overview §4.6a.
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- **Backups (15 Nov 2026):** every public table (members' data too) weekly to the laptop's gitignored `backups/`; local only, not encrypted, newest 8; restores by hand (`console/README.md`).
- **The Hangout (30 Oct 2026):** the gym's setter (CLAUDE.md → Data traps). Live LEDs while setting: geofenced on phones, admins too; a cast overrides (Show on board). Comments stay off.

## To-do
The ordered to-do list (next steps, backlog, and what not to build yet) lives in `TODO.md`. Top item = now.

## Waiting on
- **Ross, db/47 (session 9; no browser run, Chrome wasn't connected):** 1) Signed in: tick/untick, favourite a problem and a circuit, Ranks, Pat Burner. 2) Create a test problem; the same name in other capitals says "already used"; delete it. 3) Edit your problem's holds. 4) A signed-in cast shows in Console → Activity. 5) As Pablo: Trace Holds, Edit holds publish + Undo, Board Setup, Console → Holds. 6) As admin: users, activity, benchmark, Move to Circuits. 7) `/?wall` list + Create. A "permission" error = a missing grant: tell Claude.
- **Ross, PB Console (session 8):** 1) Start (icon): works, no `#c=` in the address; again: a 2nd tab; reload works, an old `#c=` address says "no session". 2) Backups → The database only: a `db-…` folder, 17 tables; the drawer says what it covers. 3) Board in use: Restart the listener asks twice. 4) Holds → Ship the snapshot pushes one commit. 5) LED map tool works in its frame.
- **Ross, at the gym (session 7):** 1) casts, circuits, wall as before. 2) Console → Deploy: dry run, then Deploy, no password. 3) Logs `netwatch-file`, `netlog` after a reboot. 4) R8 clock: reboot within 15 min, NTP back in 2 min. 5) R8 Supabase block: no listener restarts. 6) Wi-Fi drop: hotspot 15 min, `netwatch.txt` on the card.
- **Ross: session 6 phone tests** (14 Nov; steps in that session's report).
- **Ross, at the board: cast seams** (14 Nov): Stop in the countdown (stays idle); 3 laps (red on lap 3, Top!); Loop; no Loop/Laps on a non-looping circuit; live LEDs while setting, Save/Cancel idle at once; phone setting vs a wall circuit tap (Show on board).
- **Ross: update flow on a phone** (14 Nov): a circuit run survives lock + deploy + unlock; the app opens offline.
- **Ross, on site: kiosk** (12 Nov): long-press/right-click open nothing; a killed renderer recovers.
- **Ross: publish safety** (12 Nov): each board tool publishes and undoes; a publish from elsewhere in between is refused. **The snapshot is a publish behind live** (11 Nov): PB Console → Holds → Ship the snapshot (Home's tile stays amber till then).
- **Ross:** Edit holds: the footholds beside **G1 and N1** aren't in yet (3 of 5 are). Sign in as Pablo with the new PIN once (reset 10 Nov). The db/41 checks (9 Nov report). **Try Specific feet** (plan → Session 3 → "Try it").
- **Ross: try PB Console → Holds** (`console/README.md` → Holds): a redraw, a new foothold, a pair, Publish, Ship the snapshot. **Decide** whether turning a hold and new photos move to the console (the review recommends no).
- **Parked branch `parked/2b-camera-led-mapping`:** camera LED mapping (2b), unfinished, never shipped; only for a full rearrange or another gym (`TODO.md` → Not now). Its db/43 is live and harmless.
- **Ross: test the opening hours** (live 7 Nov): the 7 Nov checklist in `docs/log/2026-11.md`.
- Ross (low priority): delete the local passphrase hand-out file (and empty the Recycle Bin) once all 7 migrated accounts have signed in.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).

## Session log
Newest first, the 3 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-15, Claude Code (review fix session 9: database access tidy).**
  - **Changed:** db/47: hold ids must be hand holds (problems, circuits); board writes only through the RPCs; new functions executable by nobody by default, unused grants gone; `cast_log` cap and name check; challenge ties on server time; names unique ignoring case. App: "That name is already used". DB-08, DB-12, DB-13 accepted.
  - **Tested:** db/47 test (member, guest); member/admin/super-admin paths (dry run); guest API live; console Holds + Activity. Chrome not connected.
  - **Live:** `da3793c`, app `pb-c2909dc59f`. No Pi change.
  - **Left:** Ross's checks (Waiting on).

- **2026-11-15, Claude Code (review fix session 8: PB Console).**
  - **Changed:** CON-01–04, 06–10, 12, 13, 15: safe pull-file; Ship the snapshot pushes only its own commit; the backup is a full local DB dump (newest 8; hook refuses `backups/`; privacy.html); one-time sign-in code; busy 2nd step; 36 tests (`console/README.md`).
  - **Tested:** console/tests 183, hook 38; live backup (17 tables, counts = live); code flow over HTTP (Chrome not connected).
  - **Live:** `654f2a7`, app `pb-a9958e0c00`. No Pi change.
  - **Left:** Ross's console checks (Waiting on).

- **2026-11-15, Claude Code (review fix session 7: Pi deploy and ops).**
  - **Changed:** PI-02, 03, 04, 06, 07, 08, 11, 13, 14, CON-11, CON-16 and TODO 5's first half: signed deploys via `pb-install` (one lock and record, own unit, listener swapped whole); pb-health fixes; logs and first-boot secrets off FAT; rescue profile in `pi/conf` (`pi/README.md` → Deploying).
  - **Tested:** pi/tests 253, console/tests 148; on the Pi: swap, `visudo -c`, a killed deploy finished.
  - **Live:** `32e342a`, Pi by autodeploy (listener joined, 0 failed units, drift 68/68). No app change.
  - **Left:** Ross's tests (Waiting on).
