# Project Board: codebase overview

> **Don't read this file whole** (131 KB, about 33,000 tokens). Run `grep -n '^##' docs/codebase-overview.md` for the map and Read only the sections your task touches (CLAUDE.md working rule 1, `docs/token-audit.md`).

**Written 10 September 2026**, from a full read of the code plus read-only checks against the live Supabase database. It's the architecture reference for any new session: what the pieces are, how they fit, and what you'd otherwise have to rediscover.

**Which document wins:**
- **Hosting, rollout and install flow:** `docs/rollout-plan.md`.
- **Working rules** (dev → staging → merge on approval, one feature per session, no schema changes without asking): `CLAUDE.md`.
- **Architecture, data model, auth, caching, deploy mechanics and known issues:** this file. Where it disagrees with CLAUDE.md about the database, this file was checked against the live DB and CLAUDE.md wasn't. The discrepancies are listed at the end.
- **Security findings:** `docs/security-findings.md`. It's **local only and never committed**, because the repo is public. If you don't have it, you're not on Ross's laptop; ask before touching RLS, grants, casting or sign-up.
- **Also local only, on Ross's laptop:** `docs/changelog.md` (the feature-by-feature history that used to fill CLAUDE.md), `docs/project-notes.md` (hardware and the original DTB system) and `db/README.md` (the index of every DB script). The Circuits Phase 2 spec is committed as `docs/circuits-phase2.md`.

> **Nickname accounts went live on 18 Oct 2026** (`pb-v108`, db/30 applied, the Edge Function deployed). Sections 2, 5, 6, 8, 12 and 15 describe them. The 7 existing accounts were moved across (placeholder email, new passphrase, Google data removed) by the local `db/30_go_live.py`; a pre-switch backup is in `Documents\_Archive\ProjectBoard\ProjectBoard-archive\pre-db30-backup-2026-10-18\`. `db/30_rollback.sql` restores the schema. CAPTCHA (Turnstile) is on and the Google provider is off (18 Oct 2026). The investigation behind it, `auth_audit.md`, is archived outside the repo (29 Oct 2026).

---

## 1. What it is

A PWA for the symmetry board at The Hangout, Portland (near Weymouth, UK). The board is a wooden wall with 188 real holds on a 19 × 13 grid (A–S × 1–13), each with an LED behind it. Climbers use the app to:
- browse **problems** (boulders) and **circuits** (long sport-style routes);
- **cast** a problem, which lights its holds on the wall via a Raspberry Pi;
- **tick** sends, save **favourites**, and climb the points **leaderboard**.

- **Live:** https://symmetryboard.co.uk, from the `main` branch.
- **Staging:** https://dev-projectboard.rosslewismckechnie.workers.dev, from the `dev` branch.
- **Old address:** https://rlmck.github.io/projectboard, a permanent "we've moved" page served from the `legacy` branch (section 10).
- **Scale (10 Sep 2026):** 261 problems, 10 circuits, 5 accounts (3 admins), 34 ticks. Real users, all at one gym.

## 2. The big picture

```
 phone (PWA) ──static files──▶ Cloudflare Workers (static assets, built from main/dev)
     │
     ├──REST / Auth / Storage──▶ Supabase (project uqirowyfqwiceyjznosl, London)
     │                             Postgres + RLS · Auth (nickname + PIN) · Storage · one Edge Function
     │
     └──Realtime broadcast────▶ channel board:HangoutPortland, event cast_problem
                                     │
                                     ▼
                         Raspberry Pi 4 (being rebuilt, Oct 2026; spec in local docs/pi4-led-audit.md)
                           reads the problem's holds from the problems table
                           → WS2801 LED strip over SPI; also runs the PWA in a kiosk on the wall touchscreen

 rlmck.github.io/projectboard ── GitHub Pages ◀── legacy branch (moved page + tombstone SW)
