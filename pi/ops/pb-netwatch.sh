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
#          10.42.0.1) for 15 minutes, then back to Hangout
#    12    reboot, at most 3 times until the network comes back
# Its log goes to the boot partition, readable on a laptop when SSH is down.
# Working over the hotspot: sudo systemctl stop pb-netwatch first, or it tears it down.
LOG=/boot/firmware/netwatch.txt
STATE=/var/lib/pb-netwatch
mkdir -p "$STATE"
log() { [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 200000 ] && : > "$LOG"; echo "$(date '+%F %T') $*" >> "$LOG"; sync; }
online() { ip -4 -o addr show wlan0 2>/dev/null | grep -v ' 169\.254\.' | grep -q 'inet ' && ip -4 route show default 2>/dev/null | grep -q .; }
log "watchdog start (v2, rescue hotspot)"
sleep 90
fails=0
while :; do
  if online; then
    [ "$fails" -gt 0 ] && log "network back: $(ip -4 -br addr show wlan0 | tr -s ' ')"
    fails=0; echo 0 > "$STATE/reboots"
  else
    fails=$((fails+1)); log "no network ($fails)"
    case $fails in
      2|6) log "nmcli con up hangout-fixed"; nmcli con up hangout-fixed >> "$LOG" 2>&1 ;;
      4) log "restart NetworkManager"; systemctl restart NetworkManager ;;
      8) log "RESCUE hotspot up for 15 min"; nmcli con up pb-rescue >> "$LOG" 2>&1
         sleep 900
         log "rescue hotspot down, retrying Hangout"; nmcli con down pb-rescue >> "$LOG" 2>&1
         nmcli con up hangout-fixed >> "$LOG" 2>&1 ;;
      12) r=$(cat "$STATE/reboots" 2>/dev/null || echo 0)
          if [ "$r" -lt 3 ]; then echo $((r+1)) > "$STATE/reboots"; log "reboot $((r+1))/3"; sync; systemctl reboot
          else log "reboot cap reached, still retrying"; fails=0; fi ;;
    esac
  fi
  sleep 30
done
