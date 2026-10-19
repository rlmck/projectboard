# Project status

Shared by Claude Code and the claude.ai project chat (which edits it through GitHub). **Pull before you edit.** The repo is public: no personal data about users, no personal circumstances, no secrets. Rules for both sides: CLAUDE.md → "Session rules". The cast contract: `docs/cast-contract.md`.

## Current state (as of 2026-10-19)
- Old Pi 3B: unavailable. Not relying on it.
- Rebuild plan: a donated Raspberry Pi 4 (believed 4GB) from a gym member. Nothing else comes with it (no HAT, relays or PSU), so parts must be bought.
  - Already in the box behind the board, and reusable: the relay module, the LED power supply (a 5 V 10 A brick) and the wall touchscreen. To buy: a USB-C 5 V 3 A supply for the Pi 4, a 74AHCT125 level shifter, a micro-HDMI to HDMI cable.
- The original system's SD card image (dtb-backup.img) is kept for reference only.
- board_listener.py will be discarded; Pi-side code starts fresh.
- LEDs don't work yet, so the app is not fully rolled out to the public.
- The app itself is live at https://symmetryboard.co.uk (service worker `pb-v109`). Casting sends correctly, but no listener is running, so nothing lights.

## Decisions
- Remove Google sign-in completely. **Done 18 Oct 2026** (provider off; OAuth client deleted 19 Oct).
- Accounts: nickname + 4-word generated passphrase. Admin can generate a new passphrase for a lost account, with an activity check and a reset log. A new phone means re-entering nickname + passphrase. **Live 18 Oct 2026** (`pb-v108`, db/30; the Edge Function `admin-reset-passphrase`; the log is the `admin_actions` table).
- No personal data held. Under-18s may use the app. The gym is the data controller. **Privacy page updated (`pb-v109`).**
- Sensible nickname rules. Leaderboard is opt-in, default off. Privacy notice and sign-up wording must be readable by under-18s. **Done** (rules in db/30 `nickname_check()`; Ranks opt-in is `profiles.is_public`).
- ~~The 3 existing accounts can be deleted; no migration.~~ **Superseded:** all 7 existing accounts were migrated to nickname accounts on 18 Oct 2026.
- Points only for benchmark climbs. **Done** (db/27, Sep 2026).
- Pi-side code is rewritten from scratch for the Pi 4.
- Commit and push are separate steps, each needing Ross's explicit confirmation (19 Oct 2026; replaces the old push-straight-to-live rule). The claude.ai chat commits to `main`.

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

- **2026-10-19, Claude Code.** Investigated the cast flow end to end (PWA, Supabase, old Pi listener, Gareth's code). Created this file and `docs/cast-contract.md` (plus its `.gitignore` exception); added "Session rules" to CLAUDE.md and replaced working rule 2 (commit and push each need explicit confirmation). Left: answer the contract's open questions; Pi 4 handover. New questions: listed above.