```

There is **almost no server code**:
- The front end is static files.
- Every privileged action is gated in Postgres, by RLS and by `SECURITY DEFINER` functions that check `is_admin()`.
- **One exception:** the Supabase Edge Function `admin-reset-passphrase` (`supabase/functions/`, deployed by hand with the Supabase CLI, never by `build.sh`). Setting another account's password needs the service-role key, which must never reach the browser, so it lives only there (section 6).
- The Pi is a plain Realtime subscriber that uses the public anon key.

## 3. Repository map

Since 11 Sep 2026 the tracked files are grouped by what they are:

```
app/       the website: exactly the files that are deployed, flat (every URL stays at the site root)
tools/     generators and dev tools, never deployed
print/     the A5 poster and QR, never deployed
docs/      the committed docs (overview, rollout plan, cast contract, console plan, circuits Phase 2, Pi plan, log/); the rest is local only
build.sh  wrangler.jsonc  CLAUDE.md  .gitignore  .gitattributes   (the repo root)
```

`app/` is flat on purpose. `sw.js` must be served from `/` to control the whole app, the manifest, icons and `/privacy` are referenced by absolute URL from outside (the `og:image`, Google's sign-in branding), and `build.sh` copies `app/` into `public/` one-to-one. Don't add subfolders inside `app/`: that changes live URLs. The move from the root into `app/` changed no deployed byte (checked by hashing the build before and after).

| Path | What | Deployed? |
|---|---|---|
| `app/index.html` | All markup: splash, welcome overlay, 11 view `<section>`s, 8 modals, nav, install banner, toast | yes |
| `app/tokens.css` | The shared design tokens: every colour, font stack, radius, shadow and size, as custom properties on `:root`, shared by the phone app and the planned wall-screen mode. Loaded before `styles.css` by `index.html` and `privacy.html` | yes (and precached) |
| `app/styles.css` | All styling (dark theme), written only in `var(--token)`s from `tokens.css` | yes |
| `app/state.js` … `app/app.js` | The fourteen app scripts (section 4) | yes |
| `app/sw.js`, `app/manifest.json` | Service worker, PWA manifest | yes |
| `app/privacy.html` | Static privacy page; keep its claims true | yes |
| `app/supabase-js-2.116.0.js` | **Vendored, pinned** `supabase-js` (npm `dist/umd/supabase.js`, verified against the registry hash). Loaded before `state.js`; defines the global `supabase` | yes (and precached) |
| `app/board-fallback.jpg` | Bundled **fallback** board image: a snapshot of the live board, written by `tools/snapshot_board.py` (the photo, ~300 KB JPEG). Precached; only shown when `board_config` can't be fetched (offline, Supabase down), since `pb-v103` | yes |
| `app/ProjectBoard.png` | The old **drawing** of the board (2.1 MB), the fallback until 19 Sep 2026. Not referenced or precached; still in the `build.sh` allowlist only so an app left open from before `pb-v101` doesn't lose its image, and can be dropped from it later. `register_holds.py` records how its map was made | yes |
| `app/hold_map.json` | Fallback hold → `{x,y}` % map, a snapshot of the live board, written by `tools/snapshot_board.py` (188 holds), plus `__meta.board_updated_at`, which `loadHoldMap` strips into `bundledMapVersion` | yes |
| `app/mirror_map.json` | Fallback hold → mirror-partner map, a snapshot of the live board, written by `tools/snapshot_board.py` | yes |
| `app/hold_shapes.json` | Traced hold outlines (188), tied to one board version. **Fallback** since db/28: the live copy is `board_config.hold_shapes` | yes |
| `app/icon*.png`, `app/apple-touch-icon.png`, `app/icon.svg` | Icons (PNGs generated by `tools/make_icons.py`) | yes |
| `app/screenshot-*.png` | Manifest install-sheet screenshots, hand-captured | yes (build only, not precached) |
| `app/_headers`, `app/_redirects` | Cloudflare static-asset config (section 9); they must sit in the assets directory | yes |
| `build.sh`, `wrangler.jsonc`, `.gitattributes` | Hosting config (section 9). The first two stay at the root: the Cloudflare dashboard runs `bash build.sh` and `npx wrangler deploy` from there | no |
| `tools/snapshot_board.py`, `register_shapes.py`, `register_leds.py` | Board data tools (section 11). `register_holds.py` and `register_mirror.py` are retired history (they write into `tools/` now) | no |
| `tools/hold_positions.json` | Input to `register_holds.py` (Ross's 187 hand-placed dots) | no |
| `tools/led_map.json` | Hold → physical LED index; the Pi wiring contract. The app never reads it | no |
| `tools/make_icons.py`, `tools/make_qr.py` | Icon generator, QR generator | no |
| `tools/cast-test.html` (+ `.js`, `.css`), `tools/serve.py` | The cast test bench and its no-cache local server (section 11) | no |
| `print/` | The A5 poster and its QR | no |
| `CLAUDE.md`, `docs/rollout-plan.md`, `docs/codebase-overview.md` | Docs | no |

Local only (gitignored), on Ross's laptop:
- `db/`: numbered SQL scripts 01–29, applied by hand in the Supabase SQL editor, indexed in `db/README.md`, plus `db/.env` holding the direct-Postgres URL and the service key. **Never print or commit that file.**
- `pi/_old/`: the June 2026 listener for the old Pi 3 (with `problems.csv`, Gareth's problem list, the input to db/03) and the 26 Oct 2026 stopgap listener. **Superseded** by the committed `pi/` (the Pi 4 listener and ops, `pi/README.md`). Also `pi/config.env`, the laptop's copy of the Pi's settings.
- `docs/*`: `changelog.md`, `project-notes.md`, `pi4-led-audit.md` (the Pi 4 / LED spec), `CC_Reference_Gareth_Code.md`, `hardware/` photos, and `security-findings.md`.
- `reference/original-pi-codebase/dtb/`: Gareth's original DTB code, extracted from his SD card. `tools/register_holds.py` and `tools/register_mirror.py` read `dtb/SettingsFolder/holdlist.csv`, `dtb/SettingsFolder/MirrorDic.txt` and `dtb/dicholdlist.txt` from it by path, so it stays where it is.
- `.claude/settings.local.json`: Claude Code's per-machine settings.
- **Archived outside the repo** in `Documents\_Archive\ProjectBoard\ProjectBoard-archive\` (see its `README.txt`); nothing depends on any of it:
  - since 11 Sep 2026: the 31 GB image of Gareth's SD card, the reverse-engineering of the DTB app, and unused source art;
  - since the 11 Sep 2026 folder tidy: the rest of the SD card's boot partition (kernels, firmware, overlays, `.dtb` files; 37 MB) that used to sit in `reference/original-pi-codebase/`, and the old LED test scripts that were in `pi/archive/`.
- `.gitignore` also ignores `*.png`, so **every committed PNG needs a `!` exception** (they're written as `!app/…`).

## 4. Front end

### 4.1 Fourteen classic scripts, one global scope
Load order, set in `index.html`: **`state` → `core` → `problems` → `admin` → `account` → `authoring` → `circuits` → `challenge` → `leaderboard` → `wall` → `trace` → `setup` → `holdedit` → `app`**, after the vendored `supabase-js-2.116.0.js`.

**Upgrading `supabase-js`:**
1. Download the new version's `package/dist/umd/supabase.js` from the npm tarball, and check the tarball against the registry's `dist.integrity`.
2. Save it as `app/supabase-js-<version>.js` with the licence header.
3. Update the three places (`bash build.sh --check` checks them) and test on staging. `CACHE` changes by itself (the build stamps it).

Never go back to a floating CDN URL: the CSP also blocks it.

These are plain `<script>` tags, not ES modules. There's no build step and no framework, and every top-level `let`/`const`/`function` is visible to every file. Consequences:
- **A name may be declared only once across all fourteen files.** Check with `cd app && cat state.js core.js … app.js > ../all.js && node --check ../all.js` (then delete `all.js`).
- **Order matters for top-level code.** Function bodies can reference later files; top-level statements can't.
- **Symbols don't always live where you'd expect.** Grep across all `.js` before adding one. Traps:
  - `isAdmin`, `circuitName`, `circuitSeq`, `canEditCircuit`, `canChangeCircuit`, `mayOpenCircuitEdit` and `circuitsTableMissing` are at the bottom of `authoring.js`; `othersUsed`/`askOthersUsed`/`canEditProblem` (who may Edit, §4.8b) are in `problems.js`.
  - `rpcMissing` (in `admin.js`) is also used by `leaderboard.js`.
  - `gradeTabButtons` (in `problems.js`) is used by circuits and authoring.
  - `rankLabel` (in `leaderboard.js`) is also used by `challenge.js`; `challengeForCircuit` (in `challenge.js`) by `canEditCircuit` in `authoring.js`; `leaveChallenge` by `setView` in `core.js`.
- **A new file goes in `app/` and in three places:** the `index.html` script order, the `build.sh` allowlist and the `sw.js` `ASSETS`.
- **Don't convert to ES modules** without being asked. That's a working rule.

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel; grade ladders (`GRADE_ORDER`, `SPORT_GRADE_ORDER`, `gradeRank`, `fontGrade`); **all shared mutable state** (`allProblems`, `session`, `profile`, `HOLD_MAP`, `myTicks*`, filters, create/circuit state, leaderboard cache) |
| `core.js` | Escaping, toast, name/setter/search helpers, hold order + role classification, dot and shape overlays, `boardPct` hit-testing, fullscreen controller, **routing** (`parseHash`, `setView`, `router`, `goBack`) |
| `problems.js` | Problem list/filters/cards, detail, swipe, info modal, **geofence + `castByName`**, board data loaders (`loadHolds`, `loadBoardConfig`, `loadHoldMap`, `loadMirrorMap`, `loadHoldShapes`), problem loading, tick button, delete, **who may Edit** (`canEditProblem`, `othersUsed`, §4.8b) |
| `admin.js` | `#admin` hub: user list (nickname search) and detail (recent ticks), rename, new PIN or passphrase (the Edge Function), promote/demote, delete user |
| `account.js` | Ticks, favourites, filter-pill sync, **auth** (create an account with a nickname + 4-digit PIN, sign in with a PIN or an older passphrase, `pinPassword()`, Turnstile, the nickname checker, the iPhone Safari note, sign-out), change-nickname modal, profile page (Ranks switch, delete my account) |
| `authoring.js` | Create/edit problem (tap-to-cycle roles, the finish-zone rule (not drawn), invert-on-save, the shared checks `createProblemMissing`/`createStatus`/`createLayerHtml`), **the live LEDs while setting** (`previewEdited`…`previewEnd`, contract §9), the hold-outline editor (`#outlines`: pinch/pan, drag/add/delete points, nudge, roundness, preview, draft, **Publish**), circuit helpers |
| `circuits.js` | Circuits list, detail (swipe, info sheet, the ⋮ menu: `updateCircuitMenu`), the circuit cast (the Cast sheet, the run screen, `circuit_logs`), create **and Edit** (§4.8b), delete |
| `challenge.js` | Challenges (db/31, section 4.6a): loading, the circuit-detail link, the `#challenge` view (rules, the timed attempt, summary, save with retry, your best and history), and the challenge boards on Ranks (tabs, compare chart, admin delete) |
| `leaderboard.js` | `#leaderboard` view: Points (opted-in climbers, plus a hidden climber's private note), or a challenge board picked with the tabs; `userPoints()` for the profile |
| `wall.js` | The wall-screen mode (`/?wall`, section 4.7a): the kiosk layout, casting on the pick (problems, and a circuit's holds), **Create** (the on-screen keyboard, `wall_create_problem`), read-only Ranks, the QR, idle slides and offline note (no night screen since 7 Nov 2026). Does nothing unless `WALL` |
| `trace.js` | **Auto-tracing** (board setup, 9 Nov 2026): `traceHolds()` and its helpers (`trace*`), plus the prior fit (`tracePriorFit`) and Tap to trace (`traceTap`, 10 Nov), pure functions of the pixels with no DOM, so `tools/trace_score.js` and `tools/trace_prior_score.js` run the same code in Node (§4.8d) |
| `setup.js` | **Board setup** (`#setup`, admins, §4.8d): photo + cartoon upload, corners, trace, match, review, mirror pairs, publish and undo (`BS`, `bs*`); `bsWire()` is called from `app.js` |
| `holdedit.js` | **The hold editor** (Board Setup → Edit holds, 10 Nov 2026, §4.8d): add, delete and pair footholds, turn a hold with its mirror partner (the board image's pixels too), trim a hand outline round a foothold, one publish (`HE`, `he*`). The image work (`heRegion`, `heStripeFill`, `heComposite`, `heRotateImage`) is pure, so `tools/holdedit_score.js` runs it in Node. Uses `setup.js`'s stage and gestures (the step `'edit'`) |
| `app.js` | **Loaded last.** All event wiring, service-worker registration and update handling, the install flow (welcome overlay + banner), and **boot** |

### 4.2 Boot sequence (the Boot block in `app.js`, before the install code)
1. Stamp the opening history entry, `hashchange` → `stampNewEntry` + `router`, then `router()` once for the initial view (wrapped, so a routing error can't stop the rest).
2. Start these in parallel:
   - `loadProfileNames()` first: the id → username map behind live setter names (its saved copy applies synchronously, so the saved lists render with names).
   - `loadProblems()`: runs `router()` when data lands, so a cold `#detail/<id>` deep link renders.
   - `loadCircuits()`, then `loadChallenges()` (saved copy `pb-saved-challenges`; before db/31 is applied the table is missing and that's just "no challenges").
   - **Saved lists** (since `pb-v104`): every successful load of problems, circuits and setter names is saved on the device (`saveList`/`savedList` in `core.js`). At start-up the saved copy renders at once while the fresh one loads (weak Wi-Fi), and the fresh one replaces it in place: `loadProblems` then re-renders the detail rather than re-running `router()`, whose side effects the user would see. If the fetch fails, the saved copy stays and a note above the list says when it was saved (`#list-offline`, `#circuit-offline`); pull-to-refresh or the browser's `online` event fetches again. With nothing saved, offline still shows "Failed to load problems". Ticks and favourites aren't saved, so offline the ✓ flags and the Favourites pill are empty. `privacy.html` mentions the saved copy.
   - `loadHolds()` (db/41: names, kinds and mirror partners from the `holds` table into `HOLD_INFO` and `MIRROR_MAP`; the saved copy first, for offline).
   - `loadBoardConfig()`, **then** `loadHoldMap()` + `loadMirrorMap()`. They run in sequence so the bundled fallbacks never overwrite the live map. `board_config.mirror_map` is used only if the holds table didn't supply the pairs (`holdsHaveMirror`).
   - `loadHoldShapes()` and `measureBoardAspect()`.
   - `initAuth()`.
3. The splash plays its CSS entrance, then fades after 1.8 s (0.9 s under `prefers-reduced-motion`).

Nothing blocks on the network before first paint, so the list shows its spinner straight away.


### 4.2a Sorting and filtering the lists (the Filter sheet, 4 Nov 2026)
The sort and filter code is in `problems.js`, the circuits' part in `circuits.js`, the state in `state.js` (problems: `listSort`, `listRandom`, `gradeLo`, `gradeHi`, `favesOnly`, `benchOnly`, `excludeDone`; circuits: `circuitSort`, `circuitRandom`, `circuitGradeLo`, `circuitGradeHi`, `circuitFavesOnly`, `circuitLoopOnly`; `filterKind` = the open sheet). **A list's row** is a funnel icon (`[data-pick="filter"][data-kind]`) then the one-tap filters: phone problems Favourites · Benchmarks · Exclude Done (fits one line at 390 px: `--filter-pill-pad-x`), phone circuits Favourites · Looping, wall problems Benchmarks, wall circuits Looping; on the wall the row also holds the **search** (below). No grade tabs or Sort pill any more (the grade tabs went with `activeGrades`/`activeCircuitGrades`). **Clear** (back 4 Nov 2026, phone and wall, both lists): a `✕ Clear` pill outside the scroller, pinned at the right of the row (`.filter-clear`, `data-act="clear-filters"`), shown whenever anything isn't the default: the sort, the grade range, a quick filter, picked holds, **or search text** (`FILTER_KINDS[kind].nOn()` or `.searching()`, in `updateFilterControls`). One tap is `clearFilters(kind)`, the same as the empty list's Clear filters. A pill tapped near the row's end is kept in view (`keepPillInView`), since Clear appearing narrows the row. **Search** (phone and wall): name, setter or grade, case-insensitive, via `searchNorm` (`core.js`: lowercased, accents folded, only letters and digits kept, so `6a+` matches as `6a`), held in `searchQuery` / `circuitSearch` (trimmed, lowercased) and applied in `filteredProblems()` / `filteredCircuits()`, so the counts, the hold picker and the wall's grade rail all follow it. Phone: the `#search` / `#circuit-search` inputs (`app.js`). Wall (4 Nov 2026): a field in the row that opens the on-screen keyboard (§4.7a). The search doesn't count on the filter icon's badge, and the sheet's Reset leaves it alone; Clear and Clear filters empty it. With anything not at its default the icon goes pink (`.on`) and carries a count badge: one each for the sort ≠ New, a narrowed grade range, and each quick filter (`problemFilterCount()` / `circuitFilterCount()`). **The Filter sheet** (phone: `#filter-modal` > `#filter-sheet`, a bottom sheet; wall: a panel over the list's column, `#wall-fpanel` / `#wall-cfpanel`, with `.filtering` on the page hiding the row, rail and list; the board stays) is built afresh by `openFilter(kind)` from a *kind* (`FILTER_KINDS.problems`, and `FILTER_KINDS.circuits` added in `circuits.js`) and holds, in order: **Sort**, one row of options (problems New / Random / Easy / Hard / Popular, circuits the same without Popular; default New for both); **Grade**, the two-handle slider and the grade labels under it (no range text; `aria-valuetext` on the handles; problems on the Font ladder, circuits on the sport ladder via `sportRank`); **Quick filters**, the same toggles as the row (`[data-toggle]`, `FILTER_TOGGLES`; one line on a phone; the wall drops Favourites and Exclude Done); **Holds** (below); then **Reset** (everything back to default, sort included; disabled at default) and **Show N problems / circuits** (live; "No problems match", disabled, at 0). Every change applies at once and the list re-renders behind it, except the slider: the count follows it and the list re-renders on release (lighter on the Pi). `updateFilterControls()` (from every `renderList` / `renderCircuits`) keeps the icons, every toggle (`syncFilterToggles`, `account.js`) and the open sheet in step. The sheet closes on ✕, Show, a tap outside, Escape, a view change (`setView`) or a wall page change. **Orders:** **New** (`created_at` newest first), **Random** (a random key per row, drawn each time Random is chosen, so choosing it again reshuffles; a row added meanwhile gets a key of its own), **Easy** / **Hard** (grade, then name; unknown grades like `Project` last in both), **Popular** (problems only: distinct climbers who've ticked it, from `problem_tick_counts()` (db/38, aggregate only, callable by anon), fetched when Popular is chosen and on each problem load while it's the sort, at most once a minute; until the counts arrive it's A–Z). The swipe decks follow the list order. **Grade:** a handle at either end means no limit on that side, and a narrowed range hides unknown grades. **Empty list** (phone and wall): "No problems match these filters." (or circuits) with **Clear filters** (`clearFilters(kind)`: every filter, the sort, the picked holds and the search, phone and wall; on the wall it also closes the search keyboard); the favourites-only hint keeps its own words, with the same button. The row scrolls sideways on a phone too narrow for it, its ends faded (`markFilterRowEdges`).
- **Holds (the hold filter, 4 Nov 2026; problems.js "HOLDS", the circuits' part in `circuits.js`):** shows only the items that use **all** the picked holds, in any role (a problem's starts, hand holds or finish; any hold of a circuit's `hold_sequence`), **as set, never mirrored**. Client-side: the lists already load every problem's `start_holds` / `intermediate_holds` / `finish_hold` and every circuit's `hold_sequence` (`select('*')`); each item's hold set is cached in a `WeakMap` (`cachedHoldSet`, `problemHolds`, `circuitHolds`). State: `holdPicks`, `circuitHoldPicks` (tap order), `holdPickerOpen`, `holdsDirty` (`state.js`); each kind has `getHolds` / `setHolds` / `matches` / `holdsOf`. `filteredProblems()` / `filteredCircuits()` apply every filter unsorted (the counts and the picker use them); `visibleProblems()` / `visibleCircuits()` sort them for the lists. The picks count as **one** on the filter icon's badge, and go with Reset, Clear filters and the wall's idle (`resetListFilters` / `resetCircuitFilters`). **Holds in play** (`holdsInPlay(kind)`): the holds of every item that passes every filter and uses every pick, plus the picks; the picker leaves them bright and dims the rest. **The look** (`holdPickLayerHtml`, `core.js`): the board dimmed a little more than a problem view (`--hold-pick-dim`, 0.72, via the `.hp-dim` rect's CSS opacity), the holds in play cut out of the dim, each pick a white outline (`--hold-pick-line`) over a dark halo (`--hold-pick-halo-line`) with a pink wash (`--hold-pick-fill`), so it reads on the pink, white and black parts of the board; outline paths cached per hold. **Phone:** the sheet's Holds row (`renderFilterHolds`, `[data-hp="open"]`) is a thumbnail of the board with the picks lit, "Any holds" or "N holds" with their grid names (`gridName`), and a chevron; it opens the **hold picker** (`#hp-screen`, a screen over the sheet: back to the sheet, "Clear holds", the live line ("6 problems use both holds" / "all 3 holds" / "that hold", or how to start), the whole board fitted to the width (`#hp-board`), the picks as chips (`[data-unpick]`, tap to drop) and "Show N problems" (disabled "No problems use all of these" at 0), which closes the sheet too). **Zoom:** a pinch on the picker's board, or its expand button, opens the fullscreen viewer (§4.8) as the `'holds'` view: a tap picks or drops a hold, a double tap on empty board or a pinch out closes it, and the bar shows "Pick holds" and the live count. **Wall:** the panel's Holds section is the hint "Tap holds on the board…" or the chips plus Clear holds; the board beside the panel is the picker (§4.7a). **Performance:** a tap recomputes the counts and the bright holds only (`holdPicksSet` → `updateFilterControls` → `holdPickRefresh`); the list re-renders when the picker or the panel closes (`holdsDirty`), which keeps taps light on the wall's Pi.
### 4.3 Routing
Hash routing; `router()` switches on `parseHash()` (`route/param`).

| Hash | View | Notes |
|---|---|---|
| `#list` (default) | problem list | search, and a row: the **filter icon** (opens the Filter sheet: Sort New / Random / Easy / Hard / Popular, the Grade range, quick filters; pink with a count when anything isn't the default), Favourites, Benchmarks, Exclude Done (§4.2a) |
| `#detail/<id>` | problem detail | board overlay, tick/fave/mirror/cast, ⋮ menu (Edit: admin, or the owner while it isn't a benchmark and nobody else has ticked it; Move to Circuits: admin, not a benchmark; Delete: admin or the owner; Information: everyone); swipe = next/prev in the filtered deck, via `replaceState` |
| `#create` / `#create/<id>` | create / **Edit** (§4.8b) | guests bounced to `#auth`; anyone who may not edit it bounced off `/<id>` to its detail (`mayOpenProblemEdit`) |
| `#move/<problem id>` | **Move to Circuits** (§4.8c): the circuit create view, pre-filled from the problem | admins only, never a benchmark (anyone else → the problem); waits for `authReady` |
| `#outlines` | hold-outline editor (bottom nav hidden) | admin; the old `#calibrate` redirects here |
| `#admin`, `#admin/users`, `#admin/user/<id>` | admin hub drill-down | admin |
| `#circuits`, `#circuit/<id>`, `#circuit-create`, `#circuit-create/<id>` (Edit, §4.8b) | circuits | built to match the problem side: search, the filter icon (the same sheet: Sort New / Random / Easy / Hard, the sport-grade range, Favourites, Looping), Favourites, Looping (§4.2a), pull-to-refresh, a pinned detail with swipe (`circuitTrail`), ⋮ menu (Edit: admin, or the owner while no challenge uses it and nobody else has logged a run; Delete: owner or admin; Information: everyone); create needs sign-in |
| `#challenge/<id>` | a challenge (section 4.6a) | rules for everyone; Start needs sign-in; the bottom nav hides while an attempt runs here; in any other view a strip on the nav leads back |
| `#leaderboard` | ranks | public; tabs: Points + one per active challenge (`ranksTab`) |
| `#auth`, `#profile` | sign-in, profile | bottom nav hidden on `#auth` |

**Route guards only bounce once `authReady` is true**, which `initAuth` sets after the session **and the profile** have loaded (since `pb-v92`; before, an admin route judged `is_admin` from a profile that hadn't arrived). Before that, `#create` lets a cold deep link through; the admin routes (`#outlines`, `#admin`) show nothing until auth is known, so a non-admin never sees them, and `initAuth` re-runs `router()` then. Signing out while on an admin screen routes away from it.

**History and the in-app Back.** Every entry the app creates is stamped `{ pb: 1 }` in `history.state` (`stampNewEntry` on `hashchange`); the entry the app was opened on is stamped `{ pb: 0 }` at boot (`stampOpeningEntry`). `goBack()` only calls `history.back()` from a `pb: 1` entry. From the opening entry it replaces the route with the view's parent (`backParentHash()`: the list, `#circuits`, `#admin` or `#profile`), so Back from a shared link never leaves the site. Because of the stamps, **never `replaceState(null, …)` or `location.replace(hash)` in app code**: use `replaceRoute(hash)` (routes now) or `redirectRoute(hash)` (routes on the next tick, for redirects issued from inside `router()`), or pass `history.state` through. `parseHash()` keeps a malformed `%`-escape raw rather than throwing, and the boot block's first `router()` is wrapped so a routing error can't stop the loaders. All `localStorage` access outside the outline editor goes through `lsGet`/`lsSet` (`core.js`), which swallow the `SecurityError` thrown where site data is blocked, and the boot block runs before the install/welcome code in `app.js`.

⚠️ **`router()` doubles as the "data arrived, re-render" hook.** Loaders call it, and so does `refreshBoardViews()`. It has side effects: `setView` exits fullscreen and closes the info modal, and the `auth` case resets the form to sign-in. Prefer calling the specific render function over `router()` when adding a loader.

### 4.4 The board overlay pipeline
Four inputs, each with a live source and a fallback:

| Input | Live source | Fallback | Global |
|---|---|---|---|
| Board image | `board_config.image_path` → Storage URL `…/board/<path>?v=<updated_at>` | `board-fallback.jpg` (a snapshot of the live photo) | `BOARD_IMG` |
| Hold positions | `board_config.hold_map` (188 hand holds; since db/42 a copy made from `holds`) | `hold_map.json` | `HOLD_MAP` (+ `configHasMap`) |
| Mirror pairs | `holds.mirror` (db/41), else `board_config.mirror_map` | `mirror_map.json` | `MIRROR_MAP` (+ `configHasMirror`, `holdsHaveMirror`) |
| Hold names, kinds | `holds` (db/41) | the grid name from the id (`gridName`) | `HOLD_INFO`; `holdName(h)` (`core.js`) |
| Hold outlines | `board_config.hold_shapes` (db/28; since db/42 a copy made from `holds.outline`, plus `__meta`) | `hold_shapes.json` | `HOLD_SHAPES` (+ `configHasShapes`) |

Positions are **percentages of the image**, so the overlay scales with it. The render helpers are in `core.js`:
- **Dot overlay:** `boardOverlayHtml`.
- **Shape overlay:** `holdShapeLayerHtml`. It draws each hold as its traced polygon; on the two detail views (problem and circuit) it dims the rest of the board with an SVG mask. The problem create view passes `lightAll` (since `pb-v107`): the same dim, but with **every** hold cut out of the mask, so the wall is dimmed and all holds stay bright; circuit create doesn't dim. Circuits build their roles with `circuitHoldRoles()` and add move-number tags (`seqTagsHtml`) hanging off each outline; `fresh` flashes the hold the Play preview has just lit. When shapes aren't usable, both fall back to dots (circuit dots carry the numbers inside).
- **Shapes are traced against one specific board.** Both copies record it in `__meta.board_updated_at` (currently `2026-06-22T14:43:27.113+00:00`). `shapesUsable()` draws them **only** when that matches the board the map in use came from: `boardConfigVersion` for the live map, or (offline) `bundledMapVersion`, the version the bundled snapshot was taken from. So since `pb-v103` the outlines work offline too. Any recalibration (which bumps `updated_at`) drops everyone back to dots until the outlines are re-traced against the new board and published. **Publishing must write `hold_shapes` alone and never touch `updated_at`** — bumping the version would retire the very outlines being published. Since db/42 the outline editor publishes through `admin_set_hold_outlines()` (into `holds.outline`; the copy follows, `updated_at` untouched), and a board setup publish moves `updated_at` on and pins `__meta.board_updated_at` to it in the same transaction.
- **Footholds** (db/42) are in `holds` only, never in `board_config`'s copies, so `HOLD_MAP` is hand holds; `isHandHold()` (`core.js`) still guards Create's hit-testing (`nearestHold`, `ccNearestHold`), the finish zone (`topZoneThreshold`) and `lightAll`, in case they ever reach it. Since 10 Nov 2026 (Specific feet) `loadHolds()` also reads each hold's `x`/`y` and, in a second small read, the footholds' outlines, into **`FOOT_HOLDS`** (`state.js`: foothold id → `{x, y, pts}`), saved with the holds list for offline use. `feetUsable()` draws them over the live map, or offline when the bundled outlines fit. `holdShapeLayerHtml(roles, { feet })` outlines a problem's footholds in yellow (`.hs.foot`, `--specific`) and cuts them out of the dim; mirrored, each is drawn as its foot partner (`mirrorFoot()`, from `HOLD_INFO`; an unpaired one stays put); with no usable outlines they're small yellow dots (`footDotsHtml`). `lightAll` (Create) keeps every foothold bright too. The bundled snapshot has no footholds: a phone that has never loaded the holds table online shows none.
- **Mirroring** is a lookup table, not grid arithmetic: the board is hand-set and staggered. The live table has 10 self-mirror holds. Since db/32 (28 Oct 2026) it differs from Gareth's in 5 entries among real holds (E3, E4, E5, O5, O6). Before that, three hold labels at the top were shifted: `hold218` (I12, not a hold; its LED is behind the board) was drawn where K9 is, K9 where N13 is, and N13 on top of O13, which made the table pair I12 with I11 and leave O13 alone. db/32 moved the labels and outlines, removed `hold218`, took Gareth's pairs for the six, and moved the two app-made problems that used those dots. Mirrored casts aren't checked on the wall yet.
- `boardPct()` turns a tap into board percentages, from the board's on-screen rect, so it holds in the fullscreen viewer's zoom and pan too. All three interactive boards use it.

### 4.5 Problems: storage quirks you must know
- **Holds are stored INVERTED.** The migration wrote `start_holds`/`finish_hold` back to front. The true order is `[finish_hold, ...intermediate_holds, ...start_holds]`: the first two are starts (green, low), the last is the finish (red, high). Use `problemHoldOrder()` + `classifyHolds()`.
  - `saveProblem` inverts on the way back in, so reads and writes share one scheme.
  - A lone start is duplicated so there are always two start entries.
  - This order is exactly Gareth's original list, so the Pi side reads it the same way.
  - Fixing this for good means a data migration **plus** a Pi change in lockstep.
- **Names are UNIQUE and are the cast key.** The Pi looks a problem up by `problem_name` when the cast arrives. Names are stored clean (no embedded grade) and trimmed; since 8 Nov 2026 they can be changed through Edit (§4.8b), and a rename works from the next cast (contract §10). Changing a grade never touches the name.
- **Grades are stored lowercase** (`5, 5+, 6a … 8a`) and **displayed** capitalised via `fontGrade()`. Unknown grades sort last: 2 problems are graded `Project`.
- **Circuits use a separate lowercase sport ladder** (`4, 5a … 8b`), are **not** capitalised, and are stored in **natural order** (not inverted). A circuit is one ordered `hold_sequence` with duplicates allowed, plus `start_count` (1–2) and `loops`.
- **Board orientation:** row 1 (A1 = `hold1`) is at the **bottom**. `holdN` → grid is row-major: `hold1`=A1, `hold19`=S1, `hold20`=A2, `hold247`=S13.
- **Create rules:**
  - The top 25% of the board, by hold y-span on the live map, is the finish zone: no starts, one finish, other holds allowed. It's a rule only, not drawn on the board in Create (since 2 Nov 2026).
  - Everywhere else holds cycle start (the first two) → hold → off.
  - A problem needs 1–2 starts, at least one intermediate and exactly one finish.
- **The setter shown** is resolved live: `setter_id` → `profiles.username`. Migrated rows (no owner) and orphaned rows fall back to the `setter` text snapshot. **"The Hangout"** (db/35, 30 Oct 2026) is the gym: the 169 migrated problems that named it four ways, and every problem made on the wall screen. It's setter text only (no profile, no owner), so it never appears on Ranks, earns no points and is on no one's profile; `hangout` is a reserved nickname (db/30). Circuits have no snapshot, so an orphaned circuit shows "unknown".

### 4.6 Ticks, favourites, points
- **Ticks** are private per user and orientation-aware. The key is `(user_id, problem_id, mirrored)`, and the detail tick toggles whichever orientation is showing.
  - `myTicks` = sent either way; `myTicksNormal`/`myTicksMirrored` = each side.
  - **Exclude Done** hides problems sent both ways.
- **Favourites:**
  - Problems use the old `likes` table; circuits use `circuit_likes`.
  - Toggles are optimistic, and a duplicate insert error (`23505`) counts as success.
- **Tick and favourite writes go through `settleToggle()`** (`account.js`, since `pb-v100`). Only one write per item is in flight at a time. A tap while one is running just flips the UI, and when the write lands the loop sends one more if the screen now wants the other state, so rapid taps always end with the database matching the screen. A failed write puts the UI back to what the database holds.
- **Points** come only from the `leaderboard()` RPC (db/27), the single source of truth. **Only benchmark problems score** (Ross, 11 Sep 2026):
  - base = grade index × 10 (`5` = 10 … `8a` = 150);
  - +50% of base once if the benchmark was sent both ways;
  - a non-benchmark scores 0. The old +50% benchmark bonus went with db/27.

  Only climbers with points are listed, and "sends" counts benchmark sends. Points are worked out live, so marking a problem a benchmark scores its existing ticks straight away, and unmarking it takes them back. The profile's "Total points" reads the caller's own row back from the RPC. `leaderboardLoaded = false` invalidates the cache after ticks, edits, benchmark toggles and deletes.
- **Benchmarks:** high-quality problems that are accurate at their grade.
  - Only admins mark them: the "Mark as benchmark" / "Remove benchmark" item in the detail ⋮ menu (`toggleBenchmark` in `problems.js`). It isn't offered for an ungraded problem (`Project`).
  - They show a gold disc with a star cut out (`benchMarkSvg()` in `core.js`) on list cards and in the detail badge, and there's a Benchmarks filter pill.
  - Admin Edit on a benchmark shows a gold line under the board: changing it changes everyone's points (`#create-warn`).
  - Owners lose Edit and Delete on their own problem once it's a benchmark (db/27 enforces it).
- **Casting a circuit (Phase 2, 30 Oct 2026):** Cast beside the title opens a sheet (speed Slow 5 s / Med 3 s / Fast 2 s, Loop, Start); then a run screen with the countdown and beeps, the move count and a big Stop; signed-in runs are logged to `circuit_logs`. The Pi draws the lights itself. Details: `docs/cast-contract.md` §8. The circuits "Exclude Done" pill is still deliberately inert: runs are logged, but what counts as done isn't decided.

### 4.6a Challenges (db/31, `challenge.js`, since `pb-v110`)
A **challenge** is a timed competition on a circuit; its rules are data (`challenges.protocol`). The only one is the **Pat Burner** on the "Pat Burner" circuit: 3 sets × 3 reps, each rep to failure, 30 s between reps, 5 min between sets, a 10 s get-ready. It doesn't use the LEDs, casting or the Pi.
- **Where:** a link under the circuit's board (`fillCircuitChallenge`) opens `#challenge/<id>`: the rules, Start (signed in), your best and rank, unsaved attempts, your history (tap one for its reps), and a link to its board on Ranks.
- **The attempt:** "Get ready" countdown → "Climb!" with the clock counting up and a huge **Fell** button → rest countdown → next rep. Beeps are generated with Web Audio (no files; the `AudioContext` is made on the first tap, and after a reload any tap anywhere unlocks it again while an attempt runs). A screen wake lock is held while it runs, and on this view the bottom nav hides (`body.ch-running`).
- **Leaving the view (since `pb-v111`):** the attempt carries on. The ticker, the wake lock and the beeps (3-2-1, go, done) keep running in every view, and a strip on top of the bottom nav (`#ch-return`, filled by `chSyncAway`/`chUpdateAway`) reads "Back to the Pat Burner" with the phase and clock (Get ready / Rest counting down, Climbing counting up, or "Finished: save it"); tapping it opens the attempt. `body.ch-away` raises `--nav-h` by the strip's 40 px so every view makes room. An attempt still running when the app is reopened carries on in whichever view opens (`resumeChallenge()` at boot), and a waiting app update holds its reload until the attempt ends. **End early** needs a second tap within 3 s; ending during a rep counts that rep so far. A rep stops itself at the 1200 s cap.
- **Timing comes only from timestamps** (`chAdvance`): the attempt stores the phase and when it started, and catches up on every tick, on returning to the foreground, and on reopening the app. A countdown that ran out while the screen was off starts the next rep at the moment it ran out. The attempt is kept in localStorage (`pb-challenge-run`) the whole time, so a reload or a closed app picks it up. Only one attempt runs at a time; one older than 14 days is dropped.
- **Saving:** Save moves the attempt into `pb-challenge-pending`, then inserts it. Success or `23505` (the phone-made id is already there) removes it; `23514`/`23503` (a broken rule, a retired challenge) drops it with a message; anything else (no signal) keeps it, with a "Try saving again" button. Pending attempts are retried at start-up, on sign-in and when the browser comes back online, but only for the account that made them.
- **Server side:** the trigger works out `total_seconds` and `ended_early`, and checks the rep count against the protocol, the 14-day window and a finish no more than 5 min ahead; CHECKs cap each rep at 0–1200 s and require the time between start and finish to cover the time held (5 s slack). The phone can't send `total_seconds`, `ended_early` or `user_id` (column grants).
- **Boards:** `challenge_leaderboard(cid)` = each climber's best attempt (higher total first; on a tie the earlier `completed_at`), opted-in climbers only (`is_public`), top 20, plus the caller's own row (ranked outside the top 20, or private if their switch is off). `challenge_compare(cid, uids)` = up to 3 opted-in climbers' best attempts rep by rep, drawn as an inline SVG line chart (no chart library). Both are callable by guests, like `leaderboard()`. Challenges never score points.
- **Admin:** a delete button on each board row → `admin_delete_attempt(aid)`, logged in `admin_actions` (`delete_attempt`, `target_id` = the climber, `subject_id` = the attempt). Their next-best attempt takes its place.
- **The circuit is locked:** while a challenge uses it, only admins can edit it (RLS) and nobody can delete it (`ON DELETE RESTRICT`); the app hides the owner's Edit and Delete (`canEditCircuit`) and explains a refused admin delete. A challenge with attempts can't be deleted either: retire it with `is_active = false`.

### 4.7 Casting
`castByName(name, btn, mirror, stillShowing, { quiet })` in `problems.js` is the only cast path; it resolves `true` once Realtime accepted the cast (the wall screen uses that for its status, §4.7a).
1. **Geofence** (`ensureCastLocation`; centre and radius in `GYM_GEOFENCE`). A nudge for honest users, not access control: it's deliberately lenient, so it never blocks someone at the wall because of a poor GPS fix, and admins bypass it. The exact rules are in the code.
   - **The location wait can take seconds**, so the name and orientation are fixed at the tap and re-checked afterwards. If the screen has moved on (a swipe, the mirror flipped, the view left: the caller's `stillShowing()`), nothing is sent and the toast says "Cast cancelled". `castTarget` tracks the cast that owns the shared Cast button (one element beside the title, moved into each new title row by `renderDetail` since 30 Oct 2026); `renderDetail` releases the button when the problem or orientation changes, and a newer tap replaces an older one (only the newer one is sent). The circuit cast (`startCircuitCast` in `circuits.js`) does its own check after the location wait: the cast sheet must still be open on the same circuit.
2. **Broadcast:** `channel.httpSend('cast_problem', {problem_name, mirror?}, {timeout: 10000})` on `board:HangoutPortland`: one REST POST (since `pb-v99`).
   - **The app never subscribes**, so it holds no WebSocket (before `pb-v99`, every open app kept one joined all the time, and `send()` would have fallen back to REST anyway when it dropped). Subscribers get the same event and payload as before.
   - `httpSend` resolves once the Realtime server has accepted the broadcast (202) and rejects otherwise; a rejection shows "Cast failed". That means **the Realtime server** got it, not the Pi. There's no end-to-end confirmation.
   - **Testing without the Pi:** `python tools/serve.py`, then open `http://localhost:8000/tools/cast-test.html` (section 11).
3. **The Pi** is being rebuilt on a **new Pi 4** (Oct 2026; Gareth's Pi 3B is gone). The spec is the local `docs/pi4-led-audit.md`:
   - The listener subscribes with the anon key and looks the name up in `problems`.
   - It uses `problemHoldOrder()`'s order (which equals Gareth's) and lights green starts, blue intermediates and a red finish.
   - LED index = column-major serpentine (`led_map.json` / `register_leds.py`; the formula is in the audit §3). WS2801 on SPI0 at 1 MHz, mode 0, RGB.
   - Feed it the **live** mirror map (`board_config.mirror_map`), not Gareth's raw `MirrorDic.txt`.
   - The relays (BCM 23/24, active-low) must be switched on at boot. They're believed to power the LEDs and the wall touchscreen.
   - The same Pi drives the **wall touchscreen**: the PWA's wall-screen mode in a Chromium kiosk (section 4.7a). The cast geofence lets a cast through when there's no location, so the kiosk can cast; its Chromium runs with `--deny-permission-prompts`, so the location request fails at once instead of waiting on a permission bubble.
   - The June 2026 Pi 3 listener (now in the local `pi/_old/`) is history, not the basis; the Pi 4 listener is in `pi/`.

Nothing records casts in the database: the old `board_state` table was never used and was dropped in db/24. **Casting is open to guests by design** (decided 10 Sep 2026), with the geofence kept as the gate.

### 4.7a The wall screen (`/?wall`, `wall.js`, since `pb-v117`)
The touchscreen next to the board (1280×720, landscape) runs the app in a Chromium kiosk at `https://symmetryboard.co.uk/?wall` (`pi/systemd/kiosk.service`). Screenshots, with fake sample data: `docs/screenshots/wall-mode/`.
- **Switch:** `WALL` in `state.js`, from the `?wall` query. It stays in the URL, so a reload or an update keeps it; the service worker caches `/?wall` as the shell (any query on `/` is the shell). `body.wall` hides every phone view, the bottom nav, the welcome and the install banner (`!important`: `setView` sets the nav's display inline) and shows `#wall` (`index.html`). The phone views keep running underneath: the loaders and the router are untouched, and a few hooks call into `wall.js` only when `WALL` is set (`renderList` → `wallRenderList`, `refreshBoardViews` → `wallRefreshBoard`, `loadProblems` → `wallSetNet`, `showChallenges` → `wallOnChallenges`). The welcome, the install banner and the iOS banner never show in wall mode.
- **Problems** (layout since `pb-v118`, option A in `docs/screenshots/wall-mode/options/`): a row over the list (`#wall-filters`, since 4 Nov 2026: the filter icon, Benchmarks, the search field and Clear, §4.2a; the icon opens the Filter panel over the list's column, the same sections and state as the phone's sheet, §4.2a; no Favourites or Exclude Done, there's no account), then, sorted Easy or Hard, a rail of grades down the left edge (`#wall-rail`; a tap jumps the list to that grade's section, it doesn't filter, and the rail marks the grade at the top of the list as it scrolls) and the list in one scroller, a section per grade with a sticky header and a count, rows of `--wall-row-h` (no favourites or done: no account). **Search (4 Nov 2026):** the row's field (`[data-wsearch]`, a button styled like the phone's input, with the same ×, `[data-wsearch-clear]`) opens the on-screen keyboard (`#wall-kb`, shared with Create: `wallKbOpen(target)`, `WALL_KB_TARGETS` = `name` | `problems` | `circuits`). For a search it docks over the board (`.wall-kb.search`, from `--wall-side-w` to the right edge) so the whole list stays in view; its keys (`WALL_KB_SEARCH_ROWS`) are lowercase with no shift, `+` and `-` and `'`, delete, a Clear key and space; 40 characters at most. Each key sets `wallSearch[kind]` and the phone's `searchQuery` / `circuitSearch` (`wallSearchSet`), and the list re-renders from the top (`filtersChanged`), so it filters exactly as the phone does; the grade rail and headers follow. The keyboard closes on Done; on a tap anywhere outside it and the row (a capture-phase listener in `startWall`), and a tap on the list or the board (a card, Mirror, Start circuit) then does nothing else, so closing it never casts (`wallCast` / `wallCircShow` also refuse while it's open); on opening the Filter panel (`wallFilterShown`); on a page change; on Clear; and on going idle, which empties both searches too. On the right, a bar with the chosen problem's name (up to two lines, fixed height so the board doesn't move) and its grade, feet rule badge (since 10 Nov 2026: "Specific feet (4)", Orange or Black feet; the list's cards don't show it) and setter, Mirror and a cast status (`#wall-lit`: "Lighting it up…", "Sent to the board", "Didn’t send: tap it again", "Offline: not lit"; "Sent" means Realtime took it, never that the board lit), over the chosen problem's board (`boardShapeOverlayHtml` with `dim`, or dots); with no problem chosen the board is dimmed all over, as on the Circuits page (`wallDimOnlyHtml`, since 2 Nov 2026). **No cast button (since 2 Nov 2026, TODO 8): the pick casts.** A clean tap on a card picks it and lights it (`wallPickAndCast` → `wallCast`); a tap on the card already picked lights it again (to take the board back from a phone); **Mirror** flips the view and lights that side, and back again lights it unmirrored. A clean tap means the finger didn't move more than `WALL_TAP_SLOP` (10 px), the list didn't scroll under it, and the list wasn't moving when it went down (`WALL_FLING_MS`, 150 ms: the touch that stops a fling): a scroll or drag only moves the list. Casts go through `castByName` like the phone's (with `quiet`: no "Cast cancelled" toast), with its own `stillShowing` (same problem, same orientation, still on Problems, not idle); **one at a time** (`wallCastPump`): a tap while one is being sent waits in `wallCastNext`, and a newer tap replaces it, so rapid taps never queue and the latest wins. Nothing is sent offline. The wall's cast takes over whatever is on the board (the Pi shows the latest cast). Sorted New or Random (`.wall-flat`) the list is flat and the rail is hidden. Going idle closes the Filter panel and resets both lists' filters, sorts and picked holds to the defaults (`resetListFilters()`, `resetCircuitFilters()`); changing page closes the panel. **Picking holds (4 Nov 2026, §4.2a):** while a page's Filter panel is open the board on the right is the hold picker (`wallRenderPick`: the board built once, a tap redraws only its layer): the bar reads "Pick holds" with the live line, Mirror, Start circuit and the cast status hide (`.wall-page.filtering`), and a clean tap on the board (`wallTapBoard`: the finger moved no more than `WALL_TAP_SLOP`) picks or drops the nearest hold. While the panel is open taps never cast and never send `show_circuit` (`wallCast` / `wallCircShow` also refuse while picking). Closing the panel (`wallFilterShown`) puts back the chosen problem or circuit, or the dimmed board, and re-renders the list if the picks changed.
- **Circuits** (30 Oct 2026; redesigned 2 Nov 2026): a row with the filter icon, Looping, the search and Clear (4 Nov 2026; the Filter panel, the search keyboard and Clear as on Problems, `#wall-cfpanel`), the list (`visibleCircuits()`: the phone's order and filters, New by default; no rail) and the chosen circuit's numbered holds over the board; with none chosen the board is dimmed all over (`wallDimOnlyHtml`: `holdShapeLayerHtml`'s mask with no holds cut out; the Problems page uses it too). **Opening the page lights nothing** and leaves the board as it is. A clean tap on a circuit (the same rules as Problems: `wallTapList`, shared by both lists) picks it and lights **all its holds at once** (`wallCircPickAndShow` → `wallCircShow` → `showCircuitByName` in `circuits.js`: the event `show_circuit`, contract §8.7; starts green, the last hold red, the rest blue, the same roles as the screen's `circuitHoldRoles`); a tap on the one already picked lights it again; one at a time, the latest tap next (`wallCircShowPump`); a status beside the button (`#wall-clit`) as on Problems. The Pi shows it like a problem cast (latest wins, idle after 15 minutes). **Start circuit** (was "Light it up") opens the phone's Cast sheet (`openCircuitCast(c)`: speed, loop, the countdown, the move count, Stop), sent as `source: "wall"`. While a run is going the wall doesn't go idle; going idle closes the sheet (`abandonCircuitCast`); at closing time the Pi ends the run and stops the kiosk.
- **Create** (db/35, 30 Oct 2026; the tabs read Problems · Circuits · Ranks · Create · Get the app, and Create shows only once `wall_key_ok()` says the wall key works: `wallCheckKey` asks at start, retries a failed ask every minute on its own (since 2 Nov 2026; before, only after the next good problems poll), and asks again when a save is refused with `key`): anyone at the wall sets a problem with no sign-in. The board on the left (tap a hold: the phone's `cycleHold` rules), and a panel: the name (a button that opens an **on-screen keyboard**, `#wall-kb`, `wallKbOpen('name')`, full width over the bottom, closed by Done; the same keyboard types a list's search, above: digits, letters with shift (on at the start and after a space), `' ! ? & . , -`, space, delete; the kiosk has no keyboard), the 15 grades, the feet rule (and Specific feet: a tap on a foothold, as on the phone, §4.8a), the steps, and Undo · Clear · Cancel · Save. Every change lights the board (contract §9). **Save** calls `wall_create_problem()` with the wall key (`WALL_KEY`, from the kiosk URL's `#k=` fragment, kept in localStorage `pb-wall-key` and taken off the address at once): the database repeats every check, forces setter "The Hangout" with no owner, rate-limits (6 in 10 minutes, 30 a day) and refuses blocked words; its refusals come back as short codes (`WALL_SAVE_ERRORS`). Then Problems opens with the new problem chosen, and it's lit on the board straight away (`wallCast`, as a tap on its card). While Create is open the slides never start; after 5 minutes untouched a sheet asks "Still setting?" with a 30 s countdown, then discards it. Leaving with something set (a tab, Cancel) asks first; going idle closes it without asking.
- **Ranks:** read-only: Points and each active challenge side by side, top 10 opted-in climbers, reloaded each time the tab opens. No compare, no admin delete, no private note.
- **Get the app:** the `/scan` QR (`print/qr-scan.svg`'s path, inlined in a `<template>`, coloured by `--qr-dark`/`--qr-light`).
- **Idle:** 20 minutes with no touch (`WALL_IDLE_MS`; a tap, or the start of a scroll or drag, restarts it: `pointerdown`, `touchstart`, `wheel`, `keydown`) → back to Problems with no filters and nothing chosen, then slides every 12 s: the QR and the benchmark of the day (`wallFeatured()`: the benchmarks by name, one per day). A challenge's top-5 slide was taken out of the rotation in `pb-v118`; the boards stay on Ranks. A touch ends the slides; on the benchmark slide it picks that problem and lights it. (This 20-minute screen idle is the touchscreen's own; the board's LEDs go back to the idle pattern 15 minutes after the last cast, set on the Pi, `IDLE_AFTER_S`.) A waiting app update reloads only when it goes idle (`wall-idle` event; `hasUnsavedWork` holds it otherwise), and the wall checks for updates hourly since it's never hidden. So an update reaches the wall within an hour of the deploy if nobody's using it, or within 20 minutes of the last touch. A reload while the slides are up (sessionStorage `pb-wall-idle`) comes back to the slides, not to 20 minutes of the list.
- **Night (7 Nov 2026):** the page has no night screen of its own any more (it had a dimmed QR 23:00–08:00). Outside the opening hours the Pi stops the kiosk and powers the screen down (`pi/ops/pb-mode`, `kiosk.service`'s ExecCondition; `pi/README.md` → Opening hours), so the page only ever runs in the day, and a kiosk started each morning loads the latest app.
- **Offline:** while the problems fetch fails, or the browser says it's offline, a note says when the saved list was saved, the header shows Offline, a tap on a problem or a circuit doesn't cast ("Offline: not lit"), and the Circuits page's Start circuit is disabled. It retries every 30 s (every 5 min when online, `wallPoll`: problems, circuits, setter names, challenges), silently.

### 4.8 Fullscreen board (the viewer)
Since `pb-v106` (22 Sep 2026) fullscreen is a **camera over the board**, the "Fullscreen board viewer" section of `core.js`. The photo (~1.22:1) never matches a phone's shape, and both earlier answers were rejected: rotating it sideways (black bars) and stretching it to fill (`pb-v105`, distorted). The last commit before any of this is `8629944` (`pb-v104`).
- **Framing:** it opens framed on the **route** (`fsRouteBox()`: the problem's holds and Specific feet footholds, mirrored if the mirrored view is on, or the circuit's sequence, from `HOLD_MAP` / `FOOT_HOLDS`), zoomed to fill the space between the close button and the bar (at most 3×), gliding there from the board's place on the page. Create views open on the whole board, and on the problem create view the bar shows the name typed so far and the start/holds/finish counts.
- **Gestures** (pointer events on the board and backdrop, `touch-action: none`): one finger pans, two pinch about their midpoint (1–5×; `FS_PINCH_GAIN` 1 since `pb-v113`, so the board stays under the fingers; it was 1.8 and felt too twitchy), the mouse wheel zooms about the cursor. **Pinch in and out (since `pb-v113`):** on the detail views, two fingers spreading on the page's board (`FS_PINCH_ENTER`, 6%) open the viewer mid-pinch with no glide (`enterBoardFs(false, true)`; the board's `touch-action: none` there keeps the browser off it), and the viewer takes over the same fingers. In the viewer, a pinch on a detail view may shrink the board below fitting (`FS_PINCH_FLOOR`); one that ends zoomed all the way out (≤ 1.02×, and smaller than it started) glides the board back to its place on the page and closes (`fsPinchClose`). A double-tap closes it the same way, wherever you're zoomed (since `pb-v115`); the bar's frame button and the minimap still show the whole board. Not for a viewer opened by turning the phone (that closes by turning back) or on circuit create. **The hold filter's picker (§4.2a) does too, as the `'holds'` view (`fsView()`: `holdPickerOpen` over the list; `activeBoardWrap()` is `#hp-board`, `PICK_FS_VIEWS` shares Create's tap rules, and while the viewer is open the picker screen drops to the viewer's level and the Filter sheet behind is hidden).** **Problem Create/Edit pinches in and out the same way (`PINCH_FS_VIEWS`, 4 Nov 2026)** but never opens on turning the phone; its two-finger touches are kept from the browser by a non-passive touch listener on `#create-board` (one finger still scrolls the page), and there a double-tap closes the viewer only when both taps miss every hold (`fsCreateTap` → `nearestHold`), so a double-tap on a hold still cycles it twice; taps never hide the bar. Mid-pinch the camera is loose (not re-centred) and settles when the fingers lift. On the read-only detail views a tap hides/shows the controls (`body.fs-ui-hidden`), a double-tap switches route ↔ whole board, and a quick sideways swipe steps along the deck when the board isn't wider than the screen. On create views taps still set holds; after any drag or pinch the next click is swallowed so it never sets one. The page's own detail swipe (`wireDetailSwipe`) is off while the viewer is open.
- **Around it:** a blurred, darkened copy of the photo fills the screen (`.fs-backdrop`, inserted as the board-wrap's sibling so both share a stacking context); a minimap (top-left) shows what's in view whenever part of the board is off-screen, and tapping it shows the whole board; the bar (`#board-fs-bar`) names the problem or circuit and has previous · mirror · route/whole board · next. Stepping or mirroring re-renders the detail, and a `MutationObserver` adopts the new board-wrap and glides the camera to the new route. A one-line hint shows the first 3 times (`pb-fs-hints` in localStorage).
- **Mechanics:** zoom sets the board-wrap's **width** (so outlines, dots and move tags keep their pixel sizes and the image re-lays out sharp) and pan is a `translate3d`; `fsClampCam()` keeps the board centred when it fits and edge-to-edge when it doesn't. `boardPct()` is plain rect maths again (no rotation). Resizes re-fit the current framing; a camera the user has moved just stays in bounds.
- **Ways in:** the expand button on any board, which also asks for the browser's real fullscreen (Fullscreen API, `navigationUI: 'hide'`: hides the status and browser bars on Android and desktop; iPhone Safari only allows it for video). Leaving that (Android back, Esc) closes the viewer too. And turning a touch device to landscape on the two detail views (`fsAuto`, no browser fullscreen as there's no gesture), closed again by turning back.
- **Details:** a wake lock is held while it's open. Any route change (`setView`) closes it; Back and Esc close it first.

### 4.8a Creating a problem (`#create`)
Since `pb-v107` (23 Sep 2026) the create view is built to feel like the problem view (`authoring.js`, top section):
- **Same layout:** pinned like `#view-detail` (it shares the pinned-view, locked title-block and board rules in `styles.css`), so the board sits at exactly the same place as on a problem.
- **Title block:** the name is an `<input>` styled as `.detail-name` (typed in place, in Create and Edit). The meta row has the grade as a `.grade-badge` button that opens a sheet of grades (`#create-grade-modal`, `openCreateGrade`/`pickCreateGrade`), and "by" the setter.
- **Board:** dimmed like the problem view with every hold bright (`lightAll`), assigned holds outlined and filled in their role colour. The finish zone (the top 25%) still governs the taps (`cycleHold`, and `wall_create_problem()` on the wall) but is **not drawn** on the board, on the phone or the wall (its dashed line and label were removed on 2 Nov 2026).
- **Guidance:** no paragraph of rules. A strip pinned under the board (`.create-status`) shows start · holds · finish, each ticked off when right, and one line saying what to do next (`updateCreateStatus()`). A save that's missing something says so in a toast and takes you to it (focuses the name, opens the grade sheet).
- **Header:** back · Undo (`createUndo` in `state.js`, snapshots of `createRoles`; the bin can be undone too) · bin (clear, or revert in edit) · ✓ save.
- The tap rules (`cycleHold`) and the inverted save are unchanged. Circuit create (`#circuit-create`) is still the older form layout.
- **Specific feet** (10 Nov 2026, Ross's decisions in `docs/board-setup-plan.md` → Session 3): there's no fourth button. A tap is resolved by `createPick()` (`authoring.js`): inside a foothold's outline (and no smaller hand outline) or, outside every outline, nearest to a foothold's centre (within 4% of the board's width) picks the foothold; otherwise it's exactly `nearestHold()`, so hand-hold taps behave as before (checked over a 200 × 200 grid of taps: wherever the pick is a hand hold it's `nearestHold()`'s, every hand hold's centre picks it and every foothold's centre picks that foothold). `toggleFootHold()` adds or drops it (`createFeetHolds`, `state.js`); the first makes the problem Specific feet (`createFeet = 'specific'`; Orange or Black only goes, with a toast), the last one off makes it Any feet. Picking Any, Orange only or Black only while footholds are picked clears them, with a toast; Undo (snapshots are now `{ roles, feet, feetHolds }`) brings them back, and the bin clears them with the holds. At 30 (`FEET_MAX`, the database's limit) a toast refuses the 31st and the line under the feet rule (`#create-feet-note`, `#wall-c-feet-note`) says so; otherwise it reads "Specific feet (4): tap a yellow one again to drop it", and none of the three options is chosen. Footholds are never in the finish zone or the start/finish logic. Saved as `feet_mode: 'specific'` + `feet_holds` (phone insert and Edit update; the wall's `wall_create_problem(…, p_feet_holds)`). **Never lit:** a foothold tap sends no preview, except when it turns a sign off (Orange/Black only → Specific feet), and `preview_holds` carries `feet: "specific"`, which the Pi treats as Any (contract §6.5, §9.1). The fullscreen bar adds "· N feet".
- **Live LEDs while setting** (30 Oct 2026, contract §9): from the first change, every tap (and Undo, the bin, the feet rule) sends the whole selection as `preview_holds`, coalesced to one message in flight, with a keep-alive every 20 s and `end` when the view is left (`setView`), saved, or the app goes to the background. Phones check the geofence first with **no admin bypass** (`ensureCastLocation({ adminBypass: false })`); outside it nothing is sent and the note under the board says so. While a session is going the app subscribes to the channel (its only socket) to notice a cast or someone else's preview taking the board, and offers **Show on board** (`previewShowAgain`).

### 4.8b Edit a problem or a circuit (8 Nov 2026, db/39)
One **Edit** in the detail ⋮ menu opens the Create screen pre-filled; it replaced the separate "Edit holds" and "Edit grade" (the chooser and the grade sheet are gone). Phone only: the wall screen has no Edit (its Create shares `authoring.js` and is unchanged).
- **Problems** (`#create/<id>`): holds, name, grade and feet rule (Specific feet's footholds too, §4.8a) in one save (`seedEdit` → `saveProblem`, the same rules and inverted storage as Create; the setter is never editable). Title "Edit problem", the ✓ is "Save changes", the bin puts it back as saved (Undo brings your holds back). The live LEDs work as in Create (contract §9). Saved → the detail with the new values; the editing phone's saved list is rewritten at once (`saveList`).
- **Circuits** (`#circuit-create/<id>`): the sequence, start count, loop, name and grade (`seedCircuitEdit` → `saveCircuit`, natural order). Title "Edit circuit"; the bin puts it back as saved (`onCircuitCreateReset`).
- **Who** (`canEditProblem`, `canChangeCircuit`; RLS and db/39's guards are the real gate): admins, anything; the owner, their own problem while it isn't a benchmark and nobody else has ticked it (`problem_has_other_ticks`), their own circuit while no challenge uses it and nobody else has logged a run (`circuit_has_other_logs`). The Hangout's problems have no owner, so admins only. The "someone else" answer is asked in the background the first time a detail shows for its owner (`askOthersUsed`; Edit appears when it says no), kept a minute per account (`othersKnown`), and asked again, fresh, when Edit opens: if someone has ticked it meanwhile, a toast and back to the detail. The route guards (`mayOpenProblemEdit`, `mayOpenCircuitEdit`) bounce anyone else off a typed URL.
- **Saving:** names trimmed and unique ignoring case (the item being edited left out); a duplicate is refused before saving, and `23505` from the database says the same. The write is `.update(...).select('id')`: 0 rows means RLS refused it (an admin: "no longer an admin" + `recheckAdmin()`; an owner: "only an admin can edit this now"), `42501` means the db/39 guard refused a column.
- **Leaving with changes asks first** (`editLeaveName`, `confirmLeaveEdit` in `app.js`, the `#edit-discard-modal` sheet): the in-app back and the bottom nav; Discard forgets the edit (`discardEdits`). Not asked: the phone's own back gesture, and Create (unchanged). A clean Edit never holds an app update (`hasUnsavedWork` checks `problemEditDirty()` / `circuitEditDirty()`).
- **Kept on edit:** ticks, favourites, likes, `circuit_logs`, challenge links, cast history: all keyed by id. A rename is a new cast key; contract §10 lists everything that keys on a name.

### 4.8c Move a problem into Circuits (8 Nov 2026, db/40, admins only)
For a problem that is really a circuit. The detail ⋮ menu's **Move to Circuits** (admins, never a benchmark: unmark it first) opens `#move/<problem id>`: the circuit Create screen (`initCircuitMove` → `seedCircuitMove` in `circuits.js`), pre-filled. Phone only.
- **Pre-fill** (`problemAsCircuit`): the problem's holds in `problemHoldOrder()` order (starts, intermediates, finish), unmirrored, feet signs left out; start count 2, or 1 when the two stored starts are the same hold (a lone start is stored twice); the name; loop off. The grade is a best guess from **`FONT_TO_SPORT` in `state.js`** (the one place the table lives: one step up the sport ladder, `6b+` → `6c`); `Project` or an unknown grade pre-fills nothing. A line under the Grade label shows the problem's Font grade beside the picked sport grade.
- **The prompt** above the board: "Does this order look right? The middle holds may not be in climbing order." Why: a problem's `intermediate_holds` aren't in climbing order. On Create they're `Object.keys(createRoles)` filtered to `int`, i.e. the order each hold was **first tapped** (a start demoted to a hold keeps its early place; a hold tapped off and on again goes to the end; Edit seeds the stored order, then appends); migrated problems keep Gareth's order. Fix it with Undo and taps, as in Create. If the feet rule isn't Any, a second line says it will be dropped (for Specific feet: "its N footholds will be dropped").
- **Save** checks the name (unique among circuits ignoring case, the same message as the RPC's `23505`), then asks `admin_problem_move_counts()` for the confirm sheet (`#move-modal`): "This deletes the problem X and its N ticks and M favourites. This can't be undone." **Move** calls `admin_move_problem_to_circuit()`, one transaction: the circuit is created with the problem's `setter_id` and `setter` text (so The Hangout's stay The Hangout's), its ticks and likes are deleted, then the problem; logged `move_to_circuit`. Then the circuit's detail opens; the saved lists are rewritten, the leaderboard cache dropped.
- **Leaving** with changes asks first (the Edit discard sheet; `circuitEditDirty()` covers a move); leaving changes nothing. The bin puts it back as converted.
- `cast_log` rows (keyed by name) are left as they are.

### 4.8d Board setup (`#setup`, admins, 9 Nov 2026, db/42; `setup.js`, `trace.js`)
Admin → Board Setup. A full-screen tool (no bottom nav) in steps, built for a phone; `docs/board-setup-plan.md` has the why.
- **Start:** the board now (hand holds, footholds, corners marked or not), a saved draft (Carry on / Discard), **Undo the last publish** (two taps, `admin_undo_board`).
- **Photos:** the straight-on photo and the cartoon, read with `createImageBitmap` (no `blob:` URLs, so the CSP is unchanged), scaled (cartoon at most 2000 px, photo 3000 px), uploaded as JPEG to the `board` bucket under `setup/<stamp>-photo.jpg` / `-cartoon.jpg` (admin-only writes, db/10).
- **Corners:** four draggable corners (1 top left, clockwise; a magnifier while dragging) on the cartoon and the photo: the real board corners, footholds included (the trace's area; saved to `board_config.corners`).
- **Line up** (10 Nov 2026; only while `board_config.corners` is empty, `bsNeedLineup()`; otherwise skipped and the step numbers close up, `bsSteps()`): today's board image is cropped, so instead of its corners, four hand holds are tapped on it (`bsLuTap`: snapped to the nearest hand hold within 44 px, named, a numbered one re-tapped to change it), then the same four on the cartoon in the same order (draggable, with the magnifier). Refused (`bsLuProblem`): the smallest triangle of the four under 8% of the hand holds' box, one inside the other three's triangle, or the cartoon's four turning a different way (wrong order). State `BS.lineup` `{cur: [hold id ×4], cart: [[x%, y%] ×4]}`, in the draft.
- **Trace:** `traceHolds()` on the cartoon scaled to `TRACE_WORK` (2200 px), shapes outside the corner quad dropped (`bsTraceData()`, also run in Node by `tools/trace_prior_score.js`). **Match:** the first guess is a homography: on the first run from the line-up's four point pairs (today's image % → cartoon %, `bsLuHom`), on a later run through the stored corners (today's image → board → cartoon); then an affine fit to the first matches (twice); each hold takes the nearest shape within 2.5% of the board's width, greedily, closest first. Hand holds keep id, name and LED; today's footholds keep their ids. The mapping found is kept (`BS.xf`: homography then affine, today's image % → cartoon %).
- **The prior** (10 Nov 2026, `bsPrior()`, `BS_PRIOR`; whenever today's board has hand holds with outlines): every hand hold's outline (drawn as the app draws it, `traceCurve`) is mapped through `BS.xf` and fitted on the trace's masks (`tracePriorFit()`: shift in a band of 2.5% of the board's width, turn ±45°, scale ±25%). The traced shape that agrees (IoU ≥ 0.75, not a leak) is used; else the fitted outline (score ≥ 0.8); else the fitted outline, flagged. Turned or resized beyond the board's drift → `chk: 'changed'`. Leftover traced shapes no hand hold covers → new footholds (`chk: 'cand'`), fragments and strays dropped. Each hand shape keeps `src` (`traced` / `fitted` / `tapped` / `drawn`) and `fit` (turn, scale, score); `BS.fits` keeps every fitted outline (Use fitted shape); `BS.stats` the counts.
- **Review:** shapes coloured by kind (hand blue, foothold orange, extra red dashed; to check: gold; new footholds dashed); hand holds with no shape are red tags at their predicted spot. A status line ("181 matched · 7 to check · 50 footholds"); **Next to fix ›** goes through missing holds, extras, then the queue (`bsQueue()`: flagged, changed, new footholds), each with its reason and **Looks right** / **Keep this foothold** (`bsAccept`); **Accept all unflagged** keeps every new foothold. Tap a shape: make it a hand hold (a list, holds with no outline first), a foothold, **Tap to trace** (`bsTapTrace` → `traceTap()` on the trace's masks, `BS.masks`, rebuilt once after a reload), **Use fitted shape**, Move (with a ↻ turn handle, `bsTurn`), Redraw (finger lasso), Delete; Add a shape; All extras → footholds; Undo (every edit). Next (and Publish) only when every hand hold has exactly one shape, no extra is left and nothing is left to check (`bsOpen`).
- **Mirror pairs:** the reflection is fitted to the holds (the centre line swept, then an affine correction), and each hold pairs with the mutual nearest of the same kind (never hand ↔ foot). Hand pairs that differ from today's are listed and **keep today's** unless changed (Use reflection). Tap a hold to see its partner; Change partner / No partner.
- **Publish:** the checks, then `admin_publish_board()`: footholds named FT1, FT2… (left to right, bottom row first, rows by the board's own up), positions = each outline's centroid. Afterwards the phone reloads `board_config` and `holds`; everyone else gets it on their next load.
- **The draft** (`pb-board-setup` in localStorage: `v` 2, step, image paths, corners, the line-up, shapes, `xf`, `fits`, `stats`, pairs) is saved at each change; the images come back from Storage on Carry on. A draft without `v` (2a) shows "from an older version" with Start again (pick the final cartoon) or Carry on with it (works without the prior).
- **Edit holds** (10 Nov 2026, `holdedit.js`; a card on the start page): the live board edited in place, no photo, cartoon or line-up. It's the step `'edit'` on the same stage (pan, pinch, the loupe); `setup.js` hands it the drawing, taps, the ↻ gesture (`herot`), lassos and every `data-act` starting `he-`. The live image is read at its own size (`createImageBitmap`, no colour conversion) and kept as `HE.img.orig`; the model (`heModel()`) is today's hand holds and footholds plus the draft: `rot` (id → degrees, + = clockwise), `added` footholds, `removed` footholds, `pairs` (foothold partner overrides), `outlines` (a hand hold's outline with a foothold cut out).
  - **Select:** `heHit()`: inside an outline first (the smallest), else the nearest outline edge within 22 screen px. The hold's name, kind and angle; its partner highlighted green and labelled.
  - **Rotate:** the ↻ handle under the hold (half degrees while dragging) or −5° −1° +1° +5°, Reset. `heRotateBy()` turns the partner by the same amount the other way (always opposite); a centre-line hand hold (partner itself) or an unpaired foothold turns alone. Outlines turn about their centroid in pixels (`heTurnPct`); positions (`x`, `y`) stay. **The image:** `heRegion()` cuts the hold's region (its outline grown until the ring round it is background, at most 0.9% of the width, minus the other holds' outlines) and fills it from the background around it: 16 rays a pixel, opposite rays that land on the same background colour decide (`heBgClass`, the trace's palette); where a stripe edge crosses (`heStripeFill`), the edge is found outside the region, fitted with a straight line and carried through with its own measured profile (antialiasing and thin border line included). `heComposite()` lays the turned pixels (bicubic) over the fill, never over another hold's outline; what turns is everything inside the outline and, in the grown band, only what isn't background (so a stripe beside the hold stays put). Fills are cached per hold; the image is recomposed from the original on each change, so a turn and back is exactly the original.
  - **Add a foothold:** **Tap to trace** (`heTapPts`: `traceTap()` on the masks of the board as edited, at `TRACE_WORK`, with every other hold's outline and its line taken out first, at most 3× the median foothold's area, a thin ring refused) or **Draw** (the lasso). Named by the FTn rule (`bsFootNameList()`, shared with the setup flow: renaming others keeps the rule; ids never change). A partner is suggested by the fitted reflection (`bsMirrorFit`), foot ↔ foot, unpaired only (Clear partner / Pair with…). A foothold inside a hand hold's outline gets **Cut it out of X's outline** (`heCut`: the hand outline minus the foothold, re-traced).
  - **Delete a foothold:** refused if a problem's `feet_holds` has it (checked first; the publish refuses it anyway).
  - **Warnings:** a turned or new hold whose outline overlaps another's (> 3%) is drawn red dashed and listed; publishing is still allowed.
  - **The draft:** `pb-hold-edit` in localStorage (`v` 1, the board version and image it was made on, the edits, Undo/Redo stacks); dropped with a toast if the board was published since.
  - **Publish changes…** shows a summary (turned with angles, added, deleted, pairs, outlines trimmed, footholds renumbered, overlaps). Publish: when a hold turned, the edited image is encoded as JPEG (quality 0.95, the same size) and uploaded to `setup/<stamp>-edit.jpg`; then `admin_publish_board()` with today's photo and corners and every hand hold and foothold (hand holds keep id, name, LED and position). `board_versions` and **Undo the last publish** work as for the setup flow; no migration was needed.
- **After a real publish:** run `tools/snapshot_board.py` and ship, so the offline fallback (`board-fallback.jpg`, `hold_map.json`, `mirror_map.json`, `hold_shapes.json`) matches the new board; until then an offline phone shows the old board, consistently.

### 4.9 The install flow (welcome overlay)
`installContext()` returns `standalone | in-app | ios | android-prompt | desktop`.
- **When the welcome shows:** mobile browsers only (never standalone or desktop), on a first visit (`pb-welcome-seen` unset) or with `?src=qr` / `?src=moved`.
- **What happens to `?src`:** it's read and then stripped with `replaceState`. OAuth params and the hash survive.
- **Android:** one `beforeinstallprompt` is shared by the welcome's Install button and the small banner (`promptInstall()`).
- **iOS:** share-sheet steps.
- **In-app browsers:** "open in Safari/Chrome" plus Copy link.
- **localStorage keys:** `pb-welcome-seen`, `pb-install-dismissed`, the saved lists `pb-saved-problems` / `pb-saved-circuits` / `pb-saved-names` (§4.2), `pb-outline-draft` (admin), `pb-circuit-speed` (the Cast sheet's speed), plus the Supabase session. All access goes through `lsGet`/`lsSet`. **Don't rename these**: renaming the welcome key shows the welcome to every existing user again.

## 5. Data model (live, 10 Sep 2026)

RLS is **enabled on every public table**, and it does the row-level gating. Since db/24 (10 Sep 2026), `anon` is read-only on every table, and TRUNCATE/TRIGGER/REFERENCES/MAINTAIN are revoked from the API roles. That includes the default privileges for tables `postgres` creates later, so a new table's grants won't match the old ones: grant what it needs explicitly.

| Table | Purpose | Key facts |
|---|---|---|
| `problems` | boulder problems | `name` UNIQUE; holds stored inverted; `setter_id` → auth.users **ON DELETE SET NULL** (routes outlive accounts); `setter` text snapshot (refreshed to the current nickname when the account is deleted, db/30); `is_benchmark` (admin-curated, guarded by trigger), `stars` (the old system's 0–3 rating, guarded by the same trigger; **the app stopped showing it on 30 Oct 2026**, kept in the table for now), `comment` (**off** since db/30: nobody writes it through the API, the app doesn't show it), `feet_mode`: the feet rule, `any` / `orange` / `black` (db/33, 30 Oct 2026; the Pi lights the B2/B1 sign from it; cast contract §6.5) or `specific` (db/41, 9 Nov 2026) with `feet_holds` (text[], 1–30 footholds of the board, empty for any other rule; trigger `problems_guard_feet`; never lit; the app's UI is session 3 of `docs/board-setup-plan.md`) |
| `ticks` | sends | UNIQUE `(user_id, problem_id, mirrored)`; cascades from both user and problem; `attempts/notes/grade_vote/stars` unused |
| `likes` | problem favourites | PK `(user_id, problem_id)`; own rows only |
| `circuits` | circuits | `name` UNIQUE; `hold_sequence text[]` in natural order; `start_count`, `loops`; `setter_id` SET NULL; `setter` snapshot (db/30: filled only when the owner's account is deleted); `comment` off, as for problems |
| `circuit_likes` | circuit favourites | own rows only |
| `circuit_logs` | circuit runs (moves, looped, speed = s a move), written by the app's cast sheet since 30 Oct 2026 | own insert/select |
| `cast_log` | members' casts (db/34): `user_id` CASCADE, `kind` (`problem`/`circuit`), `name`, `mirror`, `source` (`phone`/`wall`), `run`, `created_at` | **insert-only** as yourself (column grant), no select for anyone through the API; PB Console's Activity reads it over direct Postgres for members' nicknames (the public broadcast never says who) |
| `challenges` | timed challenges on a circuit (db/31) | `circuit_id` → circuits **ON DELETE RESTRICT**; `name` UNIQUE; `protocol` jsonb (`sets`, `reps`, `rep_rest_s`, `set_rest_s`, `get_ready_s`, CHECKed); `is_active`; public read, no API writes. One row: the Pat Burner |
| `challenge_attempts` | attempts (db/31) | phone-made `id`; `challenge_id` RESTRICT; `user_id` CASCADE; `started_at`, `completed_at`, `rep_seconds int[]`; `total_seconds` + `ended_early` set by the `challenge_attempts_guard` trigger. Own select + insert (insert only `id, challenge_id, started_at, completed_at, rep_seconds`); no update; delete only via `admin_delete_attempt()` |
| `profiles` | identity | `id` = auth.users.id (CASCADE); `username` = the nickname: 3–20 `[A-Za-z0-9_-]`, unique ignoring case, checked by `nickname_check()`; `is_admin`; `is_public` (the Ranks opt-in, default off). **Readable only by its owner** (db/30) |
| `admin_actions` | admin log (db/30) | `admin_id`, `target_id`, `subject_id` (db/31: the thing acted on, e.g. an attempt), `action` (`reset_passphrase`, `rename`, `delete_user`, `make_admin`, `remove_admin`, `delete_attempt`, `move_to_circuit` (db/40: target = the setter, subject = the new circuit)); no FKs, ids only; admins read, nobody writes through the API |
| `nickname_blocklist` | reserved + offensive words (db/30) | `word`, `kind`, `match_by` (`part` / `contains`); no API access at all |
| `wall_keys` | the wall key's hash (db/35) | `key_hash` (sha256 of the key the Pi made), `revoked_at`; RLS on, **no API access at all** |
| `board_config` | the live board | one row, `wall='HangoutPortland'`: `hold_map`, `mirror_map`, `hold_shapes` (since db/42 **copies made from `holds`**, hand holds only, by the statement trigger `holds_sync_board_config`; a direct API write to them is refused by `board_config_guard_derived`), `image_path`, `updated_at` (the board version), `photo_path` and `corners` (db/42: the setup photo, and `{image, photo}` corner quads in % for camera mapping); public read, admin write |
| `board_versions` | the way back (db/42) | each publish saves the board before it (`holds` rows as jsonb, image, photo, corners, `board_updated_at`, `shapes_meta`, `reason` publish/undo, `undone_at`); admins read, only `admin_publish_board`/`admin_undo_board` write |
| `holds` | every hold of a board (db/41, 9 Nov 2026) | key (`wall`, `id`): `name` (A1–S13), `kind` (`hand` / `foot` / `feet_sign`), `led` (null only for a foothold, unique per board; the Pi lights it), `x`, `y`, `outline`, `mirror`. 188 hand holds + the two feet signs (hold2 = B1 = LED 26, hold21 = B2 = LED 25). Public read; admins may UPDATE `x`, `y`, `outline`, `mirror` (db/42, column grants + RLS). **The source of positions, outlines and mirror pairs since db/42** (`board_config`'s are copies); footholds: id `footN`, name `FTn`, no LED. Mirror pairs are checked at commit by `holds_check_mirror` (same kind, pairing back). db/41's `board_config_sync_holds` is retired. Functions: `admin_publish_board`, `admin_undo_board`, `admin_set_hold_outlines` (admins; §4.8d). Check: `python tools/check_holds.py`. Replaced db/01's empty `holds` table. `docs/board-setup-plan.md` |
| `sessions` | vestigial | empty (`board_state` was dropped in db/24) |

**Policies in short:**
- Public read on `problems`, `circuits`, `board_config`. **`profiles` is own-row only** (db/30): setter names come from `setter_names()`, Ranks from `leaderboard()`, the admin list from `admin_list_users()`.
- Own-rows-only on `ticks`, `likes`, `circuit_likes`, `sessions`.
- Insert-as-yourself (`setter_id = auth.uid()`) on `problems` and `circuits`.
- `circuits` UPDATE (db/31, db/39): an admin, or the owner while no challenge uses it and nobody else has logged a run of it (`circuit_has_other_logs`); DELETE: an admin, or the owner while no challenge uses it.
- `problems` DELETE (db/25, db/27): **an admin, or the owner while it isn't a benchmark and nobody else has ticked it**. The owner's own ticks don't count.
- `problems` UPDATE (db/27, db/39): an admin, or the owner while it isn't a benchmark **and nobody else has ticked it** (since 8 Nov 2026; WITH CHECK keeps the row the owner's). **db/39's guards** (`problems_guard_owner_edit`, `circuits_guard_owner_edit`, BEFORE UPDATE) refuse, with `42501`, any change by a non-admin API caller outside the editable columns (problems: name, grade, the three hold columns, `feet_mode`, `feet_holds` (db/41); circuits: name, grade, `hold_sequence`, `start_count`, `loops`), compared as jsonb minus those keys, so a column added later is locked by default. Once benchmarks became the only source of points, an owner re-grading their own benchmark through the API would have been a direct route to points, hence the lock. The trigger `problems_guard_curation` (db/25) pins `is_benchmark`, `stars` and the `setter` snapshot for non-admin API callers, on INSERT as well. It's SECURITY INVOKER and keys off `current_user in ('anon','authenticated')`, so the SQL editor and service role are never restricted.
- **Row checks (db/29, 19 Sep 2026).** RLS decides *who* may write a row; these CHECKs decide *what* may go in, so a scripted API call can't bypass the app's rules. `problems`: `grade` in the Font ladder or `Project`; `name` 1–60 characters after trimming; `finish_hold` and every start and intermediate a `holdN` id, with 1–2 starts. `circuits`: `grade` in the sport ladder; the same name rule; `hold_sequence` all `holdN` ids and longer than `start_count` (which db/14 already limits to 1–2). A violation returns `23514`. "At least one intermediate" is *not* enforced, because one live problem has none. The tick/like/circuit-like policies all carry `WITH CHECK (user_id = auth.uid())`. **When a ladder changes in `state.js`, change the CHECK too**, or saves of the new grade fail.
- `profiles` (db/30): no INSERT through the API (only the sign-up trigger creates profiles); users UPDATE only `username` and `is_public` on their own row, via column grants. **`is_admin` can't be written through the API.** Guests can't read it at all. Every new or changed `username` goes through the `profiles_nickname_guard` trigger (→ `nickname_check()`), plus the `profiles_nickname_format` CHECK.
- `auth.users` (db/30): the `auth_users_placeholder_only` trigger refuses any email that isn't `u-<16 base32>@users.invalid` and any phone number, so no real contact detail can be stored, even through `updateUser`.

**Functions** (all `SECURITY DEFINER`, all with `search_path = public` pinned):
- `is_admin()`
- `admin_list_users()`: returns `id, username, is_admin, is_public, created_at, route_count, tick_count` (no email since db/30). The app caches it for 60 s (`ADMIN_USERS_TTL`), and the reload button shows on the user list and on each user's screen. Deleting a user also invalidates the leaderboard.
- `admin_user_activity(target)`, `admin_rename_user(target, new_name)` (admins may use reserved words), `delete_my_account()` (refuses only the last admin), `admin_revoke_sessions(target)` (**service_role only**: the Edge Function), all db/30.
- `nickname_problem(n)` (anon + authenticated, the app's live check) over `nickname_check(n, ignore_id)` (no API access): returns NULL or one of `length`, `chars`, `contact`, `reserved`, `offensive`, `taken`. The same codes come back as the message of a refused save (SQLSTATE `23514`).
- `login_email(nick)` (anon): the placeholder email for a nickname, never a real one. `setter_names()` (anon): nicknames of accounts that set something.
- `problem_tick_counts()` (db/38): `(problem_id, climbers)`, distinct users with a tick on each problem, aggregate only, callable by anon; SECURITY DEFINER for the ticks RLS. The list's Popular sort (§4.2a); `privacy.html` says so.
- `problem_has_other_ticks(pid)`: signed-in users only. It has to be SECURITY DEFINER because ticks RLS hides other users' rows. The db/25 delete policy and the db/39 update policy use it, and so does the app before it offers Edit or Delete to an owner.
- `circuit_has_other_logs(cid)` (db/39): the same for `circuit_logs` (another climber's run); the circuits update policy and the app's circuit Edit use it.
- `admin_delete_user(target)`: refuses yourself and other admins; writes the nickname onto their problems and circuits first (db/30).
- `admin_set_admin(target, make_admin)`: refuses changing your own flag. Both log to `admin_actions`.
- `admin_problem_move_counts(pid)` → `(ticks, favourites)` and `admin_move_problem_to_circuit(pid, p_name, p_grade, p_sequence, p_start_count, p_loops)` → the circuit id (db/40, authenticated only, both check `is_admin()`, 42501 otherwise): Move to Circuits (§4.8c). Refusals: P0001 `not_found`, `benchmark`, `holds` (a feet sign); `23505` `name_taken` (ignoring case); the circuits CHECKs give `23514`.
- `challenge_leaderboard(cid)`, `challenge_compare(cid, uids)` (anon + authenticated) and `admin_delete_attempt(aid)` (authenticated; checks `is_admin()`, logs): db/31, section 4.6a.
- `leaderboard()`: granted to `anon`. Since db/30 it lists only climbers with `is_public`, ranked among themselves (`listed = true`), plus the caller's own row if they're hidden (`listed = false`, `rank` NULL).
- `wall_create_problem(p_key, p_name, p_grade, p_starts, p_ints, p_finish, p_feet, p_feet_holds default '{}')` (anon + authenticated, db/35, db/41): the wall screen's Create. Checks the wall key (`wall_key_valid`, no API access), the name (1–60 of the wall keyboard's characters, unique ignoring case, no blocked word via `problem_name_offensive`, no API access), the grade, the holds (1–2 starts, 1+ intermediates, one finish, none twice, all `hand` holds in the `holds` table, so never the feet signs or a foothold, the finish in the top 25% of the hand holds' y span and no start there), the feet rule (`specific` needs 1–30 footholds; any other rule drops `p_feet_holds`) and a rate limit (6 in 10 min, 30 a day); stores the holds inverted as `saveProblem` does, as setter "The Hangout" with no owner. Refusals are SQLSTATE P0001 with a code: `key`, `rate`, `name`, `name_taken`, `offensive`, `grade`, `holds`, `feet`. `wall_key_ok(p_key)` (anon) says whether a key works.
- `handle_new_user()`: the sign-up trigger (section 6).
- `problems_guard_curation()`: a trigger function; this one is *not* a definer function.

The admin functions re-check `is_admin()` internally, so client-side `.admin-only` hiding is UX only.

**Storage:** a public bucket `board` (5 MB limit; png/jpeg/webp only). Public read, admin-only write.

**Changing the schema:** don't, without Ross asking (a working rule). Scripts live in local `db/`, numbered and idempotent, and are applied by hand. For a full review there's direct Postgres access: the `db/.env` → `SUPABASE_DB_URL` session pooler, via `pg8000` in Python.
- Parse the URL by splitting on the **last** `@`, and don't regex-strip quote characters: the password contains one.
- Retry transient `28P01` errors on connect.
- Default to read-only.

## 6. Auth

**Nickname + PIN accounts** (db/30, `pb-v108`; PINs since 2 Nov 2026). Under-18s use the app, so an account holds no personal data: no email, no real name, no photo. **Google sign-in, email sign-up and password reset are gone.** Accounts made before 2 Nov 2026 have a four-word passphrase and keep it; nobody is moved to a PIN and no switch is offered.

**Create an account** (`#auth`, the default mode; `#auth/signin` opens Sign in; `account.js`). One step: a **nickname** ("Use a nickname, not your real name"; **Suggest one**, `NICK_ADJ` × `NICK_ANIMAL`, e.g. `Crimpy_Otter`; a live check, `nickChecker()` → `nickname_problem()`), a **4-digit PIN** and the PIN again (`type="password"`, `inputmode="numeric"`, digits only, at most 4; "✓ PINs match" or "The two PINs don't match" once both are full), Turnstile, then **Create account**. What's wrong is said on submit rather than by a button that won't press. The signed-out Profile leads with **Create an account**, then "I already have an account".

**The PIN as Supabase sees it:** Supabase Auth won't take a 4-character password (this project's minimum is 15; Supabase's floor is 6), so the app sends `pinPassword(pin)` = `'symmetryboard-pin-' + pin` (22 characters). The padding is public and adds no secrecy: 10,000 PINs, with **no lockout, rate limit or weak-PIN blocking, by design** (Ross, 2 Nov 2026: a small gym, no personal data). Turnstile on sign-in is the only brake. **Keep `pinPassword()` in step between `account.js` and the Edge Function.** No Auth setting changed for it.

Behind the scenes: `signUp({ email: 'u-<16 base32>@users.invalid', password: pinPassword(pin), options: { data: { nickname, pin: true }, captchaToken } })`. `pin: true` in `user_metadata` marks a PIN account for the admin reset; a user could change their own metadata, and the only effect would be getting a PIN rather than words from a reset. `.invalid` never receives mail, and nothing is ever sent: **Confirm email, reset and every security notification must stay off** (Supabase only checks an address's format at sign-up; its domain/MX checks run only when mail is sent; audit §10a). The trigger `handle_new_user()` (db/30) validates the nickname and inserts the profile with **no** `on conflict`, so a clash fails the whole sign-up; Supabase shows only "Database error saving new user", so the app asks `nickname_problem()` why.

**Keep in sync:** the placeholder pattern lives in `account.js` (`PLACEHOLDER_DOMAIN`, `placeholderEmail()`) and in db/30 (`auth_users_placeholder_only()`, `login_email()`).

**Sign-in:** nickname + one secret field ("PIN (or passphrase)") + Turnstile. `login_email(nick)` → `signInWithPassword`. `signInSecret()`: exactly 4 digits (spaces ignored) is a PIN and goes through `pinPassword()`; anything else is a passphrase, normalised as before (lower case, spaces/underscores → hyphens). A passphrase is always words, so the two can't collide. An unknown nickname and a wrong PIN or passphrase get the same message.

**iPhone Safari note:** on the sign-in and create screens, in iPhone Safari only (not Chrome/Firefox/Edge on iPhone or in-app browsers) and only when `navigator.standalone === false`: *"Adding this to your Home Screen? You'll need to sign in once more inside the app, just once."* (an installed iPhone app has its own storage). Dismissed for good with × (`pb-ios-signin-note-dismissed`, through `lsGet`/`lsSet`).

**Turnstile** (Cloudflare's robot check): Supabase's CAPTCHA protection covers **password sign-in as well as sign-up** (GoTrue only skips it for refresh, PKCE and id-token grants), so both modes carry it. The site key is in `account.js` (`TURNSTILE_SITE_KEY`, public); the secret key lives only in the Supabase dashboard. The script loads only when `#auth` opens. CSP: `script-src` and `frame-src https://challenges.cloudflare.com`.

**Forgotten PIN or passphrase:** an admin opens the account (`#admin/user/<id>`), checks its **recent activity** with the person, and taps **Give a new PIN**. That calls the Edge Function `admin-reset-passphrase` with the admin's own session; it checks the caller is an admin, reads the account's `user_metadata` (read only): `pin: true` gets a new 4-digit PIN (stored as `pinPassword()`), anything else four new EFF words (`eff_large_wordlist.ts`, from `tools/make_wordlist.py`) as before. It deletes the account's sessions (signed out everywhere; an access token already issued lasts up to an hour), logs `reset_passphrase` (for both), and returns `{ passphrase, kind: 'pin' | 'passphrase', signedOut }` **once**; the sheet says "New PIN for X" or "New passphrase for X". The service-role key exists only inside the function. Deploy: `npx supabase functions deploy admin-reset-passphrase --project-ref uqirowyfqwiceyjznosl --use-api` (Verify JWT stays on).

**Profile:** the nickname (Change nickname, the same rules), **Show me on Ranks** (default off; covers Ranks only, setter names are always shown), points, ticks, hardest send, Sign out, and **Delete my account and all my data** (`delete_my_account()`: account, ticks, favourites and points go; problems and circuits stay with the nickname; the last admin is refused).

**Session state:**
- `session`, `profile` (`id, username, is_admin, is_public`), `authReady` (in `state.js`); `authMode` (`'signup'` or `'signin'`). The PINs typed live only in the fields, cleared on switching mode; a service-worker update waits while a PIN is typed on Create.
- `onAuthStateChange` reloads the profile, ticks and faves on every event, and clears them on sign-out (with the cached admin member list).
- **Sign-out is this device only** (`signOut({ scope: 'local' })`, Ross, 19 Sep 2026). supabase-js drops the local session even if the server call fails, so `doSignOut` judges success by whether a session is left.
- **An admin write that RLS refuses** (an Edit: no error, 0 rows) shows an error and calls `recheckAdmin()`, which re-reads the profile so a demoted admin loses the admin controls without a reload.
- The `onAuthStateChange` callback itself is synchronous (since `pb-v102`): it ignores `INITIAL_SESSION` and `TOKEN_REFRESHED`, and hands every other event to `onAuthChanged()` on a `setTimeout(…, 0)`, because supabase-js holds its auth lock while the callback runs.

**The admin model:**
- Admin = `profiles.is_admin`. Set it in the SQL editor, or in-app through `admin_set_admin`. **Nobody can promote themselves.**
- Admins can rename anyone (`admin_rename_user`, reserved words allowed), give a new PIN or passphrase (the Edge Function), promote/demote and delete members. **Every one of those is logged** in `admin_actions` (`select * from admin_actions order by created_at desc;` in the SQL editor; there's no in-app viewer).
- Admins bypass the geofence. **On staging too, which shares the live DB.**
- "Add user" in the Supabase dashboard no longer works (it sends no nickname). Accounts only come from the app.

**Supabase Auth config** (dashboard, plan.md manual step 7): Email provider on, **Confirm email off**, minimum password length 15, Google off, sign-ups on, anonymous sign-ins off, manual linking off, security notifications off, CAPTCHA on (Turnstile secret). Site URL `https://symmetryboard.co.uk`.

## 7. Service worker and caching (`sw.js`; `CACHE` stamped by `build.sh` since 29 Oct 2026)

| Request | Strategy |
|---|---|
| Navigation to `/` or `/index.html` (any query) | network-first with a 5 s deadline (`NAV_TIMEOUT`); a plain same-origin 200 is cached **under `./`**; offline or past the deadline → the cached `./` |
| Other pages (`privacy.html`) | network-first, cached under their own URL; offline, `/privacy` also tries `privacy.html` |
| JS, CSS, JSON incl. `manifest.json` (matched by extension too, because WebKit leaves `destination` empty) | network-first with a 3 s deadline (`ASSET_TIMEOUT`), falling back to the cache. **Once anything on a page has come from the cache, the rest of that page's files do too** (`fallbackClients`, keyed by client id), so one load never mixes old and new scripts. With no cached copy, the network gets as long as it needs |
| Everything else same-origin (icons, `board-fallback.jpg`) | stale-while-revalidate |
| Cross-origin (Supabase, Cloudflare analytics) | not intercepted |

- **Precache:** the `ASSETS` list goes through `precache()`, which re-wraps any redirected response as a plain copy. Cloudflare 307s every `*.html` to its extensionless form, and **a cached redirect can't answer a navigation.** Only plain same-origin 200s are ever cached. The shell is **never** cached under `./index.html`.
- **Updates:**
  - **`CACHE` is stamped by the build** (29 Oct 2026; it was bumped by hand, `pb-v1`…`pb-v119`, before). `app/sw.js` holds `const CACHE = 'pb-local'`, which local preview uses as is; `build.sh` writes `pb-` + the first 10 hex of a SHA-1 over `git ls-tree HEAD` for the allowlisted files into `public/sw.js`, so the stamp changes on exactly the deploys that change a shipped file (a docs-only push keeps it, and line endings don't matter). `bash build.sh --stamp <ref>` prints what a commit gets; PB Console compares that for `origin/main` with the live `sw.js`. Code is network-first, so a fresh load gets the latest deploy anyway; the new stamp gives the new worker's precache one consistent version to fall back to, which the mixed-version guard above relies on.
  - **Already-open** clients get the update through the new stamp. A new worker → `skipWaiting` → `clients.claim` → the page's `controllerchange` → reload.
  - The reload is **deferred** while a create form or the outline editor has unsaved work (`hasUnsavedWork()`), and skipped on first install.
  - **It's also skipped when the page is already running the new code** (since `pb-v92`). The first launch after a deploy fetches the new code network-first, then finds the new worker, which claims the page. That used to reload it and play the splash a second time. A worker found while the page boots (`reg.installing`/`waiting` at registration, or `updatefound` until 3 s after the load's own `reg.update()` settles) doesn't reload, unless the old worker served any of the page from its cache: `sw.js` posts `pb-served-from-cache` to the client when a network-first fetch falls back. A worker found later (the app left open, then resumed) still reloads. Tested against a local copy by bumping `CACHE` between launches.
  - A change to `ASSETS` or the fetch logic is a change to `sw.js`, a shipped file, so it gets a new stamp too.
  - Registration uses `updateViaCache:'none'`, and `reg.update()` runs on load and on focus. `_headers` sets `/sw.js` and `/` to `no-cache`.
- **What works offline:** only the shell. Since `pb-v75`, `supabase-js` is vendored and precached, so an offline launch boots past the splash. But no problem data is cached, so the list can't load. Treat the precache as a speed-up, not an offline mode.
- **Stranded devices:** uninstalling the PWA doesn't clear its worker or caches. The fix is clearing site data (iOS: Settings → Safari → Advanced → Website Data; Chrome: Site settings → Clear & reset).
- **Test SW changes against a mock that reproduces Cloudflare's `.html` redirects**, then probe staging. Plain `python -m http.server` hides the redirect bugs.

## 8. External config inventory

| Service | What's configured | Notes |
|---|---|---|
| Cloudflare | Worker `projectboard` (git-connected, build `bash build.sh`, deploy `npx wrangler deploy`, non-production branch builds on); custom domain `symmetryboard.co.uk`; Registrar; Web Analytics (cookieless, auto-injected, so the CSP must allow its beacon); Email Routing `hello@symmetryboard.co.uk` → Ross's Gmail; `www` → apex redirect (done 10 Sep 2026) | ✅ **Always Use HTTPS** on (19 Oct 2026): `http://symmetryboard.co.uk` answers 301 → `https://` |
| Supabase | Project `uqirowyfqwiceyjznosl` (London): DB, Auth (nickname + PIN, older accounts a passphrase, on the Email provider with placeholder addresses, confirmation off, CAPTCHA via Turnstile), Storage `board`, Realtime, the Edge Function `admin-reset-passphrase` | ✅ db/30 + function live, CAPTCHA on, Google provider off (18 Oct 2026). Keep the Email provider on: the placeholder addresses run on it |
| Cloudflare Turnstile | Widget for the sign-in / sign-up robot check; site key `0x4AAAAAAFaUU-JF4RC7asVt` (public, in `account.js`); the secret key is only in Supabase | ✅ widget created 18 Oct 2026 |
| Google Cloud | The old Google sign-in OAuth client: **retired** with nickname accounts | ✅ client deleted (19 Oct 2026) |
| GitHub | Public repo `rlmck/projectboard`; Pages source = `legacy` / root | never delete `legacy`, never make the repo private, **never rename the repo** |

## 9. Build and deploy pipeline

1. **Ship by default** (CLAUDE.md working rule 2, 29 Oct 2026): work on `main`; when a task is done and `bash build.sh --check` passes, commit and push `main` (`/ship`, or PB Console's Ship). Cloudflare builds and promotes it to symmetryboard.co.uk.
2. **"Staging first":** push to `dev` only (`git push origin HEAD:dev`, a fast-forward). Cloudflare builds a preview version (uploaded, **not promoted**) at the stable alias `dev-projectboard.rosslewismckechnie.workers.dev`. Test on a real phone there. `dev` doesn't have to be level with `main`.
   - **Rollback** is `git revert` + push `main` (`/rollback`, or the console's Rollback), never the Cloudflare dashboard.
3. **The build** runs `build.sh` from the repo root. It's the **deploy gate**: any failed check exits non-zero, Cloudflare then skips the deploy, and the previous version stays live. The Workers Builds image has Node (24) and git.
   - **The checks** (`bash build.sh --check` runs only these): every allowlisted file exists; every file in `app/` is allowlisted and `app/` has no folder; every `sw.js` `ASSETS` entry ships; every shipped file is in `ASSETS` except `NOT_PRECACHED`; every shipped `.js`/`.css` is referenced from `index.html` or `privacy.html`; the app scripts, joined in `index.html`'s order, and `sw.js` pass `node --check`; `app/sw.js` holds the `pb-local` placeholder exactly once.
   - It then wipes `public/` and copies the **explicit allowlist** of files from `app/` into it, one-to-one (flat); anything unlisted never ships, even if it's in `app/`.
   - **It stamps `CACHE`** in `public/sw.js` (section 7). A local build with uncommitted `app/` changes gets `-dirty` on the end.
   - `wrangler.jsonc` sets `assets.directory: ./public`, with no `main` and no `not_found_handling`, so unknown paths get Cloudflare's blank 404. There's no custom 404 page.
   - **Preview locally** with `python -m http.server 8000` inside `app/`: it's the same tree as the site.
   - **Compare what Cloudflare would deploy** by building from a clean export: `git -c core.autocrlf=false archive HEAD` into a temp folder, then run `build.sh` there. The Windows checkout has CRLF line endings, so a build from the working tree doesn't match the live bytes (the stamp does: it comes from git's blob ids).
4. **The three-places rule:** a new deployable file lives in `app/`, and goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page). `build.sh` enforces it.
   - Exceptions, shipped but not precached (`NOT_PRECACHED`): `sw.js`, `_headers`, `_redirects`, `ProjectBoard.png`, `screenshot-*.png`.
   - A new PNG also needs a `.gitignore` `!app/…` exception.
5. **`_headers`:**
   - `no-cache` on `/sw.js` and `/`.
   - Site-wide: `nosniff`, `Referrer-Policy`, `Permissions-Policy: geolocation=(self)` (the geofence needs it), `X-Frame-Options: DENY`, HSTS (1 year), and a **Content-Security-Policy**.
   - The CSP allows scripts only from the site itself plus Cloudflare's analytics beacon, and network connections only to Supabase (https + wss) and the analytics endpoint.
   - It keeps `'unsafe-inline'` for styles only, because the overlays use `style="left/top"`. Images may come from the site and Supabase Storage (`blob:` went with the calibrate tool on 16 Sep 2026).
   - There are **no inline scripts or inline event handlers anywhere; keep it that way.**
   - **Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.**
   - Checked on 10 Sep 2026 by driving every view in headless Chrome with the policy enforced: zero violations.
6. **`_redirects`:** `/scan  /?src=qr  302`. The printed QR encodes `/scan`, so change its destination here, **never by reprinting**. Paths are case-sensitive.
7. **`.gitattributes`** pins `build.sh`, `app/_headers`, `app/_redirects`, `pi/**`, `console/**` and `.githooks/**` to LF, so Git Bash (and the Pi) can run them from a Windows clone.
   - **The pre-commit hook** (`.githooks/pre-commit`, on per clone with `git config core.hooksPath .githooks`) refuses service-role keys, `db/.env` values, `psk=`/`password=` lines with literal values, `secrets.env` and `pi/config.env`. `bash .githooks/test-pre-commit.sh` tests it with fake keys in a throwaway clone.
8. **Manifest screenshots are hand-captured** (`screenshot-list.png`, `screenshot-detail.png`), so they don't update with the app. Regenerate them when the list or detail view changes materially, or Android's install sheet shows a stale app. How they were made:
   - a local build, in headless Chrome with CDP mobile emulation at 412×915 CSS px and DPR 2 (so 824×1830);
   - as a guest, with the install banner suppressed (`pb-install-dismissed`);
   - then 256-colour quantized with Pillow. The detail shot is *Cool Curve*.

   Keep the `sizes` in `manifest.json` matching, and keep both shots the same size.
9. ⚠️ **Staging shares the live database.** Test problems, ticks and casts made there are real, and admins bypass the geofence. Clean up after yourself.

## 10. The `legacy` branch: why it must never be deleted

- **What it is:** an orphan branch holding `index.html` = `404.html` (a "Project Board has moved" page), a tombstone `sw.js`, `.nojekyll` and a README. GitHub Pages serves it at `rlmck.github.io/projectboard/`.
- **In a browser tab:** it `location.replace`s to the same path on `symmetryboard.co.uk` with `?src=moved`, keeping the `#hash`. An old shared `#detail/<id>` link still lands on that problem.
- **Inside an old installed app** (standalone): no redirect. A cross-origin jump from a standalone PWA opens a sheet that can't install, so it shows the moved screen with platform steps and Copy/Open. It has no manifest link, so the old origin can't be reinstalled.
- **The tombstone worker:**
  - It has the same name and scope as the old app's worker, so every old install picks it up on its next launch.
  - It deletes only `pb-v*` caches, because the github.io origin's CacheStorage is shared with Ross's other Pages sites. Its own cache is `pb-moved-v1`, deliberately not `pb-v…`.
  - After that, old installs show the moved screen even offline.
- **Why it stays forever:**
  - Old installs and old links (WhatsApp, bookmarks) keep pointing at github.io for years.
  - Delete the branch or disable Pages and those users get a GitHub 404, or a stale cached copy of the old app, with no way to find the new address.
  - Free Pages needs a **public** repo.
  - The github.io path follows the **repo name**, and `BASE = '/projectboard/'` is hardcoded in the page. **So renaming the repo breaks the redirect as well.**
- **Changing it:** push `legacy`. If github.io doesn't update, request a build with `gh api -X POST repos/rlmck/projectboard/pages/builds`, because a source change through the API doesn't trigger one.
- **If the app repo ever needs to go private:** rename it, and create a new tiny public `rlmck/projectboard` holding just the legacy content (rollout plan, Part C).

## 11. Tooling

All of these live in `tools/`. The Python scripts find their files relative to themselves, so they run from any directory (`python tools/make_qr.py`), and they read and write the bundled data in `app/`.

| Tool | Does | Needs |
|---|---|---|
| `snapshot_board.py` | **The board fallback.** Copies the live `board_config` (photo, hold map, mirror map, published outlines) into `app/` from one read, so the four always match; refuses if the published outlines belong to another board version. Run it after anything changes on the live board, then ship (the build re-stamps `CACHE`) | network, Pillow |
| `register_holds.py` | **Retired history.** Built the original fallback map on the old drawing (June 2026) by fitting Gareth's labelled layout onto Ross's 187 dots (`tools/hold_positions.json`). Now writes `tools/hold_map_drawing.json` (ignored), never `app/` | `reference/` (local) |
| `register_mirror.py` | **Retired history.** Gareth's `MirrorDic.txt` → a repaired table. The live table has since been edited, so it now writes `tools/mirror_map_gareth.json` (ignored), never `app/` | `reference/` |
| `register_shapes.py` | Auto-traces hold outlines from the **live** board (or, offline, the bundled snapshot) → `app/hold_shapes.json`; merges by default, `--overwrite` to replace. Writes a `tools/shapes_preview.png` (ignored). It writes the **file**, not the live copy: deploy it, then in the outline editor use ⋮ → *Load the shipped copy*, review, and Publish; then `snapshot_board.py` to refresh the fallback | network; run after every recalibration |
| `register_leds.py` | Gareth's wiring → `tools/led_map.json` (asserts all 247 cells) | n/a |
| `make_icons.py` | `app/icon.svg` geometry → 4 PNG icons in `app/` (Pillow). **The geometry is duplicated by hand**: keep it in step with `icon.svg` | Pillow |
| `make_qr.py` | `https://symmetryboard.co.uk/scan` → `print/qr-scan.svg` (level Q) | segno |
| `cast-test.html` (+ `.js`, `.css`) | The cast test bench. **Listener:** subscribes to `board:HangoutPortland` like the Pi and lists every `cast_problem` with its payload, so casts from a phone can be checked without the LEDs. **Run checks:** loads the local `app/` in an iframe, adds two fake problems (`~cast-test-A`/`-B`, names the Pi can't match), stubs the location check with a delay, and verifies what reaches the channel: plain and mirrored casts, a swipe or mirror flip during "Locating" sends nothing, tap-swipe-tap sends only the second, a double tap sends once, a failed send frees the button, and no socket is held open. The broadcasts are real, on the live channel. It unregisters the local service worker first | `serve.py` |
| `trace_score.js` | Scores `app/trace.js` against the hand-traced `app/hold_shapes.json` on `board-fallback.jpg`, traced at the setup flow's size: median IoU, the spread, missed, merged and extra shapes; `--opts` tries other settings, `--json` writes the shapes. Results in `docs/board-setup-plan.md` | Node, Python + Pillow |
| `holdedit_score.js` | Tests the hold editor's pure parts (`holdedit.js`, with `trace.js` and `setup.js`): +θ then −θ (two resamples, and a draft that nets to 0° = the original), the background fill on plain colours and across stripe edges, the mirror rule, hit-testing and the bounded Tap to trace beside a hand hold, the FTn names. `--image`/`--holds` for another board (e.g. the live one, local), `--feet` spots to tap, `--crops` before/after crops, `--payload` a publish payload | Node, Python + Pillow |
| `serve.py` | Serves the repo root on `localhost:8000` with `Cache-Control: no-store`. Plain `python -m http.server` lets the browser cache scripts heuristically, so a test run can use old code | Python |
| In-app `#outlines` | The hold-outline editor, built for a phone (Admin → Trace Holds; replaced both `#calibrate` and the desktop `trace_holds.html` on 16 Sep 2026). Header buttons: **zoom to this hold** and **Preview** (a toggle that draws every hold with core.js's own `holdShapeLayerHtml` while editing carries on, view and selection untouched; the note's Colour button cycles blue/green/red). Pinch to zoom (up to an 8000 px-wide board) and pan (one finger on empty board pans too); tap a hold to select it, double-tap to zoom to it; drag a point (a magnifier shows it above the finger); tap or drag the circle on an edge to add a point; drag inside to move the whole outline; a nudge pad moves the selected point, or the whole outline, by 0.05% (holding repeats). ⋮ menu: whole board, next hold with no outline, hide others, redraw, revert hold, load the shipped `hold_shapes.json`, discard all (undoable). Round slider = `__meta.smooth`. Edits are kept as a localStorage draft (`pb-outline-draft`, per board version) until published. **Publish** calls `admin_set_hold_outlines()` (db/42): each hand hold's `holds.outline`, the `board_config.hold_shapes` copy following (never `updated_at`). It refuses outlines whose `__meta.board_updated_at` doesn't match the live board. Desktop: wheel zoom, arrows nudge, Delete, ctrl+Z/Y, n/p, f, 0, right-click deletes a point | admin |

**Hold positions, the board photo and mirror pairs are edited through Board setup** (`#setup`, §4.8d, since 9 Nov 2026; single holds through its Edit holds since 10 Nov 2026; before that, not in the app at all since 16 Sep 2026). If the board is ever re-mapped (in the database), bumping `updated_at` drops every client to dots until the outlines are re-traced against it and published.

## 12. Known gaps (product, not bugs)

- **No self-service PIN or passphrase change or recovery.** By design (no email): a forgotten PIN or passphrase needs an admin (section 6), and if no admin can help, the account is gone. Email setup (Resend/SMTP) is no longer planned.
- **The geofence centre is unverified on-site.** If it's off by more than the radius, members standing at the wall get "Casting only works at the gym". Admins would never notice, because they bypass the gate. Verify it with a non-admin phone at the board.
- **`manifest.json` has `"orientation": "portrait"`.** On Android installs this locks portrait, so the landscape auto-fullscreen on detail views never fires there; the expand button still works. iOS ignores the manifest orientation.
- **Circuits Phase 3** (PBs, leaderboards from `circuit_logs`) isn't built. Mirrored circuits and a circuits Done filter are future releases. The Pat Burner challenge (section 4.6a) is phone-timed and doesn't use any of it.
- **Challenge scores are self-reported.** The database sets the total and range-checks the reps, but it can't know whether someone really held on; admins delete suspicious attempts (logged).
- **The setter can't be edited** (by design: Edit changes holds, name, grade and feet rule only, §4.8b).
- **No offline mode beyond the shell** (section 7).
- **The Supabase plan tier** isn't recorded anywhere. If it's Free, the project pauses after 7 days without API activity (e.g. a gym closure), and Realtime is capped at 200 concurrent connections. Since `pb-v99` the app holds no socket (casts are REST), so only the Pi uses one.

## 13. Known issues (bugs and debt)

Security findings are **not** listed here; they're in `docs/security-findings.md` (local). This list folds in the still-open items from the 2 July 2026 review, which it supersedes.

**Fixed on 10 Sep 2026.** `supabase-js` is vendored and pinned (it no longer loads from a CDN), a CSP and security headers were added, `trace_holds.html` is off the deploy, and the missing favicon is fixed (all SW `pb-v75`). Earlier the same day (DB changes live, SW `pb-v74`):
- the admin "Sends" stat always read 0;
- OAuth errors were dropped silently;
- the sign-up name clash and the email-prefix names;
- an owner could delete a problem others had ticked, or self-mark it as a benchmark;
- a problem delete blocked by RLS reported success;
- the first-run name modal had no autofocus.

**Medium**
- **An app from before 10 Nov 2026 doesn't know Specific feet** (`feetRule()` then read `specific` as Any): it shows such a problem as Any feet with no footholds, and its Edit would save `feet_mode: 'any'`, which `problems_guard_feet` turns into no footholds. The fix is the new app itself: JS is fetched network-first and the stamped `CACHE` reaches open clients, so only a phone that stays offline with the old version is affected, and only if its owner (or an admin) edits a Specific feet problem from it. Casting is unaffected (the Pi reads the row).
- **The create and circuit-create boards ignore taps** until `HOLD_MAP` arrives, which happens after the `board_config` round trip. There's no loading state.
- **`router()` side effects when data arrives** (section 4.3).

**Minor**
- **UI polish:**
  - The toast (z-index 200) renders behind modals (300).
  - Escape doesn't close the board-saved modal.
- **Correctness nits:**
  - `escAttr` doesn't escape `<`/`>`.
  - `loadHoldMap`/`loadMirrorMap` check their guard before the `await`. That's only safe because of the boot ordering.
  - The in-app **Copy link** drops the `#detail/…` hash.
- **Bundled data:**
  - The live mirror table differs from Gareth's in 5 entries (see §4.4). Worth checking mirrored casts on the wall; the Pi uses the same table.
- **Missing site polish:** no custom 404 page.
- **Duplication worth consolidating before the next board feature:**
  - three nearest-hold functions (`nearestHold`, `ccNearestHold`, `calNearest`);
  - five near-identical confirm modals;
  - the anon key and URL in `state.js` and (once rebuilt) the Pi listener;
  - the icon geometry in five places (`icon.svg`, `make_icons.py`, the poster, and the legacy `index.html`/`404.html`).

## 14. Rebrand checklist (the "Project Board" name and the logo)

The domain `symmetryboard.co.uk` doesn't contain the brand, so **a name change doesn't need a domain change** and the QR can stay.

**Renaming the app:**
1. `index.html`: `<title>`, `apple-mobile-web-app-title`, `og:site_name`, `og:title`, `og:image:alt`, splash (`<span class="sn-a">Project</span> <span class="sn-b">Board</span>`), welcome title, the "Open Project Board from your home screen" note, the install-banner text.
2. `manifest.json`: `name`, `short_name`.
3. `app.js`: the `?src=moved` welcome title (`'Project Board<span> has moved here</span>'`).
4. `privacy.html`: `<title>`, meta description, header, and two body mentions.
5. `print/poster.html` (3 strings), then **reprint the poster** (same QR).
6. Google Auth Platform app name (re-verification if the brand was verified); `sw.js`/file-header comments; CLAUDE.md and docs.
7. **Leave the `legacy` page as "Project Board has moved"**: that's the name old users know.
8. **Installed apps:**
   - Android picks up the new manifest name and icon over a few days, possibly with an update prompt.
   - **On iPhone the home-screen name and icon are fixed at install**, so people keep the old ones until they delete and re-add the app.

**Changing the logo:**
1. Edit `icon.svg` **and** the duplicated geometry in `make_icons.py`, then run `make_icons.py` (it rewrites 4 PNGs).
2. Update the inline copies in `print/poster.html`. The legacy page's copy can stay.
3. If the colour changes: `--accent`/`--accent-hover` and the `--accent-aNN` alpha variants in `tokens.css`, `PINK` in `make_icons.py`, the poster CSS, and `theme_color`/`background_color` if the dark ground changes.
4. `og:image` points at `icon-maskable-512.png`, so it updates by itself.
5. Ship: icons are stale-while-revalidate, and the new `CACHE` stamp (the build's, since the icons changed) pushes them to installed clients.
6. Regenerate the manifest screenshots if they show the old mark.

**Don't rename, as part of a rebrand:**
- **the GitHub repo** (it breaks the github.io redirect, section 10);
- the manifest `id` (it creates a second app identity, so Android users get duplicates);
- the `pb-` localStorage keys (the welcome would reappear for everyone);
- the Worker name `projectboard` (it changes the staging URL, so the Supabase redirect list and docs would need updating, for no user-visible gain);
- `ProjectBoard.png` / `board-fallback.jpg` and the internal identifiers.

**If the *domain* ever changes, it's a full migration like this one:**
- a new origin, so everyone reinstalls;
- a second redirect site;
- update the legacy `NEW_ORIGIN`, the OG URLs, the QR (reprint), Supabase's Site URL and redirect list, Email Routing, the privacy page and Google branding.

## 15. Gotchas you'd otherwise rediscover

- **`.icon-btn { display:flex }` beats the browser's `[hidden]` rule**, so every hideable icon button needs an explicit `#id[hidden]{display:none}` guard.
- **Cloudflare 307s `/x.html` → `/x` and `/index.html` → `/`.** Links to `privacy.html` work; just never cache or precache a redirect.
- **The hold outlines are useless after the board is re-mapped** until they're re-traced; the version stamp enforces this, for the published copy as much as the bundled one.
- **The live board image is `board.jpg` in Storage**, not the bundled PNG. The two are framed differently: never mix the live map with the bundled image, or the other way round.
- **Supabase errors:**
  - `23505` = duplicate; toggles treat it as success, creates as "name taken".
  - `42501` = RLS denial. It's raised when a *new* row fails a policy check (an insert, an upsert, or an update's `WITH CHECK`). An update or delete whose `USING` clause hides the row raises nothing and just returns 0 rows.
- **Admin status is cached** in `profile` for the session; a demoted admin keeps the admin UI until they reload.
- **Supabase auth storage is keyed by project ref** (`sb-uqirowyfqwiceyjznosl-auth-token`), not by domain. Moving origin logs everyone out, which is why the move needed "sign in again".
- **The staging URL contains the Worker name.** Renaming the Worker breaks the Edge Function's CORS for staging (its `ALLOWED_ORIGINS`) and Turnstile there (the widget's hostname list).
- **Nickname errors arrive as SQLSTATE `23514` with the bare code** (`taken`, `offensive`…) as the message; `nickSaveError()` maps them. A sign-up refused by the database only says "Database error saving new user".
- **`sb.functions` is a getter** in supabase-js: it returns a new client each time, so stub `Object.getPrototypeOf(sb.functions).invoke` when testing, not `sb.functions.invoke`.
- **Pages builds:** a Pages source change through the GitHub API doesn't trigger a build; request one explicitly.
- **`docs/` is gitignored** except `rollout-plan.md` and this file. Anything else you write there stays local.

## 16. How this file relates to CLAUDE.md

On 11 Sep 2026 CLAUDE.md was cut from 96 KB to rules and pointers. The history it carried went to the local `docs/changelog.md`, the DB script list to `db/README.md`, and the schema, data model and auth detail are here. CLAUDE.md keeps only the working rules, the invariants that must not break, and the data traps. When you change something this file describes, update this file; add to CLAUDE.md only if it's a new rule or a new trap.
