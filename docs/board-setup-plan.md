# Board setup and board sets: the plan

Planned in the claude.ai project chat on 7 Nov 2026; narrowed on 9 Nov 2026. TODO 13. The repo is public: nothing personal, nothing secret.

**Built so far:** session 1 (9 Nov 2026): the holds table and the backend for Specific feet (db/41). Sessions 2 and 3 aren't built.

## Why
- **The holds will be rearranged** one day. Some LEDs sit at fixed positions (which dictate where holds go), some go through the board into the hold itself, so LEDs move with holds. After a rearrange: a new photo, a new cartoon board image, and the holds re-mapped to LEDs.
- **Other gyms.** The app and board are close to a finished product, so setting up a board (photo → cartoon board → holds → LED mapping) must be a smooth end-to-end flow, doable on a phone, and repeatable.
- **Specific feet.** The current photo misses the footholds at the bottom. The next photo covers the whole board so footholds can be outlined and picked.

## Decisions
**7 Nov 2026 (Ross):**
- **Layout:** free-form but symmetrical; it may not fit the 19 × 13 grid. The grid stops being the hold identity (the grid becomes one possible layout, not an assumption).
- **LEDs:** every hand hold has exactly one LED (a hold without one doesn't go on the board). Footholds have no LEDs. The feet signs (Orange B2, LED 25; Black B1, LED 26) keep their LEDs and their behaviour.
- **Hands only on the wooden holds; feet never on them.** Specific feet may only pick footholds.
- **Specific feet:** a fourth feet rule beside Any / Orange only / Black only. The setter taps "Specific feet" and picks footholds. Shown in the app and on the kiosk only: **the board lights nothing for it, and no feet sign.**
- **Board sets** (for a real rearrange, later): each rearrange starts a new set ("Set 1", "Set 2"…); the old set's problems, circuits and benchmarks are archived, read-only, with ticks kept. New benchmarks are set on the new board. **Ranks and points carry on all-time** (no reset).
- **The cartoon** is made once, outside the app, with an image generator (as the current one was) and uploaded. No AI in the app.
- **LED mapping** uses a phone on a tripod facing the board.

**9 Nov 2026 (Ross):**
- **No rearrange for now:** Ross is only rotating a few little-used holds on the current board. So the **dry run is on the current board**, no archive and no new board set are needed, and nothing waits on the archive.
- **Existing hand holds keep their ids (`holdN`) and names (A1–S13)**, so no problem, circuit, tick or benchmark changes.
- **Footholds are new holds**, added by the setup flow from the new full-board photo (footholds included). Nothing in session 1 depends on that photo.
- **Foothold names: FT1, FT2…** (Ross, later on 9 Nov 2026), numbered left to right, starting from the bottom row, then the next row up, left to right, and so on. The first idea, F1, F2…, clashed with the hand holds in column F (F2–F11 and F13), and names are unique per board. The setup flow numbers them this way when it adds them.
- **Three sessions:** (1) the holds table and the Specific feet backend; (2) the admin setup flow; (3) Specific feet in Create and on the problem view (phone and wall screen).

## What session 1 built (9 Nov 2026, db/41)
- **`public.holds`**: one row per hold per board (`wall`, the `board_config` key): `id`, `name`, `kind` (`hand` / `foot` / `feet_sign`), `led` (null only for a foothold; unique per board), `x`, `y`, `outline`, `mirror` (a partner on the same board), `updated_at`. Public read; no API writes yet. Seeded from the live board: the 188 hand holds (positions, outlines and mirror pairs from `board_config`, LEDs from the formula) and the two feet signs (`hold2` = B1 = LED 26, `hold21` = B2 = LED 25). db/01's empty `holds` table was dropped first.
- **No board-set column:** problems and circuits would need one too, so adding it now saves no migration. The board is the `wall` key.
- **Who edits what until session 2:** `name`, `kind` and `led` live only in the table (direct Postgres). Positions, outlines and mirror pairs are still edited in `board_config` (the outline editor publishes `hold_shapes`); the trigger `board_config_sync_holds` copies every change into the table, so the two never drift.
- **The seed check:** `python tools/check_holds.py` (live, read-only, public data): every LED equals the formula and `tools/led_map.json`, every partner/position/outline equals `board_config`, names are the grid names, the feet signs are right, footholds have no LED, the bundled snapshot matches live. Run it after any change to the holds. `pi/tests/test_holds.py` tests the same check offline and that every problem shape, mirrored or not, every feet rule, previews and circuits light the same LEDs from the table as from the formula.
- **The Pi** reads each hold's LED and mirror partner from the table (`board.hold_led()`), on each join and every 10 minutes, cached in `/var/lib/projectboard/cache/holds.json` for a boot with no network; with no table and no cache, the formula. `pb-status` shows where the holds came from. pb-ledmap's "light a problem" uses the table too; its cell tools stay on the formula (they check it).
- **The app** reads names, kinds and mirror partners from the table (`loadHolds()` in `problems.js`, saved for offline; `holdName()` in `core.js` labels the hold chips and the outline editor). Nothing visible changed.
- **Specific feet backend:** `problems.feet_mode` gains `specific`; `problems.feet_holds` (text[]) holds 1–30 different footholds of the board, checked by `problems_guard_feet` (any other rule empties it, so an older app saving Any never fails; checked only when the feet change). Owners may edit it (db/39's guard). `wall_create_problem()` takes `p_feet_holds` (default empty; the wall page's current call still works) and now checks hand holds and the finish zone against the table. The Pi lights nothing for `specific` (contract §6.5). Tested by `db/41_holds_test.sql` (local).

## Still grid-bound (for session 2)
- **Positions and outlines** come from `board_config.hold_map` / `hold_shapes` in the app (and the bundled `hold_map.json`, `hold_shapes.json`, `mirror_map.json`, written by `tools/snapshot_board.py` from `board_config`). Session 2 makes the table the place they're edited (admin RLS + grants on `holds`), then either regenerates the `board_config` copies from it or moves the app, the snapshot and the outline editor onto the table, and retires the sync trigger.
- **`shapesUsable()`** gates outlines on `board_config.updated_at` = `__meta.board_updated_at`.
- **Create's hit-testing** (`authoring.js`, `circuits.js`) taps any key of `HOLD_MAP`: once footholds have positions, hand-hold picking must skip `kind = 'foot'`, and the finish zone (top 25% of the y span) must use hand holds only (`wall_create_problem` already does).
- **Hand hold ids** must match `^hold[0-9]{1,3}$` (CHECKs `problems_holds_valid`, `circuits_sequence_valid`, db/29). Fine while hand holds keep their ids; footholds only ever go in `feet_holds`.
- **The feet signs are hard-coded** as `hold2`/`hold21`: the app's `FEET_LIGHT_HOLDS` (`core.js`), the Pi's `FEET_LIGHTS` (`board.py`), db/40's move check. The table marks them `feet_sign`; the code could read that.
- **The Pi's idle patterns** draw on the 19 × 13 grid through the formula (`patterns/common.py`), and the teaser maps a benchmark's holds to grid cells (`teaser.from_rows`); circuit tracks (`check_track`, not drawn) check `holdN` ids. pb-ledmap's cell tools are the formula by design; camera mapping replaces it.
- **The outline editor** labels holds "B2 · hold 23" and sorts by the number in the id.
- **PB Console**'s test cast shows mirror partners from `board_config.mirror_map` (`console/supabase_api.py`).
- **`holdName()`** falls back to the grid name when the table hasn't loaded.

## Open questions
1. **How the setup flow talks to the Pi** for mapping (a new Realtime event to light one LED?): a cast contract change.
2. **Mirroring Specific feet** in the app's mirrored view: do footholds have mirror partners (foot ↔ foot), or are Specific feet shown unmirrored?
3. **Other gyms:** today there's one board (`board:HangoutPortland`, one `board_config` row, one wall key, one geofence). Multi-gym comes later; keep the setup flow free of Hangout and grid assumptions. Specific feet are checked against the one board today (problems have no board column).

## The setup flow (session 2: admin, on a phone)
1. **Upload** the photo and the cartoon (same framing).
2. **Trace:** auto-trace the holds on the cartoon (below); review: add, move, delete; outline the footholds and mark them as footholds.
3. **Map LEDs:** phone on a tripod; the app has the Pi light each LED in turn, the camera finds the lit spot, which is matched to the nearest traced hold (photo → cartoon via the four board corners). Where it can't tell, tap the lit hold. Every hand hold ends with exactly one LED; the feet-sign LEDs stay.
4. **Mirror pairs:** generated by reflecting the layout about the vertical centre line and matching nearest holds; review.
5. **Publish.** On the current board (the dry run) this updates the holds in place: the hand holds keep their ids, the footholds are added. A real rearrange later publishes a new set and archives the old one (below).

## Later (a real rearrange)
- **Board sets and the archive:** a set per layout; problems, circuits and benchmarks belong to a set; browse old sets read-only, with your ticks.

## Auto-tracing: what we found (7 Nov 2026)
Ross's rules: every hold has a black outline, possibly with black detail lines inside, so use the **outermost** line; outlines should be smooth; holds are solid (no holes); holds differ in colour, shading and texture.

A quick OpenCV test on `app/board-fallback.jpg` (thin dark lines found with a black-hat filter; background = the large connected light regions; closing; holes filled; touching holds split at their necks by a watershed; grown to the outline's outer edge; Gaussian smoothing), scored against the 188 outlines in `app/hold_shapes.json`:
- median overlap (IoU) 0.91: 166 holds ≥ 0.8, 11 at 0.6–0.8, 4 below 0.6, 7 missed; no holds merged;
- about 23 extra shapes, mostly footholds;
- **the misses are the dark grey holds** (their edge is as dark as the outline, so the line has gaps and the hold leaks into the background) and a few orange footholds on pink.
- **Fix:** combine the outline method with colour difference from the local background (dark holds stand out clearly against pink or white). The review step catches the rest.

The current 188 hand-traced outlines are the pass mark for auto-tracing.

## Cartoon prompt: what it must ask for
- a thick, even, dark outline around every hold, footholds included; dark holds drawn with a slightly lighter edge so the outline stands out;
- no drop shadows;
- flat, solid background colours, no texture or gradients;
- holds never touching or overlapping;
- the same framing and proportions as the photo, nothing cropped, no holds added or removed.

The full prompt gets written once the new photo exists.

## Next steps (Ross)
1. A full-board photo of the current board, footholds included: straight on, even light.
2. The cartoon from it, with the prompt (written in the chat when the photo exists).
