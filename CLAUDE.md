# ProjectBoard — CLAUDE.md
## CC Project Bible · Read this at the start of every session

---

## What this project is

A PWA (Progressive Web App) to replace the Digital Training Boards (DTB) system at The Hangout climbing gym, Portland (near Weymouth, UK). The gym has a wooden symmetry board with 247 LED-lit holds. Users browse problems (climbing routes), cast them to the board (which lights up the holds via a Raspberry Pi), and tick them off when completed.

The app is hosted on **GitHub Pages** from the `main` branch.
**All work commits directly to `main`.** The app is not yet public — no users, no one knows the URL. Push freely and test on a real phone via the live GitHub Pages URL after each push.

---

## Build status (12 June 2026)

**Done:** problem list + grade tabs + search + cast (Supabase Realtime); **multi-select grade filters** (tap = switch to one grade, tap-and-hold = toggle into a multi-select; "All" clears); **detail view hold overlay** (a problem's holds lit on `ProjectBoard.png` via `hold_map.json`) with **swipe between problems** (respects active filters); **auth** — Google OAuth + email/password with a first-login display name (`profiles.username`, unique); **ticks** — signed-in users toggle a problem as sent (private per-user); code split into `index.html` / `app.js` / `styles.css`.

**Done (this session):**
- **Create-a-problem** — tap holds on the board (nearest-dot hit-testing) to build a route. **Tap-to-cycle**, no mode buttons. The board's **top 25% (by hold y-span) is the finish zone**: holds there cycle hold (blue) → finish (red) → off *while no finish is set yet*; once a finish exists, the other top-zone holds cycle hold (blue) → off only (no finish-stealing) and the finish hold itself clears red → off. **No starts** are allowed in the top zone; top-zone holds may be intermediates (so a route can traverse along the top with one designated finish). Every other hold cycles start (green, first two) → hold (blue) → off. Rules: 1–2 starts (a lone matched start is **duplicated** on save), ≥1 intermediate, exactly 1 finish. Name + grade only (no feet — no foot LEDs). Stored INVERTED to match migrated rows (see inversion note). Owner recorded in `problems.setter_id`.
- **Admin tools** (admins only, gated in Postgres via `is_admin()`): **delete a problem** (red bin) and **edit its grade** (pencil) from the detail header. Promotion is **manual** — flip `profiles.is_admin` in the Supabase dashboard.
- **Profile page** — edit display name; **Total ticks** + **Hardest send** (highest-grade ticked problem).
- **Live setter names** — a problem's displayed setter resolves from the owner's *current* `profiles.username` via `setter_id`, so a rename propagates to all their problems. Legacy/migrated rows (no owner) keep their text setter.
- **iOS safe-area fix** — the header reserves the notch/status-bar area (`env(safe-area-inset-*)`).

**Done (later, same build):**
- **Recalibrate-board tool** (`#calibrate`, admins only) — swap in a new board image and re-anchor the existing holds onto it without redoing the painful 187-dot placement / ICP labelling. The hold→dot *labelling* is frozen; only each hold's x/y % shifts when the image's framing/aspect changes. **Anchor** mode: tap a dot, tap its true spot, pin ≥3 spread-out holds, **Fit** solves a least-squares affine (saved positions → anchors) and snaps all holds at once; **Nudge** drags stragglers; **Add** places holds missing from the map. Entry point: a "Recalibrate board" button on the profile page (admins).
- **Phone-native board publishing** — **Change image…** uploads a new board photo straight from the phone to Supabase Storage (`board` bucket); **Save board** publishes the image + hold positions to `board_config`, live for everyone on next load (no git, no SW bump, no GitHub Pages rebuild). The app loads the board image + map from `board_config`, falling back to the bundled `ProjectBoard.png` + `hold_map.json`. Image is cache-busted on `updated_at` so a re-upload to the same object name is never stale. Admin-gated by RLS via `is_admin()`. Detail view now shows the board at its **true aspect ratio** (centred, not stretched) so a wide board reads as wide. **Two real holds were absent from the map — `hold218` (I12) and `hold243` (O13, top row); the Add mode is how they get placed back in.**

**Done (later, same build):**
- **Mirror toggle (detail view)** — the `<|>` button is now a **toggle** (not a fire-once cast): it flips the board overlay to the **left/right-mirrored** problem and lights up; the **Cast** button then casts whatever orientation is shown (sends `payload.mirror = true` when lit — same contract Gareth's DTB used: app declares intent, Pi applies the table). Resets to normal when you swipe/navigate to another problem. Mirroring is a **static lookup table** (`mirror_map.json`, hold id → partner), **not** grid arithmetic — the board is hand-set/staggered so an A↔S column flip is wrong (28 holds have no grid partner; the physical mirror of E1 is O2, not O1). `mirror_map.json` is generated by **`register_mirror.py`** from Gareth's hand-built, board-tested `MirrorDic.txt` (reference Pi codebase), converted into `holdN` space: 184/189 holds are a clean reciprocal involution and trusted as-is; the **only** repair is a 4-hold tangled knot in the dense E3/E4/O4/O6 region (43↔72, 62↔91, 81↔110), re-paired geometrically. **11 holds are self-mirror** (the J-column centre line + I7/J12/G13/H13, plus **I12/hold218 which has no real partner** — left in place when mirrored). Keyed by hold id, so it survives board recalibration. **⚠️ Pi caveat:** when the Pi listener is rebuilt, feed it **`mirror_map.json`** (our cleaned table), not the raw `MirrorDic.txt` — otherwise the 5 repaired holds cast wrong vs what the app shows.
- **Manual mirror-pair editor (calibrate, admins)** — a few mirror pairings are still wrong (only a human eyeballing the real board can tell a genuine error from a staggered-but-correct pairing). The calibrate page gained a **Mirror** mode: tap a hold to see its partner (amber dots = no mirror), tap the correct partner to repair, or tap the same hold again to set "no mirror". Edits stay a strict involution and publish to **`board_config.mirror_map`** on **Save board**, live for everyone (fallback: bundled `mirror_map.json`). Needs **`db/11`** (adds the `mirror_map` column). **Note:** a mirrored finish that *vanishes* (e.g. *P Didn't*) is usually **not** a mirror-table bug — it's that the partner hold (`I12`/hold218 or `O13`/hold243) still has **no position** in the map; place it via **Add**, then mirroring renders it.

**Done (this session):**
- **Admin hub (`#admin`)** — a dedicated admins-only view, reached from an **"Admin tools"** button on the profile page (the old "Recalibrate board" button now points here). Same route-guard pattern as `#calibrate` (bounces non-admins once auth is known). It's a **drill-down**, all under the one `#admin` view via the hash param: `#admin` = hub with two cards (**Recalibrate board** → the unchanged `#calibrate`; **Users**); `#admin/users` = the user list (each row a card linking to that user, **no inline delete**); `#admin/user/<id>` = one user's stats + the delete button. The header title + reload button update per sub-screen; back button walks the drill-down naturally. The contextual per-problem admin buttons (delete / edit-grade) stay inline on the detail header — they belong to a specific problem, not the hub.
- **View & delete users** — the user list shows each account (avatar, username, email, Admin badge); tapping one opens its detail (Role, Joined, Routes set, Sends, plus email). Delete lives on the **detail** screen, not the list. The anon key can't read other users' emails or delete an `auth.users` account, so both go through **SECURITY DEFINER RPCs** gated on `is_admin()`: `admin_list_users()` (returns email + route/tick counts) and `admin_delete_user(target uuid)`. The delete button is **hidden for yourself and for other admins** (UI rail, with an explanatory note); the RPC **also** refuses self-deletion and admin-deletion (demote in the dashboard first). On delete, the user's account/profile/ticks/likes cascade away but **their problems are kept** — `problems.setter_id` is `ON DELETE SET NULL`, so routes survive and fall back to the text setter snapshot. Needs **`db/12`** (FK behaviour + the two RPCs); the UI shows a clear "run db/12" message if the RPCs aren't deployed yet. ⚠️ **`db/12` gained a `tick_count` column + a `drop function` guard — re-run it** if you applied the first version.
- **Promote / demote admins in-app** — the user-detail screen has **Make admin** (members) / **Remove admin** (other admins) buttons, behind a confirm dialog. Reverses the old "dashboard-only promotion" stance but keeps the security: it goes through `admin_set_admin()` (db/13), gated on `is_admin()` and refusing self-changes, so **no self-promotion** and no in-app path to zero admins. Delete stays members-only (demote an admin first). Needs **`db/13`**. A newly-promoted user sees admin UI on their **next app load** (RLS grants the power immediately server-side). SW `pb-v29`.

**Done (this session) — Circuits, Phase 1:**
- **New `Circuits` entity + bottom-nav tab** (Problems · Circuits · Profile). A circuit is a long sport-style route: one **ordered hold sequence with duplicates allowed** (the same hold can be move 8 and 17), 1–2 **starts** (the first holds), one **finish** (the last hold), and an optional **loop** flag. Sport grades are a separate lowercase ladder (`4, 5a … 8b`). Stored in **natural climbing order — NOT inverted** (fresh table, no migration baggage; unlike `problems`).
- **`#circuits` list** — search + single-select sport-grade tabs; cards show name, grade, setter (live via `setter_id`), move count, loop badge. **`#circuit-create`** — tap holds in order (each tap appends; repeats allowed), ↩ undo / 🗑 reset, a 1/2 **start-count** segmented control, a **loop** toggle, name + grade. Names are unique (a circuit is cast by name). **`#circuit/<id>` detail** — board overlay with move-numbered dots + an in-app **Play preview**.
- **Play preview engine** — animates a **4-hold moving window** up the sequence (newest hold lights, oldest turns off). A **speed stepper** on the preview adjusts the interval in **0.1s steps (default 1.0s)**, applied live; speed is a preview/cast-time knob, **not stored per circuit** (per the agreed design). No move counter. For **loops**, the start holds glow green only on the **first lap** (blue after) and the finish reads **blue** (a loop has no real top); non-loop keeps green starts + red finish. **No real casting yet** (Phase 2). The same window logic will drive the Phase-2 cast-screen move timing.
- **Owner/admin delete** on the circuit detail header (RLS-gated). Needs **`db/14`** (the app shows a "run db/14" message until applied). SW `pb-v32`.

**Done (this session) — Favourites:**
- **Favourites (heart) on problems + circuits** — a signed-in user taps the heart on a climb to save it to a personal, **private** list (project board / "ones I like"). Same privacy + optimistic-toggle pattern as ticks. Hearts appear in three places per entity: **on each list card** (tap toggles without opening the item — `stopPropagation`), **in the detail header** (problem `#detail-fave` beside the tick; circuit `#circuit-detail-fave`), and as a **"favourites only" filter toggle** in each list's topbar (`#fave-filter` / `#circuit-fave-filter`, shown only when signed in). Guests tapping a heart get a "Sign in to save favourites" prompt → `#auth`.
- **Storage:** problem favourites reuse the previously-unused **`likes`** table (PK (user_id, problem_id); own-rows RLS already shipped in db/01 — **no DB change needed for problems**). Circuit favourites use a new **`circuit_likes`** table (db/15). Loaded into `myFaves` / `myCircuitFaves` Sets on auth (mirrors `myTicks`); cleared on sign-out; cascade-cleaned when a problem/circuit is deleted. Hearting a circuit before db/15 is applied shows a "run db/15" toast (problem favourites still work).
- **CSS gotcha fixed:** `.icon-btn { display:flex }` beats the bare `[hidden]` UA rule, so each hidden icon-button needs an explicit `#id[hidden]{display:none}` guard. Added guards for the new fave buttons **and** the pre-existing `#circuit-detail-delete` (which lacked one — its delete bin could show for non-owners). SW `pb-v33`.

**Done (this session) — Font grades for problems:**
- **Boulder problems now display as capitalised Font grades** (`5b+` → `5B+`, `7a` → `7A`). This is a **display-only** transform (`fontGrade(g)` = `toUpperCase`): the DB values, `GRADE_ORDER`, `gradeRank`, filter `data-grade`, and search all stay **lowercase** — so no data migration and no DB change. `gradeTabButtons` gained an optional label-formatter arg; problem tabs (filter/create/edit) pass `fontGrade`, circuit tabs don't. **Circuits are unchanged** (lowercase French sport grades). SW `pb-v34`. See the Grade ordering section.

**Done (this session) — code-review fixes (from `review_output.md`):**
- **Cast now reports failure honestly** (review C1) — channel created with `broadcast: { ack: true }`; `castByName` checks `send()`'s status and treats non-`'ok'` as a failure (red "Cast failed" toast). Previously success was reported even on a dead socket. See the Cast payload "Reliability" note. SW `pb-v38`.
- **SW update no longer wipes an in-progress create form** (review S1) — the `controllerchange` auto-reload now defers (`hasUnsavedWork()` / `pendingReload`) while `#create`/`#circuit-create` has unsaved content, applying once the user leaves the form or refocuses clean; also suppresses the reload on first install (removes the first-run flash). SW `pb-v38`.
- **Name decoupled from grade** (review S2) — verified all 267 names are stored clean; `displayName` no longer strips the grade and grade-edit never touches the name (so editing a climb's grade can't alter its name; e.g. "It's a 5" stays intact). SW `pb-v39`.

**Done (this session) — Save button moved into the create headers:**
- **Save is now a header icon, not a bottom button** — on both **create-problem** and **create-circuit** the big pink `Save problem` / `Save circuit` block at the bottom of the form is gone; Save is a **floppy-disk `.icon-btn` in the header, furthest right** inside `.detail-actions` (problem: reset · save; circuit: undo · reset · save). Styled with a new `.save-icon-btn` (accent fill, so it still reads as the primary action). The save handlers no longer swap `textContent` (meaningless on an icon) — they disable the button and add `.casting` to dim it while the insert runs. The inline `#create-error` / `#cc-error` lines stay in the panel. SW `pb-v40`.
- **Header alignment fix** — `.detail-bar-title` had no flex sizing, so with `justify-content: space-between` it took its natural width and shoved the action cluster past the right edge (Save clipped). Gave the title `flex: 1; min-width: 0` so it absorbs the slack and the actions sit flush right. (Shared rule — also tidies the circuit + detail headers.) SW `pb-v41`.
- **Create-form footer spacing** — removing the bottom Save button exposed layout slack. Net result after iterating: `#view-create main` keeps a tight `nav-h + 8px` bottom reserve (the problem form fits on screen, no dead band); `#view-circuit-create main` gets `nav-h + 20px` so the taller, scrolling circuit form has a small gap between its last field and the bottom nav. SW `pb-v43`. (The rest of the app still uses the global `main` reserve of `nav-h + 24px`.)

**Done (earlier) — Geofenced casting:**
- **Casting a problem is gated to the gym** — a single `ensureCastLocation()` check inside `castByName` (the one cast path) blocks a cast unless the device is near the wall (`GYM_GEOFENCE` in `app.js`: 50.53 / −2.4525, 300 m radius — **centre still unverified on-site**). Deliberately **lenient**: only a *confidently far* GPS fix blocks (a missing/old/low-accuracy fix is allowed through), and **admins bypass** the gate. Reuse this same gate for the Phase-2 circuit cast. SW `pb-v44`.

**Done (this session) — Search UX:**
- **Search scrolls the list to the top** — typing in either search bar (problems or circuits) now resets the window scroll to the top after re-rendering. Previously, searching while scrolled halfway down left results rendered below the fold, so the visible area looked blank. (The topbar is `position: sticky` and there's no inner scroll container — the *window* scrolls, so the fix is `window.scrollTo(0, 0)` in each `input` handler.) SW `pb-v45`.
- **Persistent custom clear "×" in the search bars** — the native `type="search"` clear control only shows while the field is focused, so it vanished as soon as you tapped away. Replaced with a custom **`.search-clear`** button inside `.search-wrap` (native `::-webkit-search-cancel-button` hidden, input gets right padding to reserve room) that stays visible **whenever the field has text**. Pressing it clears the query, re-renders, scrolls to top, and **re-focuses the input** so the soft keyboard reopens for a fresh search. Both lists. SW `pb-v46`.
- **Punctuation/accent-insensitive search** — a shared **`searchNorm()`** helper (lowercase → NFKD accent-fold → strip everything that isn't `[a-z0-9]`, i.e. spaces *and* punctuation) normalises **both** the query and the target text before matching, so `"its"` finds *It's a crimpy one* and `"left hand"` finds *Left-Hand*. Applied to name / setter / grade on both the problems and circuits lists. **Tradeoff (accepted):** stripping spaces allows cross-word matches (`"acrim"` matches "a crimpy"); harmless/helpful for ~270 routes. No DB change. SW `pb-v47`.

**Done (this session) — Split `app.js` into per-feature scripts:**
- **`app.js` (~2760 lines) was split into eight ordered classic scripts sharing ONE global scope** — `state` · `core` · `problems` · `admin` · `account` · `authoring` · `circuits` · `app` (loaded last). It was already top-level code in a classic `<script>` (no IIFE), so the split is a **byte-for-byte slice** at section boundaries — proven identical (concat-in-load-order `diff`s clean against the original) and each file + the combined whole pass `node --check` (catches any cross-file `let`/`const` redeclaration). **Deliberately NOT ES modules** (verification-risk vs the read/edit-cost win didn't justify the bigger rewrite): no `import`/`export`, no build step, the scope is unchanged, so behaviour is identical. `index.html` loads them in dependency order (`app.js` last = wiring + boot); `sw.js` precaches all eight. **When adding a `.js` file: keep the `index.html` order and add it to `sw.js`'s `ASSETS`.** SW `pb-v48`. (See "Key files" + working rules 7/9.)

**Next:** Circuits **Phase 2** — cast screen (5s countdown + beeps, caster speed in 0.1s steps, loop toggle, big STOP) + `cast_circuit`/`stop` broadcast + write `circuit_logs`; update the Pi listener. Then edit a problem's holds (admins); Phase 3 circuit PBs/leaderboards. (See "What is deferred".) Remaining review items to triage: S3 (Back can exit the app), S4 (auth bootstraps twice), S5–S7 + Minors.

---

## Repository

**GitHub:** https://github.com/rlmck/projectboard  
**Live URL:** https://rlmck.github.io/projectboard  
**Local path (Ross's laptop):** `C:\Users\rossl\Documents\ProjectBoard\` (the repo root — there is no `projectboard\` subfolder; the tracked PWA files live directly here)

Key files in the repo:
- `index.html` — the PWA's markup only (~170 lines): the list/detail/create/auth/profile view shells + modals + nav. Links `styles.css` and `app.js`.
- **App logic — split (17 June) across eight ordered classic scripts that share ONE global scope** (no ES modules, no build step; `index.html` loads them in this order, `app.js` **last**). They were sliced byte-for-byte out of the former single `app.js`, so it's still one shared scope — every function/`let`/`const` is mutually visible, **order in `index.html` matters**, and a name must be declared only once across all eight. Read the relevant file fully before modifying:
  - `state.js` — Supabase client + cast channel, grade ladders (`GRADE_ORDER`/`SPORT_GRADE_ORDER`), and **all shared mutable state** (`session`, `profile`, `allProblems`, `HOLD_MAP`, `myTicks`, create/circuit state, …). Loaded first.
  - `core.js` — escape/toast/render helpers, hold + board-overlay helpers, and hash **routing** (`router`/`setView`).
  - `problems.js` — problem list, detail, swipe, info modal, **cast** (`castByName` + geofence), board/map loaders, and the tick/delete/grade-edit buttons.
  - `admin.js` — the `#admin` hub: recalibrate entry point + user management RPCs.
  - `account.js` — the signed-in user's data: ticks, favourites, auth, profile.
  - `authoring.js` — create-a-problem + the recalibrate-board (`#calibrate`) tools.
  - `circuits.js` — circuits: load, list, detail, Play preview, create, delete.
  - `app.js` — **event wiring, PWA service worker + install banner, and boot. Loaded LAST** (it kicks everything off).
- `styles.css` — all the styling (dark theme, board overlay, components).
- `ProjectBoard.png` — illustrated board image used in the detail/create views.
- `hold_map.json` — hold id → `{x, y}` percentage position on `ProjectBoard.png`. Drives the detail-view hold overlay. See "Hold positions" below.
- `register_holds.py` — regenerates `hold_map.json` from the original DTB hold coordinates + `hold_positions.json`.
- `mirror_map.json` / `register_mirror.py` — hold id → mirror-partner hold id (the left/right mirror lookup; bundled fallback, live copy in `board_config.mirror_map`). Generated from Gareth's board-tested `MirrorDic.txt`. See the mirror notes below.
- `led_map.json` / `register_leds.py` — hold id → **physical WS2801 LED strip index** (column-major serpentine: col A=LEDs 1–13, B=14–26 reversed, … S=235–247; idx 0 = phantom A0). The one physical artifact inherited from Gareth's wiring, extracted from his code and **not** used by the app — it's the wiring contract for the **rebuilt board listener** (our own SD card; only the hardware is reused). `register_leds.py` ports Gareth's exact logic and asserts it matches for all 247 cells.
- `sw.js` / `manifest.json` — service worker + PWA manifest. **Deploy/caching:** HTML + app JS/CSS are network-first, so a fresh page load always gets the latest. To push an update to an *already-open* client (auto-reload on next focus), **bump `CACHE`** in `sw.js`. Registered with `updateViaCache:'none'` so `sw.js` is never served stale. ⚠️ Uninstalling the PWA does **not** clear its service worker/caches — a stranded device needs the browser's site-data cleared (Safari: Settings→Safari→Website Data; Chrome: Site settings→Clear & reset).

---

## Supabase

| Property | Value |
|---|---|
| Project ID | `uqirowyfqwiceyjznosl` |
| Region | London |
| URL | `https://uqirowyfqwiceyjznosl.supabase.co` |
| Anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA` |

### Schema (deployed, do not modify structure without being asked)

```
problems      — id, name (UNIQUE, not null), grade, setter (text not null default ''),
                setter_id (uuid → auth.users; owner of app-created problems, null on migrated rows),
                comment, stars, start_holds (array), intermediate_holds (array),
                finish_hold (text), feet_mode, is_benchmark
holds         — hold_id (pk), grid_name, pixel_x, pixel_y, on_wall (bool)
                — TABLE IS EMPTY/UNUSED: the PWA reads positions from hold_map.json / board_config, never this table. Vestigial.
board_state   — id (pk, ='HangoutPortland'), current_problem_name, current_problem_id (uuid → problems ON DELETE SET NULL),
                cast_by, is_mirrored (bool), cast_at (timestamptz)
ticks         — id, user_id, problem_id, attempts (int), notes, grade_vote, stars, ticked_at
                — UNIQUE (user_id, problem_id); FK problem_id → problems ON DELETE CASCADE. grade_vote/stars are unused-by-app (latent community voting).
likes         — user_id, problem_id, created_at  (PK (user_id, problem_id); FKs ON DELETE CASCADE)
                — the FAVOURITES store for problems (a user's hearted/projecting list; private per-user). Own-rows RLS since db/01.
circuit_likes — user_id, circuit_id, created_at  (PK (user_id, circuit_id); FKs ON DELETE CASCADE)
                — favourites store for circuits; own-rows RLS. Needs db/15.
sessions      — id, user_id (→ auth.users CASCADE), started_at, ended_at, notes   (TABLE EMPTY/UNUSED so far)
profiles      — id (= auth.users.id), username (unique, case-insensitive), is_admin (bool default false), created_at
board_config  — wall (pk, ='HangoutPortland'), hold_map (jsonb), mirror_map (jsonb, hold→partner; self=no mirror), image_path (text, object name in the 'board' Storage bucket), updated_at
circuits      — id, name (UNIQUE, not null), grade (sport, lowercase), setter_id (uuid → auth.users, ON DELETE SET NULL),
                comment, hold_sequence (text[], ordered, DUPLICATES ALLOWED — climbing order, NOT inverted),
                start_count (int 1–2), loops (bool), created_at
circuit_logs  — id, user_id (uuid → auth.users, CASCADE), circuit_id (uuid → circuits, CASCADE), moves (int),
                looped (bool), speed (numeric), created_at   (Phase 2 writes these; table + RLS exist now)
```

Row Level Security (RLS) is enabled on all tables. **Storage:** a public bucket
`board` holds the admin-uploaded board image (public read; admin-only write via
`is_admin()`). The app reads the live board image + hold map from `board_config`
(falling back to the bundled `ProjectBoard.png` + `hold_map.json`), so an admin
can recalibrate the whole board **from their phone** — no git drop. See `db/10`.

### DB scripts & policies (`db/` — kept LOCAL, gitignored, applied by hand in the Supabase SQL editor)

Apply in order; each is idempotent. **`db/` is not in the repo** — these live only on Ross's laptop.

- `04_auth_policies.sql` — `profiles` RLS (public read; insert/update only your own row) + case-insensitive unique username.
- `05_problems_insert.sql` — first `problems` INSERT policy (superseded by 07's policy).
- `06_admin_delete.sql` — `is_admin` column; `is_admin()` (SECURITY DEFINER) helper; `problems` admin DELETE policy; `ticks`/`likes` FKs set to `ON DELETE CASCADE`; **locks `profiles` UPDATE to the `username` column** (no self-promotion via update).
- `07_problem_owner.sql` — uses the existing `problems.setter_id` as owner; hardens INSERT to `setter_id = auth.uid()` (drop policy → drop the old redundant `created_by` column → recreate policy, in that order or the drop fails).
- `08_problems_update_admin.sql` — admin UPDATE policy on `problems` (powers grade editing).
- `09_lock_profile_insert.sql` — **locks `profiles` INSERT to `id`+`username`** so `is_admin` can't be self-set on insert. Closes the last self-promotion path.
- `10_board_assets.sql` — `board_config` table (per-wall `hold_map` jsonb + `image_path`) with public read / admin-only write; creates the public **`board` Storage bucket** + its object policies (public read, admin-only write). Powers phone-native board recalibration. **Run this in the SQL editor before the recalibrate "Save board" button will work.**
- `11_mirror_map.sql` — adds a `mirror_map` jsonb column to `board_config` so admins can fix wrong mirror pairings in the calibrate page's **Mirror** mode, live for everyone (reuses db/10's RLS). **Run this before "Save board" works again** — calSave now always writes `mirror_map`, so a save errors until the column exists.
- `13_admin_promote.sql` — adds `admin_set_admin(target uuid, make_admin boolean)`, the gated SECURITY DEFINER RPC behind the in-app **Make admin / Remove admin** buttons. Only an existing admin can call it; refuses changing your own flag. **Run this before the promote/demote buttons work** (the app shows a "run db/13" message until then).
- `14_circuits.sql` — the **Circuits** feature (Phase 1). Creates `circuits` (public read; insert as yourself; owner-or-admin update/delete) and `circuit_logs` (own insert + read; Phase 2 writes them). **Run this before the Circuits tab works** — the app shows a "run db/14" message until it's applied.
- `15_favourites.sql` — the **Favourites** feature. Problem favourites reuse the existing `likes` table (own-rows RLS already exists from db/01, so **problem favourites work with no DB change**). This script only creates **`circuit_likes`** (user_id + circuit_id, own-rows RLS) for circuit favourites. **Run this before circuit favourites work** — until then, hearting a *circuit* shows a "run db/15" message (problem favourites are unaffected).
- `20_harden_security.sql` — **database-review hardening (17 Jun, APPLIED).** Revokes `anon`'s leftover INSERT/UPDATE/DELETE/TRUNCATE on `profiles` (incl. column write on `is_admin`) — RLS already blocked it, this is defence-in-depth; `anon` keeps SELECT only. Pins `handle_new_user()`'s `search_path = public` (the one definer function that lacked it). No behaviour change.
- `21_dedupe_policies.sql` — **database-review hygiene (17 Jun, APPLIED).** Drops duplicate PERMISSIVE policies left by superseded scripts so there's exactly one per (table, command): `problems` INSERT/DELETE/UPDATE and `profiles` SELECT/UPDATE. Kept policies are the supersets, so access is unchanged; removes the "multiple permissive policies" perf lint.
- `22_drop_dead_indexes.sql` — **database-review cleanup (17 Jun, APPLIED).** Drops `problems_is_benchmark_idx` (0 scans; boolean over ~266 rows) and `problems_setter_idx` (text setter snapshot, superseded by `problems_setter_id_idx`). Live pg_stat confirmed both unused.
- `12_admin_users.sql` — powers the **#admin Users** section. Sets `problems.setter_id` FK to **`ON DELETE SET NULL`** (keep routes, clear owner) and the user-owned FKs (profiles/ticks/likes/sessions → auth.users) to **`ON DELETE CASCADE`**; adds the SECURITY DEFINER RPCs **`admin_list_users()`** (profiles ⨝ auth.users email + route count, `is_admin()`-gated) and **`admin_delete_user(target uuid)`** (refuses deleting yourself or another admin). **Run this before the Users list/delete works** — the app shows a "run db/12" message until then.

**Admin model:** admin = `profiles.is_admin = true`, keyed by account id (independent of `username`, so renames keep admin). Promotion can be done **two ways**: flip `is_admin` directly in the Supabase dashboard, or use the **in-app "Make admin" / "Remove admin"** buttons on `#admin/user/<id>`. The in-app path goes through `admin_set_admin(target, make_admin)` (db/13) — a SECURITY DEFINER RPC that **only an existing admin can call** and that **refuses changing your own flag**, so the "no self-promotion" property holds (a non-admin can't grant it to anyone, including themselves) and an admin can't self-demote to zero admins. The direct-UPDATE column locks from db/06/db/09 are unchanged; promotion only happens through that one gated RPC. The app's admin buttons are otherwise UX only; the real gate is the RLS policies above.

### Cast payload format

To cast a problem to the board, broadcast on channel `board:HangoutPortland`:

```javascript
await channel.send({
  type: 'broadcast',
  event: 'cast_problem',
  payload: { problem_name: 'Good Bug 5b+' }
});
```

**Reliability (17 June):** the channel is created with `config: { broadcast: { ack: true } }` and `castByName` checks `send()`'s resolved status (`'ok' | 'error' | 'timed out'`), treating anything but `'ok'` as a failure. Without ack, `send()` resolves `'ok'` the instant it pushes, so a dropped socket on weak gym Wi-Fi falsely reported "Sent ✓". Ack confirms the broadcast reached the **Realtime server**, not the Pi — there's no end-to-end ack from the board, so don't report board-level success. Payload/event/channel contract unchanged (mirror adds `payload.mirror = true`).

---

## problems table — column reference

The problems table was migrated from `test.csv` (271 rows). Key columns:

| Column | Content |
|---|---|
| `name` | Problem name (e.g. "Good Bug"). **UNIQUE.** Names are stored **clean** (no embedded grade) — the original migration stripped it from every row (verified 17 June), and app-created names never include the grade. Name and grade are **independent**: `displayName` shows the stored name as-is and grade-edit never rewrites it. Dedup is a plain case-insensitive name compare (matches the DB `UNIQUE(name)`). |
| `grade` | Boulder grade, stored lowercase (e.g. "5", "5+", "6a", "7a"); see Grade ordering |
| `setter` | Setter display-name **snapshot** at creation (text, NOT NULL, default `''`). For app-created problems the *displayed* setter comes from `setter_id` → live `profiles.username`, not this column. |
| `setter_id` | Owner's account id (uuid → `auth.users`). Set on app-created problems; **null** on migrated rows. Drives the live setter name + the INSERT RLS check (`setter_id = auth.uid()`). |
| `comment` | Short description / comment (note: **`comment`**, singular — not `comments`) |
| `stars` | Star rating (integer) |
| `start_holds` | Array of hold IDs, e.g. `["hold235","hold234"]` (always 2) |
| `intermediate_holds` | Array of hold IDs |
| `finish_hold` | Single hold ID, e.g. `"hold10"` |
| `feet_mode` | Feet restriction, e.g. `"any"` (app sets `"any"` — no foot LEDs exist) |
| `is_benchmark` | Boolean |

Hold IDs are `hold{N}` strings. `N` maps to a real board position via `hold_map.json` (key = `holdN`).

> **Finish zone:** the create UI treats the **top 25% of the board** as the finish zone — any hold whose `y` falls in the top quarter of the hold-map y-span (`ymin + 0.25·(ymax−ymin)`), computed from the *live* map so it tracks whatever board image `board_config` serves. This is **positional**, **not** by hold number (`hold{N}` numbering does *not* map cleanly to visual rows on this hand-set board) and **not** a fixed hold count. Top-zone holds are finish-or-intermediate (one finish; no starts); everything below is start-or-intermediate.

**⚠️ Start/finish are stored INVERTED.** The migration assigned `start_holds`/`finish_hold` back-to-front vs the original DTB order (confirmed on 263 of 271 problems, and against the physical board via the *joe smells 2.0* cast). Reading the columns literally puts green starts at the **top** of the wall — wrong.

**Rebuild the true order before colouring** (this is what `index.html` does):
```js
order = [finish_hold, ...intermediate_holds, ...start_holds]  // = Gareth's original test.csv order
// then, per the canonical convention:
//   order[0], order[1] = start holds (green)   ← physically LOW on the wall
//   order[last]        = finish hold  (red)    ← physically HIGH
//   the rest           = intermediates (blue)
```
The Pi cast path is unaffected — it reads its own `test.csv`, which is already in correct order.

**Colour convention:**
- Start = green
- Finish = red
- Intermediate = blue
- Feet indicator = orange

---

## Hold positions & the board overlay

The PWA renders a problem's holds as coloured dots over `ProjectBoard.png` in the detail view, using `hold_map.json` (`holdN` → `{x, y}` as **percentages** of the image).

How `hold_map.json` was produced (see `register_holds.py`):
- The original DTB system stored the **hand-calibrated** pixel position of every hold in `reference/original-pi-codebase/dtb/dicholdlist.txt` (grid name → `[x, y]`; `[-30,-30]` = no hold). **189 real holds**, 58 empty cells. This is the ground-truth layout — do **not** re-derive positions from a uniform grid (the board is hand-set/staggered, so grid-fitting mislabels holds).
- `register_holds.py` ICP-aligns that labelled layout onto the **187 dots** Ross placed on `ProjectBoard.png` (`hold_positions.json`) at ~2% RMS, and writes `hold_map.json`.

**Orientation gotcha:** on the real board, **row 1 (A1 = hold1) is at the BOTTOM**, row 13 at the top. Do not assume hold1 is top-left.

`holdN` → grid name: `names[N]` where `names[0]=A0, names[1]=A1, names[2]=B1, …` so `hold1=A1`, `hold19=S1`, `hold20=A2`, `hold247=S13`.

---

## Wall & board facts (for context only — Pi handles LEDs, not the PWA)

- 19 columns (A–S) × 13 rows (1–13) = 247 holds
- Wall is a symmetry board (left/right mirror image)
- Wall ID: `HangoutPortland`
- The Pi listener receives the cast broadcast and drives the physical LEDs

---

## App structure — what to build

This is a **single-page app** using vanilla HTML/CSS/JS (no framework, no build step). Keep it that way unless explicitly told to switch. Code is split across `index.html` (markup), `app.js` (logic), and `styles.css` (styles). `app.js` can be broken into ES modules when it gets large — ask first.

### Pages / views (client-side routing via hash or shown/hidden divs)

| View | Description |
|---|---|
| `#list` | Problem list — default view. Grade filter tabs, search bar, scrollable cards. Each card shows name, grade, setter, stars, tick status. Cast button on each card. |
| `#detail` | Problem detail. Shows name, grade, setter, stars, and the problem's holds lit on the board image (green=start, blue=intermediate, red=finish) via the `hold_map.json` overlay. Cast + mirror + tick + info in the header. Back button. |
| `#auth` | Sign in / create account — **Google OAuth + email/password** (Supabase Auth). Implemented. |
| `#profile` | Signed in: display name, email, sign out. Guest: prompt to sign in. (Tick stats still deferred.) |

### Navigation

Bottom nav bar with icons: Problems (list) · Profile. Keep it minimal.

### Design direction

Dark theme. The existing `index.html` has a good dark colour palette — keep it consistent. The app is used in a gym, often in low light, on a phone held at arm's length. Prioritise:
- Large tap targets (cast and tick buttons especially)
- High contrast
- Fast loading (no heavy frameworks)
- The illustrated board image (`ProjectBoard.png`, in the repo) fills the detail and create views. In detail it carries the coloured hold overlay; the create view will make it interactive (tap holds) — see the create discussion

---

## Grade ordering

Boulder-problem grades in correct difficulty order (for filter tabs and sorting):

```
5, 5+, 6a, 6a+, 6b, 6b+, 6c, 6c+, 7a, 7a+, 7b, 7b+, 7c, 7c+, 8a
```

The low end is **collapsed into two buckets**: the old `3, 4a, 4b, 4c, 5a, 5b, 5b+` all became `5`, and the old `5c, 5c+` became `5+`; `6a` and up are unchanged. The DB `problems.grade` values were remapped to match in **`db/19_regrade_boulders.sql`** (idempotent; run in the SQL editor).

**Display vs storage:** these strings are the canonical **lowercase** values — that's what's stored in `problems.grade`, what `GRADE_ORDER`/`gradeRank` match on, what filter `data-grade` carries, and what search compares. But boulder problems are **displayed as capitalised Font grades** (`6a` → `6A`; `5`/`5+` pass through unchanged) via `fontGrade(g)` (a display-only `toUpperCase`). Every problem grade shown to the user (list/detail/info badges, the grade filter tabs, create + edit-grade pickers, profile "Hardest send") is wrapped in `fontGrade`. **Circuits are different** — they use the separate lowercase French **sport** ladder (`SPORT_GRADE_ORDER`: `4, 5a … 8b`) and are **not** capitalised. **Name and grade are independent:** `displayName` returns the stored name as-is (no grade stripping), and the admin grade-edit only writes `grade`, never the name. (Verified 17 June: all 267 names are stored clean — the original migration stripped the embedded grade from every row — so the old display-time stripping fired on nothing and was removed.)

---

## Auth rules (implemented)

- Browsing problems and casting: **no login required**
- Ticking **and creating** a problem: **requires login** — any signed-in user can create
- **Deleting** a problem and **editing its grade**: **admins only** (`profiles.is_admin`), enforced in Postgres (RLS + `is_admin()`), not just the UI.
- Sign-in methods: **Google OAuth** and **email + password** (Supabase Auth). Email confirmation is **off** for now.
- On first sign-in (either method) the user picks a **display name** (defaults to the email prefix), stored in `profiles.username`. Display names are **unique** (case-insensitive) and **editable later** from the profile page. Profile is created via a modal in `index.html`; RLS policies + unique index live in `db/04_auth_policies.sql`.
- **No self-promotion:** users can only INSERT/UPDATE their own `id`+`username` on `profiles` (column grants in `db/06` + `db/09`); `is_admin` is never writable directly via the API. It's set either in the Supabase dashboard or by an **existing admin** through the gated `admin_set_admin()` RPC (db/13), which refuses self-changes — so there's still no path for a user to promote themselves.

---

## What is deferred — do not build yet

- Editing a problem's **holds/name/setter** (admins can already delete + edit grade; full edit not built)
- Circuits **Phase 2** (cast + countdown/beeps + `circuit_logs`) and **Phase 3** (PBs/leaderboards) — Phase 1 (browse/create/Play preview) is built
- Tags
- Session/logbook tracking beyond basic ticks (Total ticks + Hardest send are done)
- Flutter migration

---

## Working rules for CC

1. **Read this file at the start of every session before doing anything else.**
2. **Commit and push to `main` when a task is complete.** Ross tests on his phone via the live GitHub Pages URL — https://rlmck.github.io/projectboard — so changes must be pushed to be testable.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Do not install frameworks** (React, Vue, etc.) without being explicitly asked.
6. **Do not modify the Supabase schema** without being explicitly asked. If a schema change is needed, flag it and wait for confirmation.
7. **Check what already exists before writing new code.** The logic is split across `state.js` / `core.js` / `problems.js` / `admin.js` / `account.js` / `authoring.js` / `circuits.js` / `app.js` (see "Key files") — read the relevant file(s) and `index.html` (markup) fully before modifying. They share one global scope, so a symbol may be defined in a different file than you expect (grep across the `.js` files).
8. **The Supabase anon key is safe to commit** — it is a public key, not a secret. Do not replace it with an environment variable placeholder.
9. **The app is `index.html` (markup) + `styles.css` (styles) + eight ordered logic scripts** (`state` → `core` → `problems` → `admin` → `account` → `authoring` → `circuits` → `app`; see "Key files"). Keep this structure. They are **classic scripts sharing one global scope, deliberately NOT ES modules** (no `import`/`export`, no build step) — when adding a file, keep the load order in `index.html` and add it to `sw.js`'s `ASSETS`. Don't "modernise" to ES modules without being asked.
10. **When in doubt about behaviour, ask.** Do not invent product decisions.

---

## Session 1 task (first time CC opens this project)

1. Confirm you are on the `main` branch
2. Read `index.html` in full
3. Restructure the app to have the four views listed above (`#list`, `#detail`, `#auth`, `#profile`) with client-side navigation
4. The `#list` view should be a polished version of the existing problem list, adding:
   - Grade filter tabs (use the grade order above)
   - Each card shows: name, grade, setter, stars
   - Cast button retained
   - Tapping a card opens `#detail`
5. The `#detail` view should show all problem metadata and hold chips (coloured by type)
6. `#auth` and `#profile` views can be placeholder screens for now — just the shell with correct navigation
7. Do not implement Supabase Auth yet — that is Session 2
8. Test that cast still works end-to-end before finishing
9. Commit and push to `main` when done

---

*Last updated: 17 June 2026 — **Split `app.js` into per-feature scripts** (no DB change, no behaviour change). The ~2760-line `app.js` was already top-level code in a classic `<script>` (no IIFE), so it was **sliced byte-for-byte** at section boundaries into eight ordered classic scripts that share one global scope — `state` · `core` · `problems` · `admin` · `account` · `authoring` · `circuits` · `app` (loaded last = wiring + boot). Proven identical (concat-in-load-order `diff`s clean vs the original; every file + the combined whole pass `node --check`, which catches cross-file `let`/`const` redeclaration). **Deliberately NOT ES modules** — keeping the shared global scope made it a zero-risk slice rather than an `import`/`export` + state-object rewrite I couldn't fully verify without running the PWA. `index.html` loads them in order; `sw.js` precaches all eight (CACHE `pb-v48`). Updated "Key files" + working rules 7/9. **When adding a `.js` file: preserve the `index.html` load order and add it to `sw.js` `ASSETS`.** Previously — **Search UX polish** (three tweaks, no DB change): (1) typing in either search bar now scrolls the list back to the top (`window.scrollTo(0,0)` in each `input` handler) so refined results aren't hidden below the sticky-topbar fold — the window scrolls, there's no inner scroll container; (2) a persistent custom clear "×" (`.search-clear` inside `.search-wrap`, native `::-webkit-search-cancel-button` hidden) replaces the focus-only native one — it stays visible whenever the field has text and, when pressed, clears + re-renders + re-focuses the input so the keyboard reopens for a fresh search; (3) search is now punctuation/accent-insensitive via a shared `searchNorm()` (lowercase → NFKD accent-fold → strip non-`[a-z0-9]`, spaces and punctuation included), so "its" matches *It's a crimpy one* and "left hand" matches *Left-Hand* — applied to name/setter/grade on both the problems and circuits lists (accepted tradeoff: stripping spaces allows cross-word matches). SW `pb-v47`. Earlier — **Geofenced casting**: casting a problem is gated to the gym via one `ensureCastLocation()` check in `castByName` (`GYM_GEOFENCE` in app.js: 50.53 / −2.4525, 300 m radius, centre still unverified on-site); lenient (only a confidently-far GPS fix blocks) and admins bypass — reuse this gate for the Phase-2 circuit cast. SW `pb-v44`. Previously — **Database review + hardening (applied directly to Postgres via a read/write `psql`-equiv session over the session pooler; conn details in `db/.env` → `SUPABASE_DB_URL`)**. Findings fixed in three new idempotent scripts, all **already executed and verified** on the live DB: **`db/20`** revokes `anon`'s stray write grants on `profiles` (incl. column write on `is_admin`; RLS already blocked it — defence-in-depth) + pins `handle_new_user()`'s `search_path`; **`db/21`** removes duplicate RLS policies so there's one PERMISSIVE policy per (table, command) on `problems`/`profiles` (access unchanged, kills the perf lint); **`db/22`** drops two unused indexes (`problems_is_benchmark_idx`, `problems_setter_idx`). Also corrected the stale **Schema (deployed)** block to match reality (`board_state` = current_problem_name/current_problem_id/cast_by/is_mirrored/cast_at; `ticks` = attempts/notes/grade_vote/stars/ticked_at; `sessions` = started_at/ended_at/notes; `holds` table is empty/vestigial). **Not changed (left for Ross — product calls):** 4 problems graded `Project` (outside GRADE_ORDER, so invisible in grade tabs), 1 problem with empty `intermediate_holds` (*Moon Cheese is Green*), and whether to drop the empty `holds` table. No app/SW change (DB + docs only). Previously — **Save button moved into the create headers**: on both create-problem and create-circuit the big bottom `Save` block is replaced by a floppy-disk `.icon-btn` in the header, furthest right in `.detail-actions` (new `.save-icon-btn`, accent fill; save handlers disable + `.casting`-dim instead of swapping text). Fixed `.detail-bar-title` to `flex: 1; min-width: 0` so the action cluster stops overflowing the right edge. Footer spacing: `#view-create main` = `nav-h + 8px` (problem form fits, no dead band), `#view-circuit-create main` = `nav-h + 20px` (taller scrolling form keeps a gap above the nav). No DB changes. SW `pb-v43`. Previously — **Code-review fixes** (C1/S1/S2 from `review_output.md`): (1) cast reports failure honestly — channel now uses `broadcast: { ack: true }` and `castByName` checks `send()`'s status, so a dropped socket on weak Wi-Fi no longer falsely shows "Sent ✓" (ack confirms the Realtime server received it, not the Pi); (2) the SW `controllerchange` auto-reload defers while a `#create`/`#circuit-create` form has unsaved content (and skips the first-install flash), so a deploy can't wipe a half-built problem; (3) name decoupled from grade — verified all 267 names are stored clean, so `displayName` no longer strips the grade and grade-edit never rewrites the name. No DB changes. SW `pb-v39`. Previously (15 June) — **Font grades for problems**: boulder problems now display capitalised (`5b+` → `5B+`) via a display-only `fontGrade()` toUpperCase; stored/matched values stay lowercase (no DB change, no migration). `gradeTabButtons` takes an optional label formatter — problem tabs (filter/create/edit) pass `fontGrade`, circuit tabs don't. Circuits keep lowercase French sport grades. SW `pb-v34`. Previously — built **Favourites**: a private per-user "saved" list on both problems and circuits. A heart on each list card (toggles without opening), in each detail header (`#detail-fave` / `#circuit-detail-fave`), and a "favourites only" filter toggle in each list topbar (signed-in only). Problem favourites reuse the existing `likes` table (own-rows RLS already from db/01 — no DB change); circuit favourites use a new `circuit_likes` table (**db/15**). Mirrors the ticks pattern (`myFaves` / `myCircuitFaves` Sets, optimistic toggle, guest → sign-in prompt). Also fixed the `.icon-btn`-beats-`[hidden]` cascade gotcha for the new buttons and the pre-existing `#circuit-detail-delete`. SW `pb-v33`. Previously — built **Circuits, Phase 1**: a new sport-route entity (ordered hold sequence, duplicates allowed, 1–2 starts + 1 finish + optional loop; lowercase sport grades) with a **Circuits** bottom-nav tab, `#circuits` list (sport-grade filter), `#circuit-create` (tap-in-order, undo/reset, start-count + loop, name + grade), and `#circuit/<id>` detail with an **in-app Play preview** (4-hold moving-window animation, 0.1s-step speed control defaulting to 1.0s; loops until Stop, with green starts only on the first lap and a blue finish). Stored in natural order (NOT inverted). Owner/admin delete; needs **`db/14`** (circuits + circuit_logs tables + RLS; app shows a "run db/14" message until applied). No real casting yet — that's Phase 2. SW `pb-v32`. Previously (13 June) — added **in-app admin promotion**: Make admin / Remove admin buttons on `#admin/user/<id>` (confirm dialog), via the gated `admin_set_admin()` RPC (db/13) that only existing admins can call and that refuses self-changes (so no self-promotion, no zero-admin lockout). Reverses the old dashboard-only stance but keeps the RLS security. Needs `db/13`; SW `pb-v29`. Earlier today — **admin hub** added: a dedicated admins-only `#admin` view reached from an "Admin tools" button on the profile page. It holds a **Recalibrate board** card (links to the unchanged `#calibrate`) and a **Users** section that lists every account (username/email/join date/route count) and lets admins delete one. User list + delete go through SECURITY DEFINER RPCs `admin_list_users()` / `admin_delete_user(uuid)` (anon key can't read auth.users emails or delete accounts), both `is_admin()`-gated and refusing self/admin deletion; deleting a user keeps their routes (`problems.setter_id` → `ON DELETE SET NULL`) and cascades their profile/ticks/likes. Needs **`db/12`** (the app shows a "run db/12" message until it's applied). DB scripts go up to `db/12`. **SW now `pb-v27`** — also fixes a stale-cache bug on iOS: the JS/CSS network-first branch keyed only off `req.destination`, which WebKit often leaves `''`, so iPhones fell through to stale-while-revalidate and served an old build (laptop/Chrome was fine). Now matched by `.js`/`.css` extension too. Previously (12 June): **mirror toggle** added to the detail view: the `<|>` button flips the overlay to the left/right-mirrored problem (and lights up), and Cast then casts that orientation (`payload.mirror = true`). Mirroring uses a static `mirror_map.json` (hold id → partner) generated by `register_mirror.py` from Gareth's board-tested `MirrorDic.txt` — NOT grid arithmetic (the staggered board has no clean A↔S flip). 184/189 holds trusted as-is; one 4-hold knot (43↔72, 62↔91, 81↔110) repaired geometrically; 11 self-mirror holds (J-column + I7/J12/G13/H13 + I12 which has no partner). ⚠️ When the Pi is rebuilt, give it `mirror_map.json`, not raw `MirrorDic.txt`. A **Mirror** mode in calibrate lets admins fix wrong pairings live (saved to `board_config.mirror_map`; needs `db/11`); a vanishing mirrored finish (e.g. P Didn't) means the partner hold has no position — place I12/O13 via Add. SW at `pb-v25`. Earlier this build: create finish zone = top 25% of the board (positional); phone-native board recalibration (`#calibrate` Anchor/Nudge/Add, `board_config` + `board` Storage bucket); `hold218`/`hold243` were missing from the map (place via Add). DB scripts go up to `db/10`. Next: full problem editing.*
*Maintained by: Ross (rlmck)*
*Fuller context in `docs/project-notes.md` (in this repo) and the Claude.ai project knowledge.*
