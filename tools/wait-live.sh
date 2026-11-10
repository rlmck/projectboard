#!/usr/bin/env bash
# Wait until a site's sw.js carries the CACHE stamp a commit gets, in ONE command.
# Replaces polling curl from the session turn by turn (each poll was a full
# model round trip). Used by /ship, /staging and /rollback.
#
#   bash tools/wait-live.sh [live|staging] [ref]      (defaults: live HEAD)
#
# Exit 0: the stamp is live. Exit 1: timed out (10 min; the Cloudflare build
# probably failed, so the site keeps the last good version). Exit 2: the site
# couldn't be reached at all. Prints one short line either way.
set -u
cd "$(dirname "$0")/.." || exit 2

target="${1:-live}"
case "$target" in
  live)    url="https://symmetryboard.co.uk/sw.js" ;;
  staging) url="https://dev-projectboard.rosslewismckechnie.workers.dev/sw.js" ;;
  *) echo "usage: bash tools/wait-live.sh [live|staging] [ref]"; exit 2 ;;
esac
ref="${2:-HEAD}"
want="$(bash build.sh --stamp "$ref")" || { echo "wait-live: no stamp for $ref"; exit 2; }

seen=""; reached=0
for i in $(seq 1 40); do                       # 40 x 15 s = 10 min
  line="$(curl -s --max-time 10 "$url?cb=$(date +%s)" -H 'Cache-Control: no-cache' | grep -o "const CACHE = '[^']*'")"
  if [ -n "$line" ]; then
    reached=1
    seen="$(echo "$line" | sed "s/const CACHE = '\(.*\)'/\1/")"
    if [ "$seen" = "$want" ]; then
      echo "wait-live: $target shows $want after ~$(( (i - 1) * 15 )) s"
      exit 0
    fi
  fi
  [ "$reached" = 0 ] && [ "$i" -ge 4 ] && break   # unreachable for a minute: stop early
  sleep 15
done
if [ "$reached" = 0 ]; then
  echo "wait-live: couldn't reach $url (want $want)"; exit 2
fi
echo "wait-live: timed out after 10 min; $target still shows $seen, want $want (build probably failed; the site keeps the last good version)"
exit 1
