# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The to-do list is in `TODO.md`. Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (`docs/log/2026-10.md`, `docs/log/2026-11.md`).

## Current state (as of 2026-11-04)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). `CACHE` is stamped by `build.sh`: `pb-8fae3d805c` since 2 Nov. Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Sorting and filtering (2 Nov 2026):** Sort (New default / Random / Easy / Hard / Popular, db/38), a Grade range slider and Clear in the list's pill row, phone and wall (§4.2a); the wall's rail only for Easy/Hard, idle resets all. Create "+" filled with `--cast`. Not yet tried on the touchscreen.
- **Deploying:** ship by default; migrations and Pi deploys done by Claude end to end (Decisions). `build.sh` is the Cloudflare build gate; a pre-commit hook scans for secrets. Slash commands `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4 is back on a new SD card (1 Nov 2026)** after the old card died on 31 Oct: it set itself up unattended at its first boot (`pi/firstboot/README.md`; everything the old card held outside the repo is now in `pi/` or the laptop's gitignored `pi/secrets.env`, with a new Tailscale key, rescue-hotspot password and wall key, db/36). Casting from a phone works again. The Pi 4 (Raspberry Pi OS Lite 64-bit, trixie, 2 GB; on the gym Wi-Fi and Tailscale as `projectboard`) runs the listener with self-healing, watchdogs and night mode 23:00–08:00 (`pi/`, `pi/README.md`). The night switch was seen working both ways on 27 Oct. The R8 acceptance tests are still to do. The idle pattern, 15 minutes after the last cast (20 until 2 Nov), is **`wave`** (ten patterns in `pi/listener/patterns/`, switched live with `pb-idle`). Wi-Fi: a random hardware address per join, a `pb-netwatch` watchdog (v2) and a rescue hotspot (`projectboard-rescue`).
- **The wall screen casts on the pick (2 Nov 2026, TODO 8):** a clean tap on a problem lights it, Mirror flips and lights that side, the benchmark slide and a Create save light theirs; no cast button. One cast at a time, the latest tap next; scrolls and drags never cast. **Circuits:** a tap lights all the circuit's holds (`show_circuit`, §8.7); Start circuit runs it. Not yet tried on the touchscreen.
- **Circuits can be cast (Phase 2, 30 Oct 2026)** from phones and the wall screen (its Circuits page): Cast → speed (Slow 5 s / Med 3 s / Fast 2 s) and Loop → a 5 s countdown with beeps, the move count and a big Stop, while the Pi runs Ross's "Pulse and fade" look itself (`pi/listener/circuit.py`). Signed-in runs go to `circuit_logs`. The Play preview is gone. Contract §8. Not yet seen on the real wall.
- **Circuit tracks (1 Nov 2026):** `circuits.led_track` (db/37). A cast starts with a 3 s route trace, then the countdown; in the run a dim ghost of the holds and the move's track in dim pink sit under Pulse and fade. Edited in PB Console. Pat Burner has Ross's track. Contract §8.6. Not yet seen on the wall.
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall` with the wall key in the URL fragment) runs on the 1280×720 touchscreen; it picks up a deploy within the hour, at its next idle. **No picture on the touchscreen (4 Nov 2026; touch works): hardware, confirmed.** Path: screen HDMI → big adapter (VGA to HDMI? unconfirmed) → female-to-male coupler → HDMI to micro-HDMI adapter → Pi. Proposal: one HDMI cable from the screen straight into the micro-HDMI adapter (TODO 3). Not yet tried by hand on the touchscreen.
- **Create on the wall, live LEDs while setting (30 Oct 2026):** the wall's Create saves as The Hangout (db/35, the wall key); taps on Create/Edit light the board (contract §9). Not yet tried on the wall.
- **Hardware:** temporary wiring. The Pi is in the junction box (31 Oct); the rest goes in next. Power enters the strip at six points (5.5 V under load, white at the far end). Two YU0510 5 V 10 A supplies (both needed to start the strip). No relays or level shifter fitted (3.3 V data direct works); the 2-channel relay module and the 74AHCT125 (a bare chip) have arrived. Wiring: `pi/README.md` → "Wiring". A USB webcam streams the back of the board to Tailscale devices only.
- **PB Console** (`console/`, `bash console/start.sh`): health dashboard, services, board controls, logs, config, Pi deploy with a drift check, release (Ship / Staging / Rollback since 29 Oct), LED map, test cast, **circuit tracks** (1 Nov, its first database write: direct Postgres), the Activity dashboard (4 Nov), the R8 checklist, backups, runbook. The Pi-side helper is deployed. Anything that needs a look can be **dismissed** until it changes, and Recent actions cleared (1 Nov). Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **End to end (30 Oct 2026):** Claude finishes the whole job, including applying migrations (`db/apply.py`, dry run first) and Pi deploys (busy check, passwordless). Still gated: deleting user data, force pushes, secrets.
- **Deploy policy (29 Oct 2026):** ship by default to `main` once checks pass; "staging first" = `dev` only, with the staging URL; no rule about keeping `dev` and `main` level. Gated: DB migrations, Pi deploys (busy check), deleting data, force pushes, secrets. Rollback = `git revert` + push, never the Cloudflare dashboard. `CACHE` is stamped by the build from the shipped files' git blob ids (not the commit hash, so docs-only pushes don't make every phone re-download the app). Replaces the 19 Oct "two confirmations" rule.
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

