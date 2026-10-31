# pi/: the board's Raspberry Pi

Everything that runs on the Pi 4 behind the board: the cast listener that lights the LEDs, and the services that keep it running unattended. The app side of casting is in `docs/cast-contract.md`. The plan and the reasons behind it are in the local, uncommitted `docs/pi4-listener-kiosk-plan.md`.

**Nothing secret lives here.** The Pi's settings are in `/etc/projectboard/config.env` on the Pi. The laptop keeps its copy in `pi/config.env`, which is gitignored. The Wi-Fi password and the Tailscale key only ever go through `secrets.env` on the SD card's boot partition (for `setup.sh`), which is also gitignored.

## What runs

| Unit | What it does |
|---|---|
| `leds-off-at-boot` | Clears the strip early in boot (`leds.py --off`). |
| `pb-listener` | The cast listener (`listener/pb_listener.py`). It joins Supabase Realtime `board:HangoutPortland`, and on each `cast_problem` looks the problem up by name and lights it (contract §6). On `cast_circuit` it reads the circuit and runs it (`listener/circuit.py`: countdown, moving holds, finish) until it finishes, a `stop` with its run token, or `CIRCUIT_MAX_S` (contract §8). On `preview_holds` it lights the holds someone is setting, live (contract §9). systemd restarts it if it exits, and its watchdog restarts it if it freezes for 30 s. When nobody has cast for 20 minutes it runs an **idle pattern** (below). Status goes to `/run/projectboard/listener.json`. |
| `pb-health.timer` | Every 2 min, as root (`ops/pb-health`). Network: brings Wi-Fi back up, restarts NetworkManager, and reboots after 10 min down (at most 1 an hour and 3 a day). It also restarts Tailscale, a stuck listener or the webcam when needed, and logs temperature, disk and throttling. |
| `pb-mode.timer` | Every minute (`ops/pb-mode`). Night (23:00–08:00 by default, from the clock) stops the kiosk and turns the screen off; day turns them back on. The listener clears the LEDs and ignores casts at night by itself. In the day the screen also stays off while `/run/projectboard/screen-off` exists (PB Console's Screen off; gone at the next reboot). |
| `pb-weekly-reboot.timer` | Monday 07:45, skipped if the Pi has been up under an hour. |
| `pb-bootcheck.timer` | 3 min after each boot, one `pb-boot` line: "came up OK" or what failed. |
| `board-cam` | The webcam on the back of the board, for Tailscale devices only: `http://projectboard:8080/stream`. |
| `pb-netlog` | 60 s after each boot, a network report to `/boot/firmware/netlog.txt`, readable from the SD card when SSH is down. |
| `pb-ledmap` | **Not enabled; started by hand.** The LED mapping tool (below): a web page on `http://projectboard:8081/` (Tailscale only) for finding LEDs that don't sit under their holds. It pauses `pb-listener` while it runs. |
| `pb-netwatch` | The Wi-Fi watchdog (`ops/pb-netwatch.sh`, v2; see "Wi-Fi"). In the repo and installed by `install.sh` since 31 Oct 2026. |
| `kiosk` | cage + Chromium showing the app's wall-screen mode (`https://symmetryboard.co.uk/?wall`) on the touchscreen. Installed 26 Oct 2026; `?wall` and `--deny-permission-prompts` added 27 Oct (deploy, then `sudo systemctl restart kiosk`: install.sh doesn't restart the screen itself). |

Also installed:
- the hardware watchdog (`RuntimeWatchdogSec=15`);
- the persistent journal, capped (below);
- the kiosk's pieces: `cage`, `chromium`, the `kiosk` user, `/etc/pam.d/kiosk` (`conf/kiosk.pam`) and a blank cursor theme in `/usr/share/kiosk-cursors` (set up by hand on 26 Oct; in `install.sh` since 31 Oct 2026);
- no random Wi-Fi MAC while scanning (the connection itself uses a random one since 28 Oct: see "Wi-Fi").

