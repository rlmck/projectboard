@echo off
rem Opens the hold-shape editor: starts a local web server at the repo root and
rem points the browser at it. The editor has to be served over http (not opened
rem as a file) so it can read app/hold_shapes.json and reach Supabase.
rem
rem A second window titled "ProjectBoard editor server" holds the server. Close
rem that window when you are done. Nothing here is deployed.

cd /d "%~dp0.."

set PORT=8123

rem Reuse a server that is already up rather than failing on a taken port.
netstat -an | find "127.0.0.1:%PORT%" | find "LISTENING" >nul
if errorlevel 1 (
  start "ProjectBoard editor server" cmd /k python -m http.server %PORT% --bind 127.0.0.1
  rem give it a moment to bind before the browser asks for a page
  timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:%PORT%/tools/trace_holds.html"
