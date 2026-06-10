# ProjectBoard — CLAUDE.md
## CC Project Bible · Read this at the start of every session

---

## What this project is

A PWA (Progressive Web App) to replace the Digital Training Boards (DTB) system at The Hangout climbing gym, Portland (near Weymouth, UK). The gym has a wooden symmetry board with 247 LED-lit holds. Users browse problems (climbing routes), cast them to the board (which lights up the holds via a Raspberry Pi), and tick them off when completed.

The app is hosted on **GitHub Pages** from the `main` branch.
**All work commits directly to `main`.** The app is not yet public — no users, no one knows the URL. Push freely and test on a real phone via the live GitHub Pages URL after each push.

---

## Build status (10 June 2026)

**Done:** problem list + grade tabs + search + cast (Supabase Realtime); **detail view hold overlay** (a problem's holds lit on `ProjectBoard.png` via `hold_map.json`); **auth** — Google OAuth + email/password with a first-login display name (`profiles.username`, unique).

**Next session — create-a-problem:** tap holds on the board (`ProjectBoard.png` + `hold_map.json`, nearest-dot hit-testing) to set start/intermediate/finish, add name/grade/feet, then save to Supabase. Any signed-in user may create. **Store start/finish correctly** (first two = start, last = finish — see the inversion note below). Needs a `problems` INSERT policy for authenticated users (not yet added — see `db/04_auth_policies.sql`).

---

## Repository

**GitHub:** https://github.com/rlmck/projectboard  
**Live URL:** https://rlmck.github.io/projectboard  
**Local path (Ross's laptop):** `C:\Users\rossl\Documents\ProjectBoard\projectboard\`

Key files in the repo:
- `index.html` — the whole PWA (list, detail, create/auth/profile shells, cast). Extend this; don't throw it away.
- `ProjectBoard.png` — illustrated board image used in the detail/create views.
- `hold_map.json` — hold id → `{x, y}` percentage position on `ProjectBoard.png`. Drives the detail-view hold overlay. See "Hold positions" below.
- `register_holds.py` — regenerates `hold_map.json` from the original DTB hold coordinates + `hold_positions.json`.
- `sw.js` / `manifest.json` — service worker (bump `CACHE` on asset changes) + PWA manifest.

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
problems      — id, name, grade, setter, comment, stars,
                start_holds (array), intermediate_holds (array), finish_hold (text), feet_mode, is_benchmark
holds         — id, hold_name, x_coord, y_coord (coords NOT populated in Supabase; PWA uses hold_map.json instead)
board_state   — id='HangoutPortland', current_problem
ticks         — id, user_id, problem_id, created_at
likes         — id, user_id, problem_id
sessions      — id, user_id, wall, date, problems (jsonb)
profiles      — id (= auth.users.id), username, created_at
```

Row Level Security (RLS) is enabled on all tables.

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
| `name` | Problem name (e.g. "Good Bug 5b+") |
| `grade` | French bouldering grade (e.g. "5b+", "7a") |
| `setter` | Setter username |
| `comment` | Short description / comment (note: **`comment`**, singular — not `comments`) |
| `stars` | Star rating (integer) |
| `start_holds` | Array of hold IDs, e.g. `["hold235","hold234"]` (always 2) |
| `intermediate_holds` | Array of hold IDs |
| `finish_hold` | Single hold ID, e.g. `"hold10"` |
| `feet_mode` | Feet restriction, e.g. `"any"` |
| `is_benchmark` | Boolean |

Hold IDs are `hold{N}` strings. `N` maps to a real board position via `hold_map.json` (key = `holdN`).

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

This is a **single-page app** using vanilla HTML/CSS/JS (no framework). Keep it that way unless explicitly told to switch. All in `index.html` or split into logical files if the codebase gets large — ask first before splitting.

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
- Sign-in methods: **Google OAuth** and **email + password** (Supabase Auth). Email confirmation is **off** for now.
- On first sign-in (either method) the user picks a **display name** (defaults to the email prefix), stored in `profiles.username`. Display names are **unique** (case-insensitive). Profile is created via a modal in `index.html`; RLS policies + unique index live in `db/04_auth_policies.sql` (already applied in Supabase).

---

## What is deferred — do not build yet

- Mirror mode toggle
- Editing / deleting existing problems (basic create-a-problem is the next session)
- Circuits and tags
- Session/logbook tracking beyond basic ticks
- Flutter migration

---

## Working rules for CC

1. **Read this file at the start of every session before doing anything else.**
2. **Commit and push to `main` when a task is complete.** Ross tests on his phone via the live GitHub Pages URL — https://rlmck.github.io/projectboard — so changes must be pushed to be testable.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Do not install frameworks** (React, Vue, etc.) without being explicitly asked.
6. **Do not modify the Supabase schema** without being explicitly asked. If a schema change is needed, flag it and wait for confirmation.
7. **Check what already exists before writing new code.** Read `index.html` fully before modifying it.
8. **The Supabase anon key is safe to commit** — it is a public key, not a secret. Do not replace it with an environment variable placeholder.
9. **Ask before splitting into multiple files.** Single `index.html` is preferred for now.
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

*Last updated: 10 June 2026 — auth (Google + email/password) live; hold overlay live. Next: create-a-problem.*
*Maintained by: Ross (rlmck)*
*Fuller context in `docs/project-notes.md` (in this repo) and the Claude.ai project knowledge.*
