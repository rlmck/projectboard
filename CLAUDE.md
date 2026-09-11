# ProjectBoard: CLAUDE.md

Read this at the start of every session. It holds the rules, the things that must not break, and the traps. Everything else lives in the documents it points to.

## What this is

A PWA for the symmetry board at The Hangout climbing gym, Portland (near Weymouth, UK): a wooden wall with 189 LED-lit holds on a 19 × 13 grid (A–S × 1–13). Climbers browse **problems** (boulders) and **circuits** (long sport-style routes), **cast** a problem to light its holds via a Raspberry Pi, **tick** sends, save **favourites** and climb the points **leaderboard**. It has real users.

| | |
|---|---|
| **Live** | https://symmetryboard.co.uk, from `main` |
| **Staging** | https://dev-projectboard.rosslewismckechnie.workers.dev, from `dev` |
| **Old address** | https://rlmck.github.io/projectboard, a permanent "we've moved" page served from the `legacy` branch |
| **Repo** | https://github.com/rlmck/projectboard (public, permanently) |
| **Local path** | `C:\Users\rossl\Documents\ProjectBoard\` (the repo root; there's no subfolder) |

**Which document to trust:**
- **Architecture, data model, auth, caching, deploy mechanics, known issues:** `docs/codebase-overview.md`. Read it at the start of a session. It was checked against the live database.
- **Hosting, rollout and the install flow:** `docs/rollout-plan.md`.
- **Security findings:** `docs/security-findings.md`, **local only, never committed**. Read it before touching RLS, grants, casting or sign-up.
- **Local only, on Ross's laptop:** `docs/changelog.md` (the full feature history), `docs/project-notes.md` (hardware, the Pi, the original DTB system, the Circuits Phase 2 spec), `db/README.md` (every DB script).

---

## Working rules

1. **Read this file and `docs/codebase-overview.md` at the start of every session.**
2. **Work on `dev`, never straight on `main`.** When a task is done: commit on `dev` → push → Ross tests on a real phone at the staging URL → **merge `dev` → `main` only when Ross approves.** The merge is what deploys to real users.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Don't install frameworks** (React, Vue, …) or add a build step without being asked.
6. **Don't change the Supabase schema** (tables, policies, grants, functions) without being asked. Flag the need and wait.
7. **Check what already exists before writing new code.** Read the relevant script(s) and `index.html` fully. The scripts share one global scope, so a symbol may be defined in a file you don't expect: grep across all `.js` files.
8. **The Supabase anon key is safe to commit.** It's a public key. Don't replace it with an environment variable.
9. **Keep the structure:** `index.html` (markup) + `styles.css` + nine ordered classic scripts. **Not ES modules**, and don't convert them without being asked.
10. **When in doubt about behaviour, ask.** Don't invent product decisions.

---

## Never break these

- **The `legacy` branch and GitHub Pages.** Never delete the branch, never disable Pages, never touch either unless asked. Old installs and old links depend on them.
- **The repo stays public and is never renamed.** Free Pages needs a public repo, and the github.io redirect follows the repo name.
- **Nothing secret is ever committed.** `docs/security-findings.md` never gets a `.gitignore` exception. `db/.env` (direct-Postgres URL + service key) is never printed, pasted or committed. Pi credentials stay out of the repo.
- **The three-places rule.** A new deployable file goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page). Exception: the manifest `screenshot-*.png` files are `build.sh` only. A new committed PNG also needs a `!` exception in `.gitignore` (which ignores `*.png`). A new script also keeps the load order in `index.html`.
- **Bump `CACHE` in `sw.js`** to push an update to already-open clients, and whenever `ASSETS` or the fetch logic changes.
- **The CSP in `_headers`.** No inline scripts and no `on*=` handlers, ever. Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.
- **Never cache or precache a redirect in `sw.js`.** Cloudflare 307s `/index.html` → `/` and `/x.html` → `/x`. The app shell is cached under `./` only.
- **Staging shares the live database.** Problems, ticks and casts made on staging are real, and admins bypass the cast geofence there. Delete test data, and don't cast by accident.
- **db/12: never re-run step 1.** See `db/README.md`.

---

## Where things are

**App logic: nine classic scripts sharing one global scope**, loaded by `index.html` in this order, after the vendored `supabase-js-2.116.0.js`. Every top-level `let`/`const`/`function` is visible everywhere, so **a name may be declared only once across all nine**, and top-level code can't use later files. Check with `cat state.js core.js problems.js admin.js account.js authoring.js circuits.js leaderboard.js app.js > all.js && node --check all.js`.

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel, grade ladders, **all shared mutable state** |
| `core.js` | Escaping, toast, search helpers, hold order/roles, dot and shape overlays, `boardPct` hit-testing, fullscreen, **routing** |
| `problems.js` | Problem list/filters, detail, swipe, info modal, **`castByName` + geofence**, board data loaders |
| `admin.js` | The `#admin` hub: users, promote/demote, delete (RPCs) |
| `account.js` | Ticks, favourites, filter pills, **auth**, display-name modal, profile |
| `authoring.js` | Create/edit problem, the `#calibrate` tool, circuit helpers |
| `circuits.js` | Circuits list, detail, Play preview, create, delete |
| `leaderboard.js` | `#leaderboard` |
| `app.js` | **Loaded last:** event wiring, service worker, install flow, boot |

