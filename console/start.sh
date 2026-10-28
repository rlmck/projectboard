#!/bin/bash
# start.sh: start PB Console and open it in the browser. From Git Bash, at the repo root:
#
#   bash console/start.sh
#
# Makes a fresh random session token for this launch (the page needs it for every
# /api/ request; a page from an earlier launch stops working), starts the backend
# on 127.0.0.1 only, and opens http://127.0.0.1:<port>/#t=<token>. Ctrl+C stops it.
# Settings: console/.env.local (PB_HOST, PB_CONSOLE_PORT, ...; see .env.local.example).

set -euo pipefail
cd "$(dirname "$0")/.."
[ -f console/server.py ] || { echo "Run it from the repo: bash console/start.sh"; exit 1; }
PY="${PYTHON:-python}"
command -v "$PY" >/dev/null || PY=python3
command -v ssh >/dev/null || { echo "!! no ssh on the PATH (Git Bash has one)"; exit 1; }

PB_CONSOLE_TOKEN=$("$PY" -c 'import secrets; print(secrets.token_urlsafe(32))')
export PB_CONSOLE_TOKEN
# The token goes through the environment, not the command line (which other programs can list).
exec "$PY" console/server.py --open "$@"
