#!/bin/bash
# install.sh: runs ON THE PI as root, from the folder pi/deploy.sh copied over
# (~pi/pb-deploy). Installs only what changed, then restarts only what needs it.
# Safe to run again: a second run changes nothing.
#
#   sudo bash ~/pb-deploy/install.sh [--dry-run]
#
# Where things go:
#   listener/*.py      /opt/projectboard/listener/ (and listener/patterns/*.py)
#   ops/board-cam.sh   /opt/projectboard/ops/
#   ops/pb-*           /usr/local/bin/ (pb-console-helper, pb-netwatch.sh: /usr/local/sbin/, root only)
#   conf/pb-console.sudoers  /etc/sudoers.d/pb-console (checked with visudo -cf first)
#   conf/pb-deploy.sudoers   /etc/sudoers.d/pb-deploy (the same check): deploys without a password
#   ledmap/            /opt/projectboard/ledmap/ (the LED mapping tool: installed, never enabled)
#   systemd/*          /etc/systemd/system/ (kiosk.service as installed 26 Oct)
#   conf/              journald + system.conf.d drop-ins, NetworkManager conf, tmpfiles.d
#   conf/kiosk.pam     /etc/pam.d/kiosk (the kiosk's login session)
#
# Also, when missing (a fresh card, 31 Oct 2026): the kiosk's packages (cage, chromium),
# the kiosk user and its blank cursor theme; and the SD-card wear settings (the apt
# timers and any swap file off; the journal and Chromium's cache are in the files above).
#   config.env         /etc/projectboard/config.env, if deploy.sh sent the laptop's copy
#
# First run: disables the stopgap cast-listener (its files stay in /home/pi).
# Rollback:  sudo systemctl disable --now pb-listener && sudo systemctl enable --now cast-listener

set -euo pipefail
export LC_ALL=C

