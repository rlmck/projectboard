# console/: PB Console

A local admin console and health checker for the whole Project Board: the Pi, the LEDs, the wall kiosk, the live app and Supabase. It runs on the laptop, in the browser, and reaches the Pi over Tailscale with the laptop's SSH key. Claude Code is for writing features; the console is for running, tuning, fixing and (in later phases) shipping. The plan for every phase is in `docs/console-plan.md`.

## Start it (Git Bash, at the repo root)

```
bash console/start.sh
```

It makes a new random session token, starts the backend on `127.0.0.1:8765` and opens `http://127.0.0.1:8765/#t=<token>` in the default browser. The page keeps the token for that tab and takes it out of the address bar. **Ctrl+C** in Git Bash stops it. If the browser opens the page without the token (it then says so), open the `this launch:` address that Git Bash printed. A tab left open from an earlier launch stops working (its token is old): start again and use the new tab.

**From the desktop:** `python console/desktop_shortcut.py` (once) puts a **PB Console** icon on the Windows desktop (`console/pb-console.ico`). Double-clicking it opens a Git Bash window running `bash console/start.sh`; closing that window (or Ctrl+C in it) stops the console. Run the script again if the repo moves.

Needs: Python 3 (the standard library only; Pillow only for the desktop icon), Git Bash's `ssh`, and `ssh pi@projectboard` working without a password (it does: the laptop's key). Optional settings go in `console/.env.local` (gitignored): copy `console/.env.local.example`.

**One-time on the Pi:** the Restart buttons, day/night (force, stay on) and the screen buttons use `pb-console-helper`, which a deploy installs (`bash pi/deploy.sh`; no password since 30 Oct 2026, `pb-deploy` sudoers rule). Until then the page says so and those buttons fail; everything else works.

## What it does

**The layout (Ross, 10 Nov 2026):** a sidebar of four: **Home · Holds · Activity · ⚙ Advanced**, plus **Runbook**, which appears only while the Pi isn't answering. Each has a status dot where it has one. **Ctrl+K** (or `/`, except on Holds) opens a palette that goes anywhere (Advanced's sections too) or runs a quick action (LEDs, patterns, night, end the stay-on override, screen, restarts, reboot, back up now), always through the same confirm. Release, Circuit tracks and Power were removed on 10 Nov 2026 (Claude Code ships; the Pi doesn't light tracks; the relays aren't fitted): their code is in git history.

