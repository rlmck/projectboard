# Pi 4: the proper listener and the wall kiosk

Written 26 Oct 2026 by Claude Code; the resilience and night-mode section added 26 Oct from the spec agreed with Ross in the claude.ai chat (dated 27 Oct). Committed on 29 Oct 2026 (it was local only until then; nothing personal or secret in it): PB Console's Tests tab follows R8 below. `pi/README.md` carries the operational parts, and `PROJECT_STATUS.md` the current state.

**Status (26 Oct, 21:30):** the listener and resilience work (section A and R1–R7) is **live on the Pi** (deployed 21:08, fixes redeployed 21:14; commits `9d296ed`, `ed62073`, `4c4ec48` on `dev` and `main`). Real casts light correctly. Not yet done: the first night checked in the log, the R8 acceptance tests, and relays (hook only). Found at deploy: Raspberry Pi OS's `40-rpi-volatile-storage.conf` had kept the journal in RAM all along; `pb-journal.conf` + a flush fixed it. Builds on `docs/cast-contract.md`, `docs/pi4-led-audit.md` and the stopgap in `pi/cast_listener.py`.

## What's on the Pi today (checked 26 Oct, read-only)
- Pi 4 Model B rev 1.1, **2 GB**. Raspberry Pi OS **Lite** 64-bit, trixie (Debian 13), systemd 257. Python 3.13.5, `python3-websockets` 15.0.1, `python3-spidev`, `python3-gpiozero`. **No `python3-systemd`** (sd_notify will be done with the stdlib socket). User `pi` is in `spi`, `gpio`, `video`, `input`; **`sudo` asks for a password**.
- Services: `cast-listener` (stopgap), `leds-off-at-boot` (oneshot, runs `show_problem.py --off`), `board-cam` (ustreamer on the Tailscale IP, which is hard-coded in `board-cam.sh`), `pb-netlog`, and **`kiosk.service`** (cage 0.3.1 + Chromium 155 as user `kiosk` on tty1, opening https://symmetryboard.co.uk; a `cursor.conf` drop-in hides the pointer). The kiosk was installed late on 26 Oct and isn't yet recorded in `PROJECT_STATUS.md` or copied into `pi/`.
- Network: NetworkManager, active connection `hangout-fixed` on wlan0 (DHCP, gateway answers ping), `98-projectboard-no-rand-mac.conf` in place, Tailscale `Running`. Time: `systemd-timesyncd`, synced; it writes `/run/systemd/timesync/synchronized` once per boot; no RTC, no `fake-hwclock` (timesyncd restores the last saved time from `/var/lib/systemd/timesync/clock`).
- Watchdog: `/dev/watchdog0` (BCM2835) present; systemd isn't using it (`RuntimeWatchdogSec` unset). `kernel.panic = 0` (a panic hangs until a watchdog fires).
- Display: KMS (`vc4-kms-v3d`), no backlight device, so `vcgencmd display_power` won't blank it.
- Journal persistent (`/var/log/journal`), no size cap yet. Root fs 29 GB, 20% used. 58 °C idle, `throttled=0x0`.
- Touchscreen: `HDMI-A-2`, the second HDMI port (corrected; first noted as HDMI 0); touch is a USB `G2Touch Multi-Touch` device.

## A. The listener

**Shape.** One Python program, stdlib + apt packages only (`python3-websockets`, `python3-spidev`, `python3-gpiozero` for the relays). No pip, no venv. Pure functions (order, roles, mirror, LED index, brightness cap, day/night) kept apart from I/O so they can be tested on the laptop with a fake SPI. **Lives in `pi/`, committed** (decision 1, settled by the resilience spec). Unit name, config file, reconnect and install are as in the next section, which supersedes this table where they differ.

| Piece | Behaviour |
|---|---|
| Config | `/etc/projectboard/config.env` (see the next section). Nothing secret. |
| Start-up | Clear the strip, tell systemd it's ready, then connect. `leds-off-at-boot` stays as the early safety clear. Relays: a hook only (next section). |
| Connection | Realtime WebSocket (v1 protocol, as the stopgap). Check the `phx_join` reply and reconnect on `error`, `phx_error`, `phx_close` or a missed heartbeat reply. Backoff and heartbeat: next section. |
| Data | Problem looked up per cast by REST (`name=eq.<name>`), one retry. Mirror map loaded on connect and refreshed every 10 min; if it has never loaded, a mirrored cast is logged and skipped rather than shown unmirrored. |
| Frame | Contract §6.2: order = finish + intermediates + starts; roles exactly as `classifyHolds()` (classify first, then drop ids outside 1–247 with a log line); §6.3 each hold then moves to its mirror partner, keeping its role (as the app draws it); §6.4 formula. Checked against the app's functions for all 261 live problems, plain and mirrored: identical. |
| Brightness | Per-role colours × a cast brightness, then a whole-frame current cap: estimate the frame's draw and scale it down if it's over budget. |
| Concurrency | One worker, latest wins: a cast arriving while one is being fetched replaces it; stale ones are dropped. |
| Unknown name | Log it, leave the board as it is. |
| Idle / stop | Daytime idle per Ross's decision (below); night mode in the next section. SIGTERM clears the strip. |
| Events | Dispatch table keyed by event, so `cast_circuit` and `stop` (Circuits Phase 2) slot in later. |
| Logs | journald, one line per cast (name, mirror, LEDs, ms taken). |
| Tools | `--dry-run` (print LEDs, no SPI), `--show "<name>"` and `--off` (replace `show_problem.py`). |

**Tests.** On the laptop: the LED map against `tools/led_map.json` for all 247; order and roles against `problemHoldOrder()`/`classifyHolds()` for every live problem (read with the read-only MCP, nothing written to the repo); the mirror against `app/mirror_map.json`; the cap; day/night across midnight, the boundaries and an unsynced clock. End to end: `tools/cast-test.html`, then a real and a mirrored cast watched on the webcam. Check column B runs down at the same time.

**Install.** `pi/deploy.sh` from the laptop (next section). It disables `cast-listener` and leaves the stopgap on disk for a quick rollback.

## Pi resilience and night mode

From the spec agreed with Ross in the claude.ai chat. Part of the fresh listener, not a separate project.

**Goal:** the board runs unattended for weeks. Every failure it can fix, it fixes on its own; every failure it can't fix is logged where Ross can see it over Tailscale. Self-healing must never hide a recurring fault: every action is a journal line, and `pb-status` counts them.
**Scope:** the listener, systemd services, health checks, night mode. Not the kiosk's own setup, not the wiring. **Relay control is a hook only** until the relay module arrives.

### R1. The listener: `pb-listener.service`
Replaces the stopgap `cast-listener` / `~/cast_listener.py`.

- **Unit:** `Type=notify`, `NotifyAccess=main`, `WatchdogSec=30`, `Restart=always`, `RestartSec=5`, `StartLimitIntervalSec=0`. `After=leds-off-at-boot.service`; it does **not** wait for `network-online.target` (a boot with no network must still bring it up). `User=pi`, `EnvironmentFile=/etc/projectboard/config.env`.
- **Ready and watchdog:** `READY=1` once config is read and the strip is cleared, before any network. `WATCHDOG=1` every 10 s from a ticker task whenever the event loop is alive, **connected or not**, so a Wi-Fi outage causes no restarts. A blocked event loop (a hung call outside a thread) stops the ticker, and systemd kills and restarts it after 30 s. sd_notify via the `NOTIFY_SOCKET` datagram socket (stdlib; `python3-systemd` isn't installed).
- **Reconnect:** backoff from 1 s doubling to 60 s, each delay with random jitter (×0.5–1.0); reset once a connection has stayed joined for 60 s. Phoenix heartbeat every 25 s; no `phx_reply` to any heartbeat for 60 s = dead socket → close and reconnect.
- **Every cast checked:** payload shape (`problem_name` a string of 1–60 characters, `mirror` true or absent), the REST row, every hold id. A bad cast is logged and skipped, never a crash; any exception in the cast path is caught at the worker. Classify holds first, then filter (as `classifyHolds()`; the stopgap filters first).
- **Clears the LEDs** on start and on SIGTERM.
- **Status file** `/run/projectboard/listener.json`, written atomically (temp file + rename) on every state change and at least every 10 s: `pid`, `started_at`, `mode` (day/night), `state` (connecting/joined/backoff), `connected_since`, `disconnected_since`, `last_message_at` (any frame, heartbeat replies included), `last_cast_at`, `last_cast_name`, `casts_ignored_night`, `error_count`, `last_error`, `updated_at`. The health check treats it as stale after 90 s.
- Built to `docs/cast-contract.md` (§3 payload, §6.2–6.4).

### R2. Health checks: `pb-health.timer` → `pb-health.service`
Oneshot, root, every 2 min (`OnBootSec=5min`, `OnUnitActiveSec=2min`, so it doesn't fight boot). Logs one line per action with tag `pb-health` (`logger -t pb-health`); a failed remedy or a suppressed reboot logs at priority `err`. Run state that should reset on reboot lives in `/run/projectboard/health/`; the reboot ledger in `/var/lib/projectboard/`.

In order:
1. **Network:** wlan0 has an IPv4 address and the default gateway answers ping (it does today).
   - Fail → `nmcli radio wifi on` (cheap; the radio state survives reboots, so nothing else would fix it) then `nmcli connection up hangout-fixed`.
   - 3 failures in a row → `systemctl restart NetworkManager`.
   - Down for 10 min (first-failure time in `/run`) → reboot, through the guard.
   - While the network is down, steps 2–4 are skipped (their remedies can't work).
2. **Tailscale:** `BackendState` not `Running` → `systemctl restart tailscaled`.
3. **Listener:** network fine but `state` not joined with `disconnected_since` over 5 min, or the status file older than 90 s or missing → `systemctl restart pb-listener`.
4. **board-cam** not active → `systemctl restart board-cam`.
5. **Log only:** one line per run, `temp`, `disk_free`, `throttled` (decoded: undervoltage now/since boot, throttled, capped). Any non-zero throttled bit, temperature ≥ 75 °C or disk free < 1 GB logs at `warning`.

**Reboot guard:** a health-triggered reboot appends a timestamp to `/var/lib/projectboard/reboots`. At most 1 in the last hour and 3 in the last 24 h. Past the limit it stops escalating and logs `REBOOT SUPPRESSED` at `err` every run until the network returns. Planned weekly reboots don't count against it.

### R3. Hardware watchdog
`/etc/systemd/system.conf.d/pb-watchdog.conf`: `RuntimeWatchdogSec=15` (the BCM2835's maximum is about 15 s; systemd pets it at half that). Covers a kernel hang or panic (`kernel.panic` is 0). Check after install: the journal shows `Using hardware watchdog 'Broadcom BCM2835 Watchdog timer', ... 15s`.

### R4. Night mode, 23:00–08:00
- **Times in config** (`NIGHT_START=23:00`, `NIGHT_END=08:00`, `NIGHT_MODE=on`). One pure function `mode(now, synced)` in `pi/listener/mode.py` decides; the window may wrap midnight.
- **Derived from the clock, never from on/off events.** The listener re-checks every 30 s; `pb-mode.timer` runs every minute (`OnBootSec=30s`) and applies the result idempotently. A boot at 02:00 comes up in night mode; a missed tick changes nothing.
- **Time sync:** synced = `/run/systemd/timesync/synchronized` exists (timesyncd, once per boot). **Unsynced = day** (fail open).
- **Night, in the listener:** on entering night, clear the strip. Casts are **ignored**: logged (`ignored at night: <name>`), counted in the status file, not shown, nothing woken. The socket stays joined, so the health checks still mean something. On entering day: nothing (the strip stays dark until the next cast).
- **Night, in `pb-mode` (root):** the screen goes fully off: stop `kiosk.service`, then power the output down (`/sys/class/graphics/fb0/blank` = 4 under KMS, so the console that reappears doesn't show). Day: unblank, start `kiosk.service`. Chromium therefore restarts every morning, which the kiosk plan wanted anyway. **To verify on the wall:** that the screen goes into standby rather than showing a lit "No signal" box. If it doesn't, the real fix is the relay (if the second relay ends up switching the screen).
- **Relay hook:** `pi/listener/power.py` with `leds_power(on)`, a logged no-op while `RELAY_PINS` is empty in config. `pb-mode` is the one owner of power: day → on, then clear the strip (a WS2801 can power up showing random colours); night → off. Set the pins with `pinctrl set <pin> op dl|dh`, which holds after the process exits (gpiozero releases its pins on exit, and a released BCM 23/24 falls back to its pull-down, which on an active-low module means **on**). Polarity in config. Not built until the module arrives and the hardware chat settles what it switches.

### R5. Weekly reboot
`pb-weekly-reboot.timer`: `OnCalendar=Mon *-*-* 07:45`, not `Persistent`. The service skips (and logs) if uptime is under 1 h. Every boot: `pb-bootcheck.timer` fires once 3 min after boot (`OnBootSec=3min`) and logs one line with tag `pb-boot`: `came up OK` or `came up with problems:` plus what failed (each pb service active, network, Tailscale, listener joined, time synced, mode, last boot's reason if known).

### R6. Logs and status
- `/etc/systemd/journald.conf.d/pb-journal.conf`: `Storage=persistent`, `SystemMaxUse=200M`.
- **`pb-status`** (`/usr/local/bin`, no sudo needed for the read-only parts): services (pb-listener, kiosk, board-cam, tailscaled, NetworkManager, the timers and when each fires next), mode and why (clock, synced), listener state with ages, last cast, last 10 `pb-health` actions plus counts per action over 24 h and 7 days, the reboot ledger and suppressions, uptime and last boot line, temperature, throttled (decoded), disk free, Wi-Fi signal.
- **`pb-netlog`** stays: the boot-partition file is the fallback when SSH is down.

### R7. Config and deploy
- **`/etc/projectboard/config.env`** on the Pi, root-owned, mode 0644: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BOARD_WALL=HangoutPortland`, `BRIGHTNESS`, `STRIP_PIXELS`, `POWER_BUDGET_MA`, `MA_PER_CHANNEL`, `NIGHT_MODE`, `NIGHT_START`, `NIGHT_END`, `NIGHT_FORCE`, `WIFI_CONNECTION`, `WIFI_IFACE`, `RELAY_PINS` (empty), `RELAY_ACTIVE_LOW`. The repo holds `pi/config.env.example` with placeholders. The laptop's copy is `pi/config.env` (gitignored); `deploy.sh` sends it and `install.sh` installs it when it differs. Without one, the first install creates the live file from the template and stops until it's filled in; a live file is never overwritten except by the laptop's copy.
- **Repo layout** (`pi/`, committed; subfolders are fine here, rule 9 is about `app/`):
  ```
  pi/README.md                what runs on the Pi, deploy, rollback, pb-status
  pi/deploy.sh                laptop (Git Bash) → Pi
  pi/install.sh               runs on the Pi under sudo, called by deploy.sh
  pi/setup.sh                 first bring-up from the boot partition (was bringup/setup.sh)
  pi/config.env.example
  pi/listener/pb_listener.py  asyncio main: Realtime, worker, sd_notify, status file
  pi/listener/board.py        pure: order, roles, mirror, LED index, cap
  pi/listener/mode.py         pure: day/night
  pi/listener/leds.py         SPI write and clear; CLI --off, --show, --dry-run
  pi/listener/supa.py         REST reads (problem by name, mirror map)
  pi/listener/power.py        relay hook (no-op)
  pi/ops/pb-health  pb-mode  pb-status  pb-bootcheck  pb-weekly-reboot  board-cam.sh
  pi/systemd/                 units, timers and drop-ins (incl. kiosk.service as installed)
  pi/conf/                    journald, system.conf.d watchdog, NetworkManager no-rand-mac, tmpfiles.d
  pi/tests/                   laptop tests (fake SPI)
  pi/tools/led_test.py  relay_test.py
  ```
  On the Pi: code in `/opt/projectboard/`, commands in `/usr/local/bin/`, units in `/etc/systemd/system/`, `/run/projectboard` (owned by `pi`) and `/var/lib/projectboard` (root) via `tmpfiles.d`.
- **`.gitignore`:** replace `pi/` with `pi/_old/` and `pi/config.env` (done). Before that, move the June Pi 3 material (`board_listener.py`, `boardlistener.service`, `SMOKE_TEST.md`, `_pi_run.py`, `requirements.txt`, `clear_strip.py`, **`problems.csv`, which holds setters' nicknames**) and the stopgap copies (`cast_listener.py`, `show_problem.py`, `cast-listener.service`) into `pi/_old/`. `secrets.env` is already ignored everywhere; add `laptop_key.pub`. `.gitattributes`: `pi/** text eol=lf` (a CRLF script fails on the Pi). Check `git status` shows nothing unexpected before the first commit.
- **`pi/deploy.sh`**, from Git Bash at the repo root, plain `ssh`/`scp` (no rsync on the laptop): copy `pi/` to `~/pb-deploy/` on the Pi, then one `ssh -t pi@projectboard sudo bash ~/pb-deploy/install.sh`, so **one sudo password prompt per deploy** and no sudoers change. `install.sh` compares each file with what's installed (`cmp`), installs only what changed with explicit modes (Windows loses exec bits), runs `daemon-reload` if a unit changed, enables the units, restarts only services whose files changed, disables `cast-listener` on the first run (its files stay for rollback), and ends by printing `pb-status`. Idempotent: a second run changes nothing. `--dry-run` lists what it would change.
- **Rollback:** `sudo systemctl disable --now pb-listener && sudo systemctl enable --now cast-listener`.
- **`setup.sh`** (first bring-up only) gains the 26 Oct Wi-Fi fix: the `hangout-fixed` keyfile (autoconnect-priority 100, `cloned-mac-address=permanent`) **built from `WIFI_SSID`/`WIFI_PSK` in `secrets.env`, because the keyfile holds the Wi-Fi password and must never be in the repo**; skipped if the connection exists. Also the no-random-MAC conf, the persistent journal and `pb-netlog`. Its Wi-Fi power-save step is dropped.

### R8. Acceptance tests
Over Tailscale, watched on the board webcam (`http://projectboard:8080/stream`) and with `pb-status`. Each must heal with no hands on the Pi. Commands that cut the network are started detached (`sudo systemd-run --on-active=…`) so they run after SSH drops, and each has its undo scheduled the same way as a safety net.

- [ ] **Kill the listener:** `sudo systemctl kill -s KILL pb-listener`. Expect: back in about 5 s, strip cleared, rejoined; `NRestarts` +1.
- [ ] **Freeze it:** `sudo kill -STOP <MainPID>`. Expect: within 30 s systemd logs a watchdog timeout, kills and restarts it.
- [ ] **Drop the Wi-Fi:** `sudo systemd-run --on-active=5 nmcli connection down hangout-fixed`. Expect: SSH drops; within about 2 min `pb-health` logs `connection up hangout-fixed` and SSH comes back; the listener rejoins without a restart (watchdog kept fed).
- [ ] **Block Supabase:** an `nft` rule dropping the project host's addresses, with its removal scheduled after 12 min. Expect: dead socket within 60 s, backoff to 60 s, no network action (gateway fine); after 5 min `pb-health` restarts the listener (logged) and does so again each 5 min; no reboot; after the unblock, rejoined within a minute and a cast works.
- [ ] **Reboot mid-cast:** cast a problem, `sudo systemctl reboot`. Expect: strip dark from `leds-off-at-boot` until the next cast; a `pb-boot ... came up OK` line; the next cast lights.
- [ ] **Clock across 23:00 and 08:00:** `sudo timedatectl set-ntp false; sudo date -s '22:59:30'`. Expect at 23:00: strip cleared, kiosk stopped, screen off; a cast is logged as ignored and doesn't light. Then `sudo date -s '07:59:30'`: at 08:00 screen on, kiosk back; a cast lights. Finish with `sudo timedatectl set-ntp true`. (Check during this test whether turning NTP off removes the synced flag; if it does, the fake clock reads as day and the test needs `NIGHT_FORCE` in config instead.)
- [ ] **Boot with no network:** on-site, or with the Wi-Fi switched off at the access point: reboot. Expect: listener up and backing off, no watchdog restarts, day mode (unsynced), `pb-health` trying `connection up`, NetworkManager restarts, a guarded reboot at 10 min (at most 1 an hour). When the network returns: rejoined, synced, correct mode.
- [ ] Extra: `sudo systemctl start pb-weekly-reboot` with uptime under 1 h logs a skip; `pb-status` shows every action from the tests above.

### Later, not now
- A heartbeat from the Pi to Supabase so the admin view can show "board online" (contract §7 items 2–3). Until then a cast at night, or with the Pi down, still shows "Cast: X" in the app.
- Relay control of the LED supplies (R4's hook).

## B. The wall kiosk

**Built late on 26 Oct** (outside this plan): `kiosk.service`, `cage` + `chromium` on tty1 as user `kiosk`, with the flags below except `--autoplay-policy` and the managed policies, and an `ExecStartPre` that waits up to 120 s for DNS. Night mode stops and starts it. Copy the unit and its drop-in into `pi/systemd/` before the first deploy so the repo matches the Pi.

**Chromium:** `--kiosk --noerrdialogs --no-first-run --disable-session-crashed-bubble --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required`, a persistent profile (so the service worker and offline lists work; not incognito), and managed policies in `/etc/chromium/policies/managed/` (geolocation denied, no password manager, no translate, no downloads).

**Operations:** restart on crash (Restart=always), restarted every morning by night mode, remote debugging bound to localhost and reached over SSH through Tailscale.

**Touch:** check the G2Touch maps onto the HDMI output at the screen's resolution and orientation; libinput under cage normally does this without config.

**Casting from the wall:** the same PWA path through Supabase (contract §7 item 14), so no Pi-side change. The geofence fails open with no location, and the policy stops the permission prompt.

**Wall-screen mode in the PWA** (browse and cast only, no sign-in, "Get the app" QR, Ranks read-only, back to the list when idle) is app work in `app/`, a separate feature. Until it exists the kiosk shows the full app, where someone could sign in and stay signed in on a shared screen.

## Decisions needed from Ross
1. ~~Where the new listener lives~~ **`pi/`, committed** (resilience spec, 27 Oct).
2. ~~Idle in the daytime~~ **An idle pattern after 20 minutes, `wave` chosen** (28 Oct; `pi/listener/patterns/`).
3. Brightness: cast brightness (stopgap 0.5) and the power budget once both 8-way feeds are wired.
4. Feet indicators `hold2`/`hold21` (LEDs 26/25): the stopgap lights them blue like Gareth did. Keep, skip, or give them their own colours?
5. Name match: exact (recommended, it's what the app sends) or trimmed / case-insensitive?
6. ~~Presence so the app can say "board offline"~~ **Later** (resilience spec).
7. Relays: what they'll switch in the new box, which pins, active-low or not. (The hardware chat should settle whether 5 V / 20 A DC goes through the relay at all.)
8. ~~Kiosk stack~~ **cage on the Lite card** (installed 26 Oct).
9. ~~Kiosk before wall mode~~ **Wall-screen mode live 27 Oct** (`/?wall`).
10. The screen: orientation and resolution. (Sleeping at night: settled, 23:00–08:00.)
11. Updates: `unattended-upgrades` for security fixes? (Weekly reboot: Monday 07:45, settled.)
12. **New:** is 23:00 safely after the gym closes on every day of the week? Casts after 23:00 are ignored while the app still says "Cast: X".
