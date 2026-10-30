---
description: Deploy pi/ to the board's Pi - busy check, then deploy.sh, then pb-status
---
Deploy `pi/` to the board's Pi. It can restart the listener, which clears the board. Ross asking for the work is the OK for its deploy (CLAUDE.md working rule 2, 30 Oct 2026): don't ask again.

1. Say what changed in `pi/` since the last deploy, and whether the listener will restart (`pi/install.sh` restarts it when the listener's files, `config.env` or its unit changed, or when it isn't running). `python -m unittest discover -s pi/tests` must pass.
2. **Busy check:** `ssh pi@projectboard python3 - busy < console/probe.py`. It lists casts in the last 5 minutes. Also say the time: the gym is busiest in the evening, and deploys are for when it's closed.
3. If someone cast in the last 5 minutes, wait a few minutes and run the probe again rather than cutting their problem off.
4. `bash pi/deploy.sh` (`--dry-run` first for a large change). It needs no password (`/etc/sudoers.d/pb-deploy`, since 30 Oct 2026). Only if it stops at a sudo password prompt (the rule missing, e.g. a re-flashed card) ask Ross to type `! bash pi/deploy.sh` once: that deploy reinstalls the rule.
5. After it: `ssh pi@projectboard pb-status` and check the listener joined, the idle pattern or night state is right, and no failed units. Report it.

Never reboot the Pi yourself (Ross does), and never commit `pi/config.env`, `secrets.env` or a Wi-Fi keyfile.

$ARGUMENTS
