# Circuits Phase 2: the design spec

Agreed 15 June 2026. Moved here on 29 Oct 2026 from the local-only `docs/project-notes.md` so the claude.ai chat can read it; nothing else from that file came with it. When it's built, the new `cast_circuit` and `stop` events go into `docs/cast-contract.md` in the same commit (CLAUDE.md → Session rules).

Phase 1 (browse, create, and an in-app Play preview, removed on 30 Oct 2026) is built. **Phase 2 was built on 30 Oct 2026**: what was built is in `docs/cast-contract.md` §8, and it differs from the spec below where Ross chose differently:
- **The look** is "Pulse and fade" (direction 4 of `tools/circuit-led-simulator.html`, chosen 30 Oct 2026), not the 4-hold window: the start holds flash **red** in the countdown; then the hold to go to is solid blue, the one after swells amber, the one let go of fades out in red; a match stays solid; at the top the route runs up in green.
- **Speed** is three steps, Slow 5 s / Med 3 s / Fast 2 s a move, not 0.1 s steps.
- **The phone** shows the countdown (with beeps), the move count and a big Stop; it doesn't mirror the lights.
- **Stop and the finish** crossfade the board into the idle pattern; a forgotten loop ends after 30 minutes (`CIRCUIT_MAX_S`).
- **The wall screen** casts circuits too (its Circuits page, 30 Oct 2026).
- **The Play preview is gone** (Ross, 30 Oct 2026): casting replaced it.
- **Future releases, not now:** mirrored circuits (the Pi takes `mirror`, the app never sends it), and a Done filter for circuits ("done" means "done both sides" and applies to problems only; the circuits list's inert Exclude Done pill was removed).

The original spec follows.

A **circuit** is its own entity (not a grouping of problems): a long route that mimics a roped **sport** climb.
- Lowercase French **sport** grade ladder: `4, 5a … 8b`.
- A single **ordered hold sequence**: 1–2 start holds → moves → finish. **Holds may repeat.**
- **Loop:** a setter-defined flag; the **caster can also toggle loop** at cast time. A looping circuit runs until Stop.
- Anyone can cast; **only signed-in users' runs are logged**.

**Cast = a moving-window LED animation** (not all-on like a problem):
- **5-second countdown with sounds** (Web Audio beeps); during it the start holds pulse green and the first 2 moves show blue.
- **A window of 4 holds** lit at once: at go, 2 starts (green) + the next 2 moves (blue). Each interval the next hold lights and the oldest turns off. A matched/single start stays lit one move longer.
- **Speed:** a global default the caster adjusts in **0.1 s** steps at cast time. Not stored per circuit; the Pi runs the loop itself.
- **Move counter:** 1 move = one LED advance, counting up across loops. A big **STOP** button ends the run, clears the board and logs the move count (for future PBs and comps).
- The phone doesn't mirror the animation during the climb (the in-app Play preview does that beforehand).
- Reuse the problem cast's geofence gate (`ensureCastLocation`).

**Data:** `circuit_logs` (`user_id`, `circuit_id`, `moves`, `looped`, `speed`, `created_at`) already exists with own-rows RLS (db/14). Writing to it is what activates the circuits "Exclude Done" pill.

**Cast contract (planned):** a new `cast_circuit` broadcast on `board:HangoutPortland` (`circuit_name`, `interval`, `loop`, `mirror`, a run token) plus a `stop` event. The Pi fetches the sequence from the `circuits` table (the same DB-read pattern the listener uses for problems) and runs the window loop itself.

**Phasing:** Phase 2 = cast screen + broadcast + `circuit_logs` + Pi listener update. Phase 3 = personal bests, leaderboards, competitions from `circuit_logs`.
