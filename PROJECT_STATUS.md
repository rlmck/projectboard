# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The cast contract: `docs/cast-contract.md`.

## Current state (as of 2026-10-26)
- **The LEDs work and casting works end to end** (phone → Supabase → Pi 4 → LEDs) on **temporary wiring** behind the board, through a **stopgap listener** (`~/cast_listener.py` on the Pi, not yet in the repo). Details in the 2026-10-26 session log entry.
- Pi 4 (donated) installed behind the board: Raspberry Pi OS Lite 64-bit, hostname `projectboard`, on the gym Wi-Fi, reachable over Tailscale. A USB webcam streams the back of the board to Tailscale devices only.
- Old Pi 3B: unavailable. Not relying on it.
  - **Corrected 20 Oct 2026:** the earlier note that a relay module was "already in the box behind the board" was wrong. Gareth's whole box (Pi 3B, Witty Pi HAT, 2-channel relay board, a small board that looks like a level shifter, and its wiring) left with the old Pi.
  - On the wall: the LED strip, **two** YU0510 5 V 10 A supplies (DC plugs now cut; both needed together to start the strip), the wall touchscreen (HDMI to the Pi via micro-HDMI; its USB touch cable now in the Pi), the 4-way strip cable, and two 8-way power-feed plugs (mapped 26 Oct, not yet connected).
  - Bought 20 Oct 2026 (to match Gareth's setup): a 2-channel 5 V opto-isolated relay module (eBay), a 74AHCT125 level shifter breakout (Amazon), a 200x100x70 mm IP65 junction box, female-female jumpers, 1 m red and 1 m blue 16 AWG wire (blue = negative; black was out of stock), 5x Wago 221-413, 5x 3 A 12-way terminal strips (Maplin Pro), a micro-HDMI to HDMI adapter, a 9 mm M2.5 standoff kit and a Pi 4 heatsink set (The Pi Hut). Relay module and level shifter not yet arrived (26 Oct). DC jack adapters no longer needed.
- The original system's SD card image (dtb-backup.img) is kept for reference only.
- board_listener.py will be discarded; Pi-side code starts fresh.
- The app is not yet announced to the public: the wiring is temporary and the far end of the board shows the wrong colours until the 8-way power feeds are wired in.
- The app itself is live at https://symmetryboard.co.uk (service worker `pb-v115`, 20 Oct 2026), with the Pat Burner challenge live.

## Decisions
- Remove Google sign-in completely. **Done 18 Oct 2026** (provider off; OAuth client deleted 19 Oct).
- Accounts: nickname + 4-word generated passphrase. Admin can generate a new passphrase for a lost account, with an activity check and a reset log. A new phone means re-entering nickname + passphrase. **Live 18 Oct 2026** (`pb-v108`, db/30; the Edge Function `admin-reset-passphrase`; the log is the `admin_actions` table).
- No personal data held. Under-18s may use the app. The gym is the data controller. **Privacy page updated (`pb-v109`).**
- Sensible nickname rules. Leaderboard is opt-in, default off. Privacy notice and sign-up wording must be readable by under-18s. **Done** (rules in db/30 `nickname_check()`; Ranks opt-in is `profiles.is_public`).
- ~~The 3 existing accounts can be deleted; no migration.~~ **Superseded:** all 7 existing accounts were migrated to nickname accounts on 18 Oct 2026.
- Points only for benchmark climbs. **Done** (db/27, Sep 2026).
- Pi-side code is rewritten from scratch for the Pi 4.
- Commit and push are separate steps, each needing Ross's explicit confirmation (19 Oct 2026; replaces the old push-straight-to-live rule). The claude.ai chat commits to `main`.
- **Pat Burner challenge** (19 Oct 2026), a timed competition on the existing "Pat Burner" circuit, timed on the phone (no LEDs, casting or Pi):
  - 3 sets × 3 reps, each rep to failure (count-up clock, tap Fell), 30 s between reps, 5 min between sets, 10 s get-ready, Web Audio beeps.
  - Score = total seconds held; ending early still saves and scores (a rep in progress counts up to that moment).
  - Leaderboard = each user's best attempt, earlier attempt wins a tie, all-time, nickname only, opt-in through "Show me on Ranks". Compare up to 3 opted-in climbers rep by rep. No mirrored runs.
  - Generic `challenges` table with the protocol as data; only the Pat Burner is seeded. A circuit used by a challenge is admin-only to edit and can't be deleted; attempts survive.
  - Self-reported scores; admins can delete an attempt (logged). Reps capped at 1200 s; an attempt saved offline can be retried for 14 days.
  - Old Symmetry results are not migrated: the board starts fresh.
- The Supabase MCP server (read-only, this project only) may be used to check live schema and data; results never go into repo files, and migrations are still applied by Ross in the SQL editor (19 Oct 2026, CLAUDE.md Session rules).

## Workstreams (in priority order)
1. PWA account rework: **done 18 Oct 2026.** Left: delete the local passphrase hand-out file once all 7 migrated accounts have signed in.
2. Cast contract finalised in docs/cast-contract.md. First version written 19 Oct 2026 from the code; its open questions need answers. (26 Oct: hardware items partly verified, see the log.)
3. Mock listener on the laptop for end-to-end cast testing without hardware. (`tools/cast-test.html` already subscribes and logs every cast; it doesn't yet turn a cast into LED indices.) Lower priority now that the real board can be tested over the webcam.
4. Hardware: **first light 26 Oct 2026** on temporary wiring. Next: wire the 8-way power feeds into 5 V/GND, build the box, fit the relay module and level shifter when they arrive, check column B direction.
5. Fresh Pi listener built to the contract, replacing the stopgap `cast_listener.py` (running on the Pi since 26 Oct). Then the tablet kiosk.

## Waiting on
- Relay module (eBay) and 74AHCT125 level shifter (Amazon) to arrive.
- An on-site check of the cast geofence centre (non-admin phone, by the board and at the far end of the gym).

## Feature backlog
- Admin can add climbs to benchmarks. (Exists per problem: detail ⋮ → "Mark as benchmark", admins only. Clarify what more is wanted.)
- Wall-screen mode for the touchscreen kiosk: browse and cast only, "Get the app" QR, Ranks read-only, back to the list when idle (after the LEDs work).
- Circuits Phase 2: the cast screen, `cast_circuit`/`stop` broadcasts, `circuit_logs`.
- Problem name/setter editing (changes the cast key: see the contract's open questions).
- ~~Pat Burner challenge~~ **live 19 Oct 2026** (`pb-v111`; db/31 applied the same day). Later, if wanted: more challenges (add a row to `challenges`), monthly boards, the metronome, casting the circuit at Start once Circuits Phase 2 exists.

## Open questions
Details in `docs/cast-contract.md` → "Open questions".
1. Feet indicators (B1/B2): light `hold2`/`hold21` as listed in the problem, as Gareth's code did, or drive them from `feet_mode`? What do both lights on mean?
2. How does the board get cleared or switched off? There's no clear/stop event.
3. Should the phone know whether the Pi is online or got the cast? Today it always says "Cast: X" once Supabase accepts it.
4. Stale, duplicate or rapid casts: debounce or rate limit on the Pi? (Casts carry no id or timestamp.)
5. Mirroring: the Pi applies `board_config.mirror_map`, or the app sends resolved holds? (The stopgap listener applies the map itself; mirrored casts not yet tested.)
6. Is the problem name still the cast key once names become editable?
7. Hardware: ~~pixel 0, colour order, strip start, the 16-wire harness~~ (answered 26 Oct: see the log). Still open: what each relay switched; column B direction (expected down).
8. Cast brightness: the stopgap uses 0.5; all-on tests stay at 0.1 until the power feeds are wired. What should the final values be?

## Session log
Newest first. Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-10-26, Claude Code (Pi files copied, cast contract updated, listener and kiosk planned).**
  - **Changed:** merged the hardware chat's status update. Copied the working Pi files into the local, gitignored `pi/` (`show_problem.py`, `cast_listener.py`, `board-cam.sh`; units in `pi/systemd/`). `docs/cast-contract.md` §6.4 and §7 item 11 now record what first light verified, and §5 notes the stopgap listener. Checked on the Pi: it's a Pi 4 with **2 GB** (not 4 GB), running trixie **Lite** (no desktop packages), Python 3.13, `websockets` 15; the touchscreen's USB touch shows up as a G2Touch multi-touch device.
  - **Left:** Ross's decisions on the listener and kiosk plan (local `docs/pi4-listener-kiosk-plan.md`), then build the listener, then the kiosk.
  - **New questions:** the kiosk needs a display stack on the Lite card (a minimal compositor such as `cage`, or a reflash with desktop). The stopgap drops out-of-range hold ids before assigning roles, so roles could shift on bad data; the new listener classifies first, like `classifyHolds()`.

- **2026-10-26, chat (hardware: bring-up, first light, first cast).**
  - **Pi 4 bring-up:** `setup.sh` ran clean (9/9). Tailscale name `projectboard`; laptop key login works.
  - **Wi-Fi lost after the first reboot:** the Pi joined but got no IPv4 (`127.0.1.1` + link-local only). Disabling setup.sh's power-save file did not fix it. NetworkManager's netplan-backed connection had been rewritten at that boot (`/etc/netplan/90-NM-*.yaml`). Fixed with a one-shot `systemd.run` script from the boot partition: a new keyfile connection `hangout-fixed` (autoconnect-priority 100, `cloned-mac-address=permanent`), `conf.d/98-projectboard-no-rand-mac.conf`, a persistent journal (`/var/log/journal`), and `pb-netlog.service` (writes `/boot/firmware/netlog.txt` 60 s after each boot). Survived a reboot test. **Root cause not confirmed.** The power-save file is parked at `/home/pi/99-projectboard-wifi-powersave.conf.disabled`; the fix scripts were deleted from the boot partition. Lesson: reboot-test straight after setup.
  - **Harness mapped** (unpowered; continuity and diode mode): 4-way **blue = 5 V, black = GND, green = data, red = clock** (data/clock confirmed at first light). Diode readings: data and clock 0.70 V, 5 V rail 0.43 V. Plain-white 8-way plug: B1, B4–B7 = 5 V. Black-and-white striped 8-way plug: A2, A3, A5–A7 = GND. A1, A4, A8, B2, B3, B8 connect to nothing (positions 1–8 counted left to right, screws facing you).
  - **Supplies (YU0510 ×2):** DC plugs cut. On both, the **plain conductor is +** and the printed one is −. Supply 1 was first wired reversed: the chips' protection diodes clamped it to ~0.3 V, with no lasting damage seen. **One 10 A supply can't start the strip; both in parallel hold 5.4 V.**
  - **Temporary wiring:** 5 V Wago = 4-way blue + both supplies' +. GND Wago = 4-way black + Pi GND (pin 25, sharing a hole) + both supplies' −. Terminal strip: 4-way green ← Pi pin 19 (MOSI), 4-way red ← Pi pin 23 (SCLK). No level shifter (3.3 V direct works), no relays, 8-way plugs not connected. One terminal-strip screw is cross-threaded.
  - **First light:** colour order **RGB**. **Pixel 0 exists but is mounted behind the board** (not visible). **Pixel 1 = A1**, walking up column A. Column B direction not checked. At 10% all-white the far end goes red/orange (voltage drop: power only enters through the 4-way cable).
  - **Casting works end to end** from the live app. Mirrored casts untested.
  - **On the Pi, not yet in the repo:** `~/show_problem.py` (light a problem by name, `--off`), `~/cast_listener.py` (stopgap listener: Realtime WebSocket, `phx_join` on `realtime:board:HangoutPortland`, `cast_problem` → REST lookup by exact name → contract §6.2 order and colours, §6.3 mirror via `board_config.mirror_map` loaded on each connect, §6.4 LED map; brightness 0.5; reconnects every 5 s on error), `~/board-cam.sh`. systemd units: `cast-listener`, `leds-off-at-boot`, `board-cam` (ustreamer USB webcam bound to the Tailscale IP, port 8080, `/stream`), `pb-netlog`. Packages added: `python3-websockets`, `ustreamer`.
  - **Touchscreen:** HDMI 0 via the micro-HDMI adapter shows the console. Its USB (touch) cable is now in the Pi. No kiosk yet.
  - **Left:** wire the 8-way feeds into 5 V/GND (fixes the far-end colour and takes current off the thin 4-way wires; until then a full-on power-up is a risk, softened by `leds-off-at-boot`); build the box; relay and 74AHCT125 when they arrive; copy the Pi files into `pi/`; proper listener to the contract (retire the stopgap); tablet kiosk; fold the Wi-Fi fix into setup.sh and drop its power-save step; check column B direction; update `docs/cast-contract.md` §6.4 and §7 item 11.
  - **New questions:** what did the second relay switch? Final brightness values? What should the board show when idle?

- **2026-10-26, Claude Code (Pi 4 SD card prepared for the first power-on).**
  - **Changed:** on the freshly imaged trixie card's boot partition, `dtparam=spi=on` added under `[all]` in `config.txt`, and a `projectboard/` folder added: `setup.sh` (apt installs python3-spidev + python3-gpiozero, raspi-config SPI as a backup, PASS/FAIL for `/dev/spidev0.0`), `led_test.py` (WS2801, SPI0 CE0, 1 MHz, mode 0, R,G,B, 10% default brightness; colour check, pixel walk, all on, all off; Ctrl+C clears 1200 pixels), `relay_test.py` (BCM 23/24, active-low, start off, toggle per key, off on exit) and `README.txt`. Copies of the scripts are in the local, gitignored `pi/bringup/`. Nothing committed.
  - **Left:** the first power-on test (README steps).
  - **New questions:** is the new relay module active-low like Gareth's? Does pixel 0 exist, and is the colour order R,G,B?

- **2026-10-20, chat (hardware parts).**
  - **Changed:** corrected the hardware notes in Current state (no relay module on the wall; Gareth's box is gone; two LED supplies and the touchscreen with its HDMI cable remain). Recorded the parts Ross bought to rebuild the box to match Gareth's setup.
  - **Left:** Ross's wall photos (Waiting on), then the wiring guide and first power-on test; then the fresh listener (workstream 5).
  - **New questions:** what each of the two LED supplies powers and their ratings; which harness wires are 5 V, ground, data and clock; what the second relay switched (possibly the touchscreen's power).

- **2026-10-20, Claude Code (no stray scroll; pinch in and out of fullscreen).**
  - **Changed (`pb-v113`–`pb-v115`):** pages that fit no longer scroll by a few pixels (12px gap above the nav, no trailing margin on the last item; Profile and the challenge page spaced a little tighter). Fullscreen pinch now follows the fingers 1:1 (gain 1.8 → 1). On a problem or circuit, a pinch on the board opens fullscreen and keeps zooming; pinching all the way back out glides the board back and closes it (not for landscape-opened fullscreen or create views). **`pb-v115`:** on those views a double-tap anywhere closes fullscreen the same way.
  - **Tested:** scroll overflow measured per view at 390×844/763/667; the pinch with simulated touches in Chrome. Not yet on a real phone.
  - **Live:** Ross checked it on his phone on staging; `main` fast-forwarded to `dev`. The first production build (`0dcea6f`) failed in Cloudflare although the same tree built on `dev`; an empty retry commit (`a9a56ec`) deployed it. Live `sw.js` confirmed at `pb-v115`.
  - **Left:** nothing.
  - **New questions:** none.

- **2026-10-20, Claude Code (button consistency sweep).**
  - **Changed (`pb-v112`):** every button now uses the page font (they were drawn in the browser's control font); one radius (`--btn-radius`, 10px) for all buttons and fields; secondary (ghost) buttons use normal text colour, and stacked buttons are always 10px apart; one small-button style (Suggest one, Copy, End early, the install banner); press feedback and a disabled look on every button; sheet close buttons are 36px like the other icon buttons; the nickname sheet lost its extra inset; Profile's header matches Ranks'; the "+" button matches the other icon buttons; the edit-grade sheet and circuit create use the same grade grid as problem create; circuit create saves with a tick (was a floppy disk) and every undo/redo uses the same icon; the outline editor's Preview toggle lights up like Shuffle.
  - **Live:** Ross checked it on his phone on staging; `main` fast-forwarded to `dev` (`b603ebe`), live `sw.js` confirmed at `pb-v112`.
  - **Left:** nothing.
  - **New questions:** none.

- **2026-10-19, Claude Code (Pat Burner: the way back).**
  - **Tested on staging** with two throwaway accounts, through the app: a full run, reloads mid-rep and mid-rest, End early, saving with no signal, the Ranks switch, a tie, compare, the circuit lock. All passed; both accounts deleted through the app. Ross checked the admin delete and the circuit delete refusal.
  - **Changed (`pb-v111`):** leaving the challenge view no longer pauses anything visible: the beeps carry on in every view, and a strip on the bottom nav ("Back to the Pat Burner", with the phase and clock) leads back to the attempt.
  - **Live:** Ross checked it on his phone on staging; `main` fast-forwarded to `dev` (`6d341d3`), live `sw.js` confirmed at `pb-v111`. This deploy took the whole challenge live (live was on `pb-v109`).
  - **Left:** nothing for the challenge.
  - **New questions:** none.

- **2026-10-19, Claude Code (Pat Burner challenge).**
  - **Background:** looked at Ross's old Symmetry app (local, not in this repo) for how the Pat Burner competition worked.
  - **Built:**
    - local `db/31_challenges.sql` (`challenges`, `challenge_attempts`, the circuit lock, `challenge_leaderboard()`, `challenge_compare()`, `admin_delete_attempt()`, `admin_actions.subject_id`), checked in PGlite with 80 behaviour checks;
    - `app/challenge.js` (a tenth script: the `#challenge` view, phone timer, saving with retry, Ranks tab, compare chart, admin delete);
    - smaller changes in `core.js`, `state.js`, `circuits.js`, `authoring.js`, `account.js`, `leaderboard.js`, `app.js`, `index.html`, `styles.css`;
    - `privacy.html` covers challenge attempts; SW `pb-v110`;
    - CLAUDE.md (ten scripts; the read-only Supabase MCP rule) and the overview (§4.6a) updated.
  - **Left:** Ross applies db/31 and runs the test checklist; then commit and push, each on confirmation.
  - **New questions:** none.

- **2026-10-19, Claude Code.** Investigated the cast flow end to end (PWA, Supabase, old Pi listener, Gareth's code). Created this file and `docs/cast-contract.md` (plus its `.gitignore` exception); added "Session rules" to CLAUDE.md and replaced working rule 2 (commit and push each need explicit confirmation). Left: answer the contract's open questions; Pi 4 handover. New questions: listed above.
