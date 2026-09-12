# Project Board: codebase overview

**Written 10 September 2026**, from a full read of the code plus read-only checks against the live Supabase database. It's the architecture reference for any new session: what the pieces are, how they fit, and what you'd otherwise have to rediscover.

**Which document wins:**
- **Hosting, rollout and install flow:** `docs/rollout-plan.md`.
- **Working rules** (dev → staging → merge on approval, one feature per session, no schema changes without asking): `CLAUDE.md`.
- **Architecture, data model, auth, caching, deploy mechanics and known issues:** this file. Where it disagrees with CLAUDE.md about the database, this file was checked against the live DB and CLAUDE.md wasn't. The discrepancies are listed at the end.
- **Security findings:** `docs/security-findings.md`. It's **local only and never committed**, because the repo is public. If you don't have it, you're not on Ross's laptop; ask before touching RLS, grants, casting or sign-up.
- **Also local only, on Ross's laptop:** `docs/changelog.md` (the feature-by-feature history that used to fill CLAUDE.md), `docs/project-notes.md` (hardware, the Pi, the original DTB system, the Circuits Phase 2 spec) and `db/README.md` (the index of every DB script).

---

## 1. What it is

A PWA for the symmetry board at The Hangout, Portland (near Weymouth, UK). The board is a wooden wall with 189 real holds on a 19 × 13 grid (A–S × 1–13), each with an LED behind it. Climbers use the app to:
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
     │                             Postgres + RLS · Auth (Google, email) · Storage bucket "board"
     │
     └──Realtime broadcast────▶ channel board:HangoutPortland, event cast_problem
                                     │
                                     ▼
                         Raspberry Pi 3B, pi/board_listener.py (local, gitignored)
                           reads the problem's holds from the problems table
                           → WS2801 LED strip over SPI

 rlmck.github.io/projectboard ── GitHub Pages ◀── legacy branch (moved page + tombstone SW)
