#!/bin/bash
# ProjectBoard Pi 4 bring-up: one run gets a freshly imaged card onto the gym
# Wi-Fi and Tailscale, ready for install.sh (the board's own services).
#
#   1  read secrets.env (WIFI_SSID, WIFI_PSK, TS_AUTHKEY, RESCUE_PSK, WALL_KEY) from this folder
#   2  Wi-Fi country GB (Raspberry Pi OS keeps the radio off until it's set)
#   3  Wi-Fi: the "hangout-fixed" connection (random MAC per join: the 28 Oct 2026 fix),
#      no random MAC while scanning, and the pb-rescue hotspot profile (off until pb-netwatch needs it)
#   4  wait for the internet (up to 10 min; exit 3 if it never comes, so pi/firstboot retries)
#   5  timezone Europe/London, and the clock synced
#   6  apt: update, install git, curl, the Python packages and the kiosk (cage, chromium)
#   7  the laptop's SSH key into /home/pi/.ssh/authorized_keys (password login stays on)
#   8  Tailscale: install, then join as "projectboard"
#   9  the wall key (db/35) into /etc/projectboard/wall-key, if secrets.env has one
#  10  persistent journal and pb-netlog (a network report on the boot partition)
#  11  read-only checks (SPI is on in config.txt; nothing here drives a GPIO pin)
#  12  delete secrets.env once Tailscale is up
#  13  summary
#
# On a fresh card pi/firstboot/firstboot.sh runs this unattended at the first boot,
# then install.sh (pi/firstboot/README.md). By hand:
#   sudo bash /boot/firmware/projectboard/setup.sh
# Safe to run again: every step checks what's already done.
# Exit codes: 0 done; 2 done but a check failed (step 11); 3 no internet; other = a step failed.
#
# Why step 3: on 26 Oct 2026, after the first reboot, the Pi joined the Wi-Fi but got
# no IPv4; NetworkManager's netplan-backed connection (from Imager's Wi-Fi settings)
# had been rewritten at that boot. The fix was a plain keyfile connection
# (autoconnect-priority 100) plus no random MAC while scanning. 28 Oct 2026: the
# connection's MAC is random per connection (it was pinned to the permanent one):
# the access point stopped answering quick rejoins with the same MAC
# (ASSOC-REJECT status_code=16). See pi/README.md. So: don't give Imager the Wi-Fi.
# Wi-Fi power saving is left at the default (turning it off didn't help).

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "Run it with sudo:  sudo bash /boot/firmware/projectboard/setup.sh"
    exit 1
fi

HERE=/boot/firmware/projectboard
SECRETS="$HERE/secrets.env"
LAPTOP_KEY="$HERE/laptop_key.pub"
CONFIG=/boot/firmware/config.txt
PI_USER=pi
PI_HOME=/home/pi
NM_DIR=/etc/NetworkManager/system-connections
NM_CONN=hangout-fixed
NM_KEYFILE=$NM_DIR/$NM_CONN.nmconnection
RESCUE_KEYFILE=$NM_DIR/pb-rescue.nmconnection
NO_RAND_MAC_CONF=/etc/NetworkManager/conf.d/98-projectboard-no-rand-mac.conf
WALL_KEY_FILE=/etc/projectboard/wall-key
PACKAGES="git curl python3-spidev python3-gpiozero python3-lgpio python3-websockets ustreamer cage chromium"
APT_OPTS="-o DPkg::Lock::Timeout=300 -o Acquire::Retries=3"
STEP="start"

trap 'echo; echo "!! setup.sh stopped at step: $STEP (line $LINENO). Fix that and run it again."' ERR

step() {
    STEP="$1"
    echo
    echo "== $1   ($(date '+%H:%M:%S'))"
}

