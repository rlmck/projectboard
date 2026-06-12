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

**Next:** edit a problem's holds (admins); circuits/tags; richer logbook. (See "What is deferred".)

---

## Repository

**GitHub:** https://github.com/rlmck/projectboard  
**Live URL:** https://rlmck.github.io/projectboard  
**Local path (Ross's laptop):** `C:\Users\rossl\Documents\ProjectBoard\projectboard\`

Key files in the repo:
- `index.html` — the PWA's markup only (~170 lines): the list/detail/create/auth/profile view shells + modals + nav. Links `styles.css` and `app.js`.
- `app.js` — **all the app logic** (routing, Supabase data + cast, list/detail/filters/swipe, auth, profile). This is where features go. Read it fully before modifying.
- `styles.css` — all the styling (dark theme, board overlay, components).
- `ProjectBoard.png` — illustrated board image used in the detail/create views.
- `hold_map.json` — hold id → `{x, y}` percentage position on `ProjectBoard.png`. Drives the detail-view hold overlay. See "Hold positions" below.
- `register_holds.py` — regenerates `hold_map.json` from the original DTB hold coordinates + `hold_positions.json`.
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
holds         — id, hold_name, x_coord, y_coord (coords NOT populated in Supabase; PWA uses hold_map.json instead)
board_state   — id='HangoutPortland', current_problem
ticks         — id, user_id, problem_id, created_at   (FK problem_id → problems ON DELETE CASCADE)
likes         — id, user_id, problem_id               (FK problem_id → problems ON DELETE CASCADE)
sessions      — id, user_id, wall, date, problems (jsonb)
profiles      — id (= auth.users.id), username (unique, case-insensitive), is_admin (bool default false), created_at
board_config  — wall (pk, ='HangoutPortland'), hold_map (jsonb), image_path (text, object name in the 'board' Storage bucket), updated_at
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

**Admin model:** admin = `profiles.is_admin = true`, keyed by account id (independent of `username`, so renames keep admin). Promotion is **manual in the Supabase dashboard** — there is no in-app promotion UI by design. The app's admin buttons are UX only; the real gate is the RLS policies above.

### Cast payload format

To cast a problem to the board, broadcast on channel `board:HangoutPortland`:

```javascript
await channel.send({
  type: 'broadcast',
  event: 'cast_problem',
  payload: { problem_name: 'Good Bug 5b+' }
});
```

---

## problems table — column reference

The problems table was migrated from `test.csv` (271 rows). Key columns:

| Column | Content |
|---|---|
| `name` | Problem name (e.g. "Good Bug 5b+"). **UNIQUE.** Migrated names include the grade suffix; app-created names do **not** (the app strips the trailing grade for display, so it dedupes on the *displayed* name). |
| `grade` | French bouldering grade (e.g. "5b+", "7a") |
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

French bouldering grades in correct difficulty order (for filter tabs and sorting):

```
3, 4a, 4b, 4c, 5a, 5b, 5b+, 5c, 5c+, 6a, 6a+, 6b, 6b+, 6c, 6c+, 7a, 7a+, 7b, 7b+, 7c, 7c+, 8a
```

---

## Auth rules (implemented)

- Browsing problems and casting: **no login required**
- Ticking **and creating** a problem: **requires login** — any signed-in user can create
- **Deleting** a problem and **editing its grade**: **admins only** (`profiles.is_admin`), enforced in Postgres (RLS + `is_admin()`), not just the UI.
- Sign-in methods: **Google OAuth** and **email + password** (Supabase Auth). Email confirmation is **off** for now.
- On first sign-in (either method) the user picks a **display name** (defaults to the email prefix), stored in `profiles.username`. Display names are **unique** (case-insensitive) and **editable later** from the profile page. Profile is created via a modal in `index.html`; RLS policies + unique index live in `db/04_auth_policies.sql`.
- **No self-promotion:** users can only INSERT/UPDATE their own `id`+`username` on `profiles` (column grants in `db/06` + `db/09`); `is_admin` is set **only** via the Supabase dashboard.

---

## What is deferred — do not build yet

- Editing a problem's **holds/name/setter** (admins can already delete + edit grade; full edit not built)
- Circuits and tags
- Session/logbook tracking beyond basic ticks (Total ticks + Hardest send are done)
- In-app admin promotion UI (promotion is manual in Supabase by design)
- Flutter migration

---

## Working rules for CC

1. **Read this file at the start of every session before doing anything else.**
2. **Commit and push to `main` when a task is complete.** Ross tests on his phone via the live GitHub Pages URL — https://rlmck.github.io/projectboard — so changes must be pushed to be testable.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Do not install frameworks** (React, Vue, etc.) without being explicitly asked.
6. **Do not modify the Supabase schema** without being explicitly asked. If a schema change is needed, flag it and wait for confirmation.
7. **Check what already exists before writing new code.** Read `app.js` (logic) and `index.html` (markup) fully before modifying them.
8. **The Supabase anon key is safe to commit** — it is a public key, not a secret. Do not replace it with an environment variable placeholder.
9. **The app is split into `index.html` (markup) + `app.js` (logic) + `styles.css` (styles).** Keep that structure; `app.js` may be split into ES modules later when it gets large — ask before doing so.
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

*Last updated: 12 June 2026 — **mirror toggle** added to the detail view: the `<|>` button flips the overlay to the left/right-mirrored problem (and lights up), and Cast then casts that orientation (`payload.mirror = true`). Mirroring uses a static `mirror_map.json` (hold id → partner) generated by `register_mirror.py` from Gareth's board-tested `MirrorDic.txt` — NOT grid arithmetic (the staggered board has no clean A↔S flip). 184/189 holds trusted as-is; one 4-hold knot (43↔72, 62↔91, 81↔110) repaired geometrically; 11 self-mirror holds (J-column + I7/J12/G13/H13 + I12 which has no partner). ⚠️ When the Pi is rebuilt, give it `mirror_map.json`, not raw `MirrorDic.txt`. SW at `pb-v24`. Earlier this build: create finish zone = top 25% of the board (positional); phone-native board recalibration (`#calibrate` Anchor/Nudge/Add, `board_config` + `board` Storage bucket); `hold218`/`hold243` were missing from the map (place via Add). DB scripts go up to `db/10`. Next: full problem editing.*
*Maintained by: Ross (rlmck)*
*Fuller context in `docs/project-notes.md` (in this repo) and the Claude.ai project knowledge.*
