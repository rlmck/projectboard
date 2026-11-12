#!/bin/sh
# kiosk-prestart.sh: run by kiosk.service (ExecStartPre, as the kiosk user) just
# before Chromium starts. Marks Chromium's last session as a clean exit, so a
# power cut, a crash or pb-health restarting the kiosk never brings up the
# "Restore pages?" bubble over the wall screen (review WALL-11, 12 Nov 2026).
# Belt and braces with --hide-crash-restore-bubble in kiosk.service, whatever
# that switch does in the installed Chromium. Never fails the start.
p="$HOME/.config/chromium/Default/Preferences"
[ -f "$p" ] || exit 0
sed -i -e 's/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/' \
       -e 's/"exited_cleanly":false/"exited_cleanly":true/' "$p" 2>/dev/null
exit 0
