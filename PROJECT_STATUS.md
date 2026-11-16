# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 12 KB: the 3 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-16)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` (stamp: newest session entry) is also on every script and stylesheet URL since 14 Nov (overview §7). Not yet announced to the public: the wiring behind the board is temporary.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs, about 0.25–0.45 s) and is used daily. Every hold's LED, mirrored casts, the feet rule and the geofence centre are checked on site.
- **The Pi 4 is on a new SD card (1 Nov 2026)** (set itself up: `pi/firstboot/README.md`). Trixie Lite, Tailscale `projectboard`; self-healing and watchdogs; R8 tests still to do. Idle pattern **`wave`** 15 min after the last cast. Wi-Fi: random MAC, `pb-netwatch` v2, rescue hotspot.
- **The wall screen** casts on a tap (problem, circuit `show_circuit`), creates as The Hangout (db/35) with live LEDs (contract §9).
- **Circuits are cast (30 Oct 2026)** from phones and the wall: Cast → speed, Loop or 1–10 laps → countdown, moves, Stop; the Pi runs it (`pi/listener/circuit.py`; contract §8).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `/?wall`, the wall key in the fragment) on the 1280×720 touchscreen checks for a deploy every 5 min and takes it after 2 min untouched (back on the same page, problem and scroll), or each morning.
- **Opening hours (7 Nov 2026):** per day in the Pi's `config.env` (Mon–Thu 15:30–22:00, Fri closed, Sat–Sun 09:30–15:00); night outside them. PB Console edits them (`pi/README.md` → Opening hours).
- **Holds in the database (db/41, db/42):** the `holds` table is the source (`board_config` copies it). **Board setup** (a new photo) and **Edit holds** / PB Console → Holds (edits, db/48) publish with Undo; a stale publish is refused (db/45); 188 hand holds, 55 footholds. The offline snapshot matches live as of 15 Nov. **Specific feet** (10 Nov). CLAUDE.md → Data traps; overview §4.8a, §4.8d.
- **Hardware:** temporary wiring (`pi/README.md` → "Wiring"), Pi in the junction box, two 5 V 10 A supplies (both needed); relays and level shifter arrived, not fitted (3.3 V data works). A USB webcam shows the back of the board (Tailscale only).
- **Pi deploys are automatic (10 Nov 2026):** CLAUDE.md working rule 2; since 15 Nov signed, through `pb-install` (`pi/README.md` → Deploying).
- **The code review (12 Nov) is closed (16 Nov):** 98 of 101 findings fixed, 3 accepted (local `review_output.md`).
- **PB Console** (`console/`, `bash console/start.sh`): Home, Holds, Activity, Advanced (`console/README.md`); weekly backups (Pi settings + a full local DB dump since 15 Nov). Phase 13 (Data) isn't built.

## Decisions
- **Code review (16 Nov 2026):** accepted: admins may reset an admin's PIN, the super admin keeps a PIN (Ross), owner gates stay check-then-act. Deferred to `TODO.md`: the kiosk's `input` group, an FTn order check.
- **Deploying:** CLAUDE.md working rule 2 (ship by default, end to end, gated items, rollback). **Confirmed 8 Nov 2026: keep shipping straight to `main`;** the bundled-release idea is parked in `TODO.md` → Not now.
- **Accounts (2 Nov 2026):** nickname + 4-digit PIN (older accounts keep their passphrase, same field); no lockout or weak-PIN blocking, by design; Ranks opt-in; resets by an admin (logged); no Google. The rest: CLAUDE.md → Supabase. The gym is the data controller.
- **Board tools (15 Nov 2026):** turning a hold and new photos stay in the app; the console owns precise outline work; Board Setup's new photo keeps the whole-board publish; everything else is edits through `admin_edit_holds` (review 2.1).
- **Super admin (10 Nov 2026, db/44):** Ross (Pablo) only; everything touching the board is his alone; admins keep the rest (CLAUDE.md → Supabase).
- Points only for benchmark climbs (db/27).
- **Move to Circuits (8 Nov 2026):** admins only; a move, not a copy: the problem, its ticks and favourites are deleted in one transaction with the circuit's creation (Ross OK'd the deletes for this feature); benchmarks can't be moved; the setter is kept; a name clash asks for a rename (db/40).
- **Editing (8 Nov 2026):** one Edit (the Create screen) for problems and circuits; the owner may edit while nobody else has ticked it (circuits: nobody else's run), never a benchmark, a challenge's circuit or The Hangout's; the setter is never editable; the name stays the cast key (db/39, contract §10).
- **Opening hours (7 Nov 2026):** the board and the wall screen follow one per-day schedule; no bank holidays; a one-evening "stay on until" from PB Console; `NIGHT_FORCE` stays for tests.
- **Board setup, Specific feet (7, 9 Nov 2026):** no rearrange now (a dry run on the current board, no archive). Sessions 1, 2a and 3 done; **2b (camera LED mapping) dropped (Ross, 10 Nov 2026)**, parked on `parked/2b-camera-led-mapping`. Footholds and their pairs: CLAUDE.md → Data traps; `docs/board-setup-plan.md`.
- **Feet rule (30 Oct 2026):** CLAUDE.md → Data traps. Migrated problems: both signs or none → Any, one sign → that rule.
- **Circuits (30 Oct 2026):** no mirrored circuits and no circuits Done filter for now (future releases); "done" means done both sides and is for problems only. No Play preview.
- **Who cast (30 Oct 2026):** never in the broadcast; private `cast_log` (CLAUDE.md → Supabase).
- Old star ratings gone (30 Oct 2026); `stars` columns stay, unused.
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, score = total seconds held; the rest is in CLAUDE.md → Data traps and overview §4.6a.
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- **Backups (15 Nov 2026):** every public table (members' data too) weekly to the laptop's gitignored `backups/`; local only, not encrypted, newest 8; restores by hand (`console/README.md`).
- **The Hangout (30 Oct 2026):** the gym's setter (CLAUDE.md → Data traps). Live LEDs while setting: geofenced on phones, admins too; a cast overrides (Show on board). Comments stay off.

## To-do
The ordered to-do list (next steps, backlog, and what not to build yet) lives in `TODO.md`. Top item = now.

## Waiting on
- **Ross: the gym checklist** (16 Nov: every open test, merged). Tell Claude any number that fails.
  - **Phone, signed in as you:** 1) Tick, favourite, Ranks, a Pat Burner attempt, edit one of your problems; a name differing only in capitals says "already used" (a "permission" error: tell Claude). 2) Scroll the list far, pull to refresh: it stays put; fullscreen stays fullscreen as data lands; Copy link opens that problem. 3) Create (don't save): each tap picks the hold under the finger (viewer, footholds too); circuit create never takes a foothold. 4) Specific feet: a throwaway problem, cast (no sign lit), delete. 5) Start a circuit run, lock the phone; after a deploy, unlock: the run goes on. Airplane mode: the app opens.
  - **Wall touchscreen:** 6) Search and Create's name, typing fast with two fingers: every letter, capitals after a space (don't save). 7) Scroll hard, tap mid-glide: it only stops; quick taps on problems then a circuit: the board shows the last. 8) Create and the filter's hold picker: taps land on the hold touched; text looks as before. 9) Long-press and right-click open nothing. 10) Next deploy: leave it on a problem, mirrored, scrolled, 3+ min: it comes back the same.
  - **At the board:** 11) Circuits: Stop in the countdown; 3 laps (three red blinks); Loop until Stop; a non-looping circuit has no Loop. 12) Live LEDs while setting: Save/Cancel → idle at once; set on the phone while a circuit is tapped on the wall: the phone says it was taken. 13) 15:30: screen on, LEDs idle (Wave); 22:00: fade, screen off, a phone cast does nothing.
  - **As Pablo (phone):** 14) Sign in with the new PIN once (reset 10 Nov). 15) Admin: users, a benchmark on and off, Move to Circuits (a throwaway). 16) Edit holds: point edits (drag, ○, remove, nudge), tap-trace or draw a foothold, a hold +5°: each Publish → Undo at once, no "offline copy is behind" card after; `#outlines` opens Edit holds.
  - **PB Console (laptop):** 17) Start icon, no `#c=`; Backups (17 tables); a busy Restart asks twice; the LED map framed. 18) Holds: arrows nudge, Esc+arrows move the outline, ○ drag, M mirror, Round slider, Discard draft; a point Publish → Undo. 19) Gym closed: Deploy (dry run, then real), Logs after a reboot, Stay on until (30 min ahead at night: on, then off by itself), kill the kiosk's renderer: it recovers. The R8 tests are `TODO.md` 1.
