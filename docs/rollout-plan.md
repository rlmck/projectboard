# Public rollout: custom domain, Cloudflare Workers, QR → install flow

**Status:** Part A and B1 are complete. B2–B4 are done on `dev` (awaiting staging check + merge). B5 onwards is outstanding.
**Live:** https://symmetryboard.co.uk
**Staging:** https://dev-projectboard.rosslewismckechnie.workers.dev (stable per-branch preview; see Hosting below)

## Context
Project Board was served from `rlmck.github.io/projectboard`, straight from `main` on GitHub Pages. It now has a custom domain on Cloudflare and a staging branch. The remaining work is the install experience: a QR code beside the symmetry board that opens a professional-looking site and gets climbers to install the PWA on Android and iOS, plus moving existing github.io users across.

**Decisions made:**
- Domain: **symmetryboard.co.uk**, bought at Cloudflare Registrar.
- Hosting: **Cloudflare Workers with static assets** (not Cloudflare Pages — see Hosting).
- The QR opens a **full-screen welcome/install screen inside the app** (no separate marketing site).
- Staging: a `dev` branch deploys to a stable preview URL; merging to `main` makes it live.

**Existing users:** some people already have the github.io link, and some have the PWA installed from it. An installed PWA is tied to its origin, so it **can't be moved automatically** to a new domain. Part C keeps the old URL working as a redirect / "we've moved" point. For existing users, only two things change: they sign in again, and they swap home-screen icons. Nothing is lost:
- Accounts, ticks, favourites and created problems all live in Supabase.
- The only per-device state is the Supabase session and the `pb-install-dismissed` flag, both in localStorage ([app.js:482](app.js:482), [state.js:8](state.js:8)).

⚠️ **Supabase, not Firebase.** An older symmetry-board project has similar-looking tables in Firebase. When verifying that data carried over, make sure you are looking at Supabase (project `uqirowyfqwiceyjznosl`).

**What exploration found (these shape the plan):**
- All app paths are relative (`manifest.json` `start_url: "."`, `sw.js` `./…`, `register('sw.js')`). OAuth `redirectTo` is `location.origin + location.pathname` ([account.js:235](account.js:235)). Moving from `/projectboard/` to a root domain needed **no path changes** — confirmed in practice.
- **Icons aren't good enough for a public launch.** `apple-touch-icon` is `icon.svg` ([index.html:13](index.html:13)), but iOS ignores SVG touch icons and uses a page screenshot as the home-screen icon. The manifest has only the SVG (`"any maskable"` combined, which is discouraged) plus the non-square `ProjectBoard.png`. Also, `.gitignore` has `*.png`, so any new PNGs need exceptions.
- **A service-worker bug gets triggered by adding a second page.** The navigate branch in [sw.js:60-69](sw.js:60) caches *every* navigation response as `./index.html`. Opening `privacy.html` (or `trace_holds.html`) would overwrite the cached app shell, so an offline launch would show the wrong page.
- The install UX today is a small banner ([app.js:474-519](app.js:474), `#install-banner` [index.html:526](index.html:526)): `beforeinstallprompt` on Android, one line of text on iOS. It gets reused and extended, not replaced.
- The whole repo root was published on GitHub Pages, including `CLAUDE.md`, `*.py`, `led_map.json` and so on. The `build.sh` allowlist now keeps those off the new domain.

---

## Hosting: why Workers, not Pages
Cloudflare has merged Pages into Workers in the dashboard. New projects created via **Create an app → Connect to Git** are Workers projects, and Cloudflare recommends Workers over Pages for new work. The practical differences from the original plan:

- There is **no "build output directory" dashboard field**. The assets directory is set in `wrangler.jsonc` (`assets.directory: "./public"`) instead.
- The repo **must contain a Wrangler config file**. Without one, `wrangler deploy` triggers automatic framework detection and opens a pull request instead of deploying.
- `_headers` and `_redirects` work natively, same filenames, same location (inside the assets directory). No change needed.
- **Preview URLs:** each branch gets a stable alias automatically — `<branch>-<worker-name>.<subdomain>.workers.dev`. For `dev` that is `dev-projectboard.rosslewismckechnie.workers.dev`, and it stays the same across every commit to the branch. Preview builds use `wrangler versions upload`, which uploads a version **without promoting it**, so pushing to `dev` never affects production.