# One value from secrets.env, without running the file. Copes with Notepad's
# CRLF line endings, a UTF-8 BOM and surrounding quotes.
read_secret() {
    [ -f "$SECRETS" ] || return 0
    sed -e 's/^\xEF\xBB\xBF//' -e 's/\r$//' "$SECRETS" \
        | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" \
        | tail -n 1 \
        | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

online() {   # the internet, not just the access point
    curl -fsS -o /dev/null --max-time 10 https://github.com 2>/dev/null \
        || curl -fsS -o /dev/null --max-time 10 http://deb.debian.org/ 2>/dev/null
}


step "1/13  Secrets"
TS_AUTHKEY=""; WIFI_SSID=""; WIFI_PSK=""; RESCUE_PSK=""; WALL_KEY=""
if [ -f "$SECRETS" ]; then
    TS_AUTHKEY="$(read_secret TS_AUTHKEY)"
    WIFI_SSID="$(read_secret WIFI_SSID)"
    WIFI_PSK="$(read_secret WIFI_PSK)"
    RESCUE_PSK="$(read_secret RESCUE_PSK)"
    WALL_KEY="$(read_secret WALL_KEY)"
    for v in TS_AUTHKEY WIFI_SSID WIFI_PSK RESCUE_PSK WALL_KEY; do
        if [ -n "${!v}" ]; then echo "   $SECRETS: $v is set"; else echo "   $SECRETS: $v is empty"; fi
    done
else
    echo "   no $SECRETS (fine if Tailscale and the Wi-Fi connection are already set up)"
fi


step "2/13  Wi-Fi country GB"
if command -v raspi-config >/dev/null; then
    raspi-config nonint do_wifi_country GB || echo "   raspi-config do_wifi_country failed (carrying on)"
fi
rfkill unblock wifi 2>/dev/null || true
iw reg set GB 2>/dev/null || true
echo "   $(iw reg get 2>/dev/null | grep -m1 country || echo 'regulatory domain unknown')"


step "3/13  Wi-Fi: $NM_CONN, no random MAC while scanning, pb-rescue"
mkdir -p "$(dirname "$NO_RAND_MAC_CONF")" "$NM_DIR"
printf '[device]\nwifi.scan-rand-mac-address=no\n' > "$NO_RAND_MAC_CONF"
echo "   wrote $NO_RAND_MAC_CONF"
# Imager's Wi-Fi (netplan) profiles caused the 26 Oct fault: remove any.
for f in /etc/netplan/*.yaml; do
    [ -f "$f" ] || continue
    if grep -q 'wifis:' "$f"; then rm -f "$f"; echo "   removed $f (an Imager/netplan Wi-Fi profile)"; fi
done
if nmcli -t -f NAME connection show | grep -qx "$NM_CONN"; then
    echo "   connection $NM_CONN already exists: left alone"
elif [ -n "$WIFI_SSID" ] && [ -n "$WIFI_PSK" ]; then
    # The keyfiles hold passwords: written here from secrets.env, never kept in the repo.
    ( umask 077
    cat > "$NM_KEYFILE" <<EOF
[connection]
id=$NM_CONN
type=wifi
interface-name=wlan0
autoconnect=true
autoconnect-priority=100

[wifi]
mode=infrastructure
ssid=$WIFI_SSID
cloned-mac-address=random

[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_PSK

[ipv4]
method=auto

[ipv6]
method=auto
EOF
    )
    chmod 600 "$NM_KEYFILE"
    echo "   wrote $NM_KEYFILE"
else
    echo "   SKIPPED: no WIFI_SSID/WIFI_PSK in $SECRETS and no $NM_CONN connection yet"
fi
if nmcli -t -f NAME connection show | grep -qx pb-rescue; then
    echo "   pb-rescue already exists: left alone"
elif [ ${#RESCUE_PSK} -ge 8 ]; then
    ( umask 077
    cat > "$RESCUE_KEYFILE" <<EOF
[connection]
id=pb-rescue
type=wifi
interface-name=wlan0
autoconnect=false

[wifi]
mode=ap
ssid=projectboard-rescue
band=bg

[wifi-security]
key-mgmt=wpa-psk
proto=rsn
pairwise=ccmp
group=ccmp
psk=$RESCUE_PSK

[ipv4]
method=shared

[ipv6]
method=ignore
EOF
    )
    chmod 600 "$RESCUE_KEYFILE"
    echo "   wrote $RESCUE_KEYFILE (the projectboard-rescue hotspot; pb-netwatch opens it)"
else
    echo "   SKIPPED pb-rescue: no RESCUE_PSK (8+ characters) in $SECRETS"
fi
WIFI_PSK=
RESCUE_PSK=
nmcli connection reload
nmcli radio wifi on 2>/dev/null || true
if [ -f /etc/NetworkManager/conf.d/99-projectboard-wifi-powersave.conf ]; then
    echo "   note: the old power-save file is still active (/etc/NetworkManager/conf.d/99-projectboard-wifi-powersave.conf)"
fi


step "4/13  Waiting for the internet"
if online; then
    echo "   online"
else
    nmcli connection up "$NM_CONN" >/dev/null 2>&1 || true
    ok=0
    for i in $(seq 1 60); do          # 60 x 10 s = 10 min
        if online; then ok=1; break; fi
        if [ $((i % 12)) -eq 0 ]; then
            echo "   still offline after $((i / 6)) min: kicking $NM_CONN"
            nmcli connection up "$NM_CONN" >/dev/null 2>&1 || true
        fi
        sleep 10
    done
    if [ $ok -eq 0 ]; then
        echo "   NO INTERNET after 10 min. Wi-Fi now:"
        nmcli -f DEVICE,STATE,CONNECTION device status | sed 's/^/     /'
        trap - ERR
        exit 3
    fi
    echo "   online: $(ip -4 -br addr show wlan0 | tr -s ' ')"
fi


step "5/13  Timezone and clock"
timedatectl set-timezone Europe/London
timedatectl set-ntp true || true
for i in $(seq 1 18); do
    [ "$(timedatectl show -p NTPSynchronized --value)" = yes ] && break
    sleep 5
done
echo "   $(timedatectl show -p Timezone --value), $(date), synced: $(timedatectl show -p NTPSynchronized --value)"


step "6/13  apt: update, then install $PACKAGES"
export DEBIAN_FRONTEND=noninteractive
apt-get $APT_OPTS update
apt-get $APT_OPTS install -y $PACKAGES
echo "   installed"


step "7/13  SSH key for $PI_USER"
if [ -f "$LAPTOP_KEY" ]; then
    install -d -m 700 -o "$PI_USER" -g "$PI_USER" "$PI_HOME/.ssh"
    touch "$PI_HOME/.ssh/authorized_keys"
    KEY_LINE="$(sed -e 's/\r$//' "$LAPTOP_KEY" | grep -E '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) ' | head -n 1 || true)"
    if [ -z "$KEY_LINE" ]; then
        echo "   $LAPTOP_KEY doesn't look like a public key: skipped"
    elif grep -qxF "$KEY_LINE" "$PI_HOME/.ssh/authorized_keys"; then
        echo "   already in $PI_HOME/.ssh/authorized_keys"
    else
        echo "$KEY_LINE" >> "$PI_HOME/.ssh/authorized_keys"
        echo "   added to $PI_HOME/.ssh/authorized_keys"
    fi
    chown "$PI_USER:$PI_USER" "$PI_HOME/.ssh/authorized_keys"
    chmod 600 "$PI_HOME/.ssh/authorized_keys"
    echo "   password login is unchanged (still on)"
else
    echo "   no $LAPTOP_KEY: skipped (password login still works)"
fi


step "8/13  Tailscale"
if command -v tailscale >/dev/null; then
    echo "   already installed"
else
    echo "   installing from https://tailscale.com/install.sh"
    curl -fsSL https://tailscale.com/install.sh | sh
fi
TS_UP=0
if tailscale ip -4 >/dev/null 2>&1; then
    echo "   already connected"
    TS_UP=1
elif [ -n "$TS_AUTHKEY" ]; then
    # Not fatal: the board runs without Tailscale; secrets.env is kept for a rerun.
    if tailscale up --authkey="$TS_AUTHKEY" --hostname=projectboard --timeout=120s; then
        echo "   connected"
        TS_UP=1
    else
        echo "   FAILED to join Tailscale (an expired or used key?): carrying on without it"
    fi
else
    echo "   SKIPPED: no TS_AUTHKEY in $SECRETS, so Tailscale is installed but not connected."
    echo "   Put the key in secrets.env and run setup.sh again, or run:  sudo tailscale up --hostname=projectboard"
fi
TS_AUTHKEY=""


step "9/13  Wall key"
if [ -s "$WALL_KEY_FILE" ]; then
    echo "   $WALL_KEY_FILE already there: left alone"
elif [ -n "$WALL_KEY" ]; then
    install -d -m 0755 "$(dirname "$WALL_KEY_FILE")"
    ( umask 077; printf '%s' "$WALL_KEY" > "$WALL_KEY_FILE" )
    chmod 0600 "$WALL_KEY_FILE"
    echo "   wrote $WALL_KEY_FILE (install.sh gives it to root:kiosk 0640)"
else
    echo "   none in $SECRETS: install.sh makes a new one (its hash then goes in wall_keys)"
fi
WALL_KEY=""


step "10/13  Persistent journal and pb-netlog"
# Raspberry Pi OS keeps the journal in RAM (40-rpi-volatile-storage.conf), so the
# folder alone isn't enough. install.sh then installs pi/conf/pb-journal.conf over this.
mkdir -p /var/log/journal /etc/systemd/journald.conf.d
systemd-tmpfiles --create --prefix /var/log/journal
if [ ! -f /etc/systemd/journald.conf.d/pb-journal.conf ]; then
    printf '[Journal]\nStorage=persistent\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/pb-journal.conf
    systemctl restart systemd-journald
fi
journalctl --flush
echo "   journal persistent in /var/log/journal"
# Keep in step with pi/systemd/pb-netlog.service (install.sh owns it after this).
cat > /etc/systemd/system/pb-netlog.service <<'EOF'
[Unit]
Description=Project Board network report to boot partition
After=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 60; { date; nmcli -f NAME,TYPE,DEVICE,AUTOCONNECT-PRIORITY connection show; nmcli device status; ip -br addr; journalctl -b --no-pager -u NetworkManager -u wpa_supplicant | grep -viE "psk|password" | tail -160; } > /boot/firmware/netlog.txt 2>&1; sync'
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pb-netlog.service
echo "   pb-netlog enabled: /boot/firmware/netlog.txt, 60 s after each boot"


step "11/13  Checks (read-only)"
CHECK_FAILS=0
if grep -Eq '^[[:space:]]*dtparam=spi=on' "$CONFIG"; then
    echo "   ok    $CONFIG has dtparam=spi=on"
else
    echo "   FAIL  $CONFIG has no active dtparam=spi=on line"
    CHECK_FAILS=$((CHECK_FAILS + 1))
fi
if [ -e /dev/spidev0.0 ]; then
    echo "   ok    /dev/spidev0.0 exists"
else
    echo "   FAIL  /dev/spidev0.0 is missing (reboot once; if it's still missing, check config.txt)"
    CHECK_FAILS=$((CHECK_FAILS + 1))
fi
if python3 -c "import spidev" 2>/dev/null; then
    echo "   ok    python3 can import spidev"
else
    echo "   FAIL  python3 can't import spidev"
    CHECK_FAILS=$((CHECK_FAILS + 1))
fi
# Import only: nothing opens the GPIO chip. lgpio writes small files into the current folder.
if (cd /tmp && python3 -c "import gpiozero, lgpio") 2>/dev/null; then
    echo "   ok    python3 can import gpiozero and lgpio"
else
    echo "   FAIL  python3 can't import gpiozero and lgpio"
    CHECK_FAILS=$((CHECK_FAILS + 1))
fi
for g in spi gpio; do
    if id -nG "$PI_USER" | tr ' ' '\n' | grep -qx "$g"; then
        echo "   ok    $PI_USER is in the $g group"
    else
        usermod -aG "$g" "$PI_USER" && echo "   fixed $PI_USER added to the $g group"
    fi
done


step "12/13  secrets.env"
if [ ! -f "$SECRETS" ]; then
    echo "   not there (nothing to delete)"
elif [ "$TS_UP" -eq 1 ]; then
    rm -f "$SECRETS"
    echo "   deleted $SECRETS"
else
    echo "   kept: Tailscale isn't connected yet, so the next run can still use it"
fi


step "13/13  Summary"
echo "   Hostname:   $(hostname)"
echo "   Local IPs:  $(hostname -I)"
if tailscale ip -4 >/dev/null 2>&1; then
    TS_NAME="$(tailscale status --json | python3 -c "import json, sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "?")"
    echo "   Tailscale:  $(tailscale ip -4 | head -n 1)  ($TS_NAME)"
else
    echo "   Tailscale:  not connected"
fi
echo "   Timezone:   $(timedatectl show -p Timezone --value)"
echo "   Wi-Fi connections:"
nmcli -f NAME,TYPE,AUTOCONNECT,AUTOCONNECT-PRIORITY,DEVICE connection show | sed 's/^/     /'
echo "   Packages:"
for p in $PACKAGES tailscale; do
    echo "     $p  $(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || echo 'not installed')"
done

echo
if [ "$CHECK_FAILS" -eq 0 ]; then
    echo "   DONE: all checks passed"
    exit 0
fi
echo "   DONE, but $CHECK_FAILS check(s) failed: see 11/13 above"
exit 2