[ "$(id -u)" -eq 0 ] || { echo "Run it with sudo"; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
CHANGED=()

put() {   # put SRC DEST MODE
    local src="$SRC/$1" dest="$2" mode="$3"
    [ -f "$src" ] || { echo "!! missing $1 in $SRC"; exit 1; }
    if [ -f "$dest" ] && cmp -s "$src" "$dest" \
       && [ "$(stat -c %a "$dest")" = "${mode#0}" ]; then
        return
    fi
    CHANGED+=("$dest")
    if [ $DRY -eq 1 ]; then
        echo "   would update $dest"
    else
        install -D -o root -g root -m "$mode" "$src" "$dest"
        echo "   updated $dest"
    fi
}
changed() {   # changed PATTERN...: did anything matching change?
    local c p
    for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do
        for p in "$@"; do [[ "$c" == $p ]] && return 0; done
    done
    return 1
}
run() { if [ $DRY -eq 1 ]; then echo "   would run: $*"; else echo "   $*"; "$@"; fi; }

# Every listener module must be on one of the two lists below (circuit.py was missed
# once, 30 Oct 2026, and the listener didn't start): refuse a deploy that misses one.
for f in "$SRC"/listener/*.py; do
    case "$(basename "$f")" in
        board.py|circuit.py|supa.py|power.py|renderer.py|pb_listener.py|leds.py|mode.py) ;;
        *) echo "!! listener/$(basename "$f") isn't in install.sh's file lists: add it"; exit 1 ;;
    esac
done

echo "== Files"
for f in board.py circuit.py supa.py power.py renderer.py; do put "listener/$f" "/opt/projectboard/listener/$f" 0644; done
for f in "$SRC"/listener/patterns/*.py; do
    put "listener/patterns/$(basename "$f")" "/opt/projectboard/listener/patterns/$(basename "$f")" 0644
done
# glisten.py moved into listener/patterns/ (28 Oct 2026): remove the old copy.
if [ -f /opt/projectboard/listener/glisten.py ]; then
    CHANGED+=(/opt/projectboard/listener/glisten.py)
    if [ $DRY -eq 1 ]; then echo "   would remove /opt/projectboard/listener/glisten.py (moved)"
    else rm -f /opt/projectboard/listener/glisten.py; echo "   removed /opt/projectboard/listener/glisten.py (moved to patterns/)"; fi
fi
for f in pb_listener.py leds.py mode.py; do put "listener/$f" "/opt/projectboard/listener/$f" 0755; done
put ops/board-cam.sh /opt/projectboard/ops/board-cam.sh 0755
# The Wi-Fi watchdog (v2, 28 Oct 2026): kicks Hangout, the rescue hotspot, guarded reboots.
# The hotspot's profile (pb-rescue) holds a password, so setup.sh writes it from secrets.env.
put ops/pb-netwatch.sh /usr/local/sbin/pb-netwatch.sh 0755
for f in pb-health pb-mode pb-status pb-idle pb-ledmap pb-bootcheck pb-weekly-reboot; do put "ops/$f" "/usr/local/bin/$f" 0755; done
# PB Console's root helper, and the sudoers rule that lets pi run it (only it) without
# a password. The rule goes in only if visudo accepts it: a broken file would lock sudo.
put ops/pb-console-helper /usr/local/sbin/pb-console-helper 0755
if visudo -cf "$SRC/conf/pb-console.sudoers" >/dev/null; then
    put conf/pb-console.sudoers /etc/sudoers.d/pb-console 0440
else
    echo "!! conf/pb-console.sudoers failed visudo -cf: not installed"
fi
# The rule that lets deploy.sh run this installer without the Pi's password (30 Oct 2026).
if visudo -cf "$SRC/conf/pb-deploy.sudoers" >/dev/null; then
    put conf/pb-deploy.sudoers /etc/sudoers.d/pb-deploy 0440
else
    echo "!! conf/pb-deploy.sudoers failed visudo -cf: not installed"
fi
for f in "$SRC"/systemd/*.service "$SRC"/systemd/*.timer; do
    put "systemd/$(basename "$f")" "/etc/systemd/system/$(basename "$f")" 0644
done
put ledmap/pb_ledmap.py /opt/projectboard/ledmap/pb_ledmap.py 0755
for f in index.html board.jpg hold_map.json; do put "ledmap/$f" "/opt/projectboard/ledmap/$f" 0644; done
put systemd/kiosk.service.d/cursor.conf /etc/systemd/system/kiosk.service.d/cursor.conf 0644
put conf/pb-journal.conf /etc/systemd/journald.conf.d/pb-journal.conf 0644
put conf/pb-watchdog.conf /etc/systemd/system.conf.d/pb-watchdog.conf 0644
put conf/projectboard.tmpfiles /etc/tmpfiles.d/projectboard.conf 0644
put conf/98-projectboard-no-rand-mac.conf /etc/NetworkManager/conf.d/98-projectboard-no-rand-mac.conf 0644
put conf/kiosk.pam /etc/pam.d/kiosk 0644
put config.env.example /etc/projectboard/config.env.example 0644
if [ -f "$SRC/config.env" ]; then
    put config.env /etc/projectboard/config.env 0644
elif [ ! -f /etc/projectboard/config.env ]; then
    if [ $DRY -eq 0 ]; then
        install -D -m 0644 "$SRC/config.env.example" /etc/projectboard/config.env
    fi
    echo "!! /etc/projectboard/config.env didn't exist: created from the template."
    echo "!! Fill in SUPABASE_URL and SUPABASE_ANON_KEY (sudo nano /etc/projectboard/config.env),"
    echo "!! or put a filled-in pi/config.env on the laptop, and deploy again."
    exit 1
fi
# The kiosk (kiosk.service): cage + Chromium as the user kiosk, with no visible pointer.
# Set up by hand on 26 Oct 2026; here since 31 Oct 2026 so a fresh card gets it.
echo "== Kiosk"
KIOSK_PKGS=""
for p in cage chromium; do command -v "$p" >/dev/null || KIOSK_PKGS="$KIOSK_PKGS $p"; done
if [ -n "$KIOSK_PKGS" ]; then
    CHANGED+=(/usr/bin/cage)
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=300 $KIOSK_PKGS
fi
if ! id kiosk >/dev/null 2>&1; then
    CHANGED+=(/home/kiosk)
    run useradd --create-home --shell /usr/sbin/nologin --groups video,render,input,audio kiosk
fi
CURSORS=/usr/share/kiosk-cursors
if [ ! -f "$CURSORS/kiosk-blank/cursors/left_ptr" ]; then
    CHANGED+=("$CURSORS")
    if [ $DRY -eq 1 ]; then
        echo "   would create the blank cursor theme in $CURSORS"
    else
        # One fully transparent 1x1 Xcursor image under every common cursor name.
        python3 - "$CURSORS" <<'PY'
import os, struct, sys
root = sys.argv[1]
d = os.path.join(root, 'kiosk-blank', 'cursors')
os.makedirs(d, exist_ok=True)
img = struct.pack('<9I', 36, 0xfffd0002, 24, 1, 1, 1, 0, 0, 0) + struct.pack('<I', 0)
data = b'Xcur' + struct.pack('<3I', 16, 0x10000, 1) + struct.pack('<3I', 0xfffd0002, 24, 28) + img
with open(os.path.join(d, 'left_ptr'), 'wb') as f:
    f.write(data)
names = ('default arrow top_left_arrow pointer hand1 hand2 text xterm crosshair wait watch progress '
         'left_ptr_watch grab grabbing fleur move all-scroll not-allowed col-resize row-resize '
         'sb_h_double_arrow sb_v_double_arrow ew-resize ns-resize nwse-resize nesw-resize help '
         'question_arrow context-menu cell copy alias vertical-text zoom-in zoom-out').split()
for n in names:
    p = os.path.join(d, n)
    if not os.path.lexists(p):
        os.symlink('left_ptr', p)
with open(os.path.join(root, 'kiosk-blank', 'index.theme'), 'w') as f:
    f.write('[Icon Theme]' + chr(10) + 'Name=kiosk-blank' + chr(10))
os.makedirs(os.path.join(root, 'default'), exist_ok=True)
with open(os.path.join(root, 'default', 'index.theme'), 'w') as f:
    f.write('[Icon Theme]' + chr(10) + 'Inherits=kiosk-blank' + chr(10))
PY
        echo "   created the blank cursor theme in $CURSORS"
    fi
fi

# The wall key (db/35): the wall screen sends it with a problem made on the kiosk, so
# only the wall can make one. 32 random bytes, made here once, readable by root and
# the kiosk user only; never copied off the Pi, printed or committed. kiosk.service
# hands it to the page in the URL's #fragment (which never leaves the browser). The
# database keeps only its SHA-256, printed below (a hash, not the key). To replace it:
# delete the file on the Pi, deploy, and put the new hash in wall_keys (db/README.md).
WALL_KEY=/etc/projectboard/wall-key
if [ ! -s "$WALL_KEY" ]; then
    CHANGED+=("$WALL_KEY")
    if [ $DRY -eq 1 ]; then
        echo "   would create $WALL_KEY"
    else
        ( umask 077; head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=' > "$WALL_KEY.new" )
        chown "root:$(id -gn kiosk)" "$WALL_KEY.new"
        chmod 0640 "$WALL_KEY.new"
        mv "$WALL_KEY.new" "$WALL_KEY"
        echo "   created $WALL_KEY"
    fi
fi
# A key put there by a fresh card's setup.sh (from secrets.env) gets the same owner and mode.
if [ -s "$WALL_KEY" ] && [ $DRY -eq 0 ] && id kiosk >/dev/null 2>&1    && [ "$(stat -c '%U:%G %a' "$WALL_KEY")" != "root:$(id -gn kiosk) 640" ]; then
    chown "root:$(id -gn kiosk)" "$WALL_KEY"
    chmod 0640 "$WALL_KEY"
    echo "   set $WALL_KEY to root:$(id -gn kiosk) 0640"
fi
if [ -s "$WALL_KEY" ]; then
    echo "   wall key sha256: $(tr -d '\n' < "$WALL_KEY" | sha256sum | cut -d' ' -f1)"
fi
[ ${#CHANGED[@]} -eq 0 ] && echo "   nothing changed"

# Fail before touching services if the config can't run the listener.
if [ $DRY -eq 0 ]; then
    for k in SUPABASE_URL SUPABASE_ANON_KEY; do
        grep -Eq "^$k=.+" /etc/projectboard/config.env || { echo "!! $k is empty in /etc/projectboard/config.env"; exit 1; }
    done
fi

echo "== System"
if changed '/etc/tmpfiles.d/*'; then run systemd-tmpfiles --create /etc/tmpfiles.d/projectboard.conf; fi
if [ $DRY -eq 0 ] && [ ! -d /run/projectboard ]; then systemd-tmpfiles --create /etc/tmpfiles.d/projectboard.conf; fi
if changed '/etc/systemd/journald.conf.d/*'; then run systemctl restart systemd-journald; fi
# Raspberry Pi OS ships 40-rpi-volatile-storage.conf (journal in RAM only); pb-journal.conf
# overrides it, but journald only moves to /var/log/journal after a flush (or a boot).
if [ -z "$(ls -A /var/log/journal 2>/dev/null)" ]; then run journalctl --flush; fi
if changed '/etc/systemd/system.conf.d/*'; then
    run systemctl daemon-reexec          # picks up RuntimeWatchdogSec
elif changed '/etc/systemd/system/*'; then
    run systemctl daemon-reload
fi
if changed '/etc/NetworkManager/*'; then
    echo "   NetworkManager conf changed: it applies at the next reboot (not restarting the network now)"
fi

echo "== SD card"
# Cut writes (the first card died on 31 Oct 2026). The journal's limits are in
# conf/pb-journal.conf, Chromium's cache in kiosk.service. apt's daily timers only
# refresh package lists (nothing installs itself here), so they go; a swap file
# (dphys-swapfile, if the image has one) goes too: 2 GB is plenty for the board.
for t in apt-daily.timer apt-daily-upgrade.timer man-db.timer; do
    if [ "$(systemctl is-enabled "$t" 2>/dev/null)" = enabled ] || [ "$(systemctl is-active "$t" 2>/dev/null)" = active ]; then
        run systemctl disable --now "$t"
    fi
done
if [ "$(systemctl is-enabled dphys-swapfile 2>/dev/null)" = enabled ]; then
    run dphys-swapfile swapoff
    run systemctl disable --now dphys-swapfile
fi

echo "== Services"
if [ "$(systemctl is-enabled cast-listener 2>/dev/null)" = enabled ] || [ "$(systemctl is-active cast-listener 2>/dev/null)" = active ]; then
    run systemctl disable --now cast-listener
    echo "   (the stopgap stays in /home/pi for a rollback)"
fi
# leds-off-at-boot runs at the next boot; running it now would only clear the strip.
# pb-ledmap is deliberately not in this list: it only runs when started by hand.
for u in leds-off-at-boot.service pb-listener.service board-cam.service pb-netlog.service kiosk.service; do
    [ "$(systemctl is-enabled "$u" 2>/dev/null)" = enabled ] || run systemctl enable "$u"
done
for t in pb-health.timer pb-mode.timer pb-weekly-reboot.timer; do
    if [ "$(systemctl is-enabled "$t" 2>/dev/null)" != enabled ] || [ "$(systemctl is-active "$t")" != active ]; then
        run systemctl enable --now "$t"
    fi
done
if [ "$(systemctl is-enabled pb-netwatch 2>/dev/null)" != enabled ] || [ "$(systemctl is-active pb-netwatch 2>/dev/null)" != active ]; then
    run systemctl enable --now pb-netwatch.service
elif changed /usr/local/sbin/pb-netwatch.sh /etc/systemd/system/pb-netwatch.service; then
    run systemctl restart pb-netwatch
fi
# Enabled only: it fires 3 min after the next boot (starting it now would log a misleading boot line).
[ "$(systemctl is-enabled pb-bootcheck.timer 2>/dev/null)" = enabled ] || run systemctl enable pb-bootcheck.timer

# A running pb-ledmap session ends here: pb-listener Conflicts= with it.
if [ "$(systemctl is-active pb-ledmap 2>/dev/null)" = active ]; then
    echo "   pb-ledmap was running: starting pb-listener ends that mapping session"
fi
if changed '/opt/projectboard/listener/*' '/etc/projectboard/config.env' '/etc/systemd/system/pb-listener.service' \
   || [ "$(systemctl is-active pb-listener)" != active ]; then
    run systemctl restart pb-listener
fi
if changed '/opt/projectboard/ops/board-cam.sh' '/etc/systemd/system/board-cam.service'; then
    run systemctl restart board-cam
fi
if changed '/etc/systemd/system/kiosk.service' '/etc/systemd/system/kiosk.service.d/*' "$WALL_KEY"; then
    echo "   kiosk unit changed: it applies the next time pb-mode starts it (not restarting the screen now)"
fi

if [ $DRY -eq 1 ]; then
    echo "== Dry run: nothing changed"
    exit 0
fi
echo "== Waiting 10 s for the listener to join"
sleep 10
/usr/local/bin/pb-status
