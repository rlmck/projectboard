#!/bin/sh
# pb-netwatch (v2, 28 Oct 2026): the Wi-Fi watchdog, run by pb-netwatch.service.
# Copied into the repo on 31 Oct 2026 from the 28 Oct session's record of the Pi's
# copy (the card died before it was pulled); installed by install.sh to
# /usr/local/sbin/pb-netwatch.sh.
#
# Every 30 s (after a 90 s grace at start): wlan0 has an IPv4 address (not
# 169.254) and a default route? If not, count a failure:
#    2, 6  nmcli con up hangout-fixed
#    4     restart NetworkManager
#    8     the rescue hotspot pb-rescue (SSID projectboard-rescue, the Pi at
#          10.42.0.1) for 15 minutes, then back to Hangout. pb-health leaves the
#          network alone while the hotspot is up (review PI-02, 15 Nov 2026).
#    12    reboot, at most 3 times until the network comes back
#
# The log (15 Nov 2026, review PI-14): /var/log/pb-netwatch.log (ext4, journaled), not
# the boot partition, which is FAT: a power cut mid-write can corrupt it, and these
# writes came every 30 s exactly when the network was down. Once per boot, when it
# opens the hotspot (or reboots, if that came first), it copies the log's tail and a
# network report to /boot/firmware/netwatch.txt, readable on a laptop from the card
# when SSH is down. Working over the hotspot: sudo systemctl stop pb-netwatch first,
# or it tears it down after 15 minutes.
#
# PB_NETWATCH_LIB=1 only defines the functions (the laptop's tests, pi/tests/test_netwatch.py).
LOG=${PB_NETWATCH_LOG:-/var/log/pb-netwatch.log}
FAT=${PB_NETWATCH_FAT:-/boot/firmware/netwatch.txt}
STATE=${PB_NETWATCH_STATE:-/var/lib/pb-netwatch}
COPIED=${PB_NETWATCH_COPIED:-/run/pb-netwatch-card-copy}   # RAM: gone at the next boot
mkdir -p "$STATE" "$(dirname "$LOG")"

log() {
  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 200000 ]; then
    tail -n 1000 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
  fi
  echo "$(date '+%F %T') $*" >> "$LOG"
}

# The boot partition's copy, at most once per boot (and never the Wi-Fi password).
card_copy() {
  [ -e "$COPIED" ] && return 0
  : > "$COPIED"
  {
    echo "pb-netwatch, copied $(date '+%F %T') (the full log: $LOG on the Pi)"
    echo
    tail -n 200 "$LOG" 2>/dev/null
    echo
    echo "== network now"
    nmcli -f NAME,TYPE,DEVICE,AUTOCONNECT-PRIORITY connection show 2>&1
    nmcli device status 2>&1
    ip -br addr 2>&1
    echo
    echo "== NetworkManager and wpa_supplicant, this boot"
    journalctl -b --no-pager -u NetworkManager -u wpa_supplicant 2>&1 | grep -viE "psk|password" | tail -n 120
  } > "$FAT.new" 2>&1
  mv -f "$FAT.new" "$FAT"
  sync
  log "copied the log to $FAT (once per boot)"
}

online() { ip -4 -o addr show wlan0 2>/dev/null | grep -v ' 169\.254\.' | grep -q 'inet ' && ip -4 route show default 2>/dev/null | grep -q .; }

set_reboots() {   # only when it changes: no SD-card write every 30 s while all is well
  [ "$(cat "$STATE/reboots" 2>/dev/null)" = "$1" ] || echo "$1" > "$STATE/reboots"
}

[ -n "${PB_NETWATCH_LIB:-}" ] && return 0 2>/dev/null

log "watchdog start (v2, rescue hotspot)"
sleep 90
fails=0
while :; do
  if online; then
    [ "$fails" -gt 0 ] && log "network back: $(ip -4 -br addr show wlan0 | tr -s ' ')"
    fails=0; set_reboots 0
  else
    fails=$((fails+1)); log "no network ($fails)"
    case $fails in
      2|6) log "nmcli con up hangout-fixed"; nmcli con up hangout-fixed >> "$LOG" 2>&1 ;;
      4) log "restart NetworkManager"; systemctl restart NetworkManager ;;
      8) log "RESCUE hotspot up for 15 min"; nmcli con up pb-rescue >> "$LOG" 2>&1
         card_copy
         sleep 900
         log "rescue hotspot down, retrying Hangout"; nmcli con down pb-rescue >> "$LOG" 2>&1
         nmcli con up hangout-fixed >> "$LOG" 2>&1 ;;
      12) r=$(cat "$STATE/reboots" 2>/dev/null || echo 0)
          if [ "$r" -lt 3 ]; then set_reboots $((r+1)); log "reboot $((r+1))/3"; card_copy; sync; systemctl reboot
          else log "reboot cap reached, still retrying"; fails=0; fi ;;
    esac
  fi
  sleep 30
done
