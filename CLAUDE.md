# ProjectBoard — CLAUDE.md
## CC Project Bible · Read this at the start of every session

---

## What this project is

A PWA (Progressive Web App) to replace the Digital Training Boards (DTB) system at The Hangout climbing gym, Portland (near Weymouth, UK). The gym has a wooden symmetry board with 247 LED-lit holds. Users browse problems (climbing routes), cast them to the board (which lights up the holds via a Raspberry Pi), and tick them off when completed.

The app is hosted on **GitHub Pages** from the `main` branch.
**All work commits directly to `main`.** The app is not yet public — no users, no one knows the URL. Push freely and test on a real phone via the live GitHub Pages URL after each push.

---

## Repository

**GitHub:** https://github.com/rlmck/projectboard  
**Live URL:** https://rlmck.github.io/projectboard  
**Local path (Ross's laptop):** `C:\Users\rossl\Documents\ProjectBoard\projectboard\`

The repo currently contains one file: `index.html` — a working PWA prototype with problem list, search, and cast functionality. This is the foundation to build on. Do not throw it away; extend it.

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
problems      — id, name, grade, setter, comments, stars, hold_ids (array), feet
holds         — id, hold_name, x_coord, y_coord (coords deferred — not yet populated)
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

The problems table was migrated from a CSV. Key columns:

| Column | Content |
|---|---|
| `name` | Problem name (e.g. "Good Bug 5b+") |
| `grade` | French bouldering grade (e.g. "5b+", "7a") |
| `setter` | Setter username |
| `comments` | Short description / comment |
| `stars` | Star rating (integer) |
| `hold_ids` | Array of hold IDs (e.g. ["hold24", "hold106", ...]) — order: starts first, then intermediates, then finish last |
| `feet` | Feet restriction string (e.g. "Orange", "Black", "Orange,Black") or null |

**Hold type convention (from Gareth's original code — do not change):**
- `hold_ids[last]` = finish hold (red)
- `hold_ids[0]` and `hold_ids[1]` = start holds (green) — problems always have exactly 2 starts
- `hold_ids[2..last-1]` = intermediate holds (blue)

**Colour convention:**
- Start = green
- Finish = red
- Intermediate = blue
- Feet indicator = orange

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
| `#detail` | Problem detail. Shows name, grade, setter, comments, stars, feet restriction. Hold breakdown as coloured chips (green=start, blue=intermediate, red=finish). Cast button. Tick button (requires auth). Back button. |
| `#auth` | Login / sign up. Supabase Auth. Email + password only for now. |
| `#profile` | User profile. Username, total ticks, list of ticked problems. Logout button. |

### Navigation

Bottom nav bar with icons: Problems (list) · Profile. Keep it minimal.

### Design direction

Dark theme. The existing `index.html` has a good dark colour palette — keep it consistent. The app is used in a gym, often in low light, on a phone held at arm's length. Prioritise:
- Large tap targets (cast and tick buttons especially)
- High contrast
- Fast loading (no heavy frameworks)
- The illustrated board image (`board.png` — to be added to repo) used as a decorative header on the list view and detail view, not as an interactive element yet

---

## Grade ordering

French bouldering grades in correct difficulty order (for filter tabs and sorting):

```
3, 4a, 4b, 4c, 5a, 5b, 5b+, 5c, 5c+, 6a, 6a+, 6b, 6b+, 6c, 6c+, 7a, 7a+, 7b, 7b+, 7c, 7c+, 8a
```

---

## Auth rules

- Browsing problems and casting: **no login required**
- Ticking a problem: **requires login**
- Profiles are created automatically on first sign-up (insert into `profiles` table with username = email prefix)

---

## What is deferred — do not build yet

- Wall diagram with hold coordinate overlay (needs physical coordinate capture at gym)
- Coordinate capture tool
- Mirror mode toggle
- Setter tools (create/edit problems)
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

*Last updated: June 2026*
*Maintained by: Ross (rlmck)*
*For questions about this project, context is in DTB_PROJECT_NOTES.md (not in this repo — lives in Claude.ai project knowledge)*
