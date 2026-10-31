# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (October 2026: `docs/log/2026-10.md`).

## Current state (as of 2026-10-31)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). Since 29 Oct its service-worker `CACHE` is stamped by `build.sh` (`pb-` + a hash of the shipped files): `pb-e0bd53c890` live since 30 Oct (no star ratings, Cast beside the title, the feet rule). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Deploying:** ship by default; migrations and Pi deploys done by Claude end to end (Decisions). `build.sh` is the Cloudflare build gate; a pre-commit hook scans for secrets. Slash commands `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4's SD card died on 31 Oct 2026: the board is down** (no casts, no kiosk) until a new card goes in. The new card sets itself up unattended at its first boot (`pi/firstboot/README.md`): everything the old card held outside the repo is now in `pi/` or comes from the laptop's gitignored `pi/secrets.env` (the Wi-Fi, a new Tailscale key, a new rescue-hotspot password, a new wall key, registered by db/36). Normally the Pi 4 (Raspberry Pi OS Lite 64-bit, trixie, 2 GB; on the gym Wi-Fi and Tailscale as `projectboard`) runs the listener with self-healing, watchdogs and night mode 23:00–08:00 (`pi/`, `pi/README.md`). The night switch was seen working both ways on 27 Oct. The R8 acceptance tests are still to do. The idle pattern after 20 minutes is **`wave`** (ten patterns in `pi/listener/patterns/`, switched live with `pb-idle`). Wi-Fi: a random hardware address per join, a `pb-netwatch` watchdog (v2) and a rescue hotspot (`projectboard-rescue`).
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs Ross's "Pulse and fade" look itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. The Play preview is gone. Contract §8. Not yet seen on the real wall.
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen; it picks up a deploy within the hour, at its next idle. Not yet tried by hand on the touchscreen.
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Not yet tried on the wall.
- **Hardware:** temporary wiring, loose on a ledge behind the board. Power enters the strip at six points (5.5 V under load, white at the far end). Two YU0510 5 V 10 A supplies (both needed to start the strip). No relays or level shifter yet (3.3 V data direct works); the 2-channel relay module and the 74AHCT125 are on order; a junction box and wiring parts are bought. Wiring: `pi/README.md` → "Wiring". A USB webcam streams the back of the board to Tailscale devices only.
- **PB Console** (`console/`, `bash console/start.sh`): health dashboard, services, board controls, logs, config, Pi deploy with a drift check, release (Ship / Staging / Rollback since 29 Oct), LED map, test cast, activity, the R8 checklist, backups, runbook. The Pi-side helper is deployed. Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship by default to `main` once checks pass; "staging first" = `dev` only, with the staging URL; no rule about keeping `dev` and `main` level. Gated: DB migrations, Pi deploys (busy check), deleting data, force pushes, secrets. Rollback = `git revert` + push, never the Cloudflare dashboard. `CACHE` is stamped by the build from the shipped files' git blob ids (not the commit hash, so docs-only pushes don't make every phone re-download the app). Replaces the 19 Oct "two confirmations" rule.
- Accounts are nickname + 4-word passphrase, no personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a lost passphrase is reset by an admin (logged). Google sign-in removed. All 7 earlier accounts were migrated (18 Oct). The gym is the data controller.
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
- **Ross: the new SD card** (31 Oct): remove the old `projectboard` from Tailscale, make a one-off auth key into `pi\secrets.env`, write the card with Imager (`pi/firstboot/README.md`), then Claude adds the setup with `make-card.py`; plug in at the gym and wait about 25 minutes. Then: disable key expiry for the new machine in Tailscale, a backup image of the working card, and the wall tests below again on the new card.
- **Ross: try creating a problem on the kiosk and a phone with live LEDs** (live 30 Oct): the wall's Create tab (keyboard, Save, Light it up), a phone's Create and an admin Edit at the gym, a cast while setting (Show on board).
- **Ross: try a circuit cast on the wall before opening** (live 30 Oct), from a phone and from the wall screen's Circuits page: the countdown, the look at each speed, Stop, a loop, the top of a run done once, a match (Pat Burner moves 6/7); whether the amber `(255,110,0)` reads as amber on the strip.
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

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-10-31, Claude Code (the Pi's SD card died: a self-installing replacement card).**
  - **Found:** what the dead card held outside the repo: `pb-netwatch.sh` v2 and its unit (recovered word for word from a 28 Oct session's record), the `pb-rescue` profile, the kiosk's packages, user, PAM file and blank cursor theme (set up by hand on 26 Oct), the Wi-Fi connection, the Tailscale identity, the wall key. Raspberry Pi OS trixie + Imager 2 use cloud-init (`user-data`, `network-config`, `meta-data` on the boot partition), not `firstrun.sh`.
  - **Changed:** `pi/firstboot/` (`firstboot.sh` + `pb-firstboot.service`, started by cloud-init's `runcmd`; `make-card.py` adds them to an Imager-written card and checks it; README with the full list); `setup.sh` (Wi-Fi country, the keyfile and the rescue hotspot first, waits for the internet, the kiosk packages, the wall key; Tailscale failure no longer fatal); `install.sh` installs `pb-netwatch` and the kiosk's pieces and cuts SD writes (journal capped and synced every 15 min, Chromium's cache in RAM, apt timers and swap file off); `pb-netlog` includes wpa_supplicant. db/36 applied: the new wall key's hash, the old key revoked. PB Console's drift map knows the new files.
  - **Tested:** Pi 125 and console 74 tests, the build check, `install.sh --dry-run` in WSL, the new wall key accepted by `wall_key_ok`.
  - **Left:** the card itself (Waiting on).

- **2026-10-30 evening, Claude Code (create on the kiosk, live LEDs while setting: TODO 9).**
  - **Changed:** 169 gym problems' four setter spellings → **The Hangout** (text only, no profile). The wall's **Create** page (on-screen keyboard; saved as The Hangout by `wall_create_problem()` with the Pi's wall key, rate-limited; 5 min untouched asks then discards). **Live LEDs while setting** on phones and the wall (`preview_holds`, contract §9; a cast takes over until Show on board). Busy check counts a preview; `install.sh` refuses unlisted listener files.
  - **Applied/deployed:** db/35 (dry run + 15-case rolled-back test, then live); the Pi at 14:21 (wall key made; the kiosk's new URL applies when it next starts).
  - **Tested:** Pi 125, console 74, build; phone 360/390/412 and `/?wall` headless (broadcasts, RPCs, socket faked); listener dry-run against the live channel.
  - **Left:** Ross tries it (Waiting on).

- **2026-10-30 afternoon, Claude Code (circuits follow-ups, Activity names).**
  - **Changed:** the circuit Play preview removed (code, styles, tokens); the circuits list's inert Exclude Done pill removed (Ross: "done" = done both sides, problems only; circuits later). The wall screen has a Circuits page (list, numbered holds over the board, Light it up → the same Cast sheet; no idle during a run; night closes the sheet). No mirrored circuits (decision). PB Console Activity: circuit runs (how it ended, moves, speed, loop) from a new `circuit ended:` journal line, and members' nicknames from a private `cast_log` (db/34, applied: insert-only, no API reads; Ross chose it over putting names in the public broadcast); `privacy.html` updated; the busy check counts a running circuit.
  - **Found:** Activity's "failed to fetch" was the console server having stopped: Claude's earlier clean-up of a local preview server on port 8765 also ended PB Console, which shares that port. Restart it with `bash console/start.sh`; previews now use another port.
  - **Tested:** Pi 110 tests, console 74, build check; the phone and the wall in a headless browser (broadcasts intercepted); db/34 behaviour checked in a rolled-back run.
  - **Left:** Ross tries circuits on the wall and the kiosk (Waiting on).

- **2026-10-30, Claude Code (circuit LED directions: TODO 7).** Eight LED looks for circuits in `tools/circuit-led-simulator.html`; Ross chose 4, "Pulse and fade"; Circuits Phase 2 went live (Cast sheet, run screen, `cast_circuit`/`stop`, `circuit_logs`, `circuit.py` on the Pi). In full in `docs/log/2026-10.md`.

- **2026-10-30, Claude Code (stars, Cast button, feet rule: TODO 8, 9, 11).**
  - **Changed:** star ratings removed (list, detail, info sheet, wall). Cast moved from the header to the right of the problem's title, deep pink, the board unmoved; long names wrap then ellipse beside it. Feet rule: three options on Create/Edit, a badge on the problem view, a Feet row on the info sheet; the listener lights the sign from `feet_mode`. db/33 applied by Claude through the new local `db/apply.py` (dry run first): 220 any, 26 black, 19 orange, no sign left in a hold list. Contract §6.5 and open question 7 closed; CLAUDE.md data trap added.
  - **Tested:** 360/375/390/412 px phones and `/?wall` locally; Pi tests 92 pass.
  - **Live:** `bf3c993`, `aadc1ba`, `d1c8116`; CACHE `pb-e0bd53c890` seen live.
  - **Later:** passwordless Pi deploys (`pi/conf/pb-deploy.sudoers`, `deploy.sh`, PB Console's Deploy with the password optional) and CLAUDE.md rule 2: Claude applies migrations (`db/apply.py`) and deploys the Pi itself; still gated: deleting user data, force pushes, secrets (`945bb6f`).
  - **Then:** Ross ran the last password deploy (listener joined, feet code live, passwordless sudo on; a passwordless dry run checked). PB Console: no deploy password, Release rows in plain English; `dev` fast-forwarded to `main` (`0501a57`).
  - **Left:** the wall test (Waiting on).