Build settings in the dashboard: build command `bash build.sh`, deploy command `npx wrangler deploy`, non-production branch builds enabled, Cloudflare Access off.

---

## Part A: dashboard work — ✅ DONE
1. ✅ Domain `symmetryboard.co.uk` bought at Cloudflare Registrar.
2. ✅ Cloudflare Worker `projectboard` created, git-connected to `rlmck/projectboard`, production branch `main`, custom domain live.
   - ⬜ **Outstanding:** `www.symmetryboard.co.uk` redirect rule to the apex.
   - ✅ Web Analytics (cookieless, injected automatically, no consent banner needed) — turned on.
   - ⬜ **Outstanding, needed before B4:** Email Routing `hello@symmetryboard.co.uk` → Gmail. The privacy page and Google branding both reference this address.
3. ✅ **Supabase → Auth → URL Configuration**: Site URL `https://symmetryboard.co.uk`; redirect URL `https://symmetryboard.co.uk/**` added; github.io entry retained.
   - ⬜ **Before testing B2–B5 on staging:** add `https://dev-projectboard.rosslewismckechnie.workers.dev/**`, or `https://*-projectboard.rosslewismckechnie.workers.dev/**` to cover all branch previews. Without this, Google sign-in on staging bounces to production.
   - ⬜ **At cutover:** remove the github.io entry, but only once the "moved" page is live (Part C).
4. ✅ **Google Cloud → Google Auth Platform**: branding set (app name "Project Board", support email, home page, privacy policy URL, authorised domain); app published out of Testing.
   - Note: the privacy policy URL 404s until B4 ships.
   - Optional: brand verification via Search Console so the consent screen shows "Project Board" rather than `uqirowyfqwiceyjznosl.supabase.co`.

## Part B: the code

**B1. Hosting infrastructure** — ✅ DONE (commits `b43b884`, `3325c51`, on `main`)
- `wrangler.jsonc`: name `projectboard`, `assets.directory: "./public"`, no `main`, no `not_found_handling` (so unmatched paths 404 rather than serving the app shell).
- `build.sh`: `set -euo pipefail`, wipes and rebuilds `public/` from an explicit allowlist. A missing allowlisted file fails the build loudly (verified).
  - Current allowlist (28 files after B4): `index.html privacy.html trace_holds.html styles.css state.js core.js problems.js admin.js account.js authoring.js circuits.js leaderboard.js app.js sw.js manifest.json icon.svg icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png screenshot-list.png screenshot-detail.png hold_map.json mirror_map.json hold_shapes.json ProjectBoard.png _headers _redirects`
  - `led_map.json` is deliberately excluded — it is the Pi wiring contract and the app never fetches it.
- `_headers`: `no-cache` on `/sw.js` and `/index.html`; site-wide `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(self)` (the cast geofence needs geolocation).
- `_redirects`: `/scan  /?src=qr  302`. **The printed QR encodes `https://symmetryboard.co.uk/scan`**, so where it points can be changed later without reprinting.
- `.gitignore`: `public/` added.
- `.gitattributes`: `build.sh`, `_headers`, `_redirects` pinned to `text eol=lf`, so a fresh Windows clone doesn't produce a CRLF `build.sh` that Git Bash refuses to run.

> **Rule for every later session: a new deployable file must be added in three places —**
> **`build.sh` allowlist, `sw.js` ASSETS, and referenced from `index.html`.**
> Miss the first and the build fails; miss the second and it won't work offline.
> **Exception:** the manifest `screenshot-*.png` files are `build.sh` only, not in `sw.js` ASSETS. Only the online install sheet uses them, so precaching would add ~350 KB to every install and cache bump for nothing (decided in B2).

