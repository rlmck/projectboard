# Board setup and board sets: the plan

Planned in the claude.ai project chat on 7 Nov 2026; narrowed on 9 Nov 2026. TODO 13. The repo is public: nothing personal, nothing secret.

**Built so far:** session 1 (9 Nov 2026): the holds table and the backend for Specific feet (db/41). Session 2a (9 Nov 2026): the admin setup flow without camera LED mapping (db/42, `#setup`). Not built: 2b (camera LED mapping) and 3 (Specific feet in Create and on the problem view).

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
- **Three sessions:** (1) the holds table and the Specific feet backend; (2) the admin setup flow, split into 2a (everything but LED mapping) and 2b (camera LED mapping); (3) Specific feet in Create and on the problem view (phone and wall screen).
- **For 2a (Ross, 9 Nov 2026):** the dry run is on the current board; Ross rotates a few little-used holds and takes a new full-board photo (footholds included) and makes a cartoon from it, so every hand hold's position and outline change and the rotated holds' outlines change shape. Hand holds keep id, name and LED; no problem, circuit, tick or benchmark changes; no board sets, no archive.
- **Footholds have mirror partners** (Ross, 9 Nov 2026; open question 2): foot ↔ foot where the reflection finds one; an unpaired foothold has none. **Hand ↔ foot pairs are never allowed.**

## What session 1 built (9 Nov 2026, db/41)
- **`public.holds`**: one row per hold per board (`wall`, the `board_config` key): `id`, `name`, `kind` (`hand` / `foot` / `feet_sign`), `led` (null only for a foothold; unique per board), `x`, `y`, `outline`, `mirror` (a partner on the same board), `updated_at`. Public read; no API writes yet. Seeded from the live board: the 188 hand holds (positions, outlines and mirror pairs from `board_config`, LEDs from the formula) and the two feet signs (`hold2` = B1 = LED 26, `hold21` = B2 = LED 25). db/01's empty `holds` table was dropped first.
- **No board-set column:** problems and circuits would need one too, so adding it now saves no migration. The board is the `wall` key.
- **Who edited what until 2a:** `name`, `kind` and `led` lived only in the table; positions, outlines and mirror pairs were edited in `board_config` and copied in by the trigger `board_config_sync_holds`. db/42 reversed that (below).
- **The seed check:** `python tools/check_holds.py` (live, read-only, public data): every LED equals the formula and `tools/led_map.json`, every partner/position/outline equals `board_config`, names are the grid names, the feet signs are right, footholds have no LED, the bundled snapshot matches live. Run it after any change to the holds. `pi/tests/test_holds.py` tests the same check offline and that every problem shape, mirrored or not, every feet rule, previews and circuits light the same LEDs from the table as from the formula.
- **The Pi** reads each hold's LED and mirror partner from the table (`board.hold_led()`), on each join and every 10 minutes, cached in `/var/lib/projectboard/cache/holds.json` for a boot with no network; with no table and no cache, the formula. `pb-status` shows where the holds came from. pb-ledmap's "light a problem" uses the table too; its cell tools stay on the formula (they check it).
- **The app** reads names, kinds and mirror partners from the table (`loadHolds()` in `problems.js`, saved for offline; `holdName()` in `core.js` labels the hold chips and the outline editor). Nothing visible changed.
- **Specific feet backend:** `problems.feet_mode` gains `specific`; `problems.feet_holds` (text[]) holds 1–30 different footholds of the board, checked by `problems_guard_feet` (any other rule empties it, so an older app saving Any never fails; checked only when the feet change). Owners may edit it (db/39's guard). `wall_create_problem()` takes `p_feet_holds` (default empty; the wall page's current call still works) and now checks hand holds and the finish zone against the table. The Pi lights nothing for `specific` (contract §6.5). Tested by `db/41_holds_test.sql` (local).

