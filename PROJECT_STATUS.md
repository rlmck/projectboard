# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". Keep this file under 15 KB: the 5 newest session entries live here, older ones in `docs/log/` (October 2026: `docs/log/2026-10.md`).

## Current state (as of 2026-10-29)
- **The app** is live at https://symmetryboard.co.uk with the Pat Burner challenge and the wall-screen mode (`/?wall`). Since 29 Oct its service-worker `CACHE` is stamped by `build.sh` (`pb-` + a hash of the shipped files): `pb-878d7f8f21` live since 29 Oct (was `pb-v119`). Every styling value lives in `app/tokens.css`. Not yet announced to the public: the wiring behind the board is temporary.
- **Deploying (29 Oct):** ship by default (commit + push `main`); "staging first" pushes `dev` only; migrations, Pi deploys, deleting data, force pushes and secrets stay gated; rollback = `git revert` + push. `build.sh` is the Cloudflare build gate (three-places rule, syntax check). A pre-commit hook scans for secrets. Slash commands `/start`, `/ship`, `/staging`, `/rollback`, `/wrap`, `/pi-deploy`. Work locally on `main`.
- **Casting works end to end** (phone → Supabase → Pi 4 → LEDs; about 0.25–0.45 s from cast to LEDs). People use it: 50 casts on the evening of 26 Oct, 114 in the 3 days to 28 Oct. **Every hold's LED is checked on the wall** (28 Oct, `pb-ledmap`); three app labels were shifted and fixed by db/32 (188 real holds). **Mirrored casts are still unchecked.**
- **The Pi 4** (Raspberry Pi OS Lite 64-bit, trixie, 2 GB; on the gym Wi-Fi and Tailscale as `projectboard`) runs the listener with self-healing, watchdogs and night mode 23:00–08:00 (`pi/`, `pi/README.md`). The night switch was seen working both ways on 27 Oct. The R8 acceptance tests are still to do. The idle pattern after 20 minutes is **`wave`** (ten patterns in `pi/listener/patterns/`, switched live with `pb-idle`). Wi-Fi: a random hardware address per join, a `pb-netwatch` watchdog (v2) and a rescue hotspot (`projectboard-rescue`).
- **The wall kiosk** (`kiosk.service`: cage + Chromium on `HDMI-A-2`, opening `/?wall`) runs on the 1280×720 touchscreen; it picks up a deploy within the hour, at its next idle. Not yet tried by hand on the touchscreen.
- **Hardware:** temporary wiring, loose on a ledge behind the board. Power enters the strip at six points (5.5 V under load, white at the far end). Two YU0510 5 V 10 A supplies (both needed to start the strip). No relays or level shifter yet (3.3 V data direct works); the 2-channel relay module and the 74AHCT125 are on order; a junction box and wiring parts are bought. Wiring: `pi/README.md` → "Wiring". A USB webcam streams the back of the board to Tailscale devices only.
- **PB Console** (`console/`, `bash console/start.sh`): health dashboard, services, board controls, logs, config, Pi deploy with a drift check, release (Ship / Staging / Rollback since 29 Oct), LED map, test cast, activity, the R8 checklist, backups, runbook. The Pi-side helper is deployed. Phase 13 (Data) isn't built; phase 14 (Power) waits for the relays.

