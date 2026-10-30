# To-do

Ross's one to-do list for Project Board, shared by the claude.ai project chat and Claude Code. The top item is what's being worked on now; the rest are in priority order. Pull before you edit. The repo is public: nothing personal, nothing secret.

**How it's used**
- "What's on my to-do list?" → show the top 3, one line each. The rest only if asked.
- "Add X" / "remove Y" / "move X up" → edit this file and ship it to `main`. Done items are removed; the session log in `PROJECT_STATUS.md` records what was done.
- One flat numbered list, plus "Not now". Details and context live in the linked docs, not here.

## List
1. **The R8 acceptance tests** (PB Console → Tests; `docs/pi4-listener-kiosk-plan.md` R8): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across 23:00/08:00, boot with no network (on-site), the weekly-reboot skip.
2. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute idle, a first real cast from the wall.
3. **Pull the Pi-only files into `pi/`** (PB Console → Deploy): `pb-netwatch.sh` v2 and its unit, the `pb-rescue` profile (secrets stripped), the newer `pb-netlog` unit; then add their `install.sh` lines. Look at the kernel errors seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
4. **Hardware:** tidy and box the wiring; when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and the console's Power phase. `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.
5. **PB Console phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).
6. **Circuits Phase 2:** the cast screen, `cast_circuit`/`stop` broadcasts, `circuit_logs`, the Pi listener update (`docs/circuits-phase2.md`).
7. **Problem name/setter editing** (changes the cast key: contract open questions).
8. **Known bugs to triage:** `docs/codebase-overview.md` §13.
9. **Wall screen, faster updates** (parked 27 Oct): check every 5 min instead of hourly and apply a waiting update after ~2 min untouched, keeping the chosen problem and scroll position.
10. **A heartbeat from the Pi to Supabase** so the app can show "board online".
11. **More challenges** (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
12. **Benchmarks:** admins can already mark a problem as a benchmark (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.
13. **A mock listener on the laptop** that turns a cast into LED indices (lower priority now the webcam shows the real board).

## Not now
Don't build yet: the feet indicators, Circuits Phase 3 (PBs, leaderboards), tags, session/logbook tracking beyond ticks, the Flutter migration.
