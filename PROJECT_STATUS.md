# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (October 2026: `docs/log/2026-10.md`).

## Current state (as of 2026-11-02)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). Since 29 Oct its service-worker `CACHE` is stamped by `build.sh` (`pb-` + a hash of the shipped files): `pb-e0bd53c890` live since 30 Oct (no star ratings, Cast beside the title, the feet rule). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (2 Nov 2026):** Sort (New default / Random / Easy / Hard), a Grade range slider and Clear in the list's pill row, phone and wall (§4.2a); the wall's rail only for Easy/Hard, idle resets all. Create "+" filled with `--cast`. Not yet tried on the touchscreen.
- **Deploying:** ship by default; migrations and Pi deploys done by Claude end to end (Decisions). `build.sh` is the Cloudflare build gate; a pre-commit hook scans for secrets. Slash commands `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4 is back on a new SD card (1 Nov 2026)** after the old card died on 31 Oct: it set itself up unattended at its first boot (`pi/firstboot/README.md`; everything the old card held outside the repo is now in `pi/` or the laptop's gitignored `pi/secrets.env`, with a new Tailscale key, rescue-hotspot password and wall key, db/36). Casting from a phone works again. The Pi 4 (Raspberry Pi OS Lite 64-bit, trixie, 2 GB; on the gym Wi-Fi and Tailscale as `projectboard`) runs the listener with self-healing, watchdogs and night mode 23:00–08:00 (`pi/`, `pi/README.md`). The night switch was seen working both ways on 27 Oct. The R8 acceptance tests are still to do. The idle pattern after 20 minutes is **`wave`** (ten patterns in `pi/listener/patterns/`, switched live with `pb-idle`). Wi-Fi: a random hardware address per join, a `pb-netwatch` watchdog (v2) and a rescue hotspot (`projectboard-rescue`).
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs Ross's "Pulse and fade" look itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. The Play preview is gone. Contract §8. Not yet seen on the real wall.
- **Circuit tracks (1 Nov 2026):** `circuits.led_track` (db/37). A cast starts with a 3 s route trace, then the countdown; in the run a dim ghost of the holds and the move's track in dim pink sit under Pulse and fade. Edited in PB Console. Pat Burner has Ross's track. Contract §8.6. Not yet seen on the wall.
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen; it picks up a deploy within the hour, at its next idle. Not yet tried by hand on the touchscreen.
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Not yet tried on the wall.
- **Hardware:** temporary wiring, loose on a ledge behind the board. Power enters the strip at six points (5.5 V under load, white at the far end). Two YU0510 5 V 10 A supplies (both needed to start the strip). No relays or level shifter yet (3.3 V data direct works); the 2-channel relay module and the 74AHCT125 are on order; a junction box and wiring parts are bought. Wiring: `pi/README.md` → "Wiring". A USB webcam streams the back of the board to Tailscale devices only.
- **PB Console** (`console/`, `bash console/start.sh`): health dashboard, services, board controls, logs, config, Pi deploy with a drift check, release (Ship / Staging / Rollback since 29 Oct), LED map, test cast, **circuit tracks** (1 Nov, its first database write: direct Postgres), activity, the R8 checklist, backups, runbook. The Pi-side helper is deployed. Anything that needs a look can be **dismissed** until it changes, and Recent actions cleared (1 Nov). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

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
- **Ross, for the new card** (in and working since 1 Nov): Tailscale → disable key expiry for the new `projectboard`; a backup image of the working card; the wall tests below again on the new card.
- **Ross: try creating a problem on the kiosk and a phone with live LEDs** (live 30 Oct): the wall's Create tab (keyboard, Save, Light it up), a phone's Create and an admin Edit at the gym, a cast while setting (Show on board).
- **Ross: cast Pat Burner on the wall** (live 1 Nov): the trace, the ghost and the pink track; whether the dim levels (0.12, 0.2) read on the strip.
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
6. Sorting: add **Popular** (needs a `problem_tick_counts()` RPC, a schema change)? And keep the phone's grade tabs now the Grade range exists, or drop them?

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-11-02, Claude Code (sorting and filtering: TODO 10).**
  - **Found:** the list was always sorted by grade then name; the wall's list was the same `visibleProblems()` with a ★ for benchmarks. Ticks are own-rows-only (RLS) and there's no count RPC, so **Popular** wasn't built (it needs a new SECURITY DEFINER function: Open question 6).
  - **Changed:** Sort / Grade / Clear pills, phone and wall, shared sheets (`problems.js`, `state.js`); Clear pinned right, the row scrolls. Default order **New** (was easiest first). Wall: pills replace the ★; rail and grade headers only for Easy/Hard; idle resets. Create "+" and the wall's Create tab filled `--cast`. Overview §4.2a, §4.7a.
  - **Tested:** build, console 91, Pi 141; in Chrome on live data: each sort, the slider (drag, label tap), Clear, the wall's idle reset; 360/390/412 and 1280×720.
  - **Left:** try the slider and pills on the touchscreen with a finger.

- **2026-11-01, Claude Code (circuit tracks, end to end).** db/37 (`circuits.led_track`, written only over direct Postgres) applied and behaviour-tested; Pat Burner seeded (11 moves). Listener: `trace_s`, the route trace, ghost and track under Pulse and fade, 3 config keys, stale moves skipped; deployed 10:55 (it read Pat Burner's track cleanly). Simulator in step. App: `trace_s: 3`, "Watch the route", countdown 3 s later. PB Console: Circuit tracks tab. Contract §8.6, console-plan phase 16. Tested: Pi 141, console 91, build; the tab in Chrome on live data (nothing saved); the run screen locally. **Left:** see it on the wall; restart PB Console.

- **2026-11-01, Claude Code (the Pi back on the new card; PB Console's Dismiss).**
  - **Found:** PB Console's `pb-idle now` failed with "Host key verification failed": the new card has a new SSH host key, the old one had been removed from the laptop's `known_hosts`, and the one-time accept step (`pi/firstboot/README.md`) hadn't been run; the console's ssh runs in batch mode, so it can't ask. Ran it (`StrictHostKeyChecking=accept-new`); the console reaches the Pi again.
  - **Changed:** PB Console: an x beside each "needs a look" chip on the Overview (and Dismiss all, Dismiss in the drawer, the Ctrl+K palette) hides it until it changes: each tile carries a `sig` (`tiles.py`: the level and value; for journal errors the newest error's time, for self-healing the last action), so a new error or a worse level brings it back. "N dismissed · show again" undoes it. Recent actions has **Clear** (the Audit section keeps everything). Both kept in the browser's localStorage.
  - **Tested:** console 75 tests (one new: the `sig`), a second console on another port in Chrome: dismiss, a refresh keeps it, show again, Clear.
  - **Left:** restart PB Console once to pick up `tiles.py`.

- **2026-10-31, Claude Code (the Pi's SD card died: a self-installing replacement card).**
  - **Found:** what the dead card held outside the repo: `pb-netwatch.sh` v2 and its unit (recovered word for word from a 28 Oct session's record), the `pb-rescue` profile, the kiosk's packages, user, PAM file and blank cursor theme (set up by hand on 26 Oct), the Wi-Fi connection, the Tailscale identity, the wall key. Raspberry Pi OS trixie + Imager 2 use cloud-init (`user-data`, `network-config`, `meta-data` on the boot partition), not `firstrun.sh`.
  - **Changed:** `pi/firstboot/` (`firstboot.sh` + `pb-firstboot.service`, started by cloud-init's `runcmd`; `make-card.py` adds them to an Imager-written card and checks it; README with the full list); `setup.sh` (Wi-Fi country, the keyfile and the rescue hotspot first, waits for the internet, the kiosk packages, the wall key; Tailscale failure no longer fatal); `install.sh` installs `pb-netwatch` and the kiosk's pieces and cuts SD writes (journal capped and synced every 15 min, Chromium's cache in RAM, apt timers and swap file off); `pb-netlog` includes wpa_supplicant. db/36 applied: the new wall key's hash, the old key revoked. PB Console's drift map knows the new files.
  - **Tested:** Pi 125 and console 74 tests, the build check, `install.sh --dry-run` in WSL, the new wall key accepted by `wall_key_ok`.
  - **Then:** the card was written with Imager (which filled in the Wi-Fi after all, and an apt step that would run before any network: `make-card.py` now strips both) and made with `make-card.py`: every check passed; the wall key was then deleted from the laptop.
  - **Left:** the first boot at the gym (Waiting on).