**B2. Icons + manifest + head** (`dev`) — ✅ DONE on `dev` (not yet merged to `main`)
- **What shipped / deviations from the spec below:**
  - `.gitignore` also needed `!screenshot-*.png` (the screenshots are PNGs too), and `docs/` became `docs/*` + `!docs/rollout-plan.md` so this plan file can be committed. Git can't re-include a file inside an ignored directory, so `docs/` alone would have blocked it. The rest of `docs/` stays ignored.
  - Maskable glyph drawn at 80% scale: it reaches 56% of the half-width, well inside the 80% safe zone (`make_icons.py` asserts this).
  - Screenshots: 824×1830 (412×915 CSS px at DPR 2), captured from a local build with headless Chrome using CDP mobile emulation, as a guest, with the install banner suppressed. They're 256-colour quantized (~50 KB + ~300 KB), which is visually identical and half the size. They're in the `build.sh` allowlist but **deliberately not in `sw.js` ASSETS** (see the exception under the three-places rule). The detail shot is *Cool Curve* (6A+). Re-capture by hand if the list/detail UI changes a lot.
  - `og:image` uses `icon-maskable-512.png` (opaque) rather than `icon-512.png` (transparent corners render oddly in some link previews). OG URLs are absolute, so they always point at production.
  - `sw.js` `CACHE` bumped `pb-v71` → `pb-v72`, since the ASSETS list changed (the four icons were added).
  - Verified locally in Chrome: zero manifest errors, zero installability errors, every icon and screenshot decodes at its declared size, and the SW activates with every ASSET precached.
- ⚠️ **First:** `.gitignore` has `*.png`. Add exceptions `!icon-*.png` and `!apple-touch-icon.png`, or the generated icons will be silently ignored and never commit. This was missed in B1.
- `make_icons.py` (Pillow; it redraws the simple `icon.svg` geometry) outputs:
  - `icon-192.png` and `icon-512.png` (purpose `any`)
  - `icon-maskable-512.png` (full-bleed background, glyph inside the 80% safe zone)
  - `apple-touch-icon.png` 180×180 (full-bleed, since iOS applies its own mask)
- `manifest.json`: add `"id": "./"`, split the `any`/`maskable` icon entries, drop `ProjectBoard.png` as an icon. Add 2 `screenshots` (form_factor `narrow`, captured at a mobile size: list and detail) to get Android's richer install sheet.
- `index.html` head: PNG `apple-touch-icon`, `<meta name="description">`, and basic Open Graph tags so a shared link previews nicely.
- Add all new PNGs to the `build.sh` allowlist and `sw.js` ASSETS (the screenshots went in `build.sh` only; see above).

**B3. Welcome / install screen** (`dev`, the core of the "landing page") — ✅ DONE on `dev`
- **What shipped / deviations from the spec below:**
  - The **Privacy link is added in B4**, together with `privacy.html`, so B3 never ships a link that 404s.
  - Context names in code: `standalone`, `in-app`, `ios`, `android-prompt`, `desktop` (`installContext()` in `app.js`). iPadOS (Mac UA + touch) counts as `ios`.
  - The small banner now keys off the same context. Its iOS instructions no longer appear inside Instagram/Facebook webviews, which used to match the old `isIOS()` but can't install. Desktop banner behaviour is unchanged: it still appears when Chrome fires `beforeinstallprompt`.
  - Android panel: shows **Install app** once `beforeinstallprompt` arrives, "Getting the app ready…" while waiting, and the manual ⋮ steps after ~3s or after the prompt is dismissed (a captured prompt can only be used once). If the prompt arrives late, the panel upgrades back to the button.
  - In-app panel: **Copy link** tries the async clipboard API, then falls back to `execCommand('copy')`; failing both, it leaves the URL selected for a long-press copy. It reports inline ("Copied ✓"), because the toast sits under the overlay.
  - `appinstalled` also sets `pb-welcome-seen`, so the welcome doesn't come back in the browser tab after installing.
  - Stacking: `#welcome` is `z-index: 900`, above modals (300) and toast (200) but below `#splash` (1000). Scroll-contained on short phones.
  - Tested in headless Chrome across 12 scenarios, checking what's actually rendered: Android with and without a prompt, iOS, iOS already seen, iOS seen but `?src=qr`, Instagram, an Android `; wv)` webview, the `?src=moved` deep link, OAuth params preserved (`?src=qr&code=…#list` → `?code=…#list`), desktop (no welcome), and repeat visits (banner instead). Real-device checks are still pending (see Verification).