```

There is **no server code**:
- The front end is static files.
- Every privileged action is gated in Postgres, by RLS and by `SECURITY DEFINER` functions that check `is_admin()`.
- The Pi is a plain Realtime subscriber that uses the public anon key.

## 3. Repository map

Since 11 Sep 2026 the tracked files are grouped by what they are:

```
app/       the website: exactly the files that are deployed, flat (every URL stays at the site root)
tools/     generators and dev tools, never deployed
print/     the A5 poster and QR, never deployed
docs/      two committed docs (the rest of docs/ is local only)
build.sh  wrangler.jsonc  CLAUDE.md  .gitignore  .gitattributes   (the repo root)
```

`app/` is flat on purpose. `sw.js` must be served from `/` to control the whole app, the manifest, icons and `/privacy` are referenced by absolute URL from outside (the `og:image`, Google's sign-in branding), and `build.sh` copies `app/` into `public/` one-to-one. Don't add subfolders inside `app/`: that changes live URLs. The move from the root into `app/` changed no deployed byte (checked by hashing the build before and after).

| Path | What | Deployed? |
|---|---|---|
| `app/index.html` | All markup: splash, welcome overlay, 11 view `<section>`s, 9 modals, nav, install banner, toast | yes |
| `app/styles.css` | All styling (dark theme, `--accent: #ec4899`) | yes |
| `app/state.js` … `app/app.js` | The nine app scripts (section 4) | yes |
| `app/sw.js`, `app/manifest.json` | Service worker, PWA manifest | yes |
| `app/privacy.html` | Static privacy page; keep its claims true | yes |
| `app/supabase-js-2.116.0.js` | **Vendored, pinned** `supabase-js` (npm `dist/umd/supabase.js`, verified against the registry hash). Loaded before `state.js`; defines the global `supabase` | yes (and precached) |
| `app/ProjectBoard.png` | Bundled **fallback** board image (2.1 MB; the live image is in Supabase Storage) | yes |
| `app/hold_map.json` | Fallback hold → `{x,y}` % map (188 holds; lacks `hold218`) | yes |
| `app/mirror_map.json` | Fallback hold → mirror-partner map | yes |
| `app/hold_shapes.json` | Traced hold outlines (189), tied to one board version. **Fallback** since db/28: the live copy is `board_config.hold_shapes` | yes |
| `app/icon*.png`, `app/apple-touch-icon.png`, `app/icon.svg` | Icons (PNGs generated by `tools/make_icons.py`) | yes |
| `app/screenshot-*.png` | Manifest install-sheet screenshots, hand-captured | yes (build only, not precached) |
| `app/_headers`, `app/_redirects` | Cloudflare static-asset config (section 9); they must sit in the assets directory | yes |
| `build.sh`, `wrangler.jsonc`, `.gitattributes` | Hosting config (section 9). The first two stay at the root: the Cloudflare dashboard runs `bash build.sh` and `npx wrangler deploy` from there | no |
| `tools/register_holds.py`, `register_mirror.py`, `register_shapes.py`, `register_leds.py` | Generators for the JSON data (section 11) | no |
| `tools/trace_holds.html` | Dev tool for viewing and hand-editing the hold outlines; run it locally (section 11) | no (removed from the deploy on 10 Sep 2026) |
| `tools/hold_positions.json` | Input to `register_holds.py` (Ross's 187 hand-placed dots) | no |
| `tools/led_map.json` | Hold → physical LED index; the Pi wiring contract. The app never reads it | no |
| `tools/make_icons.py`, `tools/make_qr.py` | Icon generator, QR generator | no |
| `print/` | The A5 poster and its QR | no |
| `CLAUDE.md`, `docs/rollout-plan.md`, `docs/codebase-overview.md` | Docs | no |

Local only (gitignored), on Ross's laptop:
- `db/`: numbered SQL scripts 01–27, applied by hand in the Supabase SQL editor, indexed in `db/README.md`, plus `db/.env` holding the direct-Postgres URL and the service key. **Never print or commit that file.**
- `pi/`: the board listener, its systemd unit, a smoke test, `clear_strip.py`, and `problems.csv` (Gareth's problem list, the input to db/03).
- `docs/*`: `changelog.md`, `project-notes.md`, `CC_Reference_Gareth_Code.md`, `hardware/` photos, and `security-findings.md`.
- `reference/original-pi-codebase/dtb/`: Gareth's original DTB code, extracted from his SD card. `tools/register_holds.py` and `tools/register_mirror.py` read `dtb/SettingsFolder/holdlist.csv`, `dtb/SettingsFolder/MirrorDic.txt` and `dtb/dicholdlist.txt` from it by path, so it stays where it is.
- `.claude/settings.local.json`: Claude Code's per-machine settings.
- **Archived outside the repo** in `Documents\ProjectBoard-archive\` (see its `README.txt`); nothing depends on any of it:
  - since 11 Sep 2026: the 31 GB image of Gareth's SD card, the reverse-engineering of the DTB app, and unused source art;
  - since the 11 Sep 2026 folder tidy: the rest of the SD card's boot partition (kernels, firmware, overlays, `.dtb` files; 37 MB) that used to sit in `reference/original-pi-codebase/`, and the old LED test scripts that were in `pi/archive/`.
- `.gitignore` also ignores `*.png`, so **every committed PNG needs a `!` exception** (they're written as `!app/…`).

## 4. Front end

### 4.1 Nine classic scripts, one global scope
Load order, set in `index.html`: **`state` → `core` → `problems` → `admin` → `account` → `authoring` → `circuits` → `leaderboard` → `app`**, after the vendored `supabase-js-2.116.0.js`.

**Upgrading `supabase-js`:**
1. Download the new version's `package/dist/umd/supabase.js` from the npm tarball, and check the tarball against the registry's `dist.integrity`.
2. Save it as `app/supabase-js-<version>.js` with the licence header.
3. Update the three places, bump `CACHE`, and test on staging.

Never go back to a floating CDN URL: the CSP also blocks it.

These are plain `<script>` tags, not ES modules. There's no build step and no framework, and every top-level `let`/`const`/`function` is visible to every file. Consequences:
- **A name may be declared only once across all nine files.** Check with `cd app && cat state.js core.js … app.js > ../all.js && node --check ../all.js` (then delete `all.js`).
- **Order matters for top-level code.** Function bodies can reference later files; top-level statements can't.
- **Symbols don't always live where you'd expect.** Grep across all `.js` before adding one. Traps:
  - `isAdmin`, `circuitName`, `circuitSeq`, `canEditCircuit` and `circuitsTableMissing` are at the bottom of `authoring.js`.
  - `rpcMissing` (in `admin.js`) is also used by `leaderboard.js`.
  - `gradeTabButtons` (in `problems.js`) is used by circuits and authoring.
- **A new file goes in `app/` and in three places:** the `index.html` script order, the `build.sh` allowlist and the `sw.js` `ASSETS`.
- **Don't convert to ES modules** without being asked. That's a working rule.

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel; grade ladders (`GRADE_ORDER`, `SPORT_GRADE_ORDER`, `gradeRank`, `fontGrade`); **all shared mutable state** (`allProblems`, `session`, `profile`, `HOLD_MAP`, `myTicks*`, filters, create/circuit state, leaderboard cache) |
| `core.js` | Escaping, toast, name/setter/search helpers, hold order + role classification, dot and shape overlays, `boardPct` hit-testing, fullscreen controller, **routing** (`parseHash`, `setView`, `router`, `goBack`) |
| `problems.js` | Problem list/filters/cards, detail, swipe, info modal, **geofence + `castByName`**, board data loaders (`loadBoardConfig`, `loadHoldMap`, `loadMirrorMap`, `loadHoldShapes`), problem loading, tick button, admin delete + grade edit |
| `admin.js` | `#admin` hub: user list/detail, promote/demote, delete user (RPCs) |
| `account.js` | Ticks, favourites, filter-pill sync, **auth** (`initAuth`, email, Google, sign-out), display-name modal, profile page |
| `authoring.js` | Create/edit problem (tap-to-cycle roles, finish zone, invert-on-save), the calibrate tool (anchor/fit/nudge/add/mirror, **Save board**), circuit helpers |
| `circuits.js` | Circuits list, detail, the Play-preview engine, create, delete |
| `leaderboard.js` | `#leaderboard` view; `userPoints()` for the profile |
| `app.js` | **Loaded last.** All event wiring, service-worker registration and update handling, the install flow (welcome overlay + banner), and **boot** |

### 4.2 Boot sequence (end of `app.js`)
1. `hashchange` → `router`, then `router()` once for the initial view.
2. Start these in parallel:
   - `loadProblems()`: re-runs `router()` when data lands, so a cold `#detail/<id>` deep link renders.
   - `loadCircuits()`
   - `loadProfileNames()`: the id → username map behind live setter names.
   - `loadBoardConfig()`, **then** `loadHoldMap()` + `loadMirrorMap()`. They run in sequence so the bundled fallbacks never overwrite the live map.
   - `loadHoldShapes()` and `measureBoardAspect()`.
   - `initAuth()`.
3. The splash fades after 1.8 s.

Nothing blocks on the network before first paint, so the list shows its spinner straight away.

### 4.3 Routing
Hash routing; `router()` switches on `parseHash()` (`route/param`).

| Hash | View | Notes |
|---|---|---|
| `#list` (default) | problem list | grade tabs (tap = single, hold = multi-select), search, 3 filter pills |
| `#detail/<id>` | problem detail | board overlay, tick/fave/mirror/cast, ⋮ menu (Edit: admin; Delete: admin or the problem's owner; Information: everyone); swipe = next/prev in the filtered deck, via `replaceState` |
| `#create` / `#create/<id>` | create / admin edit-holds | guests bounced to `#auth`; non-admins bounced off `/<id>` |
| `#calibrate` | recalibrate board | admin |
| `#admin`, `#admin/users`, `#admin/user/<id>` | admin hub drill-down | admin |
| `#circuits`, `#circuit/<id>`, `#circuit-create` | circuits | create needs sign-in |
| `#leaderboard` | ranks | public |
| `#auth`, `#profile` | sign-in, profile | bottom nav hidden on `#auth` |

**Route guards only bounce once `authReady` is true.** Before that, a cold deep link is let through, and `initAuth` re-runs `router()` once the session is known.

⚠️ **`router()` doubles as the "data arrived, re-render" hook.** Loaders call it, and so does `refreshBoardViews()`. It has side effects: `setView` exits fullscreen and closes the info modal, and the `auth` case resets the form to sign-in. Prefer calling the specific render function over `router()` when adding a loader.

### 4.4 The board overlay pipeline
Four inputs, each with a live source and a fallback:

| Input | Live source | Fallback | Global |
|---|---|---|---|
| Board image | `board_config.image_path` → Storage URL `…/board/<path>?v=<updated_at>` | `ProjectBoard.png` (different framing) | `BOARD_IMG` |
| Hold positions | `board_config.hold_map` (189 holds) | `hold_map.json` | `HOLD_MAP` (+ `configHasMap`) |
| Mirror pairs | `board_config.mirror_map` | `mirror_map.json` | `MIRROR_MAP` (+ `configHasMirror`) |
| Hold outlines | `board_config.hold_shapes` (db/28) | `hold_shapes.json` | `HOLD_SHAPES` (+ `configHasShapes`) |
| Hold outlines | none (bundled only) | none | `HOLD_SHAPES` |

Positions are **percentages of the image**, so the overlay scales with it. The render helpers are in `core.js`:
- **Dot overlay:** `boardOverlayHtml`.
- **Shape overlay:** `holdShapeLayerHtml`. It draws each hold as its traced polygon; on detail it dims the rest of the board with an SVG mask, on create it doesn't.
- **Shapes are traced against one specific board.** Both copies record it in `__meta.board_updated_at` (currently `2026-06-22T14:43:27.113+00:00`). `shapesUsable()` draws them **only** when `configHasMap` is true and the version matches. Any recalibration (which bumps `updated_at`) drops everyone back to dots until the outlines are re-traced against the new board and published. **Publishing must write `hold_shapes` alone and never touch `updated_at`** — bumping the version would retire the very outlines being published.
- **Mirroring** is a lookup table, not grid arithmetic: the board is hand-set and staggered. 11 holds are self-mirror, including `hold218`/I12, which has no real partner.
- `boardPct()` turns a tap into board percentages, taking rotated fullscreen into account. All three interactive boards use it.

### 4.5 Problems: storage quirks you must know
- **Holds are stored INVERTED.** The migration wrote `start_holds`/`finish_hold` back to front. The true order is `[finish_hold, ...intermediate_holds, ...start_holds]`: the first two are starts (green, low), the last is the finish (red, high). Use `problemHoldOrder()` + `classifyHolds()`.
  - `saveProblem` inverts on the way back in, so reads and writes share one scheme.
  - A lone start is duplicated so there are always two start entries.
  - The Pi listener does the same un-invert.
  - Fixing this for good means a data migration **plus** a Pi change in lockstep.
- **Names are UNIQUE and are the cast key.** The Pi looks a problem up by `problem_name`. Names are stored clean (no embedded grade), and grade edits never touch the name.
- **Grades are stored lowercase** (`5, 5+, 6a … 8a`) and **displayed** capitalised via `fontGrade()`. Unknown grades sort last: 2 problems are graded `Project`.
- **Circuits use a separate lowercase sport ladder** (`4, 5a … 8b`), are **not** capitalised, and are stored in **natural order** (not inverted). A circuit is one ordered `hold_sequence` with duplicates allowed, plus `start_count` (1–2) and `loops`.
- **Board orientation:** row 1 (A1 = `hold1`) is at the **bottom**. `holdN` → grid is row-major: `hold1`=A1, `hold19`=S1, `hold20`=A2, `hold247`=S13.
- **Create rules:**
  - The top 25% of the board, by hold y-span on the live map, is the finish zone: no starts, one finish, other holds allowed.
  - Everywhere else holds cycle start (the first two) → hold → off.
  - A problem needs 1–2 starts, at least one intermediate and exactly one finish.
- **The setter shown** is resolved live: `setter_id` → `profiles.username`. Migrated rows (no owner) and orphaned rows fall back to the `setter` text snapshot. Circuits have no snapshot, so an orphaned circuit shows "unknown".

### 4.6 Ticks, favourites, points
- **Ticks** are private per user and orientation-aware. The key is `(user_id, problem_id, mirrored)`, and the detail tick toggles whichever orientation is showing.
  - `myTicks` = sent either way; `myTicksNormal`/`myTicksMirrored` = each side.
  - **Exclude Done** hides problems sent both ways.
- **Favourites:**
  - Problems use the old `likes` table; circuits use `circuit_likes`.
  - Toggles are optimistic, and a duplicate insert error (`23505`) counts as success.
- **Points** come only from the `leaderboard()` RPC (db/27), the single source of truth. **Only benchmark problems score** (Ross, 11 Sep 2026):
  - base = grade index × 10 (`5` = 10 … `8a` = 150);
  - +50% of base once if the benchmark was sent both ways;
  - a non-benchmark scores 0. The old +50% benchmark bonus went with db/27.

  Only climbers with points are listed, and "sends" counts benchmark sends. Points are worked out live, so marking a problem a benchmark scores its existing ticks straight away, and unmarking it takes them back. The profile's "Total points" reads the caller's own row back from the RPC. `leaderboardLoaded = false` invalidates the cache after ticks, grade/hold edits, benchmark toggles and deletes.
- **Benchmarks:** high-quality problems that are accurate at their grade.
  - Only admins mark them: the "Mark as benchmark" / "Remove benchmark" item in the detail ⋮ menu (`toggleBenchmark` in `problems.js`). It isn't offered for an ungraded problem (`Project`).
  - They show a gold disc with a star cut out (`benchMarkSvg()` in `core.js`) on list cards and in the detail badge, and there's a Benchmarks filter pill.
  - Admin Edit on a benchmark warns in the edit chooser that it changes everyone's points.
  - Owners lose Delete on their own problem once it's a benchmark (db/27 enforces it).
- **Circuits have no completion logging yet.** That's Phase 2. The circuits "Exclude Done" pill is deliberately inert.

### 4.7 Casting
`castByName(name, btn, mirror)` in `problems.js` is the only cast path.
1. **Geofence** (`ensureCastLocation`; centre and radius in `GYM_GEOFENCE`). A nudge for honest users, not access control: it's deliberately lenient, so it never blocks someone at the wall because of a poor GPS fix, and admins bypass it. The exact rules are in the code.
2. **Broadcast:** `channel.send({type:'broadcast', event:'cast_problem', payload:{problem_name, mirror?}})` on `board:HangoutPortland`.
   - The channel is created with `broadcast.ack`, and anything but `'ok'` shows "Cast failed".
   - The ack means **the Realtime server** got it, not the Pi. There's no end-to-end confirmation.
3. **The Pi** (`pi/board_listener.py`, local):
   - It subscribes with the anon key and looks the name up in `problems`.
   - It applies the mirror table and un-inverts, then lights green starts, blue intermediates and a red finish.
   - LED index = column-major serpentine (`led_map.json` / `register_leds.py`).
   - When the listener is rebuilt, feed it the **live** mirror map (`board_config.mirror_map`), not Gareth's raw `MirrorDic.txt`.
   - As of June 2026 the software was verified up to the data leg, and the physical LED output was being debugged as a hardware fault. Check `docs/project-notes.md` for the current state.

Nothing records casts in the database: the old `board_state` table was never used and was dropped in db/24. **Casting is open to guests by design** (decided 10 Sep 2026), with the geofence kept as the gate.

### 4.8 Fullscreen board
- **Implementation:** CSS pseudo-fullscreen, because iOS has no element Fullscreen API. Body classes `board-fs`/`board-fs-rotated` switch it on. The active `.board-wrap` becomes `position:fixed`, sized by the JS-computed `--fs-bw` variable, and the backdrop is a giant `box-shadow`.
- **Two ways in:**
  - The expand button → **rotated** landscape on any board.
  - Turning a touch device to landscape → **natural** fullscreen, on the two detail views only.
- **Details:** a wake lock is held while fullscreen is open. The width/max-width rules are `!important` to beat the detail views' ID-specificity rules.

### 4.9 The install flow (welcome overlay)
`installContext()` returns `standalone | in-app | ios | android-prompt | desktop`.
- **When the welcome shows:** mobile browsers only (never standalone or desktop), on a first visit (`pb-welcome-seen` unset) or with `?src=qr` / `?src=moved`.
- **What happens to `?src`:** it's read and then stripped with `replaceState`. OAuth params and the hash survive.
- **Android:** one `beforeinstallprompt` is shared by the welcome's Install button and the small banner (`promptInstall()`).
- **iOS:** share-sheet steps.
- **In-app browsers:** "open in Safari/Chrome" plus Copy link.
- **localStorage keys:** `pb-welcome-seen`, `pb-install-dismissed`, plus the Supabase session. **Don't rename these**: renaming the welcome key shows the welcome to every existing user again.

## 5. Data model (live, 10 Sep 2026)

RLS is **enabled on every public table**, and it does the row-level gating. Since db/24 (10 Sep 2026), `anon` is read-only on every table, and TRUNCATE/TRIGGER/REFERENCES/MAINTAIN are revoked from the API roles. That includes the default privileges for tables `postgres` creates later, so a new table's grants won't match the old ones: grant what it needs explicitly.

| Table | Purpose | Key facts |
|---|---|---|
| `problems` | boulder problems | `name` UNIQUE; holds stored inverted; `setter_id` → auth.users **ON DELETE SET NULL** (routes outlive accounts); `setter` text snapshot; `is_benchmark`, `stars` (both admin-curated, guarded by trigger), `comment`, `feet_mode` (always `any`) |
| `ticks` | sends | UNIQUE `(user_id, problem_id, mirrored)`; cascades from both user and problem; `attempts/notes/grade_vote/stars` unused |
| `likes` | problem favourites | PK `(user_id, problem_id)`; own rows only |
| `circuits` | circuits | `name` UNIQUE; `hold_sequence text[]` in natural order; `start_count`, `loops`; `setter_id` SET NULL |
| `circuit_likes` | circuit favourites | own rows only |
| `circuit_logs` | Phase-2 completion logs | own insert/select; empty |
| `profiles` | public identity | `id` = auth.users.id (CASCADE); `username` unique (also case-insensitively); `is_admin` (guests can't read it) |
| `board_config` | the live board | one row, `wall='HangoutPortland'`: `hold_map`, `mirror_map`, `hold_shapes`, `image_path`, `updated_at`; public read, admin write |
| `holds`, `sessions` | vestigial | empty (`board_state` was dropped in db/24) |

**Policies in short:**
- Public read on `problems`, `circuits`, `profiles`, `board_config`.
- Own-rows-only on `ticks`, `likes`, `circuit_likes`, `sessions`.
- Insert-as-yourself (`setter_id = auth.uid()`) on `problems` and `circuits`.
- Owner-or-admin update/delete on `circuits`.
- `problems` DELETE (db/25, db/27): **an admin, or the owner while it isn't a benchmark and nobody else has ticked it**. The owner's own ticks don't count.
- `problems` UPDATE (db/27): an admin, or the owner while it isn't a benchmark. The app only offers editing to admins. Once benchmarks became the only source of points, an owner re-grading their own benchmark through the API would have been a direct route to points, hence the lock. The trigger `problems_guard_curation` (db/25) pins `is_benchmark`, `stars` and the `setter` snapshot for non-admin API callers, on INSERT as well. It's SECURITY INVOKER and keys off `current_user in ('anon','authenticated')`, so the SQL editor and service role are never restricted.
- `profiles`: users can INSERT only `id`+`username` and UPDATE only `username`, via column grants. **`is_admin` can't be written through the API.** Guests can SELECT only `id, username, created_at`.

**Functions** (all `SECURITY DEFINER`, all with `search_path = public` pinned):
- `is_admin()`
- `admin_list_users()`: returns `id, username, email, is_admin, created_at, route_count, tick_count`. `tick_count` was missing until db/12 step 2 was re-applied on 10 Sep 2026.
- `problem_has_other_ticks(pid)`: signed-in users only. It has to be SECURITY DEFINER because ticks RLS hides other users' rows. The db/25 delete policy uses it, and so does the app before it offers Delete to an owner.
- `admin_delete_user(target)`: refuses yourself and other admins.
- `admin_set_admin(target, make_admin)`: refuses changing your own flag.
- `leaderboard()`: granted to `anon`.
- `handle_new_user()`: the sign-up trigger (section 6).
- `problems_guard_curation()`: a trigger function; this one is *not* a definer function.

The admin functions re-check `is_admin()` internally, so client-side `.admin-only` hiding is UX only.

**Storage:** a public bucket `board` (5 MB limit; png/jpeg/webp only). Public read, admin-only write.

**Changing the schema:** don't, without Ross asking (a working rule). Scripts live in local `db/`, numbered and idempotent, and are applied by hand. For a full review there's direct Postgres access: the `db/.env` → `SUPABASE_DB_URL` session pooler, via `pg8000` in Python.
- Parse the URL by splitting on the **last** `@`, and don't regex-strip quote characters: the password contains one.
- Retry transient `28P01` errors on connect.
- Default to read-only.

## 6. Auth

**Sign-in methods:**
- **Google OAuth.** `signInWithOAuth({provider:'google', options:{redirectTo: location.origin + location.pathname}})`.
  - supabase-js v2's default **implicit** flow returns tokens in the URL hash.
  - `initAuth()` calls `getSession()` to consume them, then `location.replace('#list')`.
  - `parseHash()` never routes to an `access_token`/`error=` hash.
  - A failed sign-in comes back with `error`/`error_description` in the hash (or the query string). `takeOAuthError()` in `account.js` strips it and shows "Sign-in failed: …". It used to be dropped silently.
- **Email + password.** Email confirmation is **off**, and there's **no forgot-password flow** (section 12).

**Profile creation:**
- A Postgres trigger on `auth.users` (`on_auth_user_created` → `handle_new_user()`, db/26) inserts the `profiles` row at sign-up. The username is a placeholder: `climber-` + the first 8 hex characters of the user id. The insert is `on conflict do nothing`, so a clash can never block a sign-up; it just leaves the user with no profile.
- `loadProfile()` → `needsDisplayName()` treats **a placeholder name or a missing profile** as "no name chosen". Either way it opens the **mandatory** name modal: no Cancel, no Escape, and the field starts empty. `saveDisplayName()` then UPDATEs the placeholder row, or INSERTs if there was none, and refuses names that look like placeholders.
- The placeholder pattern is duplicated in `PLACEHOLDER_NAME` in `account.js` and in db/26. **Keep the two in sync.**
- Before 10 Sep 2026 the trigger used the email prefix. That blocked sign-up whenever two prefixes matched, and made part of the email address the user's public name.
- Users rename themselves from Profile.

**Session state:**
- `session`, `profile`, `authReady` (in `state.js`).
- `onAuthStateChange` reloads the profile, ticks and faves on every event, and clears them on sign-out.
- It currently runs its awaits inside the callback, and re-runs on `INITIAL_SESSION` and `TOKEN_REFRESHED` (see the known issues).

**The admin model:**
- Admin = `profiles.is_admin`.
- Set it in the Supabase dashboard, or in-app through `admin_set_admin`. **Nobody can promote themselves.**
- Promotion takes effect server-side immediately; the promoted user sees the admin UI on their next load.
- Admins bypass the geofence. **On staging too, which shares the live DB.**

**Supabase Auth config** (dashboard):
- Site URL `https://symmetryboard.co.uk`.
- Redirect URLs: `https://symmetryboard.co.uk/**`, the staging URL, and `http://127.0.0.1:8123/**` (added 12 Sep 2026, for Google sign-in in `tools/trace_holds.html`, which `trace.cmd` serves on that port). github.io was removed on 10 Sep 2026.

**Google Auth Platform:** app name "Project Board", published. Brand verification is optional.

## 7. Service worker and caching (`sw.js`, `CACHE = 'pb-v78'` on 11 Sep 2026)

| Request | Strategy |
|---|---|
| Navigation to `/` or `/index.html` (any query) | network-first; a plain same-origin 200 is cached **under `./`**; offline → the cached `./` |
| Other pages (`privacy.html`) | network-first, cached under their own URL; offline, `/privacy` also tries `privacy.html` |
| JS, CSS, JSON (matched by extension too, because WebKit leaves `destination` empty) | network-first, falling back to the cache |
| Everything else same-origin (icons, `ProjectBoard.png`, manifest) | stale-while-revalidate |
| Cross-origin (Supabase, Cloudflare analytics) | not intercepted |

- **Precache:** the `ASSETS` list goes through `precache()`, which re-wraps any redirected response as a plain copy. Cloudflare 307s every `*.html` to its extensionless form, and **a cached redirect can't answer a navigation.** Only plain same-origin 200s are ever cached. The shell is **never** cached under `./index.html`.
- **Updates:**
  - Code is network-first, so a fresh load always gets the latest deploy with no cache bump.
  - To reach **already-open** clients, bump `CACHE`. A new worker → `skipWaiting` → `clients.claim` → the page's `controllerchange` → reload.
  - The reload is **deferred** while a create form has unsaved work (`hasUnsavedWork()`), and skipped on first install.
  - Bump `CACHE` whenever `ASSETS` or the fetch logic changes.
  - Registration uses `updateViaCache:'none'`, and `reg.update()` runs on load and on focus. `_headers` sets `/sw.js` and `/` to `no-cache`.
- **What works offline:** only the shell. Since `pb-v75`, `supabase-js` is vendored and precached, so an offline launch boots past the splash. But no problem data is cached, so the list can't load. Treat the precache as a speed-up, not an offline mode.
- **Stranded devices:** uninstalling the PWA doesn't clear its worker or caches. The fix is clearing site data (iOS: Settings → Safari → Advanced → Website Data; Chrome: Site settings → Clear & reset).
- **Test SW changes against a mock that reproduces Cloudflare's `.html` redirects**, then probe staging. Plain `python -m http.server` hides the redirect bugs.

## 8. External config inventory

| Service | What's configured | Notes |
|---|---|---|
| Cloudflare | Worker `projectboard` (git-connected, build `bash build.sh`, deploy `npx wrangler deploy`, non-production branch builds on); custom domain `symmetryboard.co.uk`; Registrar; Web Analytics (cookieless, auto-injected, so the CSP must allow its beacon); Email Routing `hello@symmetryboard.co.uk` → Ross's Gmail; `www` → apex redirect (done 10 Sep 2026) | ⬜ **turn on SSL/TLS → Edge Certificates → Always Use HTTPS**: `http://symmetryboard.co.uk` still serves the site over plain HTTP (no service worker, no geolocation) |
| Supabase | Project `uqirowyfqwiceyjznosl` (London): DB, Auth (Google + email, confirmation off, built-in SMTP), Storage `board`, Realtime | ⬜ custom SMTP + "Confirm email" (section 12, Email setup) |
| Google Cloud | Google Auth Platform OAuth client (used by Supabase), branding "Project Board", privacy URL, published | ⬜ check sign-in on production, including from an iPhone home-screen install |
| GitHub | Public repo `rlmck/projectboard`; Pages source = `legacy` / root | never delete `legacy`, never make the repo private, **never rename the repo** |

## 9. Build and deploy pipeline

1. **Work on `dev`** → push. Cloudflare builds a preview version (uploaded, **not promoted**) at the stable alias `dev-projectboard.rosslewismckechnie.workers.dev`. Test on a real phone there.
2. **Merge `dev` → `main` only when Ross approves.** Cloudflare builds and promotes it to symmetryboard.co.uk.
3. **The build** runs `build.sh` from the repo root:
   - It wipes `public/` and copies an **explicit allowlist** of files from `app/` into it, one-to-one (flat); anything unlisted never ships, even if it's in `app/`.
   - A listed file that's missing fails the build, so Cloudflare deploys nothing and the previous version stays live.
   - `wrangler.jsonc` sets `assets.directory: ./public`, with no `main` and no `not_found_handling`, so unknown paths get Cloudflare's blank 404. There's no custom 404 page.
   - **Preview locally** with `python -m http.server 8000` inside `app/`: it's the same tree as the site.
   - **Compare what Cloudflare would deploy** by building from a clean export: `git -c core.autocrlf=false archive HEAD` into a temp folder, then run `build.sh` there. The Windows checkout has CRLF line endings, so a build from the working tree doesn't match the live bytes.
4. **The three-places rule:** a new deployable file lives in `app/`, and goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page).
   - Exception: `screenshot-*.png` are build-only.
   - A new PNG also needs a `.gitignore` `!app/…` exception.
5. **`_headers`:**
   - `no-cache` on `/sw.js` and `/`.
   - Site-wide: `nosniff`, `Referrer-Policy`, `Permissions-Policy: geolocation=(self)` (the geofence needs it), `X-Frame-Options: DENY`, HSTS (1 year), and a **Content-Security-Policy**.
   - The CSP allows scripts only from the site itself plus Cloudflare's analytics beacon, and network connections only to Supabase (https + wss) and the analytics endpoint.
   - It keeps `'unsafe-inline'` for styles only, because the overlays use `style="left/top"`. Images may come from the site, Supabase Storage and `blob:` (calibrate's preview).
   - There are **no inline scripts or inline event handlers anywhere; keep it that way.**
   - **Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.**
   - Checked on 10 Sep 2026 by driving every view in headless Chrome with the policy enforced: zero violations.
6. **`_redirects`:** `/scan  /?src=qr  302`. The printed QR encodes `/scan`, so change its destination here, **never by reprinting**. Paths are case-sensitive.
7. **`.gitattributes`** pins `build.sh`, `app/_headers` and `app/_redirects` to LF, so Git Bash can run `build.sh` from a Windows clone.
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
| `register_holds.py` | Built the **backup** map `app/hold_map.json` (June 2026): fits Gareth's labelled layout onto Ross's 187 unlabelled dots (`tools/hold_positions.json`) and labels each dot. A one-off: the live map is edited with `#calibrate`, and a re-run reproduces the committed file byte for byte (including the `hold243` → `hold242` fix, now in the script's `SAME_HOLD`). Its header explains it in plain English | `reference/` (local) |
| `register_mirror.py` | Gareth's `MirrorDic.txt` → `app/mirror_map.json` (repairs one 4-hold knot). Its input path was wrong (`dtb/dtb/…`) until 11 Sep 2026; re-running it now reproduces the committed map exactly | `reference/` |
| `register_shapes.py` | Auto-traces hold outlines from the **live** board → `app/hold_shapes.json`; merges by default, `--overwrite` to replace. Writes a `tools/shapes_preview.png` (ignored). It writes the **file**, not the live copy — open the editor and Publish to push the result live | network; run after every recalibration |
| `trace_holds.html` | Viewer + precision editor for the hold outlines. Draw mode appends points; Edit mode drags vertices, inserts one by dragging the **+** that appears on a hovered edge, right-click deletes one, arrows nudge by 0.05%/0.5%/0.01%, and the selected vertex's X/Y can be typed in. Wheel zooms at the cursor, space-drag pans, `f` zooms to the current hold, and a loupe magnifies under the cursor. **Publish → live** (ctrl+shift+P) writes `board_config.hold_shapes` — one click, no commit or deploy; it signs in over raw Supabase Auth REST (once per browser, tokens in `localStorage`), refuses to publish outlines traced against a different board, and checks the returned row count because an RLS-blocked PATCH looks like a success. The counter measures against the **live** copy when there is one, else the file (`Revert hold` puts one back). **Export JSON** / **Link file…** still maintain `app/hold_shapes.json`, the shipped fallback. Autosaves to localStorage. **Not deployed** (F11): double-click `tools/trace.cmd`, or serve the **repo root** yourself and open `/tools/trace_holds.html` (it fetches `../app/…`) | a local http server; an admin sign-in to publish |
| `trace.cmd` | Double-click launcher for the editor: starts `python -m http.server 8123` at the repo root (reusing one that's already up) and opens the page | Windows, Python |
| `register_leds.py` | Gareth's wiring → `tools/led_map.json` (asserts all 247 cells) | n/a |
| `make_icons.py` | `app/icon.svg` geometry → 4 PNG icons in `app/` (Pillow). **The geometry is duplicated by hand**: keep it in step with `icon.svg` | Pillow |
| `make_qr.py` | `https://symmetryboard.co.uk/scan` → `print/qr-scan.svg` (level Q) | segno |
| In-app `#calibrate` | Recalibrate the board from a phone: upload a photo, anchor 3+ holds, Fit (least-squares affine), Nudge, Add missing holds, fix Mirror pairs, **Save board** (publishes to `board_config`, live for everyone) | admin |

**After a recalibration**, overlays fall back to dots until someone re-traces the outlines against the new board and hits **Publish** in the editor. The "Board saved" modal says so.

## 12. Known gaps (product, not bugs)

- **Password reset and email confirmation are waiting on email setup.** Supabase's built-in mailer only delivers to project team members. The app side is built:
  - a "Forgot password?" link on sign-in, hidden while `PASSWORD_RESET_ENABLED = false` in `account.js`;
  - the "Set a new password" modal a reset link opens (always on);
  - `emailRedirectTo` on sign-up, so a confirmation link returns to the right site.

  Until the steps below are done, a user who forgets their password has to email Ross.

  **Email setup** (Ross does steps 1–4 and 6 in the dashboards; the code steps are 5 and 7):
  1. **Resend** (resend.com, free tier: 3,000 emails/month): add the domain `symmetryboard.co.uk`, region **EU (Ireland)**. Let Resend configure Cloudflare DNS automatically, or add the records it lists: DKIM on `resend._domainkey`, SPF + MX on the `send` subdomain. They don't touch the apex MX that Email Routing uses. Wait for "Verified".
  2. **Resend → API Keys:** create a key with *sending access* for that domain only.
  3. **Supabase → Authentication → Emails → SMTP Settings → enable custom SMTP:**
     - sender `noreply@symmetryboard.co.uk`, name `Project Board`;
     - host `smtp.resend.com`, port `465`;
     - username `resend`, password = the API key.
  4. **Supabase → Authentication → Emails → Templates:** brand the "Reset password" and "Confirm signup" emails (subject and body say Project Board).
  5. **Code:** set `PASSWORD_RESET_ENABLED = true`, add Resend (EU) to the processors in `privacy.html`, bump `CACHE`. Then on staging, request a reset for a non-team address and complete it.
  6. **Supabase → Authentication → Sign In / Providers → Email → turn on "Confirm email".** Existing accounts are already marked confirmed.
  7. Merge to `main`, and update this section.

  Dashboard menu names drift; the settings themselves are standard.
- **The geofence centre is unverified on-site.** If it's off by more than the radius, members standing at the wall get "Casting only works at the gym". Admins would never notice, because they bypass the gate. Verify it with a non-admin phone at the board.
- **`manifest.json` has `"orientation": "portrait"`.** On Android installs this locks portrait, so the landscape auto-fullscreen on detail views never fires there; the expand button still works. iOS ignores the manifest orientation.
- **Circuits Phase 2 isn't built:** casting, countdown, `circuit_logs`, and wiring up the circuits "Exclude Done" pill. Phase 3 (circuit leaderboards) isn't built either.
- **Problem name/setter editing isn't built** (admins can edit holds and grade).
- **No offline mode beyond the shell** (section 7).
- **The Supabase plan tier** isn't recorded anywhere. If it's Free, the project pauses after 7 days without API activity (e.g. a gym closure), and Realtime is capped at 200 concurrent connections. Every open app holds one socket for the cast channel.

## 13. Known issues (bugs and debt)

Security findings are **not** listed here; they're in `docs/security-findings.md` (local). This list folds in the still-open items from the 2 July 2026 review, which it supersedes.

**Fixed on 10 Sep 2026.** `supabase-js` is vendored and pinned (it no longer loads from a CDN), a CSP and security headers were added, `trace_holds.html` is off the deploy, and the missing favicon is fixed (all SW `pb-v75`). Earlier the same day (DB changes live, SW `pb-v74`):
- the admin "Sends" stat always read 0;
- OAuth errors were dropped silently;
- the sign-up name clash and the email-prefix names;
- an owner could delete a problem others had ticked, or self-mark it as a benchmark;
- a problem delete blocked by RLS reported success;
- the first-run name modal had no autofocus.

**High**
- **The admin user list is cached for the whole session**, and the reload button is hidden on the user-detail screen. So Routes set and Sends, now correct server-side, can still be stale until you go back to the list and reload.
- **The app sticks on the splash screen if `localStorage` access throws.** It's read unguarded at the top level of `app.js`, before boot. Some Android webviews have storage turned off, and so do browsers set to block site data. The `supabase-js`-from-a-CDN version of this hang was fixed on 10 Sep 2026 by vendoring the library.
- **Network-first fetches have no timeout.** On weak gym Wi-Fi (connected, barely working), loads hang instead of falling back to the cache. Race each fetch against about 3 s.

**Medium**
- **Auth runs its setup twice at startup** (`initAuth`, then `INITIAL_SESSION`), again on every hourly `TOKEN_REFRESHED`, and awaits inside `onAuthStateChange`, which Supabase warns can deadlock. Filter the events and defer the work with `setTimeout(…, 0)`.
- **`goBack()` uses `history.length > 1`**, so Back from a deep link opened in a tab with prior history leaves the app.
- **`parseHash()` calls `decodeURIComponent` unguarded.** A truncated shared link (`…%2`) throws on every navigation and leaves the app stuck.
- **The create and circuit-create boards ignore taps** until `HOLD_MAP` arrives, which happens after the `board_config` round trip. There's no loading state.
- **Calibrate seeds from whatever map is loaded.** If `board_config` failed and the fallback loaded, **Save board** publishes bundled-era positions over the live board.
- **The cast button** stays `disabled`/`.sent` for 2 s even after you swipe to the next problem. Worse, the name is captured at tap time, so a swipe during the up-to-6 s location wait casts the *previous* problem.
- **A deploy reload can wipe calibrate work.** `hasUnsavedWork()` covers the create forms but not calibrate: anchors, nudges, mirror edits and a picked image are all lost.
- **Writes blocked by RLS "succeed".** A blocked `delete()`/`update()` returns no error, just 0 rows, so the UI reports success. Problem delete now checks this. Grade edit, edit-holds and circuit delete still don't, which matters for an admin demoted mid-session. Add `.select()` and check the row count.
- **Deleting a user doesn't refresh the leaderboard.** `doDeleteUser` never sets `leaderboardLoaded = false`, and the cached admin user list (with emails) survives sign-out.
- **`router()` side effects when data arrives** (section 4.3).

**Minor**
- **UI polish:**
  - The toast (z-index 200) renders behind modals (300).
  - Escape doesn't close the edit-choice or board-saved modals.
  - Circuit grade tabs lose their scroll position on every keystroke.
- **Races:**
  - A fast double tap on tick or fave can leave the UI out of step with the DB; there's no in-flight lock.
  - Pressing Play during the 400 ms after a circuit preview finishes starts a run that's killed straight away.
- **Correctness nits:**
  - `escAttr` doesn't escape `<`/`>`.
  - `loadHoldMap`/`loadMirrorMap` check their guard before the `await`. That's only safe because of the boot ordering.
  - `doSignOut` ignores errors and uses the default *global* scope, which signs you out of every device.
  - The in-app **Copy link** drops the `#detail/…` hash.
- **Performance:** the hidden create/calibrate `<img>` tags download the 2.1 MB `ProjectBoard.png` on every first load, even when a live board exists. It's also precached. Convert it to WebP/JPEG, or set `src` lazily.
- **Stale or dead code:**
  - `holdChips()` is never called.
  - The "run db/NN in Supabase" messages will never fire now that every script is applied.
  - 8 of the 9 script headers omit `leaderboard.js` from the stated load order.
  - The bundled `hold_map.json` lacks `hold218` (I12). Neither of `register_holds.py`'s sources can place it, and no problem used it on 11 Sep 2026; the live map has it.
- **Missing site polish:** no custom 404 page.
- **Duplication worth consolidating before the next board feature:**
  - three nearest-hold functions (`nearestHold`, `ccNearestHold`, `calNearest`);
  - two copies of the circuit "by hold" overlay builder;
  - five near-identical confirm modals;
  - three optimistic-toggle functions;
  - the anon key and URL in `state.js`, `trace_holds.html` and the Pi listener;
  - the icon geometry in five places (`icon.svg`, `make_icons.py`, the poster, and the legacy `index.html`/`404.html`).

## 14. Rebrand checklist (the "Project Board" name and the logo)

The domain `symmetryboard.co.uk` doesn't contain the brand, so **a name change doesn't need a domain change** and the QR can stay.

**Renaming the app:**
1. `index.html`: `<title>`, `apple-mobile-web-app-title`, `og:site_name`, `og:title`, `og:image:alt`, splash (`Project<span> Board</span>`), welcome title, the "Open Project Board from your home screen" note, the install-banner text.
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
3. If the colour changes: `--accent`/`--accent-hover` in `styles.css`, `PINK` in `make_icons.py`, the poster CSS, and `theme_color`/`background_color` if the dark ground changes.
4. `og:image` points at `icon-maskable-512.png`, so it updates by itself.
5. Bump `CACHE`: icons are stale-while-revalidate, and the bump pushes them to installed clients.
6. Regenerate the manifest screenshots if they show the old mark.

**Don't rename, as part of a rebrand:**
- **the GitHub repo** (it breaks the github.io redirect, section 10);
- the manifest `id` (it creates a second app identity, so Android users get duplicates);
- the `pb-` localStorage keys (the welcome would reappear for everyone);
- the Worker name `projectboard` (it changes the staging URL, so the Supabase redirect list and docs would need updating, for no user-visible gain);
- `ProjectBoard.png` and the internal identifiers.

**If the *domain* ever changes, it's a full migration like this one:**
- a new origin, so everyone reinstalls;
- a second redirect site;
- update the legacy `NEW_ORIGIN`, the OG URLs, the QR (reprint), Supabase's Site URL and redirect list, Email Routing, the privacy page and Google branding.

## 15. Gotchas you'd otherwise rediscover

- **`.icon-btn { display:flex }` beats the browser's `[hidden]` rule**, so every hideable icon button needs an explicit `#id[hidden]{display:none}` guard.
- **Cloudflare 307s `/x.html` → `/x` and `/index.html` → `/`.** Links to `privacy.html` work; just never cache or precache a redirect.
- **The hold outlines are useless after a recalibration** until they're re-traced; the version stamp enforces this, for the published copy as much as the bundled one.
- **The live board image is `board.jpg` in Storage**, not the bundled PNG. The two are framed differently: never mix the live map with the bundled image, or the other way round.
- **Supabase errors:**
  - `23505` = duplicate; toggles treat it as success, creates as "name taken".
  - `42501` = RLS denial. It's raised when a *new* row fails a policy check (an insert, an upsert, or an update's `WITH CHECK`). An update or delete whose `USING` clause hides the row raises nothing and just returns 0 rows.
- **Admin status is cached** in `profile` for the session; a demoted admin keeps the admin UI until they reload.
- **Supabase auth storage is keyed by project ref** (`sb-uqirowyfqwiceyjznosl-auth-token`), not by domain. Moving origin logs everyone out, which is why the move needed "sign in again".
- **The staging URL contains the Worker name.** Renaming the Worker breaks staging Google sign-in until Supabase's redirect list is updated.
- **Pages builds:** a Pages source change through the GitHub API doesn't trigger a build; request one explicitly.
- **`docs/` is gitignored** except `rollout-plan.md` and this file. Anything else you write there stays local.

## 16. How this file relates to CLAUDE.md

On 11 Sep 2026 CLAUDE.md was cut from 96 KB to rules and pointers. The history it carried went to the local `docs/changelog.md`, the DB script list to `db/README.md`, and the schema, data model and auth detail are here. CLAUDE.md keeps only the working rules, the invariants that must not break, and the data traps. When you change something this file describes, update this file; add to CLAUDE.md only if it's a new rule or a new trap.
