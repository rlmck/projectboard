# To-do

Ross's one to-do list for Project Board, shared by the claude.ai project chat and Claude Code. Pull before you edit. The repo is public: nothing personal, nothing secret.

**How it's used**
- "What's on my to-do list?" → give a short summary of each group (what's in it, how many items, anything that stands out), not a list of items. The full list only if asked.
- "Add X" / "remove Y" / "move X up" → edit this file and ship it to `main`. Done items are removed; the session log in `PROJECT_STATUS.md` records what was done.
- New items are sorted into the right group by whoever adds them (Ross doesn't have to say which). A new group is only made when nothing fits.
- Within a group, the top item is the next one. Numbers run straight through the whole list so "remove 12" is unambiguous; they are renumbered on every edit.
- Details and context live in the linked docs, not here.

## Testing
1. **The R8 acceptance tests** (PB Console → Tests; `docs/pi4-listener-kiosk-plan.md` R8): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across 23:00/08:00, boot with no network (on-site), the weekly-reboot skip.
2. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute idle, a first real cast from the wall.

## Hardware
3. **Tidy and box the wiring;** when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and the console's Power phase. `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.

## Pi and infrastructure
4. **Pull the Pi-only files into `pi/`** (PB Console → Deploy): `pb-netwatch.sh` v2 and its unit, the `pb-rescue` profile (secrets stripped), the newer `pb-netlog` unit; then add their `install.sh` lines. Look at the kernel errors seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
5. **A heartbeat from the Pi to Supabase** so the app can show "board online".
6. **A mock listener on the laptop** that turns a cast into LED indices (lower priority now the webcam shows the real board).

## App design and features
7. **Revamp the profile stuff:** when the app loads, signed-out users should be offered Create account first, not Sign in (they won't have an account yet). Consider switching the 4-word passphrase to a PIN (Claude Code to suggest). Be careful with existing users.
8. **Revamp filtering:** sort by new, and lots more (scope to be worked out).
9. **Creating a problem on the kiosk:** open question (whether and how).
10. **Problem name/setter editing** (changes the cast key: contract open questions).
11. **Wall screen, faster updates** (parked 27 Oct): check every 5 min instead of hourly and apply a waiting update after ~2 min untouched, keeping the chosen problem and scroll position.
12. **More challenges** (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
13. **Benchmarks:** admins can already mark a problem as a benchmark (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.

## PB Console
14. **Phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).

## Bugs
15. **Known bugs to triage:** `docs/codebase-overview.md` §13.

## Not now
Don't build yet: Circuits Phase 3 (PBs, leaderboards), mirrored circuits, a Done filter for circuits ("done" = done both sides, problems only), tags, session/logbook tracking beyond ticks, the Flutter migration.
