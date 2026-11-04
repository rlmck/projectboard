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
2. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute screen idle, a first real cast from the wall. Waits on the touchscreen's picture (item 3).

## Hardware
3. **Fix the touchscreen's picture** (hardware, confirmed; none since 4 Nov 2026, touch works). The video path is screen HDMI → a big adapter (VGA to HDMI? unconfirmed) → female-to-male HDMI coupler → HDMI to micro-HDMI adapter → Pi. Proposal: drop the adapter and coupler, one HDMI cable from the screen straight into the micro-HDMI adapter. Once it works, write the real chain into `pi/README.md` → Wiring → "Touchscreen" (with item 5).
4. **Tidy and box the wiring;** when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and the console's Power phase. `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.
5. **Docs: the touchscreen's HDMI port.** Since the rebuild the screen's video is on the Pi's **`HDMI-A-1`** (the micro-HDMI port nearest the USB-C power), not `HDMI-A-2`: seen 2 Nov 2026 in `/sys/class/drm` (`card0-HDMI-A-1` connected and enabled, `HDMI-A-2` disconnected). `cage` uses whichever output is connected, so nothing is broken; fix the text in `pi/README.md` ("Touchscreen" under Wiring) and the wall kiosk line in `PROJECT_STATUS.md`, and check nothing else names `HDMI-A-2`.

## Pi and infrastructure
6. **Circuit LED match rule:** when the hold to go to is a match, light the next different hold at once, full blue, at the start of the match beat (today it's only a dim amber pulse and the beat feels stale). The match beat stays a full interval, so the climber has the match beat plus the next move's time to see it. Change `pi/listener/circuit.py` and `tools/circuit-led-simulator.html` together; update contract §8.3 and `pi/tests/test_circuit.py`.
7. **Pull the Pi-only files into `pi/`** (PB Console → Deploy): `pb-netwatch.sh` v2 and its unit, the `pb-rescue` profile (secrets stripped), the newer `pb-netlog` unit; then add their `install.sh` lines. Look at the kernel errors seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
8. **A heartbeat from the Pi to Supabase** so the app can show "board online".
9. **A mock listener on the laptop** that turns a cast into LED indices (lower priority now the webcam shows the real board).

## App design and features
10. **Problem name/setter editing** (changes the cast key: contract open questions).
11. **Wall screen, faster updates** (parked 27 Oct): check every 5 min instead of hourly and apply a waiting update after ~2 min untouched, keeping the chosen problem and scroll position.
12. **More challenges** (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
13. **Benchmarks:** admins can already mark a problem as a benchmark (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.
14. **Move a problem into Circuits (admins only):** when a problem was created but is really a circuit, an admin can move it into Circuits. A move, not a copy: afterwards it exists only as a circuit and is gone from the problems list. Design questions for the session: how the problem's holds become circuit moves, and what happens to its ticks, likes and any cast history.
15. **Grade consensus when ticking a problem.** After a tick (recorded first, never blocked), a prompt asks what grade it felt like: a picker pre-selected on the set grade, three steps either side. Confirming casts the vote (confirming the set grade counts as agreeing); closing it casts none. One vote per problem, not per side: once someone has voted, ticking the mirror doesn't ask again (closing without voting means they're asked on the mirror). **The info button shows the consensus for everyone,** with no minimum number of votes: how many have sent it and how many votes each grade has, as plain counts (no votes → "0 votes"; one vote → "1 vote at 6B"; then e.g. "1 at 6B · 1 at 6B+"). **Changing a vote, no extra taps:** for someone who has ticked the problem, the info screen shows the same grade picker inline, highlighting their vote ("You voted 7A"); one tap on another grade replaces the vote straight away (no "Change" button, no confirm step), and the counts update. Someone who ticked but never voted can vote there the same way. Un-ticking a problem removes that person's vote. Informational only, it never changes the grade; admins get a view of the biggest gaps between set grade and consensus, to regrade from.

## PB Console
16. **Phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).

## Bugs
17. **Known bugs to triage:** `docs/codebase-overview.md` §13.

## Not now
Don't build yet: Circuits Phase 3 (PBs, leaderboards), mirrored circuits, a Done filter for circuits ("done" = done both sides, problems only), tags, session/logbook tracking beyond ticks, the Flutter migration.