- **2026-11-04, Claude Code (PB Console: the Activity dashboard, TODO 17).**
  - **Changed:** Activity = the approved prototype (`tools/activity-dashboard-prototype.html`, kept as reference) on real data, cross-filtered, with a Log view; old charts gone. The console keeps its own cast history (`console/data/`, gitignored) as the journal expires; nicknames, ticks and accounts live from Postgres. UK time. `console/README.md` → Activity.
  - **Tested:** console tests (13 new); Chrome: filters, toggles, keyboard, no CSP errors, Log agrees, no-`db/.env` view.
  - **Left:** Ross: a look. Cast history starts 1 Nov (the new card).

- **2026-11-04, chat.** Touchscreen shows no picture (touch works): confirmed hardware. Proposal: drop the adapter and coupler, one HDMI cable from the screen into the micro-HDMI adapter. Left: Ross tries it (TODO 3).

- **2026-11-02, Claude Code (wall: the Create tab, the tab order, the dimmed Problems board).**
  - **Found:** the wall-key chain is sound end to end, checked on the Pi without reading the key: the file is there (root:kiosk 0640, 43 chars), its SHA-256 is db/36's, `wall_keys` has 1 live key and it's that one, the kiosk passes it in `#k=`, a `wall_key_ok` call from the Pi with it says true, and a fresh Chromium on the Pi at 1280×720 shows Create. The live screen couldn't be seen; the kiosk was restarted at 14:19. Likeliest cause: a failed first ask at the 08:00 start, retried only after a good problems poll.
  - **Changed:** `wallCheckKey` retries a failed ask every minute on its own; tabs Problems · Circuits · Ranks · Create · Get the app; Problems with nothing chosen is dimmed like Circuits (`wallDimOnlyHtml`). Overview §4.7a.
  - **Tested:** build; Chrome at 1280×720, local: the order, the dim, a chosen problem (nothing sent).
  - **Live:** `824d31b`, CACHE `pb-8fae3d805c`, kiosk at its next idle.
  - **New questions:** the key is readable in the Pi's process list by local accounts (local note).

- **2026-11-02, Claude Code (Create: the finish zone no longer drawn).**
  - **Changed:** the dashed line and label gone from Create, phone and wall (`.finish-zone`, `finishZoneEdge()`, 5 tokens). The top-25% rule is unchanged; no migration. Overview §4.5/§4.8a.
  - **Tested:** build; Chrome, local: phone and wall Create, no marker (nothing sent).
  - **Live:** `61d9ff0`, CACHE `pb-055cbd292e`.
  - **New questions:** the hints still say "finish-zone hold": reword?

- **2026-11-02, Claude Code (the wall's Circuits page: a tap lights the circuit).**
  - **Changed:** Circuits page: board dimmed with nothing chosen; opening it lights nothing; a tap lights every hold (new event `show_circuit`: starts green, last red, rest blue, finish beats start), shown as a problem cast (latest wins, idle after 15 min); "Light it up" → **Start circuit**. PB Console Activity ("holds lit"). Contract §8.7. `CACHE` `pb-538aea9b5d`.
  - **Tested:** build, Pi 153 (1 transient error in 4 runs), console 93; Chrome, broadcast stubbed: open (nothing sent), tap, re-tap, rapid taps (latest only), drag, Start circuit.
  - **Live:** `d109237`; Pi deployed 13:30 (joined, `wave`).
  - **Left:** Ross: the wall checks (session report).