## Decisions
- **Deploy policy (29 Oct 2026):** ship by default to `main` once checks pass; "staging first" = `dev` only, with the staging URL; no rule about keeping `dev` and `main` level. Gated: DB migrations, Pi deploys (busy check), deleting data, force pushes, secrets. Rollback = `git revert` + push, never the Cloudflare dashboard. `CACHE` is stamped by the build from the shipped files' git blob ids (not the commit hash, so docs-only pushes don't make every phone re-download the app). Replaces the 19 Oct "two confirmations" rule.
- Accounts are nickname + 4-word passphrase, no personal data, under-18s welcome, Ranks opt-in (`profiles.is_public`); a lost passphrase is reset by an admin (logged). Google sign-in removed. All 7 earlier accounts were migrated (18 Oct). The gym is the data controller.
- Points only for benchmark climbs (db/27).
- **Pat Burner challenge** (19 Oct): 3 sets × 3 reps to failure, phone-timed, score = total seconds held, best attempt per user, earlier wins a tie, opt-in board, compare up to 3; self-reported, admins delete attempts; reps capped at 1200 s; offline saves retried for 14 days; a generic `challenges` table with the protocol as data.
- The Pi side was rewritten from scratch for the Pi 4 and lives in `pi/` (committed).
- PB Console's Data phase (13) writes through direct Postgres with `db/.env`, never the service key in the console (28 Oct).
- The Supabase MCP server (read-only, this project only) may be used to check live schema and data; results never go into repo files; migrations stay Ross's, in the SQL editor.

## Next (in priority order)
1. **Check mirrored casts on the wall** (PB Console → Test cast, mirrored, against the webcam and the mirror pairs).
2. **The R8 acceptance tests** (PB Console → Tests; `docs/pi4-listener-kiosk-plan.md` R8): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across 23:00/08:00, boot with no network (on-site), the weekly-reboot skip.
3. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute idle, a first real cast from the wall.
4. **Pull the Pi-only files into `pi/`** (PB Console → Deploy): `pb-netwatch.sh` v2 and its unit, the `pb-rescue` profile (secrets stripped), the newer `pb-netlog` unit; then add their `install.sh` lines. Look at the kernel errors seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
5. **Hardware:** tidy and box the wiring; when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and the console's Power phase. `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.
6. **PB Console phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).
7. **Circuits Phase 2:** the cast screen, `cast_circuit`/`stop` broadcasts, `circuit_logs`, the Pi listener update (`docs/circuits-phase2.md`).
8. **Problem name/setter editing** (changes the cast key: contract open questions).
9. Known bugs to triage: `docs/codebase-overview.md` §13.

