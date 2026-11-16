# To-do

Ross's one to-do list for Project Board, shared by the claude.ai project chat and Claude Code. Pull before you edit. The repo is public: nothing personal, nothing secret.

**How it's used**
- "What's on my to-do list?" → give a short summary of each group (what's in it, how many items, anything that stands out), not a list of items. The full list only if asked.
- "Add X" / "remove Y" / "move X up" → edit this file and ship it to `main`. Done items are removed; the session log in `PROJECT_STATUS.md` records what was done.
- New items are sorted into the right group by whoever adds them (Ross doesn't have to say which). A new group is only made when nothing fits.
- Within a group, the top item is the next one. Numbers run straight through the whole list so "remove 12" is unambiguous; they are renumbered on every edit.
- Details and context live in the linked docs, not here.

## Pi and infrastructure
1. **NEXT: the Pi deploys itself from `main`, no laptop needed** (Ross, 16 Nov 2026), so work done from the phone (a Claude Code web session pushing to `main`) reaches the board. A timer on the Pi checks `main` on GitHub every few minutes; when the Pi's files (`pi/`, `app/hold_map.json`, `app/board-fallback.jpg`) change, it runs the same quiet-board check as `console/autodeploy.py` (wait for 15 quiet minutes inside the opening hours, straight away outside them) and installs through `pb-install`'s lock and fingerprint record. Today's trust is already "whatever is on `main` reaches the Pi" (the laptop's autodeploy), so this shouldn't weaken it, but it replaces the laptop-signed bundle (15 Nov 2026, review PI-03): **check it against the local `docs/security-findings.md` first (a laptop session)**, decide what the Pi verifies (fetch only from `github.com/rlmck/projectboard` over TLS, a pinned branch, maybe signed commits), and keep the laptop path as the fallback. Then update `pi/README.md` → Deploying and CLAUDE.md working rule 2. Not covered: DB migrations stay laptop-only (`db/.env`).
2. **Look at the kernel errors** seen on 28 Oct (about 3,460 in 24 h, nearly all kernel) in Logs once the gym is closed.
3. **A heartbeat from the Pi to Supabase** so the app can show "board online". Also: when the board is off (opening hours), a phone cast says so instead of "Cast: X", e.g. "Board's off, back Mon 15:30" (needs the hours where the app can read them; open question 2). Since 16 Nov 2026 a cast at night wakes the board for 30 min (`CAST_WAKE_MIN`), so this matters less.
4. **A mock listener on the laptop** that turns a cast into LED indices (lower priority now the webcam shows the real board).
5. **The kiosk user's groups:** drop `input` from the kiosk user (review WALL-11, deferred 12 Nov 2026) once a touch test on the screen shows cage still gets the touches; on site.

## Testing
6. **The R8 acceptance tests** (PB Console → Tests; `docs/pi4-listener-kiosk-plan.md` R8): kill, freeze, Wi-Fi drop, Supabase blocked, reboot mid-cast, the clock across closing and opening (the opening hours since 7 Nov 2026), boot with no network (on-site), the weekly-reboot skip.
7. **Try the wall mode on the touchscreen:** the rail with a real finger, whether ~8 rows feels right, the 20-minute screen idle (tap-to-cast, Create, search and Clear are tried and fine, 7 Nov 2026).

## Hardware
8. **Tidy and box the wiring;** when they arrive, fit the relay module and the 74AHCT125; then relay control in `pb-mode` (`pi/listener/power.py` is the hook) and a power control on PB Console's Home (its Power section was removed 10 Nov 2026). `pb-mode` mustn't cut the LED supplies while `pb-ledmap` runs.
9. **Docs: the touchscreen's HDMI port.** Since the rebuild the screen's video is on the Pi's **`HDMI-A-1`** (the micro-HDMI port nearest the USB-C power), not `HDMI-A-2`: seen 2 Nov 2026 in `/sys/class/drm` (`card0-HDMI-A-1` connected and enabled, `HDMI-A-2` disconnected). `cage` uses whichever output is connected, so nothing is broken; fix the text in `pi/README.md` ("Touchscreen" under Wiring) and the wall kiosk line in `PROJECT_STATUS.md`, and check nothing else names `HDMI-A-2`. Also write the screen's video chain as it is now (the picture is back since 7 Nov 2026) into that "Touchscreen" section.

## App design and features
10. **More challenges** (a row in `challenges`), monthly boards, a metronome, casting the circuit at Start once Circuits Phase 2 exists.
11. **Benchmarks:** admins can already mark a problem as a benchmark (detail ⋮ → "Mark as benchmark"); clarify what more is wanted.
12. **Grade consensus when ticking a problem.** After a tick (recorded first, never blocked), a prompt asks what grade it felt like: a picker pre-selected on the set grade, three steps either side. Confirming casts the vote (confirming the set grade counts as agreeing); closing it casts none. One vote per problem, not per side: once someone has voted, ticking the mirror doesn't ask again (closing without voting means they're asked on the mirror). **The info button shows the consensus for everyone,** with no minimum number of votes: how many have sent it and how many votes each grade has, as plain counts (no votes → "0 votes"; one vote → "1 vote at 6B"; then e.g. "1 at 6B · 1 at 6B+"). **Changing a vote, no extra taps:** for someone who has ticked the problem, the info screen shows the same grade picker inline, highlighting their vote ("You voted 7A"); one tap on another grade replaces the vote straight away (no "Change" button, no confirm step), and the counts update. Someone who ticked but never voted can vote there the same way. Un-ticking a problem removes that person's vote. Informational only, it never changes the grade; admins get a view of the biggest gaps between set grade and consensus, to regrade from.

## PB Console
13. **Phase 13 (Data):** benchmark marking, a hold's mirror partner, a hold relabel done as db/32 did it (`docs/console-plan.md`).
14. **`tools/check_holds.py`: check the FTn naming order** (left to right, bottom row first) against the board image's corners and size (review BRD-12, deferred 12 Nov 2026).

## Not now
Don't build yet: Circuits Phase 3 (PBs, leaderboards), mirrored circuits, a Done filter for circuits ("done" = done both sides, problems only), tags, session/logbook tracking beyond ticks, the Flutter migration; **the release workflow** (parked 8 Nov 2026, revisit later; ship straight to `main` until then): features on `dev`, bundled releases tested on staging, a "What's new" popup on phones for new features only (never bug fixes), a PB Console switch pointing the kiosk at staging that reverts itself; **camera LED mapping** (board setup 2b, dropped 10 Nov 2026): parked on `parked/2b-camera-led-mapping`, only for a full rearrange or another gym; **board sets and the archive** (board setup), only for a real rearrange.