- Markup: a new full-screen `#welcome` overlay in [index.html](index.html), next to `#splash`. It shows the icon, "Project Board", and a one-line pitch ("The Hangout's symmetry board: browse problems, light them up, tick your sends"), then platform-specific content, then a "Continue in browser" link and a small Privacy link. Styles go in [styles.css](styles.css), matching the existing dark palette and `#install-banner` look.
- Logic: refactor the install block in [app.js:474-519](app.js:474) so the banner and welcome share one `deferredPrompt` and a `promptInstall()` function. Add `installContext()`, which returns one of:
  - `standalone`: never shown.
  - `android-prompt`: big **Install app** button → `prompt()`. If `beforeinstallprompt` hasn't fired after about 3s, fall back to "tap ⋮ → Install app".
  - `ios`: illustrated steps with an inline Share-icon SVG: "Tap Share (or ⋯ → Share) → Add to Home Screen → Add". Safari, and Chrome/Edge on iOS 16.4+, all use the share sheet.
  - `in-app browser` (Instagram/Facebook/Snapchat UA, or Android `; wv)`): "Open in Safari/Chrome to install", with a copy-link button.
  - `desktop`: never shown. Laptop admin work stays untouched.
- **`?src=moved` variant** (for people arriving from the old github.io link, Part C): the headline becomes "Project Board has moved here". Body: "Install it from this page, then delete the old icon from your home screen. Your account, ticks and favourites are safe; just sign in again."
- When it appears: on mobile, not standalone, **and** (arrived via `?src=qr` / `?src=moved` **or** first visit, i.e. the `pb-welcome-seen` localStorage key is unset). Read `src`, then remove **only that param** with `URLSearchParams` + `history.replaceState`, which leaves Supabase's OAuth params alone. That way iOS saves the clean root URL. On any load where the welcome shows, the small banner stays hidden. "Continue in browser" sets `pb-welcome-seen` but not the banner's dismiss key, so the banner can still act as a gentle reminder later. `appinstalled` switches the welcome to "Installed ✓, open Project Board from your home screen".
- It's an overlay, not a routed view, so `router()`/`setView` and the hash don't change. The splash fades to reveal it.

**B4. Privacy page + SW fix** (`dev`) — ✅ DONE on `dev`
- **What shipped / deviations from the spec below:**
  - **The app shell is cached as `./`, not `./index.html`.** Cloudflare 307s `/index.html` → `/`, so the old precache of `./index.html` stored a *redirect*, and a redirect can't answer a navigation. An offline launch before the first online load would have failed. `./index.html` is out of ASSETS, and the navigate branch writes the shell under `./` only for the scope root or `index.html` (any query string is fine).
  - Other pages (`privacy.html`, `trace_holds.html`) are cached under their own URL and fall back to their own copy offline. If a page was never cached, the fallback is the browser's offline error, **not** the app shell, so the wrong page is never shown.
  - Only a plain same-origin 200 (not an error page, not a redirect) is written to the cache. The old branch cached every navigation response, 404s included.
  - `_headers`: the `no-cache` rule moved from `/index.html` (which only ever matched the redirect) to `/`.
  - `CACHE` `pb-v72` → `pb-v73`.
  - Tested locally against a server that copies Cloudflare's 307, with offline = server shut down. **Fresh install:** the shell is cached once as a plain 200; visiting `privacy.html` leaves it intact; offline, `/`, `/?src=qr`, `/index.html` and `/#detail/…` open the app, `/privacy.html` opens the privacy page, and an uncached `/trace_holds.html` gets the browser's offline error. **Upgrade from B3:** the `pb-v72` cache (including its redirected `/index.html` entry) is deleted, and offline `privacy.html` now shows the privacy page (B3 showed the app).
  - Privacy copy was checked against the code: location is compared on-device, held ≤60s in memory, and never sent; the cast payload carries no user identity; the leaderboard publicly shows display name, points and send count; on account deletion, problems keep the setter-name snapshot.
  - Data controller named on the page: **Ross McKechnie**, contact `hello@symmetryboard.co.uk`. The analytics line stays as written, since Web Analytics is on.
  - ⚠️ **Before merging to `main`:** `hello@symmetryboard.co.uk` must exist (Part A2 Email Routing). The privacy page gives it as the only contact.
- Requires `hello@symmetryboard.co.uk` to exist (Part A2).
- `privacy.html`: a static page in the same dark style. It covers:
  - What's stored: email, display name, ticks, favourites, created problems/circuits.
  - Location: used on the device only, at cast time, for the gym geofence. Never stored or sent.
  - Processors: Supabase (London), Google sign-in, Cloudflare hosting/analytics. No tracking cookies.
  - Contact / account-deletion requests go to `hello@symmetryboard.co.uk`.