## Waiting on
- Ross: the relay module (eBay) and 74AHCT125 level shifter (Amazon) to arrive.
- Ross: an on-site check of the cast geofence centre (a non-admin phone by the board and at the far end of the gym).
- Ross: delete the local passphrase hand-out file in the archive (then empty the Recycle Bin) once all 7 migrated accounts have signed in.
- Ross: what the wall screen does at night (keep it blank, or let the kiosk show the dimmed QR?), and whether 23:00 is always after the gym closes.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. Feet indicators (B1/B2, `hold2`/`hold21`, LEDs 26/25): light them as listed in the problem (as Gareth's code did, and as now), or drive them from `feet_mode`? What do both on mean?
2. How does the board get cleared or switched off? There's no clear/stop event (idle and night cover it today).
3. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it, including at night.
4. Stale, duplicate or rapid casts: the listener shows the latest; is a rate limit wanted? (Casts carry no id or timestamp.)
5. Is the problem name still the cast key once names become editable?
6. Hardware: what each relay will switch; final cast brightness (the stopgap used 0.5).
7. Should the wall show circuits too (left out: they can't be cast yet)?

## Backlog
- Wall screen, faster updates (parked 27 Oct): check every 5 min instead of hourly and apply a waiting update after ~2 min untouched, keeping the chosen problem and scroll position.
- A heartbeat from the Pi to Supabase so the app can show "board online".
- More challenges (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
- Admins adding climbs to benchmarks exists per problem (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.
- A mock listener on the laptop that turns a cast into LED indices (lower priority now the webcam shows the real board).
- Don't build yet: the feet indicators, Circuits Phase 3 (PBs, leaderboards), tags, session/logbook tracking beyond ticks, the Flutter migration.

## Session log
Newest first, the 5 newest only (older: `docs/log/`). Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-10-29, Claude Code (ways of working: ship by default, the build gate, the stamped CACHE).**
  - **Changed:** CLAUDE.md rule 2 (ship by default; staging first on request; gated list; rollback = revert). `build.sh` is the Cloudflare gate (every `app/` file allowlisted, no folders, `ASSETS` ⇄ allowlist, scripts referenced, `node --check` on the scripts in `index.html`'s order and on `sw.js`, the placeholder present) and stamps `CACHE` (`pb-` + SHA-1 of `git ls-tree` over the shipped files; `--check`, `--stamp REF`); `app/sw.js` holds `pb-local`. `.githooks/pre-commit` secret scan + `test-pre-commit.sh`. `.claude/settings.json` and six slash commands. PB Console Release: Ship / Staging / Rollback / Build check through the action table; live checks compare against `build.sh --stamp origin/main`. CLAUDE.md is rules and pointers only; this file rewritten (the old log is in `docs/log/2026-10.md`). Newly committed: `docs/circuits-phase2.md` (from the local notes) and `docs/pi4-listener-kiosk-plan.md`. Three old audit files moved from the repo root to the archive.
  - **Tested:** every build-gate failure in a scratch copy (a duplicate declaration, a syntax error, an unlisted file, an `ASSETS` entry not shipped, a shipped file not precached, a hand-edited CACHE, an unreferenced script, no node); the hook with fake keys (15 cases); console tests 65 pass (58 before), Pi tests 86 pass.
  - **Live:** `93a0acc` pushed to `main` under the new rule (a clean LF clone built the same stamp first); the live `sw.js` showed `pb-878d7f8f21` 3 minutes later, replacing `pb-v119` (one update for every installed client). `dev` stays at `6b34e69` until the next "staging first".
  - **Left:** nothing for this change. Notes: the hook doesn't cover the chat's GitHub commits; deny rules in `.claude/settings.json` are pattern-based, not airtight. Restart PB Console (`bash console/start.sh`) to load the new Release tab.
  - **New questions:** none.

- **2026-10-28 late evening, Claude Code (PB Console look and feel).** The overview became a tiled dashboard with a grouped sidebar and a Ctrl+K palette (`console/static/dash.js`, `tiles.metrics()`); the webcam stops when the overview is hidden. Noticed: about 3,460 journal errors in 24 h (nearly all kernel) and 19 self-healing actions around 15:20 (network down, no IPv4). Decided: phase 13 writes through direct Postgres. Full entry: `docs/log/2026-10.md`.

- **2026-10-28 evening, Claude Code (PB Console, phases 5–12, 14, 15).** Built Config, Deploy (`deploy.sh --sudo-stdin`, the drift check, pulling Pi-only files with secrets stripped), Release, LED map, Test cast, Activity, Tests (R8), Backups, Power (disabled), Runbook; new helper verbs, each refusing anything off its list. Found the night of 27 Oct switched correctly both ways. Full entry: `docs/log/2026-10.md`.

- **2026-10-28, Claude Code (PB Console, phases 1–4).** The console's foundation: a stdlib backend on 127.0.0.1 with a per-launch token and Host/Origin/Sec-Fetch-Site checks, confirms, the 5-minute busy check, one action at a time, an audit log; the overview, services, board controls and logs. On the Pi: `pb-console-helper` with its own sudoers rule (deployed and checked), `pb-idle off` and `brightness`, pb-mode's screen-off flag. Full entry: `docs/log/2026-10.md`.

- **2026-10-28, Claude Code (LED mapping tool).** Built `pb-ledmap` (`pi/ledmap/`, Tailscale only, `Conflicts=pb-listener`). Ross mapped every hold: 186 of 189 right; the three wrong were app labels (K9, N13, I12), fixed by db/32 (188 real holds), `pb-v119`, rechecked on the wall. Left: mirrored casts on the wall; the B1/B2 decision. Full entry: `docs/log/2026-10.md`.
