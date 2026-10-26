#!/bin/bash
# deploy.sh: put the Pi code on the board's Pi. Run from Git Bash on the
# laptop, at the repo root:
#
#   bash pi/deploy.sh            copy, install what changed, restart what needs it
#   bash pi/deploy.sh --dry-run  copy, then only list what would change
#
# Plain ssh/scp over Tailscale (no rsync on Windows). Copies pi/ into ~/pb-deploy
# on the Pi, then runs install.sh there under sudo: one password prompt.
# pi/config.env (gitignored, the laptop's copy of the Pi's settings) goes too if
# it exists. Idempotent. Set PB_HOST to deploy somewhere else.

set -euo pipefail
HOST="${PB_HOST:-pi@projectboard}"
STAGE=pb-deploy
cd "$(dirname "$0")/.."
[ -f pi/install.sh ] || { echo "Run it from the repo: bash pi/deploy.sh"; exit 1; }

# A CRLF file breaks on the Pi (.gitattributes keeps pi/ LF; this catches a stray editor).
if grep -rlI $'\r' pi/listener pi/ops pi/systemd pi/conf pi/install.sh pi/config.env.example 2>/dev/null; then
    echo "!! the files above have Windows line endings: fix them before deploying"; exit 1
fi
if [ -f pi/config.env ] && grep -q $'\r' pi/config.env; then
    echo "!! pi/config.env has Windows line endings: fix it before deploying"; exit 1
fi

echo "== Copying pi/ to $HOST:~/$STAGE"
ssh "$HOST" "rm -rf ~/$STAGE && mkdir -p ~/$STAGE/listener ~/$STAGE/ops ~/$STAGE/systemd/kiosk.service.d ~/$STAGE/conf"
scp -q pi/install.sh pi/config.env.example "$HOST:$STAGE/"
scp -q pi/listener/*.py "$HOST:$STAGE/listener/"
scp -q pi/ops/* "$HOST:$STAGE/ops/"
scp -q pi/systemd/*.service pi/systemd/*.timer "$HOST:$STAGE/systemd/"
scp -q pi/systemd/kiosk.service.d/* "$HOST:$STAGE/systemd/kiosk.service.d/"
scp -q pi/conf/* "$HOST:$STAGE/conf/"
if [ -f pi/config.env ]; then
    scp -q pi/config.env "$HOST:$STAGE/"
    echo "   with pi/config.env"
fi

echo "== Installing (sudo will ask for the Pi's password)"
ssh -t "$HOST" "sudo bash ~/$STAGE/install.sh $*"