- Link it from the welcome screen and from a static footer under `#profile-content` in `#view-profile` ([index.html:211](index.html:211)).
- Add `privacy.html` to the `build.sh` allowlist and `sw.js` ASSETS.
- [sw.js](sw.js) navigate branch: write to the `./index.html` cache **only** when the path is the scope root or `index.html`. Other navigations go network-first with `caches.match(req)` as the fallback.
- **Bump `CACHE` again in B4: `pb-v72` → `pb-v73`.** B2's bump to `pb-v72` doesn't cover B4. B4 changes the ASSETS list (adds `privacy.html`) and the fetch logic, so installed clients need a new cache version to pick it up.

**B5. QR code + poster** (`dev`, not deployed)
- `make_qr.py` (`segno`) → `print/qr-scan.svg` for `https://symmetryboard.co.uk/scan`: error-correction level Q, 4-module quiet zone, black on white (inverted/dark QRs fail on some scanners).
- `print/poster.html`: an A5 poster with a big QR, "Scan to get Project Board: free for iPhone & Android", the short URL as text for people who'd rather type it, and a two-line iOS/Android hint. Print to PDF from the browser.
- Printing: 6–8 cm QR, matte lamination (gloss glares under gym lights), mount at chest height beside the board.
- `print/` stays out of the `build.sh` allowlist.

**B6. Docs** (`dev`)
- [CLAUDE.md](CLAUDE.md):
  - Live URL `https://symmetryboard.co.uk`; staging `https://dev-projectboard.rosslewismckechnie.workers.dev`.
  - Rewrite working rule 2: work on `dev` → push → test on the branch preview → merge to `main` only when approved.
  - Key files: the `build.sh` allowlist and the three-places rule, `wrangler.jsonc`, `_headers`, `_redirects`, `privacy.html`, icons, `print/`.
  - Add a hosting section: Cloudflare Workers with static assets; **`legacy` branch = permanent github.io redirect; never delete it; repo stays public**.
  - Replace the "not yet public, no users" line: there are real users now, so changes go through staging.
  - **Manifest screenshots are hand-captured.** `screenshot-list.png` and `screenshot-detail.png` are static images from B2, so they don't update themselves: regenerate them whenever the list or detail view changes materially, or Android's install sheet will show a stale app. Record how they were made (412×915 CSS px at DPR 2, CDP mobile emulation, guest, install banner suppressed, 256-colour quantized) and that they're `build.sh`-only, not in `sw.js`.

## Part C: Moving existing users off github.io
The old URL **keeps being served by GitHub Pages permanently**, but from an orphan **`legacy` branch** that contains only a "moved" site. `main` no longer feeds GitHub Pages; it feeds Cloudflare only.

**C1. `legacy` branch** (`git switch --orphan legacy`). It contains `index.html`, `404.html` (a copy of index.html), `sw.js`, `icon.svg` and `.nojekyll`, and **no `manifest.json` link**, so nobody can install the old origin again. The page behaves differently depending on how it's opened:
- **In a normal browser tab** (old bookmark or shared link): immediate `location.replace('https://symmetryboard.co.uk' + path + '?src=moved' + hash)`, where `path` is the old path with the `/projectboard` prefix stripped. The hash is kept, so a shared `#detail/<id>` deep link still lands on the same problem. There's also a `<meta refresh>` + canonical fallback, and `404.html` does the same, so `/projectboard/privacy.html` and similar paths also map across.
- **Inside the old installed app** (`display-mode: standalone` / `navigator.standalone`): **no auto-redirect.** From a standalone PWA, a cross-origin jump opens in an in-app browser sheet that can't install. Instead it shows a clear **"Project Board has moved"** screen:
  - The new address, shown large, with a **Copy link** button and an **Open** link (`target=_blank`).
  - Platform steps. iOS: "Open Safari → go to symmetryboard.co.uk → Share → Add to Home Screen, then press-and-hold this old icon → Delete". Android: "Open in Chrome → Install, then long-press this old icon → Uninstall".
  - Reassurance that their account, ticks and favourites carry over; they just sign in again.
- **Replacement "tombstone" `sw.js`** (same filename and scope as the old worker):
  - `install`: precache only the moved page, then `skipWaiting`.
  - `activate`: **delete all `pb-v*` caches**, then `clients.claim()`.
  - `fetch`: navigations go network-first with the cached moved page as the fallback.