- **Home** (`static/dash.js`): one page you drill into. The **status line** on top (what needs a look, as chips you can click or dismiss; the Pi's uptime, casts in 24 h, the last cast, day or night; a Runbook button when the Pi is offline). Then the tiles; a click opens the **drawer** with the detail and every line behind it:
  - **Board:** the webcam with what the LEDs show and day/night over it, and the controls: LEDs (idle now, off, default), idle pattern, brightness, **Stay on until HH:MM** (and End override), Night (Auto, or Force night/day for tests: `NIGHT_FORCE`), the wall screen, and **Light a problem** (a real `cast_problem`, plain or mirrored, then when the listener received and lit it, from its journal). Its drawer: what the board is doing in full and the last casts. Patterns, LEDs off and brightness last until the listener restarts (`pb-idle`); the permanent ones are in `config.env`.
  - **Health:** temperature (gauge), **power** (under-voltage now, or how often this week), Wi-Fi, disk, each with a 7-day line; services (a Restart beside any that's down), the live site and Supabase, and self-healing (fixes in 24 h, journal errors). Its drawer: **7-day charts** of temperature (each 5-minute reading and the highest in it, 70 °C and 80 °C marked), power (under-voltage red, throttling amber), Wi-Fi signal and disk; every service with Restart, Restart the wall screen, Reboot the Pi; and every line of the checks. The history is the Pi's own (`pb-healthlog`, below): the laptop only reads it (`probe.py healthlog`, `GET /api/health-history`, cached 4 minutes). The Pi 4 can't measure its supply voltage; "under-voltage" is its firmware's flag for a drop below about 4.63 V, checked every 15 s.
  - **Activity · 7 days:** casts per day and the three most cast; Activity has the rest.
  - **Opening hours:** day or night and the next switch, the week's hours (today in bold). Its drawer **edits the hours** (per day from, to, or Closed; a "to" of 00:00 is midnight; London time; re-read within 10 s, no restart), written like any config change. Amber while anything overrides the hours: a stay-on override, `NIGHT_FORCE` or `NIGHT_MODE=off` (`tiles.py` `schedule_tile`).
  - **Recent actions:** the last six; **Clear** hides them here (Advanced → Audit keeps them all).
  - **Backups** have no tile: they show in the status line only when the last try failed or the newest good backup is more than 8 days old (`tiles.backup_tile`), with Back up now in the drawer.
  - **Dismiss:** the x beside a chip (or Dismiss all, Dismiss in the drawer, or Ctrl+K) hides that warning until it changes: each check carries a `sig` from `tiles.py` (its level and value; for journal errors the newest error's time, for self-healing the last action), so a new error or a worse level brings it back; "N dismissed · show again" undoes it. Kept in this browser's localStorage.
  - The checks behind it, every 30 s (**Refresh** probes at once): the Pi online (uptime, last boot, the boot check line), temperature, throttling and under-voltage, disk and memory, Wi-Fi (signal, connection, rescue hotspot), each service (listener, kiosk, Wi-Fi watchdog, webcam) and the timers, the listener (joined, what the LEDs show, fps, last cast), the live site and its `sw.js` CACHE against the stamp `build.sh --stamp origin/main` gives, Supabase (REST, and a Realtime join of `board:HangoutPortland` every 5 minutes), the self-healing actions (pb-health, watchdog restarts, pb-netwatch) and the journal's errors in 24 h by source. The Pi side is `console/probe.py`, sent over ssh and run as `pi`: it reads, never writes.
- **Holds** (10 Nov 2026, `docs/console-plan.md` phase 17): the live board's outlines, footholds and foothold pairs, laptop-first. Pick any hold or foothold from the list (`/` and its name then Enter, ↑/↓ or J/K to walk the list, "Most points first" puts the over-traced on top; each row shows its point count, amber from 30, red from 60) or on the board (wheel to zoom, drag to move). **Clear and draw** (C) a fresh outline point by point (Backspace takes one back, Enter or the first point finishes, Esc stops), drag, Shift+click or double-click points, **Simplify**, **Revert**; **New foothold** (N; named FTn and paired by the board's reflection as in the app), **Pair with…** (P), **Unpair**, **Delete foothold** (not while a problem uses it). Undo/Redo; the draft stays in this browser. **Publish** lists every change, then calls `admin_publish_board()` as the super admin over direct Postgres (the same RPC and checks as the phone's Edit holds; refused if the board was published since the page loaded); **Undo the last publish**; **Ship the snapshot** (pulls main first if GitHub is ahead, then `snapshot_board.py`, `check_holds.py`, the build check, a commit of the four snapshot files, push main, then the Pi's automatic deploy). Turning a hold and new photos stay in the app's Board Setup (they upload an image, which the console can't).
- **Activity:** a dashboard that fits the window (no scrolling at 1366×768 or 1920×1080), built from the approved prototype `tools/activity-dashboard-prototype.html` (fake data; kept as the design reference). The last cast; 7 days / 30 days / All (all end today), by day or week; five tiles (casts, active members, new accounts, ticks, busiest day) against the previous equal period; a main chart (casts stacked by wall, phone and console, or members, ticks, new accounts); a weekday × hour heatmap (08–22); who's using it (top members with casts and ticks, a "new" badge for accounts under a week old, and guests); what they're climbing (problems cast, circuits, most ticked, with grades); how it's cast (where from, members and guests, mirrored share, circuit runs and how many reached the top, casts tried outside the opening hours). Clicking a bar, a heatmap square or label, a member, a climb or a source filters every other panel (the chips row lists the filters; click again to clear); bars, squares and rows work from the keyboard too. **Log** lists every cast, circuit run and circuit lit on the wall in the range, newest first. Definitions: a cast is a problem cast or a circuit run start received in the daytime (not a circuit lit on the wall, not the cast-test names; console test casts count); casts ignored at night are counted only as tried outside the hours; a member is a cast with a nickname or a tick, a guest a cast with none; a circuit reached the top when its run ended "finished". All dates and hours are UK time. **Data:** the console keeps its own cast history in `console/data/activity-history.json` (gitignored), read from the Pi's journal on each refresh (`probe.py history`, the last hour again, merged without repeats), because the journal expires after a month; members' nicknames (matched from the private cast log, db/34: a circuit by its run token, a problem by name within 2 minutes), ticks and accounts are read live over direct Postgres with `db/.env` (`console/castlog.py`, read-only). Without `db/.env` the page says so and shows casts as member or guest only (`console/activity_history.py`, `static/activity.js`, `GET /api/activity-history`).
- **⚙ Advanced:** one page of closed sections; opening one loads it (and a link to, say, Logs opens Advanced there).
  - **Logs:** the journal for one unit or tag (or the kernel, all errors, everything), a time range (`-1h`, `2 hours ago`, `today`, `2026-10-28 14:00`), a line count, a filter (case-insensitive text) and **Follow**; also `/boot/firmware/netlog.txt` and pb-netwatch's own log.
  - **Config:** the Pi's `config.env` as a form (the opening hours are on Home), every key checked (the same checks as the helper on the Pi); Apply shows the change first; the Pi backs up the old file, restarts the listener only when a key it reads at start changed, and the laptop's `pi/config.env` follows. Earlier copies (the last 30) with what putting each back would change. When the two copies differ: keep the Pi's or keep the laptop's.
  - **Deploy:** the Pi updates itself from main (`autodeploy.py`, below; this shows its last result). By hand: `bash pi/deploy.sh` from the page, a dry run, and a drift check: every file `install.sh` places, hashed on the Pi against the repo; files on the Pi the repo doesn't have, with a button to pull them in; NetworkManager profiles pulled with every password line stripped on the Pi.
  - **LED map:** start and stop `pb-ledmap` and use it beside the webcam; keep exported results in `console/data/ledmap/`. Only needed after rewiring.
  - **Tests:** the R8 acceptance checklist with a button per step and pass/fail notes (`console/data/acceptance.json`), and "check a night": the closing and the next opening switches from the journal, for the night that began on a date or covers it (a closed Friday is Thursday's night; `mode.py --night`).
  - **Backups:** **weekly by themselves** (10 Nov 2026, `console/backups.py`): the Pi's settings as a tar.gz (secrets stripped on the Pi) and an export of the public Supabase tables, into `backups/<date>/` (gitignored). The scheduled task that keeps the Pi up to date (`autodeploy.py`, every 10 minutes) makes one when the last good one is 7 days old, retrying hourly after a failure; the console does the same while it's open. State in `console/data/backups.json`. Back up now (or the Pi or Supabase alone) by hand; the list of what's there.
  - **Audit:** every action from `console/audit.log` (gitignored): time, action, result, how long.
- **Runbook** (only while the Pi isn't answering): the rescue-hotspot steps and the key sections of `pi/README.md`, readable when the Pi isn't.

Not built yet: the rest of **Data** (phase 13: benchmarks, hand-hold mirror partners, relabels). Ross chose direct Postgres through `db/.env` (28 Oct 2026); Holds uses it; `docs/console-plan.md`.

## Safety

- **Confirm** before anything that restarts, reboots, deploys, ships the board snapshot, casts or writes config (one confirm each). The dialog says exactly what happens and shows the command, diff or commits.
- **Board busy** (`probe.py busy`, 10 Nov 2026): before a stop, restart, reboot, deploy, Light a problem, mapping session or acceptance step it asks the Pi whether anyone used the board in the last 15 minutes in opening hours (casts, circuits, circuit views, live LEDs while setting, a running circuit, a wall-screen touch from `pb-touchwatch`; never busy outside the hours, always busy while `pb-ledmap` runs) and shows what it found. The automatic Pi deploy uses the same check. Going ahead anyway takes a second click; the server refuses without it.
- **One action at a time:** a second one is refused while another runs (logs don't count).
- **config.env stays in step:** Force and Config (the opening hours among it) write `/etc/projectboard/config.env` on the Pi (through the helper, which backs up the old copy to `/var/lib/projectboard/config-backups/`) and then copy it to the laptop's `pi/config.env`, so the next `bash pi/deploy.sh` doesn't put the old values back. If the two copies already differ, the console refuses and shows the diff.
- **pb-ledmap and pb-listener** never drive the strip together: the units' `Conflicts=` does it, and the console doesn't start either around it.
- Migrations are never applied by the console. Its only database writes are the board's holds (Holds: `admin_publish_board()` / `admin_undo_board()` as the super admin), each confirmed, one transaction, with an undo record.

## Security

- The backend binds **127.0.0.1 only**, refuses to share its port, and sends a strict CSP, no CORS headers.
- **Every `/api/` request needs this launch's token** in `X-PB-Token` (compared in constant time). The static page (`/`, `/static/*`, `/tokens.css`) needs none: it holds no data.
- The **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); an **Origin**, when sent, must be the console's own, and a POST must send one; on `/api/`, **Sec-Fetch-Site** must be `same-origin` or `none`. Only GET and POST; every POST is JSON; everything that changes something is a POST.
- The page never sends a command: only an action name and its arguments, which `console/actions.py` checks against fixed lists and builds into a fixed command (and `pb-console-helper` checks them again on the Pi).
- **Root on the Pi:** only `/usr/local/sbin/pb-console-helper` runs without a password, through `/etc/sudoers.d/pb-console`. It takes a fixed list of commands (units, reboot, night, stay-on, screen, config writes with every key checked, the mapping tool, hashes, NetworkManager export and backup with secrets stripped, the acceptance-test steps) and refuses everything else: `pi/README.md` → PB Console. Deploys still need the Pi's password (they run `install.sh` from a folder `pi` can write).
- **Acting as the super admin** (Holds): a publish sets the transaction's JWT claims to the one `is_super_admin` profile and the role to `authenticated` before calling the RPC, so the database's own checks (`is_super_admin()`, RLS, the RPC's validation) decide, never the console. That power comes from `db/.env` on this laptop; nothing in the page or the repo carries it.
- No sign-in: the boundary is the laptop's Windows login, the SSH key and Tailscale. Serving it to a phone would use Tailscale identity, not a login page (`docs/console-plan.md`).

## Files

| | |
|---|---|
| `start.sh` | the launcher (token, backend, browser) |
| `server.py` | the HTTP server: routes, the lock, streaming, the audit |
| `security.py` | the request checks and response headers |
| `actions.py` | the action table, the audit log, the config.env sync |
| `remote.py` | ssh to the Pi |
| `procs.py` | local programs and Python functions behind one streaming shape |
| `gitops.py` | git status, the CACHE stamp (`build.sh --stamp`), the gate (`build.sh --check`): for the live-site check and Holds' Ship the snapshot |
| `backups.py` | the backups: the Pi's settings and the public tables, weekly (`run_if_due()`, from the scheduled task and the console), the state, the summary Home warns from |
| `drift.py` | deploy drift: install.sh's files, hashed on the Pi |
| `autodeploy.py` | automatic Pi deploys of main (10 Nov 2026; `pi/README.md` → Deploying): a scheduled task every 10 min, `--install` makes it; its state in `data/autodeploy.json`; `attention()` is the sidebar's "needs you" list; each run then makes the weekly backup if one is due |
| `supabase_api.py` | Supabase with the anon key: problems, mirror map, Light a problem's cast, the export |
| `holds.py` | Holds: the live board (public reads), the edits laid over it (`apply_edits`: the publish payload and the change list), the publish and undo as the super admin over direct Postgres, the snapshot tools |
| `castlog.py` | members' casts from the private cast log, over direct Postgres; its connection is shared with `holds.py` |
| `reports.py` | activity, the acceptance checklist and night check, mapping results, backups, the runbook |
| `probe.py` | the read-only script Home runs on the Pi (and `healthlog`: pb-healthlog's 7 days) |
| `checks.py` | the laptop's checks: the live site, Supabase REST, a Realtime join |
| `tiles.py` | Home's thresholds (green, amber, red), the backup warning, and `metrics()`, the raw numbers Home draws |
| `static/` | the page (`index.html`, `console.css`, `console.js` for the sidebar, Advanced and the actions, `more.js` for Advanced's sections, Light a problem and the hours editor, `dash.js` for Home, its drawer, the health charts and the Ctrl+K palette, `activity.js`, `holds.js`; the Holds tab also loads the app's `trace.js` and `setup.js`, served as `/app/…`); the colours come from `app/tokens.css`. The CSP blocks inline `style=""` attributes, so sizes set from data go through `element.style` |
| `tests/` | `python -m unittest discover -s console/tests` |

The Pi side lives with the rest of the Pi code: `pi/ops/pb-console-helper`, `pi/conf/pb-console.sudoers`, and `pb-idle off` / `pb-idle brightness` in the listener.

## Tests

```
python -m unittest discover -s console/tests
```

No Pi and no network: ssh and the laptop checks are faked. They cover the request checks (no token, a wrong token, Host, Origin, Sec-Fetch-Site, methods, JSON, a shared port), the action table and its argument checks, confirms, the busy guard, one action at a time, the audit log, the config.env sync, the log options, the helper's own checks, the tiles' thresholds, and `test_autodeploy.py`: the busy rules (15 minutes, night, touches, LED mapping), the automatic deploy's decisions with a fake Pi, and the "needs you" list (only real problems); `test_holds.py`: the edits laid over a board (the payload, refusals: shapes, a foothold in use, hand ↔ foot pairs, pairs that don't point back, names), the actions' checks and the board version, the routes behind the token.
