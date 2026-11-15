#!/bin/bash
# deploy.sh: put the Pi code on the board's Pi. Run from Git Bash on the laptop, at
# the repo root. Every deploy goes through here: the automatic one
# (console/autodeploy.py), /pi-deploy and PB Console's Deploy tab.
#
#   bash pi/deploy.sh                install what changed, restart what needs it
#   bash pi/deploy.sh --dry-run      only list what would change
#   bash pi/deploy.sh --push-config  also install the laptop's pi/config.env when it
#                                    differs from the Pi's (the Pi's is backed up first)
#   bash pi/deploy.sh --fingerprint  print the fingerprint of what would be sent (no ssh)
#   bash pi/deploy.sh --make-key     make the laptop's signing key, once
#   bash pi/deploy.sh --password     the way back (pi/README.md -> Deploying): copy to
#                                    ~/pb-deploy and run install.sh with sudo's password
#
# How (14 Nov 2026, review PI-03, PI-04, PI-08): the files go into one tar with a
# MANIFEST (fingerprint, commit, source, time, the Pi's config.env hash), signed with
# the laptop's key (~/.ssh/pb-deploy-sign, never in the repo), and streamed over ssh
# to `sudo -n /usr/local/sbin/pb-install`, the only thing pi may run as root without a
# password (conf/pb-deploy.sudoers). pb-install checks the signature, every path, the
# time and the config, takes the Pi's deploy lock, backs up config.env, runs
# install.sh from a root-only folder in its own systemd unit (pb-install-run: a dropped
# ssh session can't stop it halfway, review PI-06) and records the fingerprint on the Pi. Here,
# the laptop's deploy lock (console/data/pi-deploy.lock) keeps two deploys from this
# laptop apart, and a deploy that worked is recorded in console/data/pi-deployed,
# which autodeploy compares with main.
#
# config.env: the laptop's pi/config.env goes with every deploy if it exists. If the
# Pi's differs (PB Console edits the Pi's), nothing is deployed unless --push-config.
#
# Exit codes: 0 done; 2 usage; 3 config.env differs; 75 another deploy is running;
# 77 the Pi refused the bundle; else the installer's. Set PB_HOST to deploy elsewhere.
# PB_DEPLOY_SOURCE (autodeploy, by-hand, console), PB_DEPLOY_COMMIT and PB_DEPLOY_DATA
# (where the lock and the record live) are set by the console's callers.

set -euo pipefail
HOST="${PB_HOST:-pi@projectboard}"
KEY="${PB_SIGN_KEY:-$HOME/.ssh/pb-deploy-sign}"
SOURCE="${PB_DEPLOY_SOURCE:-by-hand}"
MODE=install
PUSH=0
DO=deploy
for a in "$@"; do
    case "$a" in
        --dry-run) MODE=dry-run ;;
        --push-config) PUSH=1 ;;
        --fingerprint) DO=fingerprint ;;
        --make-key) DO=make-key ;;
        --password) DO=password ;;
        *) echo "deploy.sh [--dry-run] [--push-config] | --fingerprint | --make-key | --password"; exit 2 ;;
    esac
done
case "$SOURCE" in autodeploy|by-hand|console) ;; *) echo "PB_DEPLOY_SOURCE: autodeploy, by-hand or console"; exit 2 ;; esac
cd "$(dirname "$0")/.."
[ -f pi/install.sh ] || { echo "Run it from the repo: bash pi/deploy.sh"; exit 1; }
ROOT="$PWD"
DATA="${PB_DEPLOY_DATA:-$ROOT/console/data}"

if [ "$DO" = make-key ]; then
    if [ -f "$KEY" ]; then
        echo "$KEY exists: not making another."
    else
        mkdir -p "$(dirname "$KEY")"
        ssh-keygen -q -t ed25519 -N '' -C pb-deploy-sign -f "$KEY"
        echo "made $KEY (private: stays on this laptop, never in the repo)"
    fi
    echo "pi/conf/pb-deploy.signers should hold this line (public):"
    echo "pb-deploy namespaces=\"pb-deploy\" $(cut -d' ' -f1,2 "$KEY.pub")"
    exit 0
fi