- **Ross:** Edit holds: the footholds beside **G1 and N1** aren't in yet (3 of 5 are).
- **Parked branch `parked/2b-camera-led-mapping`:** camera LED mapping (2b), unfinished, never shipped; only for a full rearrange or another gym (`TODO.md` → Not now). Its db/43 is live and harmless.
- Ross (low priority): delete the local passphrase hand-out file (and empty the Recycle Bin) once all 7 migrated accounts have signed in.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).

## Session log
Newest first, the 3 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-16, Claude Code (review fix session 13: polish and docs; review closed).**
  - **Changed:** font-size scale in `tokens.css` (`--text-*`, ≤1px moves); dead code/CSS gone; `ProjectBoard.png` off the deploy; HSTS `includeSubDomains`; a 404 page; Pi re-reads holds on an unknown hold id (PI-10); idle default `wave`; hook: YAML/JSON passwords; CLAUDE.md, overview §9/§13/§14/§15, contract §5.
  - **Tested:** build, pi/tests 255, hook 44/44; Chrome: phone views, `/?wall`, privacy, before/after sizes.
  - **Live:** `bcf366f`, app `pb-163a5139b1`; Pi deployed 08:43.
  - **Left:** Ross's gym checklist (Waiting on).

- **2026-11-15, Claude Code (review fix session 12: wall performance + TODO 8).**
  - **Changed:** wall keys built once, type on lift (overlapping two-finger typing 0/8 → 8/8 keys); no hidden phone list; a pick redraws only the overlay; the poll renders only changes, never under a finger; one wall send queue, in order; Save follows the connection; no phone text. Updates: every 5 min, applied after 2 min untouched, same problem + scroll.
  - **Tested:** headless Chrome CPU ×6 (key ~350→~200 ms, poll no change ~660→~65 ms); 39 wall + 10 phone checks; update flow; casts stubbed.
  - **Live:** `3bb287c`, app `pb-8a3928ae84`. No Pi change.
  - **Left:** Ross's feel test (Waiting on); next is session 13.

- **2026-11-15, Claude Code (review fix session 11: retire Trace Holds, C3).**
  - **Changed:** `#outlines` → Board Setup → Edit holds; Trace Holds and ~880 lines gone; db/49 drops `admin_set_hold_outlines`, adds a `smooth` edit. Console → Holds: arrow nudge, mid handles, Round slider, mirror-copy (M). One geometry module (`trace.js`), one `hitHold()`. Retired generators archived (BRD-14).
  - **Tested:** db/49 test (rolled back); scorers unchanged; console/tests 179; headless Chrome, publishes stubbed; taps = old pickers on 120,000 taps.
  - **Live:** `e67bdba`, app `pb-6d2a49bf5d`. No Pi change.
  - **Left:** Ross's checks (Waiting on); next is session 12.
