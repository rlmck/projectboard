# PB Console: the plan

PB Console (`console/`, see `console/README.md`) is a local admin console for the Project Board, run on Ross's laptop with `bash console/start.sh`. It's for running, tuning, fixing and shipping without opening a Claude Code session; new features are still written in Claude Code. Phases 1–4 and the foundation were built on 28 Oct 2026, and **phases 5–12, 14 and 15 later the same day** (Ross asked to carry on). Each phase below says what was built and where it differs from the plan. **Phase 13 (Data) is not built yet**: Ross chose its write path (direct Postgres, 28 Oct 2026). Phases 5, 6 (NetworkManager pull, root hashes), 8, 11 and 12 need the new `pb-console-helper` on the Pi: one deploy. The repo is public: nothing secret or personal goes in this file.

## What every phase builds on (the foundation, done)

- **Backend:** `console/server.py`, Python standard library only, `127.0.0.1` only. Routes: GET for reading, POST (JSON) for anything that changes something. Long output streams as text lines ending with `@@result {json}` (`@@ping` lines are keepalives so a closed tab kills the remote command).
- **Security (`console/security.py`):** a random token per launch (from `start.sh`, in the URL's `#t=`), required on every `/api/` request as `X-PB-Token`; Host must be `127.0.0.1:<port>` or `localhost:<port>`; Origin, when present, the console's own, and required on POST; Sec-Fetch-Site on `/api/` `same-origin` or `none`; strict CSP; no CORS; the port can't be shared. **Every new route goes through it unchanged**; add tests for any new route to `console/tests/`.
- **Actions (`console/actions.py`):** the page sends only an action name and arguments. Each action is built from a fixed table that checks every argument against a list or pattern. Flags: `confirm` (restarts, reboots, deploys, commits, pushes, writes), `busy` (the 5-minute cast check before a restart, reboot or deploy), `config` (writes `config.env`: both copies kept in step). One action at a time (a lock). Every action, including refusals, goes to `console/audit.log` (gitignored).
- **Root on the Pi:** only `/usr/local/sbin/pb-console-helper` (`pi/ops/`), through `/etc/sudoers.d/pb-console`, no password. A new privileged command is a new verb in the helper with its own checks, and a laptop test that it refuses bad input. **Never** widen the sudoers rule, and never add a verb that runs something `pi` can write (that would be root for `pi`). Deploys keep the password.
- **The Pi probe (`console/probe.py`):** read-only, sent over ssh and run as `pi` (in `adm`, so it reads the journal). Extend it rather than adding ssh calls per tile.
- **The page:** `console/static/`, one page with tabs, colours from `app/tokens.css`. No inline scripts or `on*=` handlers (the CSP blocks them).
- **Two copies of config.env:** the laptop's `pi/config.env` (gitignored) is what `deploy.sh` installs. Anything that writes the Pi's copy must leave the laptop's identical, or the next deploy reverts it. The console refuses a config write when they already differ and shows the diff.

## Phase 5: Config

**Built 28 Oct 2026** as below. The key checks live once, in the helper (`KEYS`); the console loads the helper file to use the same checks in its form. "Make the laptop match" is `config-pull` (a local write); "make the Pi match" is the helper's `config-put` with the laptop's file on stdin.

Edit the Pi's `config.env` in a form.

- **Read:** the probe already returns `config_env`. Parse it with the same rules as `pi/listener/mode.py` `load_config` (KEY=value, # comments, quotes stripped).
- **Form:** one field per known key (`mode.py` `DEFAULTS` is the list), grouped as in `config.env.example`, with validation: numbers and ranges (`BRIGHTNESS` 0–1, `IDLE_BRIGHTNESS` 0–1, `IDLE_MAX_AMPS` 0.5–5, `IDLE_FPS` 5–60, `IDLE_AFTER_S` ≥ 60, `IDLE_CYCLE_MIN` 0.25–1440, `POWER_BUDGET_MA`, `STRIP_PIXELS` 248–1200), names (`IDLE_PATTERN` one of the patterns or `cycle`; `IDLE_CYCLE` a list of them), `HH:MM` for the night, `on/off`, `day/night/empty`. Unknown keys are shown read-only and kept.
- **Apply:** a new helper verb `config-set KEY=VALUE ...` that takes only known keys and checked values (extend `set_keys`; it already keeps comments and order and backs up), then restarts only what needs it: the listener for LED and idle keys; nothing for the night keys (re-read every 30 s; pb-mode each minute); nothing for `WIFI_*` (pb-health reads them each run). Show the diff first (confirm), and the busy check if the listener restarts.
- **Keep the laptop copy in step:** as night mode does: refuse if they differ, copy the Pi's file back after.
- **Roll back:** the helper's `backups` verb lists `/var/lib/projectboard/config-backups/` (30 kept). Add `config-restore <name>` (the name must be one it lists; it backs up the current file first), then the same restart rules. Show a diff against the current file before confirming.
- **Drift fix:** when the copies differ, offer "make the laptop match the Pi" (writes `pi/config.env`, no Pi change) or "make the Pi match the laptop" (a `config-restore`-like verb taking the content, checked key by key).

## Phase 6: Pi deploy

**Since 30 Oct 2026 no password:** the Pi's `pb-deploy` sudoers rule lets `deploy.sh` install unattended; the password field and `--sudo-stdin` were removed. **Built 28 Oct 2026.** `deploy.sh --sudo-stdin` reads one line (the password) into a shell variable and pipes it to `sudo -S` on the Pi; its other ssh calls use `-n` so they can't eat it. Pulled files land in `pi/ops/`, `pi/systemd/` or `pi/conf/`; their `install.sh` lines are still added by hand, in a session, and reviewed.

- **Run `pi/deploy.sh` with streamed output.** It ends in `ssh -t … sudo bash ~/pb-deploy/install.sh`; for the console, add a `--sudo-stdin` mode to `deploy.sh` (or have the console run the same scp steps itself) that runs `sudo -S -p '' bash …` and writes the password the user typed into the page to its stdin. The password is never stored, logged or put on a command line; the field clears after use. Add `--dry-run` as its own button (it needs the password too, since install.sh runs as root).
- Confirm, busy check, the lock, the audit (without the password). A deploy restarts the listener when listener files changed: say so in the confirm (from a dry run).
- **Drift check:** a new probe mode that returns sha256 of every installed file `install.sh` places (its `put` list: `/opt/projectboard/…`, `/usr/local/bin/pb-*`, `/usr/local/sbin/pb-console-helper`, `/etc/systemd/system/<units>`, the conf drop-ins, `/etc/sudoers.d/pb-console` (root-only: the helper gets a `hashes` verb for root-readable files)). Compare with the repo's files and list: same, differs, missing on the Pi.
- **Files on the Pi that aren't in the repo:** list `pb-*` units, `/usr/local/sbin/*`, `/etc/NetworkManager/system-connections/*` names (not contents), and anything under `/opt/projectboard` not in the repo. Known today: `pb-netwatch.sh` (v2) and its unit, the `pb-rescue` NetworkManager profile.
- **Pull into `pi/`:** a button per file copies it into the repo (`pi/ops/`, `pi/systemd/`, `pi/conf/`). For a NetworkManager profile, the helper reads it and **strips `psk=`, `password`, `secret`, `private-key` lines before it leaves the Pi**; the laptop checks again for them and refuses to write a file that still has one. Never pull a Wi-Fi keyfile or `secrets.env`. Then `install.sh` gains the matching `put` lines (in the same session, reviewed by Ross).

## Phase 7: App release

**Built 28 Oct 2026; reworked 29 Oct 2026** for the ship-by-default rule (CLAUDE.md working rule 2): the separate commit, push-dev, fast-forward-main and CACHE-bump steps became **Ship** (commit the ticked files + push `main`, one confirm), **Staging** (push `HEAD` to `dev`, fast-forward only) and **Rollback** (revert one of `main`'s last 15 commits + push), all through the action table, the audit and the lock. Each runs `bash build.sh --check` first: the syntax check and the three-places rule now live in `build.sh` (the Cloudflare build gate), not in the console. CACHE is stamped by the build; the console asks `bash build.sh --stamp <ref>` what live should show. New (untracked) files start unticked, so nothing unrelated gets committed by default. Console commits carry no attribution lines. The bullets below are the original 28 Oct plan.

- **Status:** `git status`, the branch, ahead/behind `origin/dev` and `origin/main`, `git pull --ff-only` (and `git pull --ff-only origin main` on `dev`, as CLAUDE.md asks).
- **Diff:** `git diff` and `git diff --stat` for what would be committed; staged and unstaged shown apart.
- **CACHE check:** if any file in `app/` changed but `const CACHE` in `app/sw.js` didn't, warn and offer to bump it (`pb-vN` → `pb-vN+1`). Also check the three-places rule for a new file in `app/` (`build.sh` allowlist, `sw.js` ASSETS, referenced from `index.html`), and run CLAUDE.md's syntax check (concatenate the eleven scripts, `node --check`) if `node` is on the PATH.
- **Commit:** a message box; the commit shows the full diff first (confirm). Stage only the files listed in the diff the user saw (never `git add -A` of unrelated files). End the message with the attribution lines CLAUDE.md's rules ask for, if any.
- **Push to dev:** a separate button, showing `git log origin/dev..dev` first (confirm). Then a link to staging.
- **Fast-forward main:** separate again, showing `git log origin/main..dev` (confirm, "this deploys to real users"); `git push origin dev:main` only if it's a fast-forward.
- **Poll the live `sw.js`** every 15 s for up to 10 minutes until `CACHE` shows the new version, then show it on the Live site tile.
- The console never commits or pushes on its own: two separate confirms, as CLAUDE.md's working rule 2 says.

## Phase 8: LED mapping

**Built 28 Oct 2026**: start/stop through the helper, the page in an iframe (the console's CSP allows `frame-src http://projectboard:8081`), results kept by adding the exported file on the tab.

- Start and stop `pb-ledmap` through new helper verbs (`ledmap start|stop`, i.e. `systemctl start|stop pb-ledmap`), with the busy check and a confirm (it pauses the listener; the board shows the mapping tool's LEDs until it ends). `Conflicts=` keeps it and the listener apart; the console adds nothing around that.
- Embed `http://projectboard:8081/` in an iframe beside the webcam (add `frame-src http://projectboard:8081` to the console's CSP; the mapping page itself must allow being framed by `http://127.0.0.1:<port>`: today it sends no frame headers, check that). Or open it in a new tab if framing is a problem.
- **Results history:** the page's Export JSON goes to the browser. Add an "export to the console" button on the mapping page? Simpler: a POST to the console with the exported JSON, saved in `console/data/ledmap/<date>.json` (gitignored), and a list with OK / wrong / unchecked counts per run.

## Phase 9: Test cast

**Built 28 Oct 2026.** The endpoint is what the vendored supabase-js `httpSend` posts to: `POST /realtime/v1/api/broadcast/board%3AHangoutPortland/events/cast_problem`, the payload as the body, 202 on success. No change to the contract.

- Send `cast_problem` on `board:HangoutPortland` from the laptop: an HTTPS POST to Realtime's broadcast endpoint (`/realtime/v1/api/broadcast`, the anon key, `{"messages":[{"topic":"board:HangoutPortland","event":"cast_problem","payload":{"problem_name":…,"mirror":true?}}]}`), exactly the contract's payload (`docs/cast-contract.md` §3; never `mirror: false`). Check what `httpSend` posts in the vendored supabase-js first and copy it. **A real cast lights the real board**: confirm, and note the time (night mode ignores it).
- **The problem picker:** names from `problems` (anon read), with a search.
- **Receipt and latency:** note the send time; then read the listener's journal for `cast received: '<name>'` and `lit '<name>' … in N ms` after it (`journalctl -u pb-listener --since @<epoch>`, the Pi's clock is NTP-synced). Show send → received → lit. With the webcam beside it.
- **Mirrored casts** (still unchecked on the wall): the same with `mirror: true`, and a list of each hold with its mirror partner from the live `board_config.mirror_map`, to compare with the webcam.
- No change to the channel, event or payload; if one is ever needed, `docs/cast-contract.md` changes in the same commit.

## Phase 10: Activity

**Built 28 Oct 2026, Pi side only** (casts per day and hour, mirrored, ignored at night, top problems). The Supabase counts wait for phase 13's admin path.

- **From the Pi's journal** (the persistent journal holds weeks; 200 MB cap): `cast received` lines → casts per day and per hour of day, mirrored share, casts ignored at night, the top problems by name (problem names aren't personal).
- **From Supabase:** ticks per day and distinct users per day, as **counts only** (no nicknames, no ids). With the anon key the `leaderboard()` RPC is public; ticks are own-row only under RLS, so counts need either an admin path (see phase 13: direct Postgres with `db/.env`, read-only) or a new aggregate RPC (a schema change: Ross's call, CLAUDE.md rule 6).
- Cache the results in `console/data/` (gitignored). Charts as inline SVG (no libraries; the CSP allows nothing else).
- **Never write any of it into the repo.**

## Phase 11: Acceptance tests (plan R8)

**Built 28 Oct 2026**: the helper's `test` verbs below, the checklist, and the night check. Not yet run on the board.

A guided checklist for R8 of the local plan (`docs/pi4-listener-kiosk-plan.md`): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, 23:00/08:00, boot with no network, and the weekly-reboot skip.

- Each test: what it does, what to expect, a button per step, and pass/fail with a note, saved in `console/data/acceptance.json` (gitignored).
- **Steps need new helper verbs**, each narrow: `test kill-listener` (`systemctl kill -s KILL pb-listener`), `test freeze-listener` (`kill -STOP` the listener's MainPID, read from systemd, never a PID from the page), `test wifi-drop` (`systemd-run --on-active=5 nmcli connection down hangout-fixed` with the undo scheduled the same way), `test block-supabase` (an nft table with the project host's addresses, its removal scheduled after 12 minutes), `test clock 22:59:30|07:59:30|ntp` (`timedatectl set-ntp false; date -s …`, and back), `test weekly-reboot`. Each one that cuts the network is started detached and schedules its own undo first. Confirm on every step; busy check on every step.
- The page then watches: polls the overview and tails the relevant journal lines, and shows what was expected beside what happened.
- **"Check last night":** read `pb-mode` and `pb-listener` lines around 23:00 and 08:00 (mode switches, kiosk stopped and started, screen off/on, strip cleared, casts ignored) and say whether each happened, and when.
- Boot with no network is on-site only: the checklist says so and only records the result.

## Phase 12: Backups

**Built 28 Oct 2026** (the helper's `backup` verb, and the anon export of the four public tables).

- **Pi config:** one button pulls `/etc/projectboard/config.env` and its backups, the units in `/etc/systemd/system/pb-*`, `kiosk.service` and its drop-ins, the conf drop-ins, `/usr/local/sbin/*`, and the NetworkManager profiles **with secrets stripped on the Pi** (the same stripping as phase 6), into `backups/<date>/pi/` at the repo root (gitignored). Root-only files come through a helper verb (`backup-tar`), which writes a tarball to stdout with the secrets stripped.
- **Supabase:** a local export of `problems`, `circuits`, `board_config` (hold map, mirror map, outlines), `challenges` as JSON into `backups/<date>/supabase/`. Public tables with the anon key; anything else only through the admin path in phase 13. No `profiles`, ticks or attempts unless Ross asks (personal data, and the repo is public: the folder is gitignored, but keep it to what's needed).
- A list of backups with sizes and dates.

## Phase 13: Data

**Not built yet. Write path chosen by Ross, 28 Oct 2026: option 1, direct Postgres through `db/.env`.**

Admin edits to the board data with a preview and an undo record.

**How it's stored (checked 28 Oct 2026):**
- `board_config`: one row, `wall = 'HangoutPortland'`: `hold_map` (hold id → position on the photo, 188 real holds since db/32), `mirror_map` (hold id → partner, a lookup table, not grid arithmetic: the board is staggered), `hold_shapes` (traced outlines, with `__meta.board_updated_at` and `__meta.smooth`), `image_path`, `updated_at`. Public read, admin write (RLS).
- **`updated_at` is the board version the outlines are pinned to**: `shapesUsable()` falls back to dots unless it matches `hold_shapes.__meta.board_updated_at`. db/32 relabelled holds by moving entries in `hold_map`, `hold_shapes` and `mirror_map` together, **without touching `updated_at`**, and moved the hold ids of app-made problems with them. Any hold-label edit must do the same: one transaction, all three maps, the same problems, `updated_at` untouched, then `tools/snapshot_board.py` and Ship (phase 7; the build re-stamps `CACHE`), and `bash pi/deploy.sh` so pb-ledmap's copy matches.
- Problem holds are stored inverted (CLAUDE.md "Data traps"); a label move rewrites ids in `start_holds`, `intermediate_holds`, `finish_hold`, never their order.
- **Benchmarks:** `problems.is_benchmark`; only admins set it (the app's ⋮ menu); once set, only admins can edit or delete the problem (RLS); only benchmarks score (db/27).

**How the console writes:** not with the service key. CLAUDE.md names the Edge Function as the only place the service-role key is used. Two options were weighed; Ross chose **1** (28 Oct 2026):
1. **Direct Postgres** with `db/.env` (`SUPABASE_DB_URL`, as the db scripts and reviews use), through `pg8000` if it's installed (not the standard library: a decision), in one transaction per edit.
2. **Signed in as an admin** (nickname + passphrase in the page, the session kept in memory only): writes go through RLS like the app's, with the anon key and the user's JWT. Turnstile guards sign-in, which a local page can't pass easily: check first.

Either way: show the rows before and after (preview), write an undo record (the old values) to `console/data/undo/<time>.json` (gitignored), and check the affected row count (a write blocked by RLS "succeeds" with 0 rows: CLAUDE.md). **Never** a schema change, never a migration (those stay Ross's, in the SQL editor).

First edits worth having: mark or unmark a benchmark; the mirror partner of one hold (both directions at once, checked against the hold map); a hold relabel exactly as db/32 did it (previewed as a diff of the three maps and the problems touched).

## Phase 14: Power

**Built 28 Oct 2026 as the disabled view.** The switching itself waits for the relay module.

Relay on/off for the LED supplies. `pi/listener/power.py` is the hook; it's a no-op while `RELAY_PINS` is empty. The relay module hasn't arrived.

- Show the buttons disabled, with "relay module not fitted", until `RELAY_PINS` is set in `config.env`.
- When it's built: `power.py` sets each pin with `pinctrl set <pin> op dl|dh` (held after the process exits; not gpiozero, which releases its pins); a helper verb `power on|off` calls it. pb-mode switches it at night; pb-ledmap's sessions must keep the power on (pb-mode should skip switching while pb-ledmap runs: `pi/README.md` → LED mapping → Night). Confirm and busy check for "off".

## Phase 15: Runbook

**Built 28 Oct 2026.**

A tab that works without the Pi (static content, no ssh): the rescue hotspot steps (`projectboard-rescue`, the Pi at 10.42.0.1, stop `pb-netwatch` first), reading `netlog.txt` from the SD card, the rollback to the stopgap listener, the key commands from `pi/README.md` (pb-status, pb-idle, pb-ledmap, journalctl lines, deploy), and what each overview tile's red means and what to try. Generated from `pi/README.md` at start (so it stays in step), with the hotspot section always shown first when the Pi is unreachable.

## Later: the phone

If the console is ever served to Ross's phone, the security boundary becomes **Tailscale identity**, not a login page: bind to the Tailscale address, use `tailscale serve` or check the caller with the local Tailscale API (`/localapi/v0/whois`) against an allow-list of Ross's own devices, and keep the token, Host, Origin and confirm rules. Never expose it beyond the tailnet.