**SD-card wear** (31 Oct 2026, after the first card died; `install.sh`): the journal stays on the card (the Wi-Fi faults were found from earlier boots' logs) but is capped at 100 MB and a month, stores nothing below info and is written every 15 minutes (`conf/pb-journal.conf`); Chromium's HTTP cache is in RAM (`/run/kiosk-cache`, 64 MB, `kiosk.service`), while its profile (the service worker's offline copy) stays on the card; apt's daily timers and `man-db.timer` are off (nothing installs itself here); a `dphys-swapfile` swap file, if the image has one, is turned off.

**Relays:** not built. `listener/power.py` is the hook for switching the LED supplies at night once the relay module is fitted.

## Circuits (30 Oct 2026)

A `cast_circuit` (contract §8) runs a circuit: a 5 s countdown on the start holds, then one move every `interval` seconds in Ross's "Pulse and fade" look (solid blue to go to, amber swelling for the one after, soft red fading on the hold let go of; a match stays solid; at the top of a run done once, the route runs up in green). `listener/circuit.py` is a port of direction 4 in `tools/circuit-led-simulator.html`: change both together. A `stop` with the run's token (or none), the finish, a problem cast, night, or `CIRCUIT_MAX_S` (1800 s) ends it, and the board crossfades into idle. The journal shows `circuit received`, `circuit started`, `stop received`, and `circuit ended: 'Name' <how> after N moves (S s), …` when it ends (PB Console's Activity reads that one), then the `LEDs: idle …` line. Tests: `pi/tests/test_circuit.py`.

## Live preview while setting (30 Oct 2026)

While someone sets a problem (the phone's Create or Edit, or the wall screen's Create page), the app sends `preview_holds` with the whole selection on every change (contract §9). The LED thread's `preview` state lights it at once in a cast's colours and brightness (`board.preview_frame()`, never mirrored, the feet sign from the rule being set) and keeps it until an `end`, 60 s with no message (`PREVIEW_TIMEOUT_S`; the app sends a keep-alive every 20 s), night, or SIGUSR1; then idle. A problem cast or another person's preview takes the board (the latest wins) and that session stays dark until the app's **Show on board**; a circuit run makes it wait and it comes back after the run. The journal shows `LEDs: preview <token>: N LEDs`, `… taken over by a problem cast`, `… shown again`, `… waits for the circuit`, `… ended`, never a line per tap. `listener.json` shows `leds: preview`, and the busy check counts it. Tests: `pi/tests/test_preview.py`.

**The wall key** (db/35): `install.sh` makes `/etc/projectboard/wall-key` once (32 random bytes, `root:kiosk 0640`) and prints its SHA-256; `kiosk.service` opens `/?wall#k=<key>`, so the wall screen can make problems through `wall_create_problem()`, and the database keeps only the hash (`wall_keys`). The key is never copied off the Pi, printed or committed. To replace it: delete the file on the Pi, deploy, put the printed hash in `wall_keys` (and revoke the old row), then restart the kiosk. The kiosk unit change applies the next time `pb-mode` starts it (or `sudo pb-console-helper unit restart kiosk`).

## Idle patterns

From `IDLE_AFTER_S` (1200 s) after the last cast, and when the listener starts or the night ends in the daytime, the board runs an idle pattern. It fades in over 1.5 s from whatever was lit. A cast cuts straight in, with no fade. At 23:00 everything fades to black over 3 s. The same brightness, gamma (2.2), `IDLE_MAX_AMPS` cap and frame rate apply to every pattern.

| Pattern | What it does | Pi 4 ms/frame |
|---|---|---|
| `glisten` (default) | a navy, teal and violet shimmer, cool white sparkles, now and then a diagonal glint | 3.1 |
| `chase` | four comets (pink, blue, green, gold) with fading tails chasing round a loop just inside the edge on an otherwise dark board, weaving, now and then one surging past | 3.3 |
| `lava` | big soft blobs drifting slowly, merging (their colours blend) and glowing in and out | 4.1 |
| `breathe` | the whole board breathing between two palette colours, each breath rising from the bottom row; the pair moves on every 5 breaths | 2.5 |
| `aurora` | slow horizontal bands, green low to pink high, rippling across the board | 3.2 |
| `rain` | soft drops falling down the columns with short trails | 2.4 |
| `ripples` | rings spreading from random spots and fading | 2.8 |
| `fireflies` | a handful of warm points fading in and out, drifting slightly | 2.6 |
| `wave` (chosen 28 Oct) | a vertical band 15% of the board wide sweeping left to right and back every 8 s on a dark board: green in the bottom quarter (rows 1–3), red in the top three rows, blue between | 1.1 |
| `teaser` | every 15–25 s a random benchmark problem fades in (its cast colours, dimmer), holds 5 s and fades out, over a turned-down shimmer | 3.2 |

The colours come from the app's `tokens.css` (accent pink, the hold colours, gold), copied into `listener/patterns/common.py` (a test checks they still match). Frame times were measured on the Pi on 28 Oct 2026 with `pi/tools/idle_bench.py`, with the listener and kiosk running; SPI adds about 6 ms (frames write the board's 248 pixels, not all 1200). At a pattern change the new pattern is created in one frame: up to ~20 ms once, still inside the 33 ms frame.

- **Settings** (`config.env`, a restart applies them): `IDLE_PATTERN` (a name, or `cycle`), `IDLE_CYCLE` (the names to cycle through, comma or space separated; empty = all ten), `IDLE_CYCLE_MIN` (minutes each, 10; a 3 s crossfade between them; the position follows the clock, so a cast doesn't send the cycle back to the start). Also `IDLE_ANIMATION=on|off` (off just clears the strip when idle), `IDLE_AFTER_S`, `IDLE_BRIGHTNESS` (0–1), `IDLE_MAX_AMPS` (2.0: 60 mA a pixel at full white; the whole frame is scaled down and it's logged once if it goes over), `IDLE_FPS` (30). An unknown name is logged and left out (Glisten if nothing's left).
- **Try them live, no deploy:** `pb-idle` on the Pi (as pi). `pb-idle list` shows them and what's on; `pb-idle <name>` switches now with a crossfade, until the next listener restart or `pb-idle default`; `pb-idle cycle` runs `IDLE_CYCLE`; `pb-idle tour` shows each pattern for 60 s (each named in the journal: `journalctl -u pb-listener`) and follows along in the terminal, then goes back to the default; `pb-idle now` goes idle now (clears a lit problem); `pb-idle off` takes the board dark now (a lit problem too) and keeps idle dark, while casts still light, until `pb-idle default` or a pattern; `pb-idle brightness 0.5` dims everything, casts and idle, to that share of the configured brightness (0.05–1, never brighter). Like a pattern, these last until the listener restarts. It writes `/run/projectboard/idle-pattern` and sends the listener SIGUSR2: the listener keeps running, a lit problem stays lit (the choice shows at the next idle) and night still wins. `pb-status` shows the pattern and the plan.
- **Code:** `listener/patterns/`, one module per pattern (pure; each has a Tunables block), `common.py` (the grid, gamma, the palette, the `Pattern` base class: `levels(t)` gives perceptual colours for the 247 cells) and `idle.py` (the registry, `Plan` and `Idle`: plans, crossfades, brightness, gamma and the cap). `listener/renderer.py` is the LED thread, the only writer to the strip (cast / circuit / preview / idle / night). The event loop only posts to it, so casts, the heartbeat and the watchdog never wait on it.
- **Failures:** a pattern that throws, or returns a bad frame, is logged once and replaced by Glisten (and skipped from then on, until a restart). If Glisten itself throws, idle stays dark until a restart; casts carry on. If the LED thread dies or stops for 20 s, the listener exits and systemd restarts it.
- **The teaser's problems:** the listener reads the benchmark problems (`is_benchmark`, one small read with the anon key) when it first joins and every 30 minutes; a failed read is a warning and keeps the last ones. Shown unmirrored.
- **Safety:** nothing changes the whole board at once (breathe takes 9 s a breath and rises up the board); Glisten's sparkles are single cells, a cell at most once every 2 s. A test checks every pattern: at most 3 cells jump frame to frame.
- **Preview on the laptop** (the same code): `python tools/idle_preview.py`, then double-click `tools/idle-preview.html` (gitignored, about 3 MB): every pattern side by side, a big view of the one you click, and a "cycle" tile showing the crossfades.
- **Bench on the Pi** (no strip touched, the listener keeps running): see the docstring in `pi/tools/idle_bench.py`.

## LED mapping

`pb-ledmap` finds LEDs that don't sit under their holds. It's a page served from the Pi (`ledmap/pb_ledmap.py` + `ledmap/index.html`), open in the laptop's browser over Tailscale with the webcam beside it, so it works from home too.

**What the page does:**
- **Tap:** click a cell and its LED lights. The grid shows every cell's grid ref, `holdN` and LED; empty cells are dashed. **Photo** shows the app's board photo with the 188 holds instead.
- **Walk:** step through the real holds (or all 247), along the strip or by hold number. `→` next, `←` back, `Space` OK, `W` wrong (then click where it really lit), `H` not visible.
- **Raw LED:** step through LED indices (1 to `STRIP_PIXELS - 1`, past the board's 247 too) and click where each one is.
- **Column check:** row 1 of every column green and row 13 red, so each column's direction shows at a glance. Click the letters to record them.
- **Light a problem:** a problem lit exactly as a cast lights it: the same order, roles, colours, mirror map, `BRIGHTNESS` and current cap.
- **Results:** OK / wrong / unchecked counts and a list of mismatches. **Export JSON** gives each hold's expected LED and observed cell, the raw LEDs, the columns and a `led_positions` table; **Download summary** gives a readable text version. Progress is kept in the browser (localStorage `pb-ledmap-v1`), so a refresh loses nothing.

**How it shares the strip:**
- `pb-ledmap.service` has `Conflicts=pb-listener.service`. Starting it stops the listener, which clears the strip, and anything that starts the listener stops it first. That includes a **deploy**, which ends a mapping session.
- Its `ExecStopPost` starts the listener again however the session ends: Finish on the page, Ctrl+C in `pb-ledmap`, `pb-ledmap stop`, 30 minutes without a click (status polling doesn't count), a crash, or a failed start.
- It's never enabled, so any reboot (weekly, pb-health's, pb-netwatch's) comes back to the listener.
- `pb-health` never restarts a stopped listener. While pb-ledmap runs it logs "pb-listener paused for LED mapping" instead of a warning.
- **Night:** mapping works at night as it is: `pb-mode` doesn't touch the LEDs (the relays aren't built), and the listener's night logic and the idle patterns stop with the listener. When you finish, the listener comes back dark until 08:00. Once the relays switch the LED supplies, `pb-mode` will need to skip that while pb-ledmap runs.
- It writes the strip through `leds.Strip` (R, G, B; LED 0 is never lit), at brightness 0.3 (the slider goes 0.05 to 0.6), under the listener's current cap. Only the HTTP server writes, one request at a time.
- Bound to the Tailscale address only, port 8081. Every POST must be JSON (a cheap guard against other web pages posting to it).

**Using it:**

```
ssh -t pi@projectboard pb-ledmap           # Git Bash: pauses the listener, prints the URL, follows the log
                                           # open http://projectboard:8081/ ; Ctrl+C here or Finish on the page ends it
ssh pi@projectboard pb-ledmap status       # is it running, and the listener
ssh -t pi@projectboard pb-ledmap stop      # end it from another terminal
```

**On the laptop** (no Pi, the strip printed instead): `python pi/ledmap/pb_ledmap.py --dry-run --host 127.0.0.1 --config pi/config.env`, then open `http://127.0.0.1:8081/`. It finds the board photo and hold map in `app/`; `deploy.sh` copies them next to the page on the Pi (`board-fallback.jpg` as `board.jpg`).

## PB Console

The laptop's admin console (`console/`, `bash console/start.sh`; see `console/README.md`) does most of what follows from a browser page: the health tiles, services, the LEDs, night mode, logs. Its root commands go through one helper, installed by `install.sh`:

- `/usr/local/sbin/pb-console-helper` (`ops/pb-console-helper`), root-owned. It takes only: `unit start|stop|restart` for `pb-listener`, `kiosk`, `board-cam`, `pb-netwatch`, `pb-health.timer`, `pb-mode.timer`; `reboot`; `night auto|day|night` (`NIGHT_FORCE`); `night-hours HH:MM HH:MM`; `screen on|off`; `backups`; `config-set KEY=VALUE...`, `config-restore <backup>` and `config-put` (a whole file on stdin), each key and value checked against its list (`KEYS`), restarting the listener only when a key it reads at start changed; `ledmap start|stop`; `hashes` (root-only files, for the drift check); `nm-export <connection>` and `backup` (a tar.gz on stdout), both with every password/psk/secret line removed; `test <step>` for the R8 acceptance tests (kill or freeze the listener, drop the Wi-Fi, block Supabase, set the clock, the weekly-reboot skip), each cutting step scheduling its own undo first. It checks every argument, never uses a shell, logs each command to the journal as `pb-console`, and backs up `config.env` to `/var/lib/projectboard/config-backups/` (30 kept) before it changes it.
- `/etc/sudoers.d/pb-console` (`conf/pb-console.sudoers`): `pi` may run that helper, and nothing else, without a password. `install.sh` installs it only if `visudo -cf` accepts it.
- `/etc/sudoers.d/pb-deploy` (`conf/pb-deploy.sudoers`, since 30 Oct 2026): `pi` may run `bash /home/pi/pb-deploy/install.sh` (with or without `--dry-run`) as root without a password, so `deploy.sh` and PB Console deploy unattended. The trade-off: `~/pb-deploy` is pi's own folder, so a login as `pi` (Tailscale + the laptop's SSH key) can reach root without the password. To undo: `sudo rm /etc/sudoers.d/pb-deploy` and delete the file from the repo.

By hand: `ssh pi@projectboard sudo pb-console-helper screen on` (for example).

## Looking at it (Git Bash on the laptop, over Tailscale)

```
ssh pi@projectboard pb-status                                   # everything at a glance
ssh pi@projectboard 'journalctl -u pb-listener --since "1 hour ago"'   # casts and connection
ssh pi@projectboard 'journalctl -t pb-health -t pb-mode -t pb-boot --since today'
```

Every self-healing action is a journal line starting `ACTION <name>:`, and `pb-status` counts them over 24 h and 7 days. A count that keeps growing is a fault to fix, not something to ignore.

## Deploying

From the repo root in Git Bash. Deploying restarts the listener, which clears the board, so do it when the gym is closed:

```
bash pi/deploy.sh --dry-run    # lists what would change
bash pi/deploy.sh              # installs; no password since pb-deploy (30 Oct 2026), else sudo asks once
```

PB Console's Deploy tab runs the same script, with no password (the `pb-deploy` rule). The old `--sudo-stdin` mode was removed on 30 Oct 2026.

`deploy.sh` copies `pi/` to `~/pb-deploy` on the Pi with scp and runs `install.sh` there. `install.sh` only installs files that differ, and restarts only what those files affect. (The 26 Oct stopgap `cast-listener` went with the first card; there's no stopgap to roll back to now: roll back with `git revert` and a deploy.)

**Settings:** edit `pi/config.env` on the laptop (start from `config.env.example`), then deploy. The night times are re-read every 30 s. `NIGHT_FORCE=day` or `NIGHT_FORCE=night` overrides the clock for tests and late events.

## Tests

On the laptop (no Pi, no network):

```
python -m unittest discover -s pi/tests
```

The tests check the LED map against `tools/led_map.json`, the hold order and roles against the app's rules, mirroring, the brightness cap and day/night, `test_glisten.py` the LED thread's states (a cast cuts into idle, idle after the timeout, night wins), the idle current cap, pixel 0 off and the sparkle limits, and `test_patterns.py` every idle pattern (frame time, the 2 A cap, pixel 0, the board only, no flashes, brightness near Glisten's), the crossfade, the fallback to Glisten and pb-idle's commands, and `test_ledmap.py` the mapping tool (its map against `led_map.json` and the app's 188 holds, no two holds at one position, request checks, the column check, a problem lit as `board.frame()` lights it, the idle clock, and its HTTP server on 127.0.0.1). `test_circuit.py` and `test_preview.py` cover circuit runs and the live preview (its payload checks, colours, and the precedence against casts, circuits, other previews, night and idle). `install.sh` refuses to deploy a `listener/*.py` that isn't on its file lists (`circuit.py` was missed once). To try the listener on the laptop: `python pi/listener/pb_listener.py --dry-run --config pi/config.env --no-status`. It joins the real channel and prints the LEDs it would light, so a cast from `tools/cast-test.html` shows up there. On the Pi, `leds.py --show "<name>" [--mirror] [--dry-run]` lights one problem and `leds.py --off` clears the strip.

**Stop the listener before any LED test on the Pi** (`leds.py`, `tools/led_test.py`): while `pb-listener` runs it keeps drawing the idle pattern, so whatever a test writes is overwritten straight away. `ssh -t pi@projectboard 'sudo systemctl stop pb-listener'`, test, then `sudo systemctl start pb-listener`.

The acceptance tests (kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across 23:00 and 08:00, boot with no network) are a checklist in the plan doc, section R8.

## A fresh SD card

**`pi/firstboot/README.md`** (31 Oct 2026): Imager writes Raspberry Pi OS Lite with its customisation but no Wi-Fi, `python pi/firstboot/make-card.py D:\` adds the rest, and the card sets itself up at its first boot (`setup.sh`, then a clone of the repo and `install.sh`), logging to `firstboot.log` on the card, then reboots once. It lists everything the old card held outside the repo and where each comes from now. `setup.sh` still works by hand: `sudo bash /boot/firmware/projectboard/setup.sh`, then `bash pi/deploy.sh` from the laptop.

## Wi-Fi (28 Oct 2026)

**Random hardware address per connection.** After a disconnect and quick rejoin with the same address, the gym's access point stopped answering the join (`CTRL-EVENT-ASSOC-REJECT bssid=00:00:00:00:00:00 status_code=16` in the wpa_supplicant log, before any password is used). This cut the Wi-Fi after reboots on 26 Oct (11:42, 16:48) and 28 Oct (12:11). `hangout-fixed` now has `802-11-wireless.cloned-mac-address=random` (it was `permanent`), and `setup.sh` writes the same for a fresh card. Verified 28 Oct with an immediate reconnect and two back-to-back reboots. The LAN IP now changes per connection; Tailscale, `projectboard` and `board-cam` (bound to the Tailscale IP) don't care.

**Watchdog and rescue hotspot** (in the repo since 31 Oct 2026: `ops/pb-netwatch.sh` and `systemd/pb-netwatch.service`, installed by `install.sh`; the hotspot profile holds a password, so `setup.sh` writes it from `secrets.env`):
- `pb-netwatch` (`/usr/local/sbin/pb-netwatch.sh`, v2) checks every 30 s: it kicks the Hangout connection at 2 and 6 failed checks, restarts NetworkManager at 4, opens the rescue hotspot for 15 minutes at 8, and reboots at 12 (at most 3 times).
- `pb-rescue` (`/etc/NetworkManager/system-connections/pb-rescue.nmconnection`): an access point with SSID `projectboard-rescue`, `ipv4.method=shared` (the Pi is 10.42.0.1), autoconnect off. Its password is `RESCUE_PSK` in the laptop's gitignored `pi/secrets.env` (new on 31 Oct 2026). **Working over the hotspot:** `sudo systemctl stop pb-netwatch` first, or it will tear the hotspot down.
- `pb-netlog` now includes `-u wpa_supplicant`, and the wpa_supplicant logs are kept across boots.

Still to do: decide on Wi-Fi power saving (on, per the kernel log). (The Imager profile `netplan-wlan0-Hangout` is gone with the old card; a new card gets no Wi-Fi from Imager.)

## Wiring (temporary but working, 28 Oct 2026)

Loose on a ledge behind the board for now; it gets tidied into the junction box, and the relay module and 74AHCT125 go in when they arrive.

**Supplies:** two YU0510 5 V 10 A bricks on one mains lead through a splitter, DC plugs cut. On both, the **plain conductor is +** and the printed one is −. Both are needed together to start the strip.

**Power enters the strip at six points:** the 4-way cable plus five feeds from the two 8-way harness plugs. Measured 28 Oct: no short between the 5 V and GND buses before connecting; **5.5 V under load** after, and all-on dim white is white at the far end.

**5 V side** (red 16 AWG links):
- Main 5 V Wago: supply 1 +, supply 2 +, a red link to the 5 V bus Wago.
- 5 V bus Wago: that link, plus red links to rows 1 and 2 of the 5 V terminal piece.
- 5 V terminal piece: row 1, left = red link + 4-way blue, right = B1 + B4; row 2, left = red link + B5, right = B6 + B7.

**GND side** (blue 16 AWG links):
- Main GND Wago: supply 1 −, supply 2 −, a blue link to GND bus Wago 1.
- GND bus Wago 1: that link, a blue link to GND terminal row 1, and a blue link to GND bus Wago 2.
- GND bus Wago 2: that link, a blue link to GND terminal row 2, and the **Pi ground** (Pi pin 25) in its own hole.
- GND terminal piece: row 1, left = blue link + 4-way black, right = A2 + A3; row 2, left = blue link + A5, right = A6 + A7.

**Data** (the old terminal strip): 4-way green ← Pi pin 19 (MOSI, data); 4-way red ← Pi pin 23 (SCLK, clock). No level shifter (3.3 V direct works) and no relays yet.

**The 4-way strip cable:** blue = 5 V, black = GND, green = data, red = clock.

**The harness** (two 8-way plugs, positions 1–8 left to right with the screws facing you): plain-white plug B1, B4–B7 = 5 V; black-and-white striped plug A2, A3, A5–A7 = GND. A1, A4, A8, B2, B3 and B8 connect to nothing and stay in the plugs.

**Ratings:** the terminal pieces are 3 A each. Normal use is well under that (a cast is under 1 A; all-on at 10% is about 1.5 A). Only a full-on power-up after a power cut briefly exceeds it, until the Pi boots and `leds-off-at-boot` clears the strip. A few 5-port Wagos (221-415) would make a cleaner power bus when it's boxed.

**Touchscreen:** video on the Pi's second HDMI port (DRM connector `HDMI-A-2`, through the micro-HDMI adapter), touch over USB (a G2Touch multi-touch device).

## Other files

- `tools/led_test.py` and `tools/relay_test.py`: the bring-up tests (colour check, pixel walk, all on; the relays on BCM 23 and 24).
- `pi/_old/` (local only, gitignored): the June 2026 Pi 3 listener and the 26 Oct stopgap.
