# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The cast contract: `docs/cast-contract.md`.

## Current state (as of 2026-10-19)
- Old Pi 3B: unavailable. Not relying on it.
- Rebuild plan: a donated Raspberry Pi 4 (believed 4GB) from a gym member. Nothing else comes with it (no HAT, relays or PSU), so parts must be bought.
  - Already in the box behind the board, and reusable: the relay module, the LED power supply (a 5 V 10 A brick) and the wall touchscreen. To buy: a USB-C 5 V 3 A supply for the Pi 4, a 74AHCT125 level shifter, a micro-HDMI to HDMI cable.
- The original system's SD card image (dtb-backup.img) is kept for reference only.
- board_listener.py will be discarded; Pi-side code starts fresh.
- LEDs don't work yet, so the app is not fully rolled out to the public.
- The app itself is live at https://symmetryboard.co.uk (service worker `pb-v111`, 19 Oct 2026), with the Pat Burner challenge live. Casting sends correctly, but no listener is running, so nothing lights.

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
2. Cast contract finalised in docs/cast-contract.md. First version written 19 Oct 2026 from the code; its open questions need answers.
3. Mock listener on the laptop for end-to-end cast testing without hardware. (`tools/cast-test.html` already subscribes and logs every cast; it doesn't yet turn a cast into LED indices.)
4. Hardware: parts list once the Pi 4 is in hand; check LED strip compatibility against the original SD image. (From Gareth's code and the image: WS2801 over SPI0, 1 MHz, mode 0, RGB, 5 V. Still to check on the wall: colour order, pixel 0, the 16-wire harness, what each relay switches.)
5. Fresh Pi listener built to the contract, replacing the mock.

## Waiting on
- Pi 4 donation (handover)
- On install day: photos of the green sockets in the box; identifying the 16-wire harness (two 8-way plugs).
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
5. Mirroring: the Pi applies `board_config.mirror_map`, or the app sends resolved holds?
6. Is the problem name still the cast key once names become editable?
7. Hardware: pixel 0, colour order, strip start, the 16-wire harness, what each relay switches.

## Session log
Newest first. Each entry: date, which side (Claude Code / chat), what changed, what's left, new questions.

- **2026-10-20, Claude Code (button consistency sweep).**
  - **Changed (`pb-v112`, on `dev` only):** every button now uses the page font (they were drawn in the browser's control font); one radius (`--btn-radius`, 10px) for all buttons and fields; secondary (ghost) buttons use normal text colour, and stacked buttons are always 10px apart; one small-button style (Suggest one, Copy, End early, the install banner); press feedback and a disabled look on every button; sheet close buttons are 36px like the other icon buttons; the nickname sheet lost its extra inset; Profile's header matches Ranks'; the "+" button matches the other icon buttons; the edit-grade sheet and circuit create use the same grade grid as problem create; circuit create saves with a tick (was a floppy disk) and every undo/redo uses the same icon; the outline editor's Preview toggle lights up like Shuffle.
  - **Left:** Ross to check on his phone on staging, then fast-forward `main`.
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
