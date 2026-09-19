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
2. **For now, every change goes straight to live (Ross, 11 Sep 2026).** When a task is done: commit on `dev` → push `dev` → fast-forward `main` to `dev` → push `main`, without asking first, then confirm the live `sw.js` shows the new `CACHE`. Keep the two branches level so staging is ready when it's needed again. **This lasts until the app is properly rolled out and the LEDs work.** After that, go back to: Ross tests on a real phone at the staging URL, and `dev` merges to `main` only when he approves. Pushing to `main` deploys to real users, so still run the syntax check before every push.
   Claude Code web sessions start on an assigned `claude/<slug>` branch and are told not to push elsewhere without permission: treat this rule as that permission, and carry the work through to `dev` and `main` rather than stopping at the session branch. If the live site is unreachable from the session (the environment's network policy blocks it), say so rather than skipping the `CACHE` check silently.
3. **One feature per session.** Finish it properly before starting the next.
4. **Rewrite whole files** rather than providing inline diffs.
5. **Don't install frameworks** (React, Vue, …) or add a build step without being asked.
6. **Don't change the Supabase schema** (tables, policies, grants, functions) without being asked. Flag the need and wait.
7. **Check what already exists before writing new code.** Read the relevant script(s) and `index.html` fully. The scripts share one global scope, so a symbol may be defined in a file you don't expect: grep across all `.js` files.
8. **The Supabase anon key is safe to commit.** It's a public key. Don't replace it with an environment variable.
9. **Keep the structure:** `app/index.html` (markup) + `app/styles.css` + nine ordered classic scripts, all flat in `app/`. **Not ES modules**, and don't convert them without being asked. Don't add subfolders inside `app/`: it's copied to the site one-to-one, so a subfolder changes live URLs.
10. **When in doubt about behaviour, ask.** Don't invent product decisions.

---

## Never break these

- **The `legacy` branch and GitHub Pages.** Never delete the branch, never disable Pages, never touch either unless asked. Old installs and old links depend on them.
- **The repo stays public and is never renamed.** Free Pages needs a public repo, and the github.io redirect follows the repo name.
- **Nothing secret is ever committed.** `docs/security-findings.md` never gets a `.gitignore` exception. `db/.env` (direct-Postgres URL + service key) is never printed, pasted or committed. Pi credentials stay out of the repo.
- **The three-places rule.** A new deployable file lives in `app/`, and goes in the `build.sh` allowlist **and** `sw.js` `ASSETS` **and** is referenced from `index.html` (or another shipped page). Exception: the manifest `screenshot-*.png` files are `build.sh` only. A new committed PNG also needs a `!app/…` exception in `.gitignore` (which ignores `*.png`). A new script also keeps the load order in `index.html`.
- **Bump `CACHE` in `sw.js` on every deploy that changes app code or data** (not only `ASSETS` or the fetch logic). It pushes the update to already-open clients, and it keeps each precache one consistent version: the worker's mixed-version guard falls back to it on weak Wi-Fi.
- **The CSP in `_headers`.** No inline scripts and no `on*=` handlers, ever. Any new third-party origin (CDN, font, API) must be added to the CSP, or it's silently blocked.
- **Never cache or precache a redirect in `sw.js`.** Cloudflare 307s `/index.html` → `/` and `/x.html` → `/x`. The app shell is cached under `./` only.
- **Staging shares the live database.** Problems, ticks and casts made on staging are real, and admins bypass the cast geofence there. Delete test data, and don't cast by accident.
- **db/12: never re-run step 1.** See `db/README.md`.

---

## Where things are

**The layout:**
```
app/      the website: exactly the files that are deployed, flat. build.sh copies it into public/.
tools/    generators, dev tools and the cast test bench (never deployed)
print/    the A5 poster and QR (never deployed)
docs/     codebase-overview.md + rollout-plan.md (the rest is local only)
build.sh  wrangler.jsonc   at the root, because the Cloudflare dashboard runs them from there
```

**App logic: nine classic scripts in `app/`, sharing one global scope**, loaded by `index.html` in this order, after the vendored `supabase-js-2.116.0.js`. Every top-level `let`/`const`/`function` is visible everywhere, so **a name may be declared only once across all nine**, and top-level code can't use later files. Check with `cd app && cat state.js core.js problems.js admin.js account.js authoring.js circuits.js leaderboard.js app.js > ../all.js && node --check ../all.js`, then delete `all.js`.

| File | Owns |
|---|---|
| `state.js` | Supabase client + cast channel, grade ladders, **all shared mutable state** |
| `core.js` | Escaping, toast, search helpers, hold order/roles, dot and shape overlays, `boardPct` hit-testing, fullscreen, **routing** |
| `problems.js` | Problem list/filters, detail, swipe, info modal, **`castByName` + geofence**, board data loaders |
| `admin.js` | The `#admin` hub: users, promote/demote, delete (RPCs) |
| `account.js` | Ticks, favourites, filter pills, **auth**, display-name modal, profile |
| `authoring.js` | Create/edit problem, the `#outlines` hold-outline editor, circuit helpers |
| `circuits.js` | Circuits list, detail (swipe, info), Play preview, create, delete |
| `leaderboard.js` | `#leaderboard` |
| `app.js` | **Loaded last:** event wiring, service worker, install flow, boot |

**Other tracked files:**
- **Shipped (`app/`):** `index.html`, `privacy.html` (keep its claims true), `styles.css`, `sw.js`, `manifest.json`, the icons, the fallback board image `board-fallback.jpg` (`ProjectBoard.png` is its source, kept for the tools), the fallback board data `hold_map.json`, `mirror_map.json`, `hold_shapes.json`, and Cloudflare's `_headers` and `_redirects`.
- **`app/supabase-js-2.116.0.js`:** vendored and pinned. Never a CDN URL. To upgrade, see overview §4.1.
- **Hosting config:** `build.sh` (the deploy allowlist, copying from `app/`), `wrangler.jsonc`, `app/_headers`, `app/_redirects`, `.gitattributes`.
- **Tools (`tools/`, not deployed):** `register_holds.py`, `register_mirror.py`, `register_shapes.py`, `register_leds.py`, `make_icons.py`, `make_qr.py`, `hold_positions.json`, `led_map.json` (the Pi wiring contract). They find their files relative to themselves and write the bundled data into `app/`. What each does: overview §11.
- **`print/`:** the A5 poster and QR, not deployed. The QR encodes `/scan`; change where it lands in `app/_redirects`, never by reprinting.

**Local only (gitignored):** `db/`, `pi/` (the board listener), `docs/*` except the two committed docs, `reference/original-pi-codebase/dtb/` (Gareth's original code; two register scripts read it by path). Gareth's SD-card image, the rest of its boot partition, the old reverse-engineering and the old LED test scripts are archived outside the repo in `Documents\ProjectBoard-archive\`.

**Deploy:** Cloudflare Workers static assets. Push `dev` → a preview build at the staging URL (not promoted). Merge to `main` → production. `build.sh` wipes and rebuilds `public/` from its allowlist of files in `app/`; anything unlisted never ships. Preview locally with `python -m http.server` inside `app/`. Details: overview §9 and `docs/rollout-plan.md`.

---

## Data traps

- **Problem holds are stored INVERTED.** The migration wrote start/finish back to front. The true order is
  ```js
  order = [finish_hold, ...intermediate_holds, ...start_holds]
  // order[0], order[1] = starts (green, LOW on the wall); order[last] = finish (red, HIGH); the rest = intermediates (blue)
  ```
  Always use `problemHoldOrder()` + `classifyHolds()`. `saveProblem` re-inverts on the way in, and a lone start is duplicated so there are always two. The Pi listener does the same un-invert. Fixing it for good means a data migration **and** a Pi change together.
- **A problem's name is UNIQUE and is the cast key** (the Pi looks it up by name). Names are stored clean, with no embedded grade. Name and grade are independent: never strip a grade in `displayName` or rewrite a name in grade-edit.
- **Grade ladders are also CHECK constraints** (db/29): changing `GRADE_ORDER` or `SPORT_GRADE_ORDER` needs a matching db script, or saves of the new grade fail with `23514`.
- **Grades are stored lowercase** (`5, 5+, 6a, 6a+ … 7c+, 8a`) and **displayed** as capitalised Font grades via `fontGrade()`. Storage, `GRADE_ORDER`, filters and search all stay lowercase. Unknown grades (2 problems are `Project`) sort last.
- **Circuits are different:** a separate lowercase sport ladder (`4, 5a … 8b`, never capitalised), stored in **natural climbing order, not inverted**, as one `hold_sequence` with duplicates allowed, plus `start_count` (1–2) and `loops`.
- **Board orientation: row 1 is at the BOTTOM.** `holdN` is row-major from the bottom-left: `hold1` = A1, `hold19` = S1, `hold20` = A2, `hold247` = S13. `holdN` numbering doesn't map cleanly to visual rows on this hand-set board.
- **Hold positions** come from the live `board_config.hold_map`, with the bundled `hold_map.json` as a fallback. There's no in-app position editor any more (`#calibrate` was replaced by the outline editor on 16 Sep 2026): don't hand-edit the map or re-derive positions from a uniform grid. The live board image is `board.jpg` in Storage, framed differently from the bundled `ProjectBoard.png`: never mix the live map with the bundled image or the other way round.
- **Mirroring is a lookup table** (`board_config.mirror_map`, fallback `mirror_map.json`), keyed by hold id. Never grid arithmetic: the board is staggered. When the Pi listener is rebuilt, feed it the **live** mirror map, not Gareth's raw `MirrorDic.txt`.
- **Hold outlines fit one board version.** The live copy is `board_config.hold_shapes` (db/28), edited and published from the in-app outline editor (`#outlines`, Admin → Trace Holds); `app/hold_shapes.json` is the shipped fallback. `shapesUsable()` falls back to dots unless the live board's `updated_at` matches `__meta.board_updated_at`. **Publishing writes `hold_shapes` alone and must never touch `updated_at`** — bumping the version retires the outlines being published. If the board is ever re-mapped, re-trace (`register_shapes.py`, deploy, then the editor's *Load the shipped copy*) and Publish.
- **Create rules:** the top 25% of the board (by the live map's hold y-span) is the finish zone: exactly one finish, no starts, other holds allowed. Everywhere else, holds cycle start (the first two) → hold → off. A problem needs 1–2 starts, at least one intermediate and one finish.
- **Colours:** start green, intermediate blue, finish red, feet orange.
- **Points come only from the `leaderboard()` RPC.** Never re-implement the formula in JS. **Only benchmarks score** (db/27). Only admins mark a benchmark (detail ⋮ menu), and once a problem is one, only admins can edit or delete it (RLS). Details: overview §4.6.
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
- **DB scripts** live in local `db/`, numbered and idempotent, applied by hand in the SQL editor. 01–29 are applied (29, the row checks on `problems`/`circuits`, on 19 Sep 2026). The index and warnings are in `db/README.md`. A new script takes the next number.
- **Admin** = `profiles.is_admin`. It's set in the Supabase dashboard or in-app through `admin_set_admin()`, which only an existing admin can call and which refuses changing your own flag. **Nobody can promote themselves.**
- **Who can do what:** browsing and casting need no login. Ticking, favourites and creating need sign-in. Admins edit (grade, holds) and delete any problem; an owner can delete their own problem only while nobody else has ticked it. Details: overview §5–6.
- **Direct Postgres** for reviews: `db/.env` → `SUPABASE_DB_URL` (session pooler), via `pg8000`. Default to read-only. How to connect: overview §5.

---

## The cast contract

```javascript
await channel.httpSend('cast_problem',
  { problem_name: 'Good Bug', mirror: true },   // mirror only when the mirrored view is shown
  { timeout: 10000 });
// channel: sb.channel('board:HangoutPortland'), never subscribed: the app holds no socket
```

- `castByName()` in `problems.js` is the only cast path. It runs the geofence check first (lenient; admins bypass), then sends only if the caller's `stillShowing()` says the tapped problem and orientation are still on screen. **Reuse both for the circuit cast.**
- `httpSend` resolving means the **Realtime server** accepted the broadcast, not the Pi. There's no end-to-end confirmation, so never report board-level success.
- **Test casting without the Pi:** `python tools/serve.py`, open `http://localhost:8000/tools/cast-test.html`. It lists every cast on the channel, and *Run checks* drives the local app through the cast cases using fake problem names.
- The Pi listener (`pi/board_listener.py`, local) looks the name up in the `problems` table, applies the mirror map, un-inverts, and lights the LEDs.

---

## Status

**The app** has four tabs (Problems · Circuits · Ranks · Profile) and 11 views; the full route list is in overview §4.3. SW `CACHE` is `pb-v101`. The problem detail bar has a **shuffle** toggle (left of the tick, `shuffleStep()` in `problems.js`): with it on, swiping forward jumps to a random unseen problem in the filtered deck, and swiping back retraces the path (`shuffleBack`/`shuffleFwd`, reset on entering the detail view). It's in-memory only, and circuits don't have it. The splash plays a short CSS-only entrance (the mark draws out from its vertex, a ring of holds casts across the wall, the wordmark settles); the timeline and the `prefers-reduced-motion` fallback are commented at the top of `styles.css`, and `app.js` only adds `.hide`. Hold outlines are drawn as smooth curves: the roundness is set in the outline editor and published as `hold_shapes.__meta.smooth`; `SHAPE_SMOOTH` (0.7) in `core.js` is the default for a set without one. The outline editor (`#outlines`, admin, in `authoring.js`) is built for a phone: pinch/pan, drag points with a magnifier, edge handles to add points, a nudge pad, a live app preview, a localStorage draft (`pb-outline-draft`), and **Publish** writes `board_config.hold_shapes` only, never `updated_at`. It hides the bottom nav and handles every gesture on its stage itself (`touch-action: none`). Pinch and double-tap zoom are disabled app-wide (viewport meta + `html { touch-action }` + an iOS gesture guard at the top of `app.js`), and so is text selection outside inputs (`body { user-select: none }`; `.welcome-url` stays selectable for the in-app-browser copy fallback). The browser's pull-to-refresh is off app-wide (`overscroll-behavior-y: none`, except on iOS, which keeps its bounce and has no pull-to-refresh as an installed app); only the Problems and Circuits lists have one, their own (`.list-pull`, wired in `app.js` via `PULL_LISTS`, calling `refreshProblems()` / `refreshCircuits()`), which re-fetches in place. **Circuits look and behave like problems** (18 Sep 2026): the same grade tabs (tap = one, hold = several), cards with the New badge, a pinned detail view you swipe through, traced outlines over a dimmed board, and an Information item in the ⋮ menu. What's circuit-only is the move-number tags on the holds (`seqTagsHtml`) and the Play panel under the board, whose speed is a Slow → Fast slider (0.2–3.0 s per move, in 0.1 s steps). Keep the two sides in step when either changes.

**Next:**
- **Circuits Phase 2:** the cast screen (5 s countdown + beeps, speed in 0.1 s steps, loop toggle, big STOP), `cast_circuit`/`stop` broadcasts, writing `circuit_logs` (which also activates the circuits "Exclude Done" pill), and the Pi listener update. Spec: `docs/project-notes.md`.
- **Problem name/setter editing** (holds and grade editing are done).
- **Known bugs** to triage: overview §13.

**Don't build yet:** Circuits Phase 3 (PBs, leaderboards), tags, session/logbook tracking beyond ticks, the Flutter migration.

**Waiting on Ross:** email (custom SMTP) before password reset and email confirmation go live (overview §12), Cloudflare *Always Use HTTPS* (overview §8), and checking the geofence centre on-site.

---

*Rewritten 11 September 2026: cut from 96 KB to rules and pointers. The same day the repo was tidied into `app/` (the website) and `tools/`, without changing a deployed byte. The old build history is in `docs/changelog.md` (local) and in git. Maintained by Ross (rlmck).*
