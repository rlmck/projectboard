# To-do

Ross's one to-do list for Project Board, shared by the claude.ai project chat and Claude Code. Pull before you edit. The repo is public: nothing personal, nothing secret.

**How it's used**
- "What's on my to-do list?" → give a short summary of each group (what's in it, how many items, anything that stands out), not a list of items. The full list only if asked.
- "Add X" / "remove Y" / "move X up" → edit this file and ship it to `main`. Done items are removed; the session log in `PROJECT_STATUS.md` records what was done.
- New items are sorted into the right group by whoever adds them (Ross doesn't have to say which). A new group is only made when nothing fits.
- Within a group, the top item is the next one. Numbers run straight through the whole list so "remove 12" is unambiguous; they are renumbered on every edit.
- Details and context live in the linked docs, not here.

## Testing
1. **The R8 acceptance tests** (PB Console → Tests; `docs/pi4-listener-kiosk-plan.md` R8): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across closing and opening (the opening hours since 7 Nov 2026), boot with no network (on-site), the weekly-reboot skip.
2. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute screen idle (tap-to-cast, Create, search and Clear are tried and fine, 7 Nov 2026).

## Hardware
3. **Tidy and box the wiring;** when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and the console's Power phase. `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.
4. **Docs: the touchscreen's HDMI port.** Since the rebuild the screen's video is on the Pi's **`HDMI-A-1`** (the micro-HDMI port nearest the USB-C power), not `HDMI-A-2`: seen 2 Nov 2026 in `/sys/class/drm` (`card0-HDMI-A-1` connected and enabled, `HDMI-A-2` disconnected). `cage` uses whichever output is connected, so nothing is broken; fix the text in `pi/README.md` ("Touchscreen" under Wiring) and the wall kiosk line in `PROJECT_STATUS.md`, and check nothing else names `HDMI-A-2`. Also write the screen's video chain as it is now (the picture is back since 7 Nov 2026) into that "Touchscreen" section.

## Pi and infrastructure
5. **Circuit run screen: laps on the phone and wall (session 2).** The Pi already takes `laps` (0 = endless, 1–10) since 5 Nov 2026; the Cast sheet still sends only `loop` (contract §8.1, §8.4).
6. **Pull the Pi-only files into `pi/`** (PB Console → Deploy): `pb-netwatch.sh` v2 and its unit, the `pb-rescue` profile (secrets stripped), the newer `pb-netlog` unit; then add their `install.sh` lines. Look at the kernel errors seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
7. **A heartbeat from the Pi to Supabase** so the app can show "board online". Also: when the board is off (opening hours), a phone cast says so instead of "Cast: X", e.g. "Board's off, back Mon 15:30" (needs the hours where the app can read them; open question 2).
8. **A mock listener on the laptop** that turns a cast into LED indices (lower priority now the webcam shows the real board).

## App design and features
9. **Wall screen, faster updates** (parked 27 Oct): check every 5 min instead of hourly and apply a waiting update after ~2 min untouched, keeping the chosen problem and scroll position.
10. **More challenges** (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
11. **Benchmarks:** admins can already mark a problem as a benchmark (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.
12. **Grade consensus when ticking a problem.** After a tick (recorded first, never blocked), a prompt asks what grade it felt like: a picker pre-selected on the set grade, three steps either side. Confirming casts the vote (confirming the set grade counts as agreeing); closing it casts none. One vote per problem, not per side: once someone has voted, ticking the mirror doesn't ask again (closing without voting means they're asked on the mirror). **The info button shows the consensus for everyone,** with no minimum number of votes: how many have sent it and how many votes each grade has, as plain counts (no votes → "0 votes"; one vote → "1 vote at 6B"; then e.g. "1 at 6B · 1 at 6B+"). **Changing a vote, no extra taps:** for someone who has ticked the problem, the info screen shows the same grade picker inline, highlighting their vote ("You voted 7A"); one tap on another grade replaces the vote straight away (no "Change" button, no confirm step), and the counts update. Someone who ticked but never voted can vote there the same way. Un-ticking a problem removes that person's vote. Informational only, it never changes the grade; admins get a view of the biggest gaps between set grade and consensus, to regrade from.
13. **Board setup flow (session 2), then Specific feet in Create and on the problem view (session 3)** (`docs/board-setup-plan.md`; session 1, the holds table and the Specific feet backend, is done: db/41, 9 Nov 2026): an admin flow on a phone (upload photo and cartoon, auto-trace holds, outline footholds, LED mapping with a phone on a tripod, mirror pairs, publish), a dry run on the current board, no archive; then picking footholds on the phone's and the wall's Create and showing them on the problem view (app and kiosk only, never lit). Waits on the full-board photo. Footholds are named FT1, FT2…, left to right from the bottom row (Ross, 9 Nov 2026). Board sets and the archive only for a real rearrange, later.

## PB Console
14. **Phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).

## Bugs
15. **Known bugs to triage:** `docs/codebase-overview.md` §13.

## Not now
Don't build yet: Circuits Phase 3 (PBs, leaderboards), mirrored circuits, a Done filter for circuits ("done" = done both sides, problems only), tags, session/logbook tracking beyond ticks, the Flutter migration; **the release workflow** (parked 8 Nov 2026, revisit later; ship straight to `main` until then): features on `dev`, bundled releases tested on staging, a "What's new" popup on phones for new features only (never bug fixes), a PB Console switch pointing the kiosk at staging that reverts itself.