## What session 2a built (9 Nov 2026, db/42, `#setup`)
- **The holds table is the source** of positions, outlines and mirror pairs. `board_config.hold_map` / `mirror_map` / `hold_shapes` are copies made from it (hand holds only, `__meta` kept) by the statement trigger `holds_sync_board_config`, so the app, the bundled snapshot (`tools/snapshot_board.py`), PB Console and old cached app versions read exactly what they read before. A direct API write to those three columns is refused (`board_config_guard_derived`). db/41's `board_config_sync_holds` is retired.
- **Admins may UPDATE** `holds.x`, `y`, `outline`, `mirror` (RLS + column grants; never `led`, `name`, `kind`). Mirror pairs are checked at commit (`holds_check_mirror`): the same kind, pairing back.
- **`board_config.photo_path` and `corners`** (`{image: [[x,y]×4], photo: [[x,y]×4]}` in % of each picture, TL/TR/BR/BL): for 2b.
- **`admin_publish_board()`**: one transaction. Hand holds keep id, name and LED (only position, outline and partner change; every one must be given); footholds (`footN`, `FTn`, no LED) replace the old ones; the cartoon becomes the board image; `updated_at` moves on and `hold_shapes.__meta.board_updated_at` with it. Refuses a foothold a problem uses, a hand ↔ foot pair, a one-way pair, a clashing name, an image not in the bucket.
- **The way back:** `board_versions` keeps the board before each publish (all its holds rows, image, photo, corners, version, outline settings); **`admin_undo_board()`** puts the newest back, keeping the replaced board as a version too. Admin → Board Setup → Undo the last publish.
- **`admin_set_hold_outlines()`**: the `#outlines` editor now publishes into the table (still pinned to the board version).
- **The app:** Admin → **Board Setup** (`#setup`, `app/setup.js`, `app/trace.js`): photos, corners, line-up (first run), trace, match, review, mirror pairs, publish, undo (overview §4.8d). `isHandHold()` keeps footholds out of Create's hit-testing and the finish zone.
- **The line-up (10 Nov 2026), first run only:** today's board image is cropped (no footholds section), so its corners can't be marked and the 2a "Today's board" corners tab would have given a badly wrong first guess. It's replaced by a **Line up** step after Corners, shown only while `board_config.corners` is empty: tap four hand holds on today's image (each tap snaps to the nearest hand hold and shows its name; tap a numbered hold, then another hold, to change it), then the same four on the cartoon in the same order (the hint names the next one; drag a number to fine-tune, with the magnifier). The match's first guess is then the homography from those four point pairs (today's image % → cartoon %); the affine refinement is unchanged. It refuses four holds that are bunched, nearly in a line or with one inside the other three's triangle, and a cartoon four in a different order. Saved in the device draft (`lineup`). On a later run (corners stored) the step is skipped and the match goes through the stored corners as before. The cartoon and photo corners are still the real board corners (the trace's area, saved to `board_config.corners`).
- **Tested:** `db/42_board_setup_test.sql` (rolled back; fails on the old schema): anon and members refused, direct copy writes refused, LEDs locked, publish refusals change nothing, publish (LEDs, names, kinds unchanged; copies follow; version pinned), the outline editor's publish, a foothold in use, two publishes and two undos back to exactly the board before. A full dry run of the flow on `board-fallback.jpg` in Chrome at phone width (uploads and the RPC stubbed), then the flow's own publish payload through the real `admin_publish_board()` and `admin_undo_board()` in a rolled-back transaction. The line-up (10 Nov): today's board = `board-fallback.jpg` with the bottom 30% cut off (holds' y rescaled), the cartoon = the whole picture; four holds near the cropped picture's corners, tapped on the cartoon up to ±0.4% off: all 188 hand holds matched their own shape (first guess within 0.84% of the board's width of the truth); bunched/collinear picks, a hold inside the others' triangle and a swapped cartoon order were refused; the draft restored the line-up.

### What was grid-bound, now
- **Positions and outlines:** resolved (the table is the source; `board_config` copies).
- **`shapesUsable()`:** unchanged and still right: a publish moves `updated_at` and `__meta.board_updated_at` together.
- **Create's hit-testing and the finish zone:** hand holds only (`isHandHold()`; `HOLD_MAP` holds hand holds anyway).
- **Hand hold ids** stay `holdN` (the CHECKs are untouched); footholds only ever go in `feet_holds`.
- **Still as they were, not blocking:** the feet signs hard-coded as `hold2`/`hold21`; the Pi's idle patterns, teaser and pb-ledmap cell tools on the 19 × 13 grid through the formula (2b's camera mapping replaces pb-ledmap's cells); the outline editor sorts by the id's number; `holdName()` falls back to the grid name; PB Console's test cast reads `board_config.mirror_map` (a copy now, so right).
- **The offline snapshot** (`app/hold_map.json` etc.) is hand holds only and must be re-taken after a real publish (`python tools/snapshot_board.py`, then ship). Footholds reach the app from the `holds` table (session 3 draws them).

## Session 2b: camera LED mapping (not built)
- The phone on a tripod facing the board; a new cast-contract event has the Pi light one LED at a time (open question 1); the camera finds the lit spot on the photo, which maps to the cartoon through the two corner quads (`board_config.corners`), and the nearest hand hold takes that LED. Where it can't tell, tap the lit hold. Every hand hold ends with exactly one LED; the feet-sign LEDs stay.
- Publishing new LEDs goes through the same transaction and undo (`board_versions` already keeps `led`). `holds_led_unique` isn't deferrable: a swap of LEDs needs the publish to move them in one statement or through a free value.
- pb-ledmap's grid tools and the idle patterns' grid would then move onto the table's LEDs.
## Open questions
1. **How the setup flow talks to the Pi** for mapping (a new Realtime event to light one LED?): a cast contract change.
2. ~~**Mirroring Specific feet**~~ **Answered (Ross, 9 Nov 2026):** footholds have mirror partners, foot ↔ foot, where the reflection finds one; an unpaired foothold has none (stays put in the mirrored view). Hand ↔ foot pairs are never allowed (the setup flow refuses them, and so does the database).
3. **Other gyms:** today there's one board (`board:HangoutPortland`, one `board_config` row, one wall key, one geofence). Multi-gym comes later; keep the setup flow free of Hangout and grid assumptions. Specific feet are checked against the one board today (problems have no board column).