**How existing installs pick it up (no action needed from users):** the old app registered its worker with `updateViaCache:'none'`, fetches the page network-first, and calls `reg.update()` on launch and on focus ([app.js:461-469](app.js:461)).
- The next time someone opens the old icon online, the navigation returns the moved page, and the tombstone worker installs and wipes the old app's caches.
- If the old app is open when the swap lands, its existing `controllerchange` auto-reload ([app.js:445](app.js:445)) takes it to the moved page. That reload waits if the user is mid-way through a create form.
- After that, even **offline** launches show the moved screen, not a stale copy of the old app.
- GitHub Pages sends `max-age=600`, so everyone has switched within about 10 minutes of the swap.

**C2. Cutover order** (after staging is signed off):
1. Merge `dev` → `main`. Cloudflare deploys to symmetryboard.co.uk. Check Google sign-in works there.
2. Push the `legacy` branch, then switch **Settings → Pages → Source** to `legacy` / root. Don't dawdle between steps 1 and 2: until Pages is flipped, `main` still feeds github.io, so the new welcome screen would briefly appear on the old origin.
3. Check the old URL (see Verification). Then remove github.io from Supabase's redirect list and print the poster.
4. Swap your own icons the same way everyone else will: open the old app, see the moved screen, install the new one, delete the old one.
5. Optional: tell regulars directly (gym WhatsApp/socials: "new address, reinstall once"). The moved screen handles anyone who misses it.

**Keep the redirect running for good:**
- Never delete the `legacy` branch or disable GitHub Pages.
- Free GitHub Pages needs a **public** repo, so the repo stays public. Nothing secret is in it, and the `build.sh` allowlist keeps `CLAUDE.md` and friends off the new domain.
- If you later want the app repo private: rename it (e.g. `projectboard-app`) and create a new tiny public `rlmck/projectboard` repo holding just the `legacy` content, since the github.io path follows the repo name. Only do this after checking Cloudflare still builds from the renamed repo.

## Verification
- **Staging:** on `dev-projectboard.rosslewismckechnie.workers.dev`:
  - Android Chrome shows the Install button and the rich sheet with screenshots; the installed icon is correct.
  - iPhone Safari: follow the on-screen steps and check the home-screen icon is the PNG, not a screenshot, and it opens standalone at `/` with no `?src`.
  - In-app browser path: open the link from Instagram or a similar app.
  - Google sign-in round-trips back to the preview URL (requires the Supabase entry from Part A3).
  - Offline launch after visiting `privacy.html` still opens the app.
  - `/CLAUDE.md` and `/register_holds.py` return 404.
  - `/scan` goes to `/?src=qr` with a 302.
- **Existing-user transition.** Before cutover, install the *current* github.io app on a test Android phone and a test iPhone (and sign in) to act as a "legacy user". Before switching GitHub Pages over for real, serve the `legacy` content from a throwaway fork's Pages and check it there. After the swap:
  - Opening each old icon shows the moved screen within one launch, and still shows it in airplane mode, with no old app code loading.
  - Following the steps installs the new app, and signing in there shows the same ticks and favourites — **check this in Supabase, not the old Firebase project**.
  - In a desktop/mobile browser tab, `rlmck.github.io/projectboard/#detail/<id>` lands on `symmetryboard.co.uk/#detail/<id>` with the "moved" welcome, and `/projectboard/privacy.html` maps to `symmetryboard.co.uk/privacy.html`.
- **QR:** scan the printed test page with both the iOS and Android camera apps, from about 1 m, under gym lighting.
- **Headers:** `curl -I https://symmetryboard.co.uk/sw.js` shows `no-cache`. Web Analytics records the visits.
- ⚠️ Staging shares the **live Supabase DB**, and you are an admin, so the geofence doesn't apply. Test problems and casts made on staging are real. Delete test data and don't cast unintentionally.

## Open decisions
- **`trace_holds.html` on the public host.** It is currently in the `build.sh` allowlist, so it ships and is reachable by URL guess — the same as it was on github.io, so not a regression, but newly explicit. Options: leave it, drop it from the allowlist and run it locally, or gate it behind the app's existing admin check.

## Pre-launch gaps (not part of this plan; separate tasks)
- **No "forgot password" flow.** Supabase's built-in email only delivers to project team members, so public password resets need a custom SMTP (e.g. Resend) on symmetryboard.co.uk.
- The **geofence centre** is still unverified on-site.
- The manifest's `"orientation": "portrait"` locks the installed Android app to portrait, which stops the landscape auto-fullscreen on detail views from ever triggering there.
