# console/: PB Console

A local admin console and health checker for the whole Project Board: the Pi, the LEDs, the wall kiosk, the live app and Supabase. It runs on the laptop, in the browser, and reaches the Pi over Tailscale with the laptop's SSH key. Claude Code is for writing features; the console is for running, tuning, fixing and (in later phases) shipping. The plan for every phase is in `docs/console-plan.md`.

## Start it (Git Bash, at the repo root)

```
bash console/start.sh
```

It makes a new random session token, starts the backend on `127.0.0.1:8765` and opens `http://127.0.0.1:8765/#t=<token>` in the default browser. The page keeps the token for that tab and takes it out of the address bar. **Ctrl+C** in Git Bash stops it. If the browser opens the page without the token (it then says so), open the `this launch:` address that Git Bash printed. A tab left open from an earlier launch stops working (its token is old): start again and use the new tab.

Needs: Python 3 (the standard library only), Git Bash's `ssh`, and `ssh pi@projectboard` working without a password (it does: the laptop's key). Optional settings go in `console/.env.local` (gitignored): copy `console/.env.local.example`.

**One-time on the Pi:** the Services tab, night mode and the screen buttons use `pb-console-helper`, which a deploy installs (`bash pi/deploy.sh`, the Pi's password once). Until then the page says so and those buttons fail; everything else works.

## What it does

- **Overview:** green, amber or red tiles, refreshed every 30 s: the Pi online (uptime, last boot, the boot check line), temperature, throttling and under-voltage, disk and memory, Wi-Fi (signal, connection, rescue hotspot), each service (listener, kiosk, Wi-Fi watchdog, webcam) and the timers, the listener (joined, what the LEDs show, fps, last cast), the live site and its `sw.js` CACHE against the repo's, Supabase (REST, and a Realtime join of `board:HangoutPortland` every 5 minutes), the self-healing actions (pb-health, watchdog restarts, pb-netwatch) and the journal's errors in 24 h by source, against the day before. **Refresh** probes at once. The Pi side is `console/probe.py`, sent over ssh and run as `pi`: it reads, never writes.
- **Services:** start, stop or restart `pb-listener`, `kiosk`, `board-cam`, `pb-netwatch`, `pb-health.timer`, `pb-mode.timer`; restart the kiosk (the wall loads the latest app); reboot the Pi.
- **Board:** idle now, LEDs off (dark now and whenever idle, casts still light) and back to the default, the idle pattern (each of the ten, the tour, the cycle), a brightness for everything (5–100% of the configured level), night mode (auto, force night, force day) and the night hours, the wall screen off/on, and the webcam beside them. Patterns, LEDs off and brightness last until the listener restarts (`pb-idle`); the permanent ones are in `config.env`.
- **Logs:** the journal for one unit or tag (or the kernel, all errors, everything), a time range (`-1h`, `2 hours ago`, `today`, `2026-10-28 14:00`), a line count, a filter (case-insensitive text) and **Follow**; also `/boot/firmware/netlog.txt` and pb-netwatch's own log.
- **Config:** the Pi's `config.env` as a form, every key checked (the same checks as the helper on the Pi), Apply shows the change first; the Pi backs up the old file, restarts the listener only when a key it reads at start changed, and the laptop's `pi/config.env` follows. Earlier copies (the last 30) with what putting each back would change. When the two copies differ: keep the Pi's or keep the laptop's.
- **Deploy:** `bash pi/deploy.sh` from the page (the Pi's password typed in, never saved), a dry run, and a drift check: every file `install.sh` places, hashed on the Pi against the repo; files on the Pi the repo doesn't have, with a button to pull them in; NetworkManager profiles pulled with every password line stripped on the Pi.
- **Release:** git status, pull, the diff, commit the ticked files (new files start unticked), push dev, fast-forward main (live), bump CACHE, the scripts' syntax check, warnings when `app/` changed without a CACHE bump or a new app file breaks the three-places rule, and the live `sw.js` polled until the new CACHE shows.
- **LED map:** start and stop `pb-ledmap` and use it in the page beside the webcam; keep exported results in `console/data/ledmap/`.
- **Test cast:** a real `cast_problem` (plain or mirrored), then when the listener received and lit it, from its journal; the problem's holds and where mirroring puts each.
- **Activity:** casts per day and per hour, mirrored share, casts ignored at night and the most cast problems, from the Pi's journal (no user data).
- **Tests:** the R8 acceptance checklist with a button per step and pass/fail notes (`console/data/acceptance.json`), and "check a night": the 23:00 and 08:00 switches from the journal.
- **Backups:** the Pi's settings as a tar.gz (secrets stripped on the Pi) and an export of the public Supabase tables, into `backups/<date>/` (gitignored).
- **Power:** the relay buttons, disabled until the relay module is fitted.
- **Runbook:** the rescue-hotspot steps and the key sections of `pi/README.md`, readable when the Pi isn't.
- **Audit:** every action from `console/audit.log` (gitignored): time, action, result, how long.

Not built: **Data** (admin edits to board data, phase 13) waits for Ross's choice of how the console writes to Supabase (`docs/console-plan.md`).

## Safety

- **Confirm** before anything that restarts, reboots, deploys, commits, pushes, casts or writes config. The dialog says exactly what happens and shows the command, diff or commits.
- **Board busy:** before a stop, restart, reboot, deploy, test cast, mapping session or acceptance step it checks the Pi's journal for a cast in the last 5 minutes and shows them. Going ahead anyway takes a second click; the server refuses without it.
- **One action at a time:** a second one is refused while another runs (logs don't count).
- **config.env stays in step:** night mode and night hours write `/etc/projectboard/config.env` on the Pi (through the helper, which backs up the old copy to `/var/lib/projectboard/config-backups/`) and then copy it to the laptop's `pi/config.env`, so the next `bash pi/deploy.sh` doesn't put the old values back. If the two copies already differ, the console refuses and shows the diff.
- **pb-ledmap and pb-listener** never drive the strip together: the units' `Conflicts=` does it, and the console doesn't start either around it.
- Migrations are never applied by the console.

## Security

- The backend binds **127.0.0.1 only**, refuses to share its port, and sends a strict CSP, no CORS headers.
- **Every `/api/` request needs this launch's token** in `X-PB-Token` (compared in constant time). The static page (`/`, `/static/*`, `/tokens.css`) needs none: it holds no data.
- The **Host** must be `127.0.0.1:<port>` or `localhost:<port>` (stops DNS rebinding); an **Origin**, when sent, must be the console's own, and a POST must send one; on `/api/`, **Sec-Fetch-Site** must be `same-origin` or `none`. Only GET and POST; every POST is JSON; everything that changes something is a POST.
- The page never sends a command: only an action name and its arguments, which `console/actions.py` checks against fixed lists and builds into a fixed command (and `pb-console-helper` checks them again on the Pi).
- **Root on the Pi:** only `/usr/local/sbin/pb-console-helper` runs without a password, through `/etc/sudoers.d/pb-console`. It takes a fixed list of commands (units, reboot, night, screen, config writes with every key checked, the mapping tool, hashes, NetworkManager export and backup with secrets stripped, the acceptance-test steps) and refuses everything else: `pi/README.md` → PB Console. Deploys still need the Pi's password (they run `install.sh` from a folder `pi` can write).
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
| `gitops.py` | release: git status, diff, the CACHE and three-places checks |
| `drift.py` | deploy drift: install.sh's files, hashed on the Pi |
| `supabase_api.py` | Supabase with the anon key: problems, mirror map, the test cast, the export |
| `reports.py` | activity, the acceptance checklist and night check, mapping results, backups, the runbook |
| `probe.py` | the read-only script the overview runs on the Pi |
| `checks.py` | the laptop's checks: the live site, Supabase REST, a Realtime join |
| `tiles.py` | the overview's thresholds (green, amber, red) |
| `static/` | the page (`index.html`, `console.css`, `console.js` for the first tabs, `more.js` for the rest); the colours come from `app/tokens.css` |
| `tests/` | `python -m unittest discover -s console/tests` |

The Pi side lives with the rest of the Pi code: `pi/ops/pb-console-helper`, `pi/conf/pb-console.sudoers`, and `pb-idle off` / `pb-idle brightness` in the listener.

## Tests

```
python -m unittest discover -s console/tests
```

No Pi and no network: ssh and the laptop checks are faked. They cover the request checks (no token, a wrong token, Host, Origin, Sec-Fetch-Site, methods, JSON, a shared port), the action table and its argument checks, confirms, the busy guard, one action at a time, the audit log, the config.env sync, the log options, the helper's own checks, and the tiles' thresholds.
