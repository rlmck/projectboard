#!/bin/bash
# deploy.sh: put the Pi code on the board's Pi. Run from Git Bash on the
# laptop, at the repo root:
#
#   bash pi/deploy.sh            copy, install what changed, restart what needs it
#   bash pi/deploy.sh --dry-run  copy, then only list what would change
#
# Plain ssh/scp over Tailscale (no rsync on Windows). Copies pi/ into ~/pb-deploy
# on the Pi, then runs install.sh there under sudo: no password with the Pi's
# pb-deploy sudoers rule (30 Oct 2026), else one prompt (a freshly flashed card).
# pi/config.env (gitignored, the laptop's copy of the Pi's settings) goes too if
# it exists. Idempotent. Set PB_HOST to deploy somewhere else.

set -euo pipefail
HOST="${PB_HOST:-pi@projectboard}"
STAGE=pb-deploy
ARGS=()
for a in "$@"; do
    case "$a" in
        --dry-run) ARGS+=(--dry-run) ;;
        *) echo "deploy.sh [--dry-run]"; exit 2 ;;
    esac
done
cd "$(dirname "$0")/.."
[ -f pi/install.sh ] || { echo "Run it from the repo: bash pi/deploy.sh"; exit 1; }

# A CRLF file breaks on the Pi (.gitattributes keeps pi/ LF; this catches a stray editor).
if grep -rlI $'\r' pi/listener pi/ledmap pi/ops pi/systemd pi/conf pi/install.sh pi/config.env.example 2>/dev/null; then
    echo "!! the files above have Windows line endings: fix them before deploying"; exit 1
fi
if [ -f pi/config.env ] && grep -q $'\r' pi/config.env; then
    echo "!! pi/config.env has Windows line endings: fix it before deploying"; exit 1
fi

echo "== Copying pi/ to $HOST:~/$STAGE"
ssh -n "$HOST" "rm -rf ~/$STAGE && mkdir -p ~/$STAGE/listener/patterns ~/$STAGE/ledmap ~/$STAGE/ops ~/$STAGE/systemd/kiosk.service.d ~/$STAGE/conf"
scp -q pi/install.sh pi/config.env.example "$HOST:$STAGE/"
scp -q pi/listener/*.py "$HOST:$STAGE/listener/"
scp -q pi/listener/patterns/*.py "$HOST:$STAGE/listener/patterns/"
scp -q pi/ops/* "$HOST:$STAGE/ops/"
# The mapping page, with the app's real-hold map and board photo (a snapshot of the live board)
scp -q pi/ledmap/pb_ledmap.py pi/ledmap/index.html app/hold_map.json "$HOST:$STAGE/ledmap/"
scp -q app/board-fallback.jpg "$HOST:$STAGE/ledmap/board.jpg"
scp -q pi/systemd/*.service pi/systemd/*.timer "$HOST:$STAGE/systemd/"
scp -q pi/systemd/kiosk.service.d/* "$HOST:$STAGE/systemd/kiosk.service.d/"
scp -q pi/conf/* "$HOST:$STAGE/conf/"
if [ -f pi/config.env ]; then
    scp -q pi/config.env "$HOST:$STAGE/"
    echo "   with pi/config.env"
fi

# Since 30 Oct 2026 /etc/sudoers.d/pb-deploy (conf/pb-deploy.sudoers) lets pi run the
# installer without a password, so no one needs to be at the keyboard.
# The probe is `sudo -n true` (allowed by that rule only): `sudo -n -l <cmd>` says yes
# for pi's password-protected ALL too, so it can't tell (found 30 Oct 2026).
if ssh -n "$HOST" "sudo -n /usr/bin/true" >/dev/null 2>&1; then
    echo "== Installing (no password needed)"
    ssh -n "$HOST" "sudo -n bash /home/pi/$STAGE/install.sh ${ARGS[*]+${ARGS[*]}}"
else
    echo "== Installing (no pb-deploy rule on the Pi yet: sudo will ask for its password once)"
    ssh -t "$HOST" "sudo bash ~/$STAGE/install.sh ${ARGS[*]+${ARGS[*]}}"
fi