**Other tracked files:**
- **Shipped:** `index.html`, `privacy.html` (keep its claims true), `styles.css`, `sw.js`, `manifest.json`, the icons, `ProjectBoard.png`, and the fallback board data `hold_map.json`, `mirror_map.json`, `hold_shapes.json`.
- **`supabase-js-2.116.0.js`:** vendored and pinned. Never a CDN URL. To upgrade, see overview §4.1.
- **Hosting config:** `build.sh` (the deploy allowlist), `wrangler.jsonc`, `_headers`, `_redirects`, `.gitattributes`.
- **Tools, not deployed:** `register_holds.py`, `register_mirror.py`, `register_shapes.py`, `register_leds.py`, `make_icons.py`, `make_qr.py`, `trace_holds.html` (run locally), `hold_positions.json`, `led_map.json` (the Pi wiring contract). What each does: overview §11.
- **`print/`:** the A5 poster and QR, not deployed. The QR encodes `/scan`; change where it lands in `_redirects`, never by reprinting.

**Local only (gitignored):** `db/`, `pi/` (the board listener), `docs/*` except the two committed docs, `reference/` (Gareth's original code; two register scripts read it by path). Gareth's SD-card image and the old reverse-engineering are archived outside the repo in `Documents\ProjectBoard-archive\`.

**Deploy:** Cloudflare Workers static assets. Push `dev` → a preview build at the staging URL (not promoted). Merge to `main` → production. `build.sh` wipes and rebuilds `public/` from its allowlist; anything unlisted never ships. Details: overview §9 and `docs/rollout-plan.md`.

---

## Data traps

- **Problem holds are stored INVERTED.** The migration wrote start/finish back to front. The true order is
  ```js
  order = [finish_hold, ...intermediate_holds, ...start_holds]
  // order[0], order[1] = starts (green, LOW on the wall); order[last] = finish (red, HIGH); the rest = intermediates (blue)
  ```
  Always use `problemHoldOrder()` + `classifyHolds()`. `saveProblem` re-inverts on the way in, and a lone start is duplicated so there are always two. The Pi listener does the same un-invert. Fixing it for good means a data migration **and** a Pi change together.
- **A problem's name is UNIQUE and is the cast key** (the Pi looks it up by name). Names are stored clean, with no embedded grade. Name and grade are independent: never strip a grade in `displayName` or rewrite a name in grade-edit.
- **Grades are stored lowercase** (`5, 5+, 6a, 6a+ … 7c+, 8a`) and **displayed** as capitalised Font grades via `fontGrade()`. Storage, `GRADE_ORDER`, filters and search all stay lowercase. Unknown grades (2 problems are `Project`) sort last.
- **Circuits are different:** a separate lowercase sport ladder (`4, 5a … 8b`, never capitalised), stored in **natural climbing order, not inverted**, as one `hold_sequence` with duplicates allowed, plus `start_count` (1–2) and `loops`.
- **Board orientation: row 1 is at the BOTTOM.** `holdN` is row-major from the bottom-left: `hold1` = A1, `hold19` = S1, `hold20` = A2, `hold247` = S13. `holdN` numbering doesn't map cleanly to visual rows on this hand-set board.
- **Hold positions** come from the live `board_config.hold_map`, with the bundled `hold_map.json` as a fallback. Recalibrate in-app (`#calibrate`); don't hand-edit the map or re-derive positions from a uniform grid. The live board image is `board.jpg` in Storage, framed differently from the bundled `ProjectBoard.png`: never mix the live map with the bundled image or the other way round.
- **Mirroring is a lookup table** (`board_config.mirror_map`, fallback `mirror_map.json`), keyed by hold id. Never grid arithmetic: the board is staggered. When the Pi listener is rebuilt, feed it the **live** mirror map, not Gareth's raw `MirrorDic.txt`.
- **Hold outlines (`hold_shapes.json`) fit one board version.** `shapesUsable()` falls back to dots unless the live board's `updated_at` matches. After any recalibration, re-run `register_shapes.py` and commit the new file.
- **Create rules:** the top 25% of the board (by the live map's hold y-span) is the finish zone: exactly one finish, no starts, other holds allowed. Everywhere else, holds cycle start (the first two) → hold → off. A problem needs 1–2 starts, at least one intermediate and one finish.
- **Colours:** start green, intermediate blue, finish red, feet orange.
- **Points come only from the `leaderboard()` RPC.** Never re-implement the formula in JS.
- **`.icon-btn { display:flex }` beats `[hidden]`**, so every hideable icon button needs an explicit `#id[hidden]{display:none}`.
- **A write blocked by RLS "succeeds"**: an update or delete whose policy hides the row returns no error and 0 rows. Add `.select()` and check the count.

---

## Supabase

| | |
|---|---|
| Project ID | `uqirowyfqwiceyjznosl` (London) |
| URL | `https://uqirowyfqwiceyjznosl.supabase.co` |
| Anon key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA` |

- **Tables, policies and functions:** overview §5. RLS is on everywhere and is the real gate; the app's admin-only UI is just UX.
- **DB scripts** live in local `db/`, numbered and idempotent, applied by hand in the SQL editor. All of 01–26 are applied. The index and warnings are in `db/README.md`. A new script takes the next number.
- **Admin** = `profiles.is_admin`. It's set in the Supabase dashboard or in-app through `admin_set_admin()`, which only an existing admin can call and which refuses changing your own flag. **Nobody can promote themselves.**
- **Who can do what:** browsing and casting need no login. Ticking, favourites and creating need sign-in. Admins edit (grade, holds) and delete any problem; an owner can delete their own problem only while nobody else has ticked it. Details: overview §5–6.
- **Direct Postgres** for reviews: `db/.env` → `SUPABASE_DB_URL` (session pooler), via `pg8000`. Default to read-only. How to connect: overview §5.

---

## The cast contract

```javascript
await channel.send({
  type: 'broadcast',
  event: 'cast_problem',
  payload: { problem_name: 'Good Bug', mirror: true }   // mirror only when the mirrored view is shown
});
// channel: 'board:HangoutPortland', created with config: { broadcast: { ack: true } }
```

- `castByName()` in `problems.js` is the only cast path. It runs the geofence check first (lenient; admins bypass). **Reuse that gate for the circuit cast.**
- The ack means the **Realtime server** got the broadcast, not the Pi. There's no end-to-end confirmation, so never report board-level success.
- The Pi listener (`pi/board_listener.py`, local) looks the name up in the `problems` table, applies the mirror map, un-inverts, and lights the LEDs.

---

## Status

**The app** has four tabs (Problems · Circuits · Ranks · Profile) and 11 views; the full route list is in overview §4.3. SW `CACHE` is `pb-v75`.

**Next:**
- **Circuits Phase 2:** the cast screen (5 s countdown + beeps, speed in 0.1 s steps, loop toggle, big STOP), `cast_circuit`/`stop` broadcasts, writing `circuit_logs` (which also activates the circuits "Exclude Done" pill), and the Pi listener update. Spec: `docs/project-notes.md`.
- **Problem name/setter editing** (holds and grade editing are done).
- **Known bugs** to triage: overview §13.

**Don't build yet:** Circuits Phase 3 (PBs, leaderboards), tags, session/logbook tracking beyond ticks, the Flutter migration.

**Waiting on Ross:** email (custom SMTP) before password reset and email confirmation go live (overview §12), Cloudflare *Always Use HTTPS* (overview §8), and checking the geofence centre on-site.

---

*Rewritten 11 September 2026: cut from 96 KB to rules and pointers. The old build history is in `docs/changelog.md` (local) and in git. Maintained by Ross (rlmck).*
