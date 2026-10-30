# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (October 2026: `docs/log/2026-10.md`).

## Current state (as of 2026-10-30)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). Since 29 Oct its service-worker `CACHE` is stamped by `build.sh` (`pb-` + a hash of the shipped files): `pb-e0bd53c890` live since 30 Oct (no star ratings, Cast beside the title, the feet rule). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Deploying (29 Oct):** ship by default (commit + push `main`); "staging first" pushes `dev` only; migrations, Pi deploys, deleting data, force pushes and secrets stay gated; rollback = `git revert` + push. `build.sh` is the Cloudflare build gate (three-places rule, syntax check). A pre-commit hook scans for secrets. Slash commands `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`. Work locally on `main`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4** (Raspberry Pi OS Lite 64-bit, trixie, 2 GB; on the gym Wi-Fi and Tailscale as `projectboard`) runs the listener with self-healing, watchdogs and night mode 23:00–08:00 (`pi/`, `pi/README.md`). The night switch was seen working both ways on 27 Oct. The R8 acceptance tests are still to do. The idle pattern after 20 minutes is **`wave`** (ten patterns in `pi/listener/patterns/`, switched live with `pb-idle`). Wi-Fi: a random hardware address per join, a `pb-netwatch` watchdog (v2) and a rescue hotspot (`projectboard-rescue`).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall`) runs on the 1280×720 touchscreen; it picks up a deploy within the hour, at its next idle. Not yet tried by hand on the touchscreen.
- **Hardware:** temporary wiring, loose on a ledge behind the board. Power enters the strip at six points (5.5 V under load, white at the far end). Two YU0510 5 V 10 A supplies (both needed to start the strip). No relays or level shifter yet (3.3 V data direct works); the 2-channel relay module and the 74AHCT125 are on order; a junction box and wiring parts are bought. Wiring: `pi/README.md` → "Wiring". A USB webcam streams the back of the board to Tailscale devices only.
- **PB Console** (`console/`, `bash console/start.sh`): health dashboard, services, board controls, logs, config, Pi deploy with a drift check, release (Ship / Staging / Rollback since 29 Oct), LED map, test cast, activity, the R8 checklist, backups, runbook. The Pi-side helper is deployed. Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship by default to `main` once checks pass; "staging first" = `dev` only, with the staging URL; no rule about keeping `dev` and `main` level. Gated: DB migrations, Pi deploys (busy check), deleting data, force pushes, secrets. Rollback = `git revert` + push, never the Cloudflare dashboard. `CACHE` is stamped by the build from the shipped files' git blob ids (not the commit hash, so docs-only pushes don't make every phone re-download the app). Replaces the 19 Oct "two confirmations" rule.
- Accounts are nickname + 4-word passphrase, no personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a lost passphrase is reset by an admin (logged). Google sign-in removed. All 7 earlier accounts were migrated (18 Oct). The gym is the data controller.
- Points only for benchmark climbs (db/27).
- **Feet rule (30 Oct 2026):** every problem is Any feet (default), Orange feet only or Black feet only (`problems.feet_mode`, db/33). Any lights no sign; Orange lights B2 (LED 25), Black lights B1 (LED 26), never mirrored; `hold2`/`hold21` are never in a hold list. Migrated: both signs or none → Any, one sign → that rule. Cast contract §6.5.
- Star ratings from the old system are gone from the app (30 Oct 2026); `problems.stars` / `ticks.stars` stay in the table, unused.
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, phone-timed, score = total seconds held, best attempt per user, earlier wins a tie, opt-in board, compare up to 3; self-reported, admins delete attempts; reps capped at 1200 s; offline saves retried for 14 days; a generic `challenges` table with the protocol as data.
- The Pi side was rewritten from scratch for the Pi 4 and lives in `pi/` (committed).
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- The Supabase MCP server (read-only, this project only) may be used to check live schema and data; results never go into repo files; migrations stay Ross's, in the SQL editor.

## To-do
The ordered to-do list (next steps, backlog, and what not to build yet) lives in `TODO.md`. Top item = now.

