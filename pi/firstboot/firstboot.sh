#!/bin/bash
# firstboot.sh: a fresh SD card sets itself up, unattended (31 Oct 2026, after the
# first card died). Run as root by pb-firstboot.service, which cloud-init's runcmd
# (user-data on the boot partition, added by pi/firstboot/make-card.py) installs
# and starts at the first boot. Until it finishes, it runs again at every boot and
# 60 s after a failure, so no network at the first try only delays it.
#
#   1  pb-netwatch now (the Wi-Fi watchdog and the projectboard-rescue hotspot)
#   2  setup.sh: Wi-Fi, apt, SSH key, Tailscale, the wall key, journal (pi/setup.sh)
#   3  clone the public repo (fall back to the copy on the card) and stage
#      ~pi/pb-deploy exactly as pi/deploy.sh does, with the laptop's config.env
#   4  install.sh: the listener, kiosk, watchdogs, night mode, sudoers, ... (pi/install.sh)
#   5  mark done, then reboot once (the boot that proves it comes up by itself)
#
# Everything is logged to /boot/firmware/projectboard/firstboot.log (readable on a
# laptop from the card), to the journal (journalctl -u pb-firstboot) and to the
# wall screen (tty1) while it runs. Guide: pi/firstboot/README.md.

set -u
export LC_ALL=C
CARD=/boot/firmware/projectboard
LOG=$CARD/firstboot.log
STATE=/var/lib/projectboard
DONE=$STATE/firstboot.done
TRIES=$STATE/firstboot.tries
REPO_URL=https://github.com/rlmck/projectboard.git
CLONE=/home/pi/projectboard
STAGE=/home/pi/pb-deploy

[ -f "$DONE" ] && exit 0
mkdir -p "$STATE"
n=$(( $(cat "$TRIES" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$TRIES"

# Everything below goes to the log on the card, the journal and the screen.
if [ -w /dev/tty1 ]; then
    printf '\033c' > /dev/tty1 2>/dev/null
    exec > >(tee -a "$LOG" /dev/tty1) 2>&1
else
    exec > >(tee -a "$LOG") 2>&1
fi

say() { echo; echo "######## $(date '+%F %T')  $*"; }
fail() { say "FAILED: $*. Trying again in 60 s (attempt $n)."; sync; exit 1; }

say "PROJECT BOARD FIRST-BOOT SETUP, attempt $n. Leave it switched on: about 20 minutes, then it reboots by itself."

# ---- 1  pb-netwatch, so a Wi-Fi that never comes still opens the rescue hotspot
if [ ! -x /usr/local/sbin/pb-netwatch.sh ] && [ -f "$CARD/repo/pi/ops/pb-netwatch.sh" ]; then
    say "1/5  pb-netwatch"
    install -D -m 0755 "$CARD/repo/pi/ops/pb-netwatch.sh" /usr/local/sbin/pb-netwatch.sh
    install -D -m 0644 "$CARD/repo/pi/systemd/pb-netwatch.service" /etc/systemd/system/pb-netwatch.service
    systemctl daemon-reload
    systemctl enable --now pb-netwatch.service
fi

# ---- 2  setup.sh
say "2/5  setup.sh"
bash "$CARD/setup.sh"
rc=$?
case $rc in
    0) ;;
    2) echo "   setup.sh: a check failed (above); carrying on" ;;
    3) fail "no internet yet (is the Hangout Wi-Fi in range?)" ;;
    *) fail "setup.sh stopped (exit $rc)" ;;
esac

# ---- 3  the code: a fresh clone of the public repo, else the card's copy
say "3/5  the code"
SRC=""
for i in 1 2 3; do
    rm -rf "$CLONE"
    if sudo -u pi git clone --depth 1 "$REPO_URL" "$CLONE"; then
        SRC=$CLONE
        echo "   cloned $REPO_URL at $(sudo -u pi git -C "$CLONE" log -1 --format='%h %s')"
        break
    fi
    sleep 20
done
if [ -z "$SRC" ]; then
    if [ -f "$CARD/repo/pi/install.sh" ]; then
        SRC=$CARD/repo
        echo "   the clone failed: using the copy on the card ($(cat "$CARD/repo/COMMIT" 2>/dev/null || echo '?'))"
    else
        fail "no clone and no copy on the card"
    fi
fi
# The same layout pi/deploy.sh copies to ~/pb-deploy (keep the two in step).
rm -rf "$STAGE"
mkdir -p "$STAGE/listener/patterns" "$STAGE/ledmap" "$STAGE/ops" "$STAGE/systemd/kiosk.service.d" "$STAGE/conf" || fail "mkdir $STAGE"
{
    cp "$SRC/pi/install.sh" "$SRC/pi/config.env.example" "$STAGE/" &&
    cp "$SRC"/pi/listener/*.py "$STAGE/listener/" &&
    cp "$SRC"/pi/listener/patterns/*.py "$STAGE/listener/patterns/" &&
    cp "$SRC"/pi/ops/* "$STAGE/ops/" &&
    cp "$SRC/pi/ledmap/pb_ledmap.py" "$SRC/pi/ledmap/index.html" "$SRC/app/hold_map.json" "$STAGE/ledmap/" &&
    cp "$SRC/app/board-fallback.jpg" "$STAGE/ledmap/board.jpg" &&
    cp "$SRC"/pi/systemd/*.service "$SRC"/pi/systemd/*.timer "$STAGE/systemd/" &&
    cp "$SRC"/pi/systemd/kiosk.service.d/* "$STAGE/systemd/kiosk.service.d/" &&
    cp "$SRC"/pi/conf/* "$STAGE/conf/"
} || fail "copying the code into $STAGE"
if [ -f "$CARD/config.env" ]; then
    tr -d '\r' < "$CARD/config.env" > "$STAGE/config.env"
    echo "   with the laptop's config.env"
fi
chown -R pi:pi "$STAGE"
if grep -rlI $'\r' "$STAGE" --exclude=board.jpg; then
    fail "the files above have Windows line endings"
fi

# ---- 4  install.sh
say "4/5  install.sh"
bash "$STAGE/install.sh" || fail "install.sh (exit $?)"

# ---- 5  done
say "5/5  checks"
ok=1
for u in pb-listener pb-netwatch pb-health.timer pb-mode.timer; do
    s=$(systemctl is-active "$u")
    echo "   $u: $s"
    [ "$s" = active ] || ok=0
done
echo "   kiosk: $(systemctl is-enabled kiosk) (pb-mode starts it in the day)"
echo "   Tailscale: $(tailscale ip -4 2>/dev/null | head -n1 || echo 'not connected')"
echo "   wall key: $([ -s /etc/projectboard/wall-key ] && stat -c '%U:%G %a' /etc/projectboard/wall-key || echo MISSING)"
[ $ok -eq 1 ] || fail "a service isn't running (above)"
if ! tailscale ip -4 >/dev/null 2>&1; then
    # The board itself works now; only remote access is missing. secrets.env is kept,
    # and every retry (each 10 min, and each boot) runs setup.sh's tailscale up again.
    say "Tailscale isn't connected (a used or expired key?). The board works; retrying in 10 min."
    sleep 540
    fail "Tailscale not connected"
fi
date '+%F %T' > "$DONE"
systemctl disable pb-firstboot.service 2>/dev/null
rm -f "$CARD/secrets.env"
say "DONE. Rebooting in 15 s; the wall screen shows the app about 2 minutes later."
sync
sleep 15
systemctl reboot
