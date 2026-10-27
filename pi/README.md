# pi/: the board's Raspberry Pi

Everything that runs on the Pi 4 behind the board: the cast listener that lights the LEDs, and the services that keep it running unattended. The app side of casting is in `docs/cast-contract.md`. The plan and the reasons behind it are in the local, uncommitted `docs/pi4-listener-kiosk-plan.md`.

**Nothing secret lives here.** The Pi's settings are in `/etc/projectboard/config.env` on the Pi. The laptop keeps its copy in `pi/config.env`, which is gitignored. The Wi-Fi password and the Tailscale key only ever go through `secrets.env` on the SD card's boot partition (for `setup.sh`), which is also gitignored.

## What runs

| Unit | What it does |
|---|---|
| `leds-off-at-boot` | Clears the strip early in boot (`leds.py --off`). |
| `pb-listener` | The cast listener (`listener/pb_listener.py`). It joins Supabase Realtime `board:HangoutPortland`, and on each `cast_problem` looks the problem up by name and lights it (contract §6). systemd restarts it if it exits, and its watchdog restarts it if it freezes for 30 s. Status goes to `/run/projectboard/listener.json`. |
| `pb-health.timer` | Every 2 min, as root (`ops/pb-health`). Network: brings Wi-Fi back up, restarts NetworkManager, and reboots after 10 min down (at most 1 an hour and 3 a day). It also restarts Tailscale, a stuck listener or the webcam when needed, and logs temperature, disk and throttling. |
| `pb-mode.timer` | Every minute (`ops/pb-mode`). Night (23:00–08:00 by default, from the clock) stops the kiosk and turns the screen off; day turns them back on. The listener clears the LEDs and ignores casts at night by itself. |
| `pb-weekly-reboot.timer` | Monday 07:45, skipped if the Pi has been up under an hour. |
| `pb-bootcheck.timer` | 3 min after each boot, one `pb-boot` line: "came up OK" or what failed. |
| `board-cam` | The webcam on the back of the board, for Tailscale devices only: `http://projectboard:8080/stream`. |
| `pb-netlog` | 60 s after each boot, a network report to `/boot/firmware/netlog.txt`, readable from the SD card when SSH is down. |
| `kiosk` | cage + Chromium showing the app's wall-screen mode (`https://symmetryboard.co.uk/?wall`) on the touchscreen. Installed 26 Oct 2026; `?wall` and `--deny-permission-prompts` added 27 Oct (deploy, then `sudo systemctl restart kiosk`: install.sh doesn't restart the screen itself). |

Also installed:
- the hardware watchdog (`RuntimeWatchdogSec=15`);
- a 200 MB cap on the persistent journal;
- no random Wi-Fi MAC.

**Relays:** not built. `listener/power.py` is the hook for switching the LED supplies at night once the relay module is fitted.

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
bash pi/deploy.sh              # installs; sudo asks for the Pi's password once
```

`deploy.sh` copies `pi/` to `~/pb-deploy` on the Pi with scp and runs `install.sh` there. `install.sh` only installs files that differ, and restarts only what those files affect. On its first run it disables the stopgap `cast-listener`.

**Rollback** to the stopgap (its files stay in `/home/pi`):

```
ssh -t pi@projectboard 'sudo systemctl disable --now pb-listener && sudo systemctl enable --now cast-listener'
```

**Settings:** edit `pi/config.env` on the laptop (start from `config.env.example`), then deploy. The night times are re-read every 30 s. `NIGHT_FORCE=day` or `NIGHT_FORCE=night` overrides the clock for tests and late events.

## Tests

On the laptop (no Pi, no network):

```
python -m unittest discover -s pi/tests
```

The tests check the LED map against `tools/led_map.json`, the hold order and roles against the app's rules, mirroring, the brightness cap and day/night. To try the listener on the laptop: `python pi/listener/pb_listener.py --dry-run --config pi/config.env --no-status`. It joins the real channel and prints the LEDs it would light, so a cast from `tools/cast-test.html` shows up there. On the Pi, `leds.py --show "<name>" [--mirror] [--dry-run]` lights one problem and `leds.py --off` clears the strip.

The acceptance tests (kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across 23:00 and 08:00, boot with no network) are a checklist in the plan doc, section R8.

## A fresh SD card

`setup.sh` goes on the boot partition with `secrets.env` (`TS_AUTHKEY`, `WIFI_SSID`, `WIFI_PSK`) and `laptop_key.pub`. Run `sudo bash /boot/firmware/projectboard/setup.sh`, **reboot once to test the Wi-Fi**, then run `bash pi/deploy.sh` from the laptop.

## Other files

- `tools/led_test.py` and `tools/relay_test.py`: the bring-up tests (colour check, pixel walk, all on; the relays on BCM 23 and 24).
- `pi/_old/` (local only, gitignored): the June 2026 Pi 3 listener and the 26 Oct stopgap.
