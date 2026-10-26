#!/bin/bash
# The webcam on the back of the board, streamed to Tailscale devices only:
# http://projectboard:8080/stream. Bound to the Tailscale address, looked up
# each start (exits if Tailscale isn't up yet; board-cam.service retries).
CAM=$(ls /dev/v4l/by-id/*-video-index0 2>/dev/null | head -n1)
[ -z "$CAM" ] && { echo "No USB webcam found"; exit 1; }
TS_IP=$(tailscale ip -4 2>/dev/null | head -n1)
[ -z "$TS_IP" ] && { echo "No Tailscale address yet"; exit 1; }
exec /usr/bin/ustreamer --device="$CAM" --host="$TS_IP" --port=8080 --resolution=1280x720 --desired-fps=10
