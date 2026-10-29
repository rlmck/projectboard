---
description: Deploy pi/ to the board's Pi - busy check, Ross's confirmation, then deploy.sh
---
Deploy `pi/` to the board's Pi. **Gated:** it can restart the listener, which clears the board (CLAUDE.md working rule 2).

1. Say what changed in `pi/` since the last deploy, and whether the listener will restart (`pi/install.sh` restarts it when the listener's files, `config.env` or its unit changed, or when it isn't running). `python -m unittest discover -s pi/tests` must pass.
2. **Busy check:** `ssh pi@projectboard python3 - busy < console/probe.py`. It lists casts in the last 5 minutes. Also say the time: the gym is busiest in the evening, and deploys are for when it's closed.
3. Ask Ross for an explicit OK, showing the busy check's result. No OK, no deploy.
4. `pi/deploy.sh` asks for the Pi's sudo password, which you can't type. Ask Ross to run `! bash pi/deploy.sh` in the prompt (or `! bash pi/deploy.sh --dry-run` first to see what would change). PB Console's Deploy tab does the same with the password typed into the page.
5. After it: `ssh pi@projectboard pb-status` and check the listener joined, the idle pattern or night state is right, and no failed units. Report it.

Never reboot the Pi yourself (Ross does), and never commit `pi/config.env`, `secrets.env` or a Wi-Fi keyfile.

$ARGUMENTS
