# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 12 KB: the 3 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-10)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh` (see the newest session entry for the current stamp). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (4 Nov 2026):** the Filter sheet (phone) or panel (wall): Sort, Grade slider, quick filters, pick Holds; `✕ Clear` (overview §4.2a).
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs, about 0.25–0.45 s) and is used daily. Every hold's LED, mirrored casts, the feet rule and the geofence centre are checked on site.
- **The Pi 4 is on a new SD card (1 Nov 2026)** after the old one died: it set itself up unattended (`pi/firstboot/README.md`; secrets in the laptop's gitignored `pi/secrets.env`; db/36 new wall key). Trixie Lite, Tailscale `projectboard`; the listener with self-healing and watchdogs; R8 tests still to do. Idle pattern **`wave`** 15 min after the last cast. Wi-Fi: random MAC, `pb-netwatch` v2, rescue hotspot.
- **The wall screen casts on the pick (2 Nov 2026):** a tap lights a problem (Mirror flips it), a circuit (`show_circuit`); Start circuit runs it. Tried (Ross, 7 Nov).
- **Circuits can be cast (30 Oct 2026)** from phones and the wall: Cast → speed and Loop → a 5 s countdown, the move count and Stop, while the Pi runs it (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. Contract §8.
- **The circuit LED look is "map and next hold" (5 Nov 2026):** contract §8.3; `cast_circuit` takes `laps`, the app still sends `loop` (TODO 5).
- **The wall kiosk** (`kiosk.service`: cage + Chromium opening `/?wall` with the wall key in the fragment) runs on the 1280×720 touchscreen and picks up a deploy at its next idle (within the hour) or each morning; the screen works again (Ross, 7 Nov).
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall saves as The Hangout (db/35); taps light the board (contract §9).
- **Opening hours (7 Nov 2026):** per day in the Pi's `config.env` (Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00); outside them the LEDs and wall screen are off and casts ignored. PB Console edits them and has Stay on until (`pi/README.md` → Opening hours).
- **Holds in the database (db/41, db/42):** the `holds` table is the source of each hold's name, kind, LED, position, outline and mirror partner (`board_config` copies it); checked by `tools/check_holds.py`. **Board setup** (Admin → Board Setup) publishes a whole board with Undo; Ross published the new board on 10 Nov (188 hand holds, 50 footholds). **Edit holds** adds/deletes/pairs footholds and turns holds. **Specific feet** (10 Nov): footholds picked in Create/Edit, yellow, never lit (overview §4.8a, §4.8d).
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"); the Pi is in the junction box. Two YU0510 5 V 10 A supplies (both needed). No relays or level shifter fitted yet (3.3 V data works; both parts have arrived). A USB webcam shows the back of the board (Tailscale only).
- **Pi deploys are automatic (10 Nov 2026):** `console/autodeploy.py` keeps the Pi on main (a scheduled task every 10 min, and `/ship`): 15 quiet minutes in opening hours, straight away outside them (`pi/README.md` → Deploying).
- **PB Console** (`console/`, `bash console/start.sh`): health, services, board controls, logs, config, Pi deploy, release, LED map, test cast, circuit tracks, Activity, the R8 checklist, backups, runbook (`console/README.md`). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **Deploying:** CLAUDE.md working rule 2 (ship by default, end to end, gated items, rollback). **Confirmed 8 Nov 2026: keep shipping straight to `main`;** the bundled-release idea is parked in `TODO.md` → Not now.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN for new accounts; accounts made before keep their 4-word passphrase (no switch offered) and sign in through the same field. No lockout, rate limit or weak-PIN blocking, by design. No personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a forgotten PIN or passphrase is reset by an admin (activity check, logged), giving a new PIN or new words to match. Google sign-in removed. The gym is the data controller.
- Points only for benchmark climbs (db/27).
- **Move to Circuits (8 Nov 2026):** admins only; a move, not a copy: the problem, its ticks and favourites are deleted in one transaction with the circuit's creation (Ross OK'd the deletes for this feature); benchmarks can't be moved; the setter is kept; a name clash asks for a rename (db/40).
- **Editing (8 Nov 2026):** one Edit (the Create screen) for problems and circuits; the owner may edit while nobody else has ticked it (circuits: nobody else's run), never a benchmark, a challenge's circuit or The Hangout's; the setter is never editable; the name stays the cast key (db/39, contract §10).
- **Opening hours (7 Nov 2026):** the board and the wall screen follow one per-day schedule; no bank holidays; a one-evening "stay on until" from PB Console; `NIGHT_FORCE` stays for tests.
- **Board setup, Specific feet (7, 9 Nov 2026):** Specific feet = footholds only, never lit. No rearrange now: a dry run on the current board, no archive; hand holds keep ids, names and LEDs. Sessions 1, 2a and 3 (Specific feet) done; **2b (camera LED mapping) dropped (Ross, 10 Nov 2026):** every LED is verified, rotations don't move LEDs, footholds have none; parked on `parked/2b-camera-led-mapping`. Footholds FT1, FT2…, left to right, bottom row up; **footholds mirror foot ↔ foot where the reflection finds a partner, never hand ↔ foot**. `docs/board-setup-plan.md`.
- **Feet rule (30 Oct 2026):** CLAUDE.md → Data traps. Migrated problems: both signs or none → Any, one sign → that rule.
- **Circuits (30 Oct 2026):** no mirrored circuits and no circuits Done filter for now (future releases); "done" means done both sides and is for problems only. No Play preview.
- **Who cast (30 Oct 2026):** never in the broadcast; private `cast_log` (CLAUDE.md → Supabase).
- Star ratings from the old system are gone from the app (30 Oct 2026); `problems.stars` / `ticks.stars` stay in the table, unused.
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, score = total seconds held; the rest is in CLAUDE.md → Data traps and overview §4.6a.
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- **The Hangout (30 Oct 2026):** the gym's setter (CLAUDE.md → Data traps). Live LEDs while setting: geofenced on phones, admins too; a cast overrides (Show on board). Comments stay off.

## To-do
The ordered to-do list (next steps, backlog, and what not to build yet) lives in `TODO.md`. Top item = now.

## Waiting on
- **Ross:** Edit holds: 3 of the 5 missing footholds are in (beside F3 and M2, a pair, and on J1); the pair beside **G1 and N1** isn't yet; after the next publish, Claude snapshots + ships (the 10 Nov board is snapshotted, `c669ae8`). Sign in as Pablo with the new PIN once (reset 10 Nov). The db/41 checks (9 Nov report). **Try Specific feet** (plan → Session 3 → "Try it").
- **Ross: run `python console/autodeploy.py --install` once** in Git Bash at the repo root (the scheduled task; Claude's session may not create one). Until then only `/ship` deploys.
- **Claude (next session): re-baseline two score tools on the new bundled board.** Since the 10 Nov snapshot, `tools/trace_prior_score.js` scores 179 unchanged holds (bar 180) and `tools/holdedit_score.js` finds one tap spot that isn't a foothold (it auto-picks spots that were the missing footholds on the old board). Both pass at `b98c121` and fail at `c669ae8` (the snapshot alone); no app code they load changed. Thresholds left as they are until then.
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
Newest first, the 3 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-10, Claude Code (automatic Pi deploys; the console banner).**
  - **Cause:** the yellow banner was the config.env drift check: the laptop's `pi/config.env` had `STRIP_LEDS` from the parked 2b work (nothing on main reads it); removed. The Pi was also behind main (pb-ledmap, the 10 Nov snapshot).
  - **Changed:** `console/autodeploy.py` (clean export of main, pi tests, busy check, deploy); busy = 15 min, opening-hours aware, counts wall touches (`pb-touchwatch`); the banner is now a sidebar notice for real problems only. CLAUDE.md rule 2, `/ship`, `/pi-deploy`, both READMEs.
  - **Live:** console + Pi only, CACHE unchanged. Pi deployed by autodeploy at 20:29 (open, 54 min quiet); no listener restart.
  - **Left:** Ross: `--install` (Waiting on).

- **2026-11-10, Claude Code (token audit).**
  - **Changed:** `/start` reads only the status and TODO (not CLAUDE.md again, not the 131 KB overview whole); big docs are read by section (CLAUDE.md rule 1); `tools/wait-live.sh` waits for a deploy in one command (`/ship`, `/staging`, `/rollback`); status keeps 3 entries under 800 bytes, cap 12 KB; Decisions no longer repeat CLAUDE.md; memory index trimmed. `docs/token-audit.md`.
  - **Live:** docs and tooling only; CACHE unchanged. No safety gate touched.
  - **Left:** done (Ross's `wait-live.sh` permission committed, `eff15d8`). Bigger ideas in the audit.

- **2026-11-10, Claude Code (Specific feet in Create, Edit and the problem view; board setup session 3; TODO 13 done).**
  - **Snapshot:** the 10 Nov board into the offline copy (`c669ae8`). Footholds: 3 of the 5 added by Ross (beside F3 and M2, a pair, and on J1); G1/N1's pair not yet.
  - **Changed:** tap a foothold in Create/Edit (phone and wall) → yellow outline, Specific feet; again → off; none → Any. Orange/Black → Specific; Any/Orange/Black clear them (Undo). 1–30. Problem view, fullscreen, wall bar: outlines and "Specific feet (N)"; mirrored = foot partners. Never lit, no sign. Move to Circuits note. Footholds from `holds` (`FOOT_HOLDS`). No migration, no Pi change. Overview §4.4, §4.8a; contract §6.5, §9.1; plan.
  - **Tested:** Chrome 390 px + `/?wall` (stubbed); hand taps unchanged (40,000-tap grid); payloads through real RLS/RPC, rolled back; pi + console tests (trace demo cells regenerated); a real cast both ways: 4 LEDs (hands, no sign), webcam, idle, test problem deleted.
  - **Live:** `80e2e4e`, CACHE `pb-06484e4a19`.
  - **Left:** Ross: the checklist below; G1/N1 footholds. Claude: re-baseline two score tools (Waiting on). Older app versions show Specific feet as Any (overview §13).
  - **Ross's checklist:** `docs/board-setup-plan.md` → Session 3 → "Try it".