# A CRLF file breaks on the Pi (.gitattributes keeps pi/ LF; this catches a stray editor).
if grep -rlI $'\r' pi/listener pi/ledmap pi/ops pi/systemd pi/conf pi/install.sh pi/config.env.example 2>/dev/null; then
    echo "!! the files above have Windows line endings: fix them before deploying"; exit 1
fi
if [ -f pi/config.env ] && grep -q $'\r' pi/config.env; then
    echo "!! pi/config.env has Windows line endings: fix it before deploying"; exit 1
fi

WORK=$(mktemp -d)
LOCKED=0
cleanup() {
    rm -rf "$WORK"
    if [ "$LOCKED" = 1 ]; then rm -rf "$DATA/pi-deploy.lock"; fi
}
trap cleanup EXIT

# The bundle's files, in the layout install.sh expects (pi/firstboot/firstboot.sh copies the same).
B="$WORK/b"
mkdir -p "$B/listener/patterns" "$B/ledmap" "$B/ops" "$B/systemd/kiosk.service.d" "$B/conf"
cp pi/install.sh pi/config.env.example "$B/"
cp pi/listener/*.py "$B/listener/"
cp pi/listener/patterns/*.py "$B/listener/patterns/"
find pi/ops -maxdepth 1 -type f -exec cp {} "$B/ops/" \;      # files only (a test run leaves __pycache__)
# The mapping page, with the app's real-hold map and board photo (a snapshot of the live board)
cp pi/ledmap/pb_ledmap.py pi/ledmap/index.html app/hold_map.json "$B/ledmap/"
cp app/board-fallback.jpg "$B/ledmap/board.jpg"
cp pi/systemd/*.service pi/systemd/*.timer "$B/systemd/"
find pi/systemd/kiosk.service.d -maxdepth 1 -type f -exec cp {} "$B/systemd/kiosk.service.d/" \;
find pi/conf -maxdepth 1 -type f -exec cp {} "$B/conf/" \;
if [ -f pi/config.env ]; then cp pi/config.env "$B/"; fi

# The fingerprint: every file sent, by path and content (autodeploy runs --fingerprint on main).
FP=$(cd "$B" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)
if [ "$DO" = fingerprint ]; then
    echo "$FP"
    exit 0
fi

# The laptop's deploy lock (mkdir is atomic). One older than 45 minutes is a crashed run.
mkdir -p "$DATA"
if ! mkdir "$DATA/pi-deploy.lock" 2>/dev/null; then
    if [ -n "$(find "$DATA/pi-deploy.lock" -maxdepth 0 -mmin +45 2>/dev/null)" ]; then
        rm -rf "$DATA/pi-deploy.lock"
        mkdir "$DATA/pi-deploy.lock"
    else
        echo "!! another Pi deploy is running from this laptop (console/data/pi-deploy.lock): try again when it has finished"
        exit 75
    fi
fi
LOCKED=1
echo "$SOURCE $$ $(date '+%F %T')" > "$DATA/pi-deploy.lock/who"

if [ -n "${PB_DEPLOY_COMMIT:-}" ]; then
    COMMIT="$PB_DEPLOY_COMMIT"
elif COMMIT=$(git rev-parse HEAD 2>/dev/null); then
    [ -n "$(git status --porcelain -- pi app/hold_map.json app/board-fallback.jpg 2>/dev/null)" ] && COMMIT="$COMMIT-dirty"
else
    COMMIT=unknown
fi

# The old way: copy the folder to ~/pb-deploy and run install.sh from it with sudo.
legacy() {   # legacy -n (the pre-14 Nov rule, no password) | -t (sudo asks for the password)
    ssh -n "$HOST" "rm -rf ~/pb-deploy"
    scp -rq "$B" "$HOST:pb-deploy"
    local dry=""
    [ "$MODE" = dry-run ] && dry=" --dry-run"
    if [ "$1" = -n ]; then
        ssh -n "$HOST" "sudo -n bash /home/pi/pb-deploy/install.sh$dry"
    else
        ssh -t "$HOST" "sudo bash ~/pb-deploy/install.sh$dry"
    fi
}

if [ "$DO" = password ]; then
    echo "== The way back: install.sh from ~/pb-deploy, with sudo's password"
    legacy -t
    ssh -n "$HOST" "rm -rf ~/pb-deploy"
    echo "== Done. The fingerprint isn't recorded: the next normal deploy records it."
    exit 0
fi

# config.env: never put a stale laptop copy over PB Console's edits on the Pi.
BASE=""
if [ -f "$B/config.env" ]; then
    BASE=$(ssh -n "$HOST" "sha256sum /etc/projectboard/config.env 2>/dev/null | cut -d' ' -f1")
    [ -n "$BASE" ] || BASE=none
    MINE=$(sha256sum "$B/config.env" | cut -d' ' -f1)
    if [ "$BASE" != none ] && [ "$BASE" != "$MINE" ]; then
        if [ "$PUSH" = 1 ]; then
            echo "   pi/config.env differs from the Pi's: --push-config installs the laptop's (the Pi's is backed up first)"
        else
            echo "!! pi/config.env on this laptop differs from the Pi's (PB Console edits the Pi's: opening hours, night)."
            echo "!! Nothing deployed. Keep one copy in PB Console -> Config, or deploy with --push-config to install"
            echo "!! the laptop's (the Pi's goes to /var/lib/projectboard/config-backups first)."
            exit 3
        fi
    fi
fi

# A Pi without pb-install yet (deployed before 14 Nov 2026): one install the old way puts it there.
if ! ssh -n "$HOST" "test -x /usr/local/sbin/pb-install && test -s /etc/projectboard/deploy-signers"; then
    echo "== This Pi has no pb-install yet: installing it the old way once"
    if ssh -n "$HOST" "sudo -n /usr/bin/true" >/dev/null 2>&1; then
        legacy -n
    else
        legacy -t
    fi
    ssh -n "$HOST" "rm -rf ~/pb-deploy"
    [ "$MODE" = dry-run ] && exit 0
    echo "== Now the signed way (records the fingerprint)"
fi

[ -f "$KEY" ] || { echo "!! no signing key at $KEY: run bash pi/deploy.sh --make-key (pi/README.md -> Deploying)"; exit 1; }
{
    echo "format=1"
    echo "created=$(date +%s)"
    echo "mode=$MODE"
    echo "fingerprint=$FP"
    echo "commit=$COMMIT"
    echo "source=$SOURCE"
    if [ -n "$BASE" ]; then echo "config_base=$BASE"; fi
} > "$B/MANIFEST"
(cd "$B" && find . -type f | sed 's|^\./||' | LC_ALL=C sort > "$WORK/list" \
    && tar --format=ustar --owner=0 --group=0 --numeric-owner -cf "$WORK/bundle.tar" -T "$WORK/list")
if ! ssh-keygen -Y sign -f "$KEY" -n pb-deploy "$WORK/bundle.tar" 2>"$WORK/sign.err"; then
    cat "$WORK/sign.err"; echo "!! could not sign the bundle"; exit 1
fi
{
    printf 'PBDEPLOY1 %d %d\n' "$(wc -c < "$WORK/bundle.tar.sig")" "$(wc -c < "$WORK/bundle.tar")"
    cat "$WORK/bundle.tar.sig" "$WORK/bundle.tar"
} > "$WORK/stream"

WHAT="Installing"
[ "$MODE" = dry-run ] && WHAT="Dry run of"
echo "== $WHAT $COMMIT ($SOURCE, fingerprint $FP) through pb-install"
set +e
ssh "$HOST" "sudo -n /usr/local/sbin/pb-install" < "$WORK/stream"
CODE=$?
set -e
case $CODE in
    0) ;;
    75) echo "!! another deploy is running on the Pi: try again when it has finished"; exit 75 ;;
    77) echo "!! the Pi refused the bundle (its reason is above)"; exit 77 ;;
    *) echo "!! the install failed (exit $CODE)"; exit $CODE ;;
esac
if [ "$MODE" = install ]; then
    printf 'fingerprint=%s\ncommit=%s\nsource=%s\nat=%s\n' "$FP" "$COMMIT" "$SOURCE" "$(date '+%FT%T')" \
        > "$DATA/pi-deployed.new"
    mv "$DATA/pi-deployed.new" "$DATA/pi-deployed"
    echo "== Recorded: the Pi has fingerprint $FP ($COMMIT)"
fi
