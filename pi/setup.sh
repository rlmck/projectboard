#!/bin/bash
# ProjectBoard Pi 4 bring-up: one run sets up the Pi for remote work and the
# LED and relay tests.
#
#   1  read secrets.env (TS_AUTHKEY, WIFI_SSID, WIFI_PSK) from this folder
#   2  timezone Europe/London
#   3  apt: update, install git, curl and the Python packages
#   4  the laptop's SSH key into /home/pi/.ssh/authorized_keys (password login stays on)
#   5  Wi-Fi: the "hangout-fixed" connection and no random MAC (the 26 Oct 2026 fix)
#   6  Tailscale: install, then join as "projectboard"
#   7  persistent journal and pb-netlog (a network report on the boot partition)
#   8  read-only checks (SPI is enabled in config.txt; nothing here drives a GPIO pin)
#   9  delete secrets.env once Tailscale is up
#  10  summary
#
# Run on the Pi:  sudo bash /boot/firmware/projectboard/setup.sh
# Safe to run again: every step checks what's already done.
# REBOOT-TEST STRAIGHT AFTERWARDS: on 26 Oct 2026 the Wi-Fi only failed at the
# first reboot. The board's own services then come from pi/deploy.sh.
#
# Why step 5: after the first reboot the Pi joined the Wi-Fi but got no IPv4;
# NetworkManager's netplan-backed connection had been rewritten at that boot.
# The fix was a plain keyfile connection (autoconnect-priority 100) plus no
# random MAC while scanning. Root cause not confirmed.
# 28 Oct 2026: the connection's MAC is now random per connection (it was
# pinned to the permanent one): the access point stopped answering quick
# rejoins with the same MAC (ASSOC-REJECT status_code=16). See pi/README.md.
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
NM_CONN=hangout-fixed
NM_KEYFILE=/etc/NetworkManager/system-connections/$NM_CONN.nmconnection
NO_RAND_MAC_CONF=/etc/NetworkManager/conf.d/98-projectboard-no-rand-mac.conf
PACKAGES="git curl python3-spidev python3-gpiozero python3-lgpio python3-websockets ustreamer"
STEP="start"

trap 'echo; echo "!! setup.sh stopped at step: $STEP (line $LINENO). Fix that and run it again."' ERR

step() {
    STEP="$1"
    echo
    echo "== $1"
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


step "1/10  Secrets"
TS_AUTHKEY=""
WIFI_SSID=""
WIFI_PSK=""
if [ -f "$SECRETS" ]; then
    TS_AUTHKEY="$(read_secret TS_AUTHKEY)"
    WIFI_SSID="$(read_secret WIFI_SSID)"
    WIFI_PSK="$(read_secret WIFI_PSK)"
    for v in TS_AUTHKEY WIFI_SSID WIFI_PSK; do
        if [ -n "${!v}" ]; then echo "   $SECRETS: $v is set"; else echo "   $SECRETS: $v is empty"; fi
    done
else
    echo "   no $SECRETS (fine if Tailscale and the Wi-Fi connection are already set up)"
fi


step "2/10  Timezone"
timedatectl set-timezone Europe/London
echo "   $(timedatectl show -p Timezone --value)"


step "3/10  apt: update, then install $PACKAGES"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y $PACKAGES
echo "   installed"


step "4/10  SSH key for $PI_USER"
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


step "5/10  Wi-Fi: $NM_CONN and no random MAC"
mkdir -p "$(dirname "$NO_RAND_MAC_CONF")"
printf '[device]\nwifi.scan-rand-mac-address=no\n' > "$NO_RAND_MAC_CONF"
echo "   wrote $NO_RAND_MAC_CONF"
if nmcli -t -f NAME connection show | grep -qx "$NM_CONN"; then
    echo "   connection $NM_CONN already exists: left alone"
elif [ -n "$WIFI_SSID" ] && [ -n "$WIFI_PSK" ]; then
    # The keyfile holds the Wi-Fi password: it's written here from secrets.env
    # and never kept in the repo.
    umask 077
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
    umask 022
    chmod 600 "$NM_KEYFILE"
    nmcli connection reload
    echo "   wrote $NM_KEYFILE (takes over at the next reboot: reboot-test it)"
else
    echo "   SKIPPED: no WIFI_SSID/WIFI_PSK in $SECRETS and no $NM_CONN connection yet"
fi
WIFI_PSK=""
if [ -f /etc/NetworkManager/conf.d/99-projectboard-wifi-powersave.conf ]; then
    echo "   note: the old power-save file is still active (/etc/NetworkManager/conf.d/99-projectboard-wifi-powersave.conf)"
fi


step "6/10  Tailscale"
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
    tailscale up --authkey="$TS_AUTHKEY" --hostname=projectboard
    echo "   connected"
    TS_UP=1
else
    echo "   SKIPPED: no TS_AUTHKEY in $SECRETS, so Tailscale is installed but not connected."
    echo "   Put the key in secrets.env and run setup.sh again, or run:  sudo tailscale up --hostname=projectboard"
fi
TS_AUTHKEY=""


step "7/10  Persistent journal and pb-netlog"
# Raspberry Pi OS keeps the journal in RAM (40-rpi-volatile-storage.conf), so the
# folder alone isn't enough: this drop-in matches pi/conf/pb-journal.conf.
mkdir -p /var/log/journal /etc/systemd/journald.conf.d
systemd-tmpfiles --create --prefix /var/log/journal
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/pb-journal.conf
systemctl restart systemd-journald
journalctl --flush
echo "   journal persistent in /var/log/journal, capped at 200 MB"
# Keep in step with pi/systemd/pb-netlog.service (deploy.sh owns it after this).
cat > /etc/systemd/system/pb-netlog.service <<'EOF'
[Unit]
Description=Project Board network report to boot partition
After=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'sleep 60; { date; nmcli -f NAME,TYPE,DEVICE,AUTOCONNECT-PRIORITY connection show; nmcli device status; ip -br addr; journalctl -b --no-pager -u NetworkManager | grep -viE "psk|password" | tail -120; } > /boot/firmware/netlog.txt 2>&1; sync'
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable pb-netlog.service
echo "   pb-netlog enabled: /boot/firmware/netlog.txt, 60 s after each boot"


step "8/10  Checks (read-only)"
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
        echo "   warn  $PI_USER is not in the $g group: run the tests with sudo"
    fi
done


step "9/10  secrets.env"
if [ ! -f "$SECRETS" ]; then
    echo "   not there (nothing to delete)"
elif [ "$TS_UP" -eq 1 ]; then
    rm -f "$SECRETS"
    echo "   deleted $SECRETS"
else
    echo "   kept: Tailscale isn't connected yet, so the next run can still use it"
fi


step "10/10  Summary"
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
echo "   Wi-Fi now:"
nmcli -f IN-USE,SSID,SIGNAL device wifi list --rescan no | grep '^\*' | sed 's/^/     /' || echo "     not connected"
echo "   Packages:"
for p in $PACKAGES tailscale; do
    echo "     $p  $(dpkg-query -W -f='${Version}' "$p" 2>/dev/null || echo 'not installed')"
done

echo
if [ "$CHECK_FAILS" -eq 0 ]; then
    echo "##############################################"
    echo "#  DONE: all checks passed                   #"
    echo "##############################################"
else
    echo "##############################################"
    echo "#  DONE, but check(s) failed: see 8/10 above #"
    echo "##############################################"
fi
exit $((CHECK_FAILS > 0 ? 1 : 0))