## The setup flow (admin, on a phone)
1. **Upload** the photo and the cartoon (same framing). *(2a: built)*
2. **Corners:** the four board corners on the cartoon and the photo. **Line up** (the first time only): four hand holds tapped on today's board image, then on the cartoon. *(2a: built; the line-up 10 Nov 2026)*
3. **Trace:** auto-trace the holds on the cartoon (below), match them to today's holds; review: add, move, redraw, delete; mark footholds; fix a wrong match. *(2a: built)*
4. **Map LEDs:** phone on a tripod (session 2b, above). *(not built)*
5. **Mirror pairs:** generated by reflecting the layout about the vertical centre line (fitted to the holds) and matching nearest holds of the same kind; review. *(2a: built)*
6. **Publish.** On the current board this updates the holds in place: the hand holds keep their ids, the footholds are added. Undo puts the previous board back. A real rearrange later publishes a new set and archives the old one. *(2a: built, without sets)*
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

**What 2a ships (9 Nov 2026, `app/trace.js`, scored by `node tools/trace_score.js`):** the same idea in plain JavaScript (it runs on the phone): the background palette from the flat pixels (pink, white, near-black); background = large connected regions near a palette colour, a darker shade of a coloured one (shadows on pink), a light neutral shade of white (shadows on white), or an anti-aliased edge between two background colours (only where both are beside it, and never a grey between white and black, which is what dark holds are); the dark outlines (a black-hat) are never background, so a light hold can't leak through its outline; holes filled; touching holds split by a watershed on the distance map; each shape trimmed to its own closed outline (with the image's edge counting as outline); the boundary traced, smoothed, moved in 1.25 px, simplified. Traced at 2200 px across (finer outlines; about 6 s on a laptop).
- **Score on `board-fallback.jpg`:** median IoU **0.923** (Node, the reference resize); 181 holds ≥ 0.8, 7 at 0.6–0.8, **0 below 0.6, 0 missed, 0 merged**; 27 extra shapes (the footholds, and one stray edge). In Chrome (canvas resize) 0.914, 179 / 9 / 0 / 0. The bar was 0.91 (166 / 11 / 4 / 7 missed).
- **Matching** (corners, then an affine fit): all 188 hand holds found their own shape on the dry run, every centroid within 2% of today's position.
- **Mirror pairs** (the fitted reflection): 6 hand holds differ from today's pairs on this cartoon (A1, S1, A3, S4, B4, R4: the edges, where the cartoon is least symmetric); they keep today's unless changed. 10 of the 25 footholds pair up (20 holds).

## Cartoon prompt: what it must ask for
- a thick, even, dark outline around every hold, footholds included; dark holds drawn with a slightly lighter edge so the outline stands out;
- no drop shadows;
- flat, solid background colours, no texture or gradients;
- holds never touching or overlapping;
- the same framing and proportions as the photo, nothing cropped, no holds added or removed.

The full prompt gets written once the new photo exists.

## Next steps (Ross)
1. The full-board photo of the current board, footholds included: straight on, even light.
2. The cartoon from it, with the prompt (written in the chat when the photo exists).
3. **Run the flow** (Admin → Board Setup, on a phone): Start → pick the photo and the cartoon → Upload → drag the four corners on the Cartoon and the Photo onto the real board corners, footholds included → Next → **Line up** (this first time only): on Today's board tap four hand holds spread out, as near its four corners as you can (each snaps to the nearest hold and shows its name; tap a number, then another hold, to change one); it then switches to the Cartoon: tap the middle of each hold it names, in the same order (drag a number to fine-tune) → Next → Trace the holds → Next → Review: tap **Next to fix ›** until every hand hold has one shape and nothing is extra (Delete strays; Foothold, or **All extras → footholds** once only footholds are left; for a hand hold with no shape, tap its red tag and Draw it or tap an extra shape) → Next → Mirror pairs: check any listed holds (today's pair is kept unless you choose the reflection) → Next → Publish the board. If anything looks wrong afterwards: Board Setup → Undo the last publish.
4. Then tell Claude Code to snapshot the board (`tools/snapshot_board.py` + ship) so the offline copy matches.