## Waiting on
- **Ross: test the feet rule on the wall** (the listener is deployed, 30 Oct): Orange-only lights B2 only, Black-only B1 only, Any neither; the same mirrored (the first mirrored-cast check).
- Ross: the relay module (eBay) and 74AHCT125 level shifter (Amazon) to arrive.
- Ross: an on-site check of the cast geofence centre (a non-admin phone by the board and at the far end of the gym).
- Ross: delete the local passphrase hand-out file in the archive (then empty the Recycle Bin) once all 7 migrated accounts have signed in.
- Ross: what the wall screen does at night (keep it blank, or let the kiosk show the dimmed QR?), and whether 23:00 is always after the gym closes.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
2. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
3. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
4. Is the problem name still the cast key once names become editable?
5. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).
6. Should the wall show circuits too (left out: they can't be cast yet)?

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-10-30, Claude Code (circuit LED directions: TODO 7).**
  - **Changed:** `tools/circuit-led-simulator.html` (not deployed) now holds **8 LED "directions"** for Circuits Phase 2, switched live (click or keys 1–8): Window (today's look), Comet tail, Next move only, Fill-up timer, Get ready / go, Metronome, Progress line, Pulse to the beat. Shared by all: the 5 s red countdown, Slow 5 s / Med 3 s / Fast 2 s, green starts on the first lap only, a double-blink on a match, the green run-up finish. Each direction is a pure function of time, ready to port to the listener. The old "Try other looks" panel is gone.
  - **Then (Ross's feedback):** a match now stays solid (the double-blink looked like a bug). Window's let-go hold flashes red all beat ("catch up"). 4, 6, 7, 8 replaced by Flash to grab, Hurry up, Traffic lights and Red chaser: the hold to go to flashes blue until it's yours, amber is the hold after, red says you're behind.
  - **Left:** **Ross to choose a direction** (no decision yet), ideally after trying the shortlist on the real strip; then the Phase 2 build.

- **2026-10-30, Claude Code (stars, Cast button, feet rule: TODO 8, 9, 11).**
  - **Changed:** star ratings removed (list, detail, info sheet, wall). Cast moved from the header to the right of the problem's title, deep pink, the board unmoved; long names wrap then ellipse beside it. Feet rule: three options on Create/Edit, a badge on the problem view, a Feet row on the info sheet; the listener lights the sign from `feet_mode`. db/33 applied by Claude through the new local `db/apply.py` (dry run first): 220 any, 26 black, 19 orange, no sign left in a hold list. Contract §6.5 and open question 7 closed; CLAUDE.md data trap added.
  - **Tested:** 360/375/390/412 px phones and `/?wall` locally; Pi tests 92 pass.
  - **Live:** `bf3c993`, `aadc1ba`, `d1c8116`; CACHE `pb-e0bd53c890` seen live.
  - **Later:** passwordless Pi deploys (`pi/conf/pb-deploy.sudoers`, `deploy.sh`, PB Console's Deploy with the password optional) and CLAUDE.md rule 2: Claude applies migrations (`db/apply.py`) and deploys the Pi itself; still gated: deleting user data, force pushes, secrets (`945bb6f`).
  - **Then:** Ross ran the last password deploy (listener joined, feet code live, passwordless sudo on; a passwordless dry run checked). PB Console: no deploy password, Release rows in plain English; `dev` fast-forwarded to `main` (`0501a57`).
  - **Left:** the wall test (Waiting on).

- **2026-10-30, chat (one to-do list).**
  - **Changed:** new `TODO.md` at the root: one flat, ordered list (top = now), built from the old Next and Backlog sections, which are gone from this file. "What's on my to-do list?" shows the top 3; Ross adds, removes and reorders by asking. `CLAUDE.md`, `/start` and `/wrap` read and update it. No app change, so the CACHE stays.
  - **Left:** nothing.

- **2026-10-29 evening, Claude Code (the wall screen is black).**
  - **Found:** the Pi side is healthy. `kiosk` is up with no crashes, it's day mode with no screen-off flag, and HDMI-A-2 is connected (EDID: ASUS VT168), 1280×720, DPMS On. A `grim` screenshot taken as the `kiosk` user shows the wall page drawn correctly. So the fault is in the monitor or its power: its standby/power button, the HDMI/power cables, its input source, or the box's relays (BCM 23/24) if they feed the screen.
  - **Odd:** `/sys/class/graphics/fb0/blank` read `4` (powerdown) on a fresh boot, with `consoleblank=0`; it was cleared to `0` with `pb-console-helper screen off` then `screen on`. That doesn't seem to be the cause (Chromium draws either way), but if it keeps coming back, `pb-mode` could clear it before starting the kiosk.
  - **Changed:** nothing in the repo or on the Pi apart from that screen toggle.
  - **Left:** Ross checks behind the board on 30 Oct.

- **2026-10-29, Claude Code (ways of working: ship by default, the build gate, the stamped CACHE).**
  - **Changed:** CLAUDE.md rule 2 (ship by default; staging first on request; gated list; rollback = revert). `build.sh` is the Cloudflare gate (every `app/` file allowlisted, no folders, `ASSETS` ⇄ allowlist, scripts referenced, `node --check` on the scripts in `index.html`'s order and on `sw.js`, the placeholder present) and stamps `CACHE` (`pb-` + SHA-1 of `git ls-tree` over the shipped files; `--check`, `--stamp REF`); `app/sw.js` holds `pb-local`. `.githooks/pre-commit` secret scan + `test-pre-commit.sh`. `.claude/settings.json` and six slash commands. PB Console Release: Ship / Staging / Rollback / Build check through the action table; live checks compare against `build.sh --stamp origin/main`. CLAUDE.md is rules and pointers only; this file rewritten (the old log is in `docs/log/2026-10.md`). Newly committed: `docs/circuits-phase2.md` (from the local notes) and `docs/pi4-listener-kiosk-plan.md`. Three old audit files moved from the repo root to the archive.
  - **Tested:** every build-gate failure in a scratch copy (a duplicate declaration, a syntax error, an unlisted file, an `ASSETS` entry not shipped, a shipped file not precached, a hand-edited CACHE, an unreferenced script, no node); the hook with fake keys (15 cases); console tests 65 pass (58 before), Pi tests 86 pass.
  - **Live:** `93a0acc` pushed to `main` under the new rule (a clean LF clone built the same stamp first); the live `sw.js` showed `pb-878d7f8f21` 3 minutes later, replacing `pb-v119` (one update for every installed client). `dev` stays at `6b34e69` until the next "staging first".
  - **Left:** nothing for this change. Notes: the hook doesn't cover the chat's GitHub commits; deny rules in `.claude/settings.json` are pattern-based, not airtight. Restart PB Console (`bash console/start.sh`) to load the new Release tab.
  - **Later the same day (Ross's asks):** PB Console starts every time: a second launch (the new desktop icon, `console/desktop_shortcut.py`) opens the running console instead of failing on the port, replaces an idle one on older code, and falls through to the next port if 8765 is held by something else (`console/session.py`). Activity now leads with when the board was last used and lists the latest 100 casts (date and time, climb, wall kiosk / phone / console, member / guest). For that, casts carry `source` and `signed_in` (never who; contract §3), shipped in the app (`pb-49c7ccc80d`, live); the listener logs them after its next deploy.
  - **New questions:** the privacy page says nothing about casts being logged; with a member/guest flag (no identity) it stays true, but Ross may want a line about it.


