# pi/firstboot: a new SD card that sets itself up

Written on 31 Oct 2026, when the Pi 4's card died. A card made this way goes in the Pi, is powered on, and comes back as the board on its own: hostname `projectboard`, the gym Wi-Fi, Tailscale, the listener, the kiosk, the watchdogs, night mode, `pb-netwatch` and the rescue hotspot, passwordless deploys. Nothing secret is in the repo: the secrets go only through the laptop's gitignored `pi/secrets.env` and the card.

## What the old card held that isn't in the repo, and where it comes from now

| What | Where it comes from on a new card |
|---|---|
| OS user `pi` (password, the laptop's SSH key), hostname, timezone, keyboard | Raspberry Pi Imager's customisation (cloud-init `user-data`); `setup.sh` adds the SSH key again from `laptop_key.pub` |
| SPI on (`dtparam=spi=on`) | `make-card.py` writes it into `config.txt` before the first boot |
| Wi-Fi country (GB) | `make-card.py` adds `cfg80211.ieee80211_regdom=GB` to `cmdline.txt`; `setup.sh` runs `raspi-config nonint do_wifi_country GB` and unblocks the radio |
| The `hangout-fixed` connection with `cloned-mac-address=random` (the 28 Oct fix) and no random MAC while scanning | `setup.sh` step 3, from `WIFI_SSID`/`WIFI_PSK` in `secrets.env`. **Imager gets no Wi-Fi**, so there's no netplan profile (the 26 Oct fault) |
| The `pb-rescue` hotspot profile (`projectboard-rescue`, 10.42.0.1) | `setup.sh` step 3, from `RESCUE_PSK` (a new password: the old one went with the card) |
| `pb-netwatch.sh` v2 and its unit | now in the repo (`pi/ops/pb-netwatch.sh`, `pi/systemd/pb-netwatch.service`), installed by `install.sh`; `firstboot.sh` starts it first |
| Tailscale identity | a new machine: `setup.sh` joins with a one-off auth key (`TS_AUTHKEY`) as `projectboard`. The old machine must be removed from the admin first so the name is free |
| `/etc/projectboard/config.env` | the laptop's `pi/config.env` (the anon key, which is public), installed by `install.sh` |
| The wall key | a new one, made on the laptop (`WALL_KEY`), written by `setup.sh`; its hash went into `wall_keys` by db/36, which revoked the old one. The laptop's copy is deleted once the card is made |
| The kiosk: `cage`, `chromium`, the `kiosk` user, `/etc/pam.d/kiosk`, the blank cursor theme | now in `install.sh` (they were set up by hand on 26 Oct) |
| sudoers `pb-console` and `pb-deploy` | `install.sh` (unchanged) |
| Persistent journal, `pb-netlog` | `setup.sh` and `install.sh` |
| The 26 Oct stopgap `cast-listener` | gone for good (not needed: `install.sh` copes without it) |

## Making a card

1. **Tailscale**, at https://login.tailscale.com/admin/machines: the old `projectboard` → `…` → **Remove**. Then **Settings → Keys → Generate auth key**: not reusable, not ephemeral, expiry 7 days, pre-approved on (if device approval is on), no tags. Paste the `tskey-auth-…` after `TS_AUTHKEY=` in `pi\secrets.env` (Notepad), save.
2. **Raspberry Pi Imager 2** (v2.0.6 or newer): device Raspberry Pi 4; OS Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)** (trixie); storage the card. Customisation: hostname `projectboard`; capital city London, time zone Europe/London, keyboard `gb`; username `pi` and its password; **Wi-Fi: leave empty / skip**; SSH on, public-key authentication with the laptop's `id_ed25519.pub`; Raspberry Pi Connect off. Write. Imager ejects the card at the end: take it out and put it back.
3. From the repo root (after `pi/` is committed and pushed): `python pi/firstboot/make-card.py D:\` (the card's boot partition). It refuses anything that isn't an Imager-written Pi boot partition, copies the files, edits `config.txt`, `cmdline.txt` and `user-data`, reads everything back and prints `READY` or what's wrong. `--check` only checks.
4. Delete `WALL_KEY` from the laptop's `pi\secrets.env` (the key lives only on the card and the Pi).

## What happens at the first boot

1. Raspberry Pi OS's own first boot (it may reboot once by itself), then cloud-init applies `user-data`; its `runcmd` installs and starts `pb-firstboot.service`.
2. `firstboot.sh`: starts `pb-netwatch`, runs `setup.sh` (Wi-Fi, waits up to 10 min for the internet, timezone, apt with the kiosk packages, SSH key, Tailscale, the wall key, journal), clones https://github.com/rlmck/projectboard (else uses the card's copy in `projectboard/repo/`), stages `~/pb-deploy` as `deploy.sh` does, runs `install.sh`, checks the services, deletes `secrets.env`, and **reboots once**.
3. After that reboot the wall screen shows the app (in the day; 23:00–08:00 it stays off), and casts light the board.

**Where to look:** the wall screen shows the setup's progress while it runs. Everything is in `firstboot.log` in the card's `projectboard` folder (readable on the laptop), and on the Pi in `journalctl -u pb-firstboot`. `netlog.txt` and `netwatch.txt` on the card show the Wi-Fi.

**If something fails:** it tries again 60 s later and at every boot, until it's done (no internet just delays it). `pb-netwatch` kicks the Wi-Fi, opens the `projectboard-rescue` hotspot (password: `RESCUE_PSK` in the laptop's `pi\secrets.env`) and reboots up to 3 times. If Tailscale won't join, the board still works and it retries every 10 minutes with the key kept on the card.

**The first SSH from the laptop** meets a new host key: `ssh -o StrictHostKeyChecking=accept-new pi@projectboard true` once (the old card's entries were removed from `known_hosts` on 31 Oct 2026). Then in the Tailscale admin, `projectboard` → `…` → **Disable key expiry**.

## A backup image of a working card

With the Pi shut down (`ssh -t pi@projectboard sudo poweroff`, wait for the green LED to stop), put the card in the laptop. **Win32 Disk Imager** (free): Image File `Documents\_Archive\ProjectBoard\projectboard-YYYY-MM-DD.img`, Device = the card's boot drive letter, tick **Read Only Allocated Partitions**, **Read**. Restoring: Raspberry Pi Imager → Use custom → that `.img`, no customisation. A restored card has the same Tailscale identity and wall key, so it's a drop-in spare. The image holds the Wi-Fi password and the wall key: keep it off any shared drive.
