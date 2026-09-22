// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file: escape/toast/render helpers, hold + board-overlay helpers, and hash routing.

  // ── Escape helpers ───────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Toast helper ─────────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 2800);
  }

  // ── localStorage, guarded ────────────────────────────────────────────────────
  // The accessor itself throws (SecurityError) where site data is blocked: cookies
  // blocked for the site, some webviews, some private modes. Nothing stored here is
  // essential, so a failed read is "not set" and a failed write is dropped.
  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  // ── Saved lists (offline) ────────────────────────────────────────────────────
  // The last problems, circuits and setter names that loaded, kept on this device.
  // At start-up they show at once while the fresh copy loads (weak gym Wi-Fi), and
  // if the fetch fails they stay up with a note (offline, Supabase down). All of it
  // is public data, so nothing needs clearing on sign-out. { t, rows }.
  const SAVED_KEYS = { problems: 'pb-saved-problems', circuits: 'pb-saved-circuits', names: 'pb-saved-names' };
  function saveList(kind, rows) {
    lsSet(SAVED_KEYS[kind], JSON.stringify({ t: Date.now(), rows }));
  }
  function savedList(kind) {
    try {
      const v = JSON.parse(lsGet(SAVED_KEYS[kind]) || 'null');
      return v && v.rows && typeof v.t === 'number' ? v : null;
    } catch (e) { return null; }
  }

  function savedWhen(t) {
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const d = new Date(t);
    return d.toDateString() === new Date().toDateString()
      ? 'at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : 'on ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // The note above a list that says it's the saved copy. t = when it was saved;
  // 0 hides the note (the fresh list is showing).
  function setOfflineNote(id, t) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !t;
    if (t) el.textContent = `Offline: showing the list saved ${savedWhen(t)}. Pull down to try again.`;
  }

  // ── Small render helpers ─────────────────────────────────────────────────────
  function starsHtml(n) {
    n = Math.max(0, Math.min(3, Number(n) || 0));
    let out = '';
    for (let i = 0; i < 3; i++) {
      out += i < n ? '<span class="star-on">★</span>' : '<span class="star-off">☆</span>';
    }
    return `<span class="stars" title="${n} star${n !== 1 ? 's' : ''}">${out}</span>`;
  }

  // The benchmark mark: a solid gold disc with a star cut out of the centre (one
  // path; evenodd makes the star a hole, so the background shows through). Used on
  // list cards and in the detail badge. A benchmark is a high-quality problem
  // that's accurate at its grade; only benchmarks score points (db/27).
  function benchMarkSvg() {
    return '<svg class="bench-mark" viewBox="0 0 24 24" role="img" aria-label="Benchmark">' +
      '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z' +
      'M12 6.3 13.5 10.44 17.9 10.58 14.43 13.29 15.64 17.52 12 15.05 8.36 17.52 9.57 13.29 6.1 10.58 10.5 10.44Z"></path></svg>';
  }

  // "New" badge: shown for NEW_DAYS after a row's created_at. The migrated
  // problems all share one import date (20 May 2026), so they're never new.
  const NEW_DAYS = 14;
  function isNew(row) {
    const t = Date.parse(row && row.created_at);
    return Number.isFinite(t) && Date.now() - t < NEW_DAYS * 86400000;
  }
  function newBadgeHtml(row) {
    return isNew(row) ? '<span class="new-badge" title="Set in the last 2 weeks">New</span>' : '';
  }

  // The problem's display name — just the stored name, trimmed. Name and grade are
  // independent: the grade is shown separately as a badge, so editing a climb's
  // grade never changes its name. (Names are stored clean — the original migration
  // stripped the embedded grade from every row, verified across all of them.)
  // This used to re-strip the current grade off the name on every render, which
  // wrongly coupled the two — a name ending in its own grade token, e.g.
  // "It's a 5" at grade 5, would lose the token and display as "It's a".
  function displayName(p) {
    return String(p.name || '').trim() || '(unnamed)';
  }

  // The setter to show. App-created problems carry setter_id (the owner's account
  // id), so we resolve the *live* display name from profileNames — that way a rename
  // propagates everywhere. Legacy/migrated rows have no owner, so fall back to the
  // text setter captured at creation.
  function setterName(p) {
    if (p.setter_id && profileNames[p.setter_id]) return profileNames[p.setter_id];
    return p.setter || 'unknown';
  }

  // Normalise text for searching: lowercase, fold accents, then drop everything
  // that isn't a letter or digit (spaces and punctuation included). So a query
  // of "its" matches "It's a crimpy one", "left hand" matches "Left-Hand", etc.
  function searchNorm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '') // strip combining accent marks
      .replace(/[^a-z0-9]/g, '');      // drop spaces + punctuation
  }

  // Display a hold id compactly: "hold235" -> "235", otherwise raw.
  function holdNum(id) {
    const m = /^hold(\d+)$/i.exec(String(id));
    return m ? m[1] : String(id);
  }

  // Grid name for a hold number: hold1 -> A1, hold19 -> S1, hold20 -> A2, hold243 -> O13.
  // 19 columns (A–S) × 13 rows, numbered row-major. Labels holds in the outline editor.
  function gridName(n) {
    n = +n;
    if (!n || n < 1) return 'hold' + n;
    return String.fromCharCode(65 + (n - 1) % 19) + (Math.floor((n - 1) / 19) + 1);
  }

  // The Supabase migration assigned start_holds/finish_hold back-to-front vs the
  // original DTB order (proven against test.csv + the joe smells 2.0 cast). Rebuild
  // Gareth's true order — finish first, then intermediates, then the two starts —
  // so the low holds come out green and the top hold red, matching the real board.
  function problemHoldOrder(p) {
    const f = p.finish_hold ? [p.finish_hold] : [];
    const mid = Array.isArray(p.intermediate_holds) ? p.intermediate_holds : [];
    const s = Array.isArray(p.start_holds) ? p.start_holds : [];
    return f.concat(mid, s);
  }

  // hold id -> 'start' | 'int' | 'finish' (first two = starts, last = finish).
  function classifyHolds(order) {
    const cls = {};
    order.forEach(h => { if (!(h in cls)) cls[h] = 'int'; });
    order.slice(0, 2).forEach(h => { cls[h] = 'start'; });
    if (order.length) cls[order[order.length - 1]] = 'finish';
    return cls;
  }

  // A hold's left/right mirror partner (board_config.mirror_map, else the bundled
  // mirror_map.json). Self for centre-line holds and any hold without a real
  // partner, so mirroring leaves them in place. Falls back to the hold itself if
  // the map hasn't loaded.
  function mirrorHold(h) {
    return (MIRROR_MAP && MIRROR_MAP[h]) || h;
  }

  // Coloured dots positioned over the board from hold_map.json (loaded async).
  // When `mirror` is set, each hold is drawn at its mirror partner's position —
  // roles are preserved (mirroring is symmetric, so starts stay starts).
  function boardOverlayHtml(p, mirror = false) {
    const order = problemHoldOrder(p);
    if (!HOLD_MAP || !order.length) return '';
    const cls = classifyHolds(order);
    const seen = new Set();
    const dots = order.filter(h => (seen.has(h) ? false : seen.add(h))).map(h => {
      const pos = HOLD_MAP[mirror ? mirrorHold(h) : h];
      if (!pos) return '';   // hold has no mapped dot (board gap) — skip
      return `<div class="hold-dot ${cls[h]}" style="left:${pos.x}%;top:${pos.y}%"></div>`;
    }).join('');
    return `<div class="hold-layer">${dots}</div>`;
  }

  // ── Hold-shape overlay (problems and circuits) ───────────────────────────────
  // Draws each used hold as its *real traced outline* (hold_shapes.json) instead
  // of a circle, and on the detail view dims the rest of the board so only the
  // used holds stay bright. Returns null when shapes can't be used so callers
  // fall back to boardOverlayHtml().
  //
  // Shapes are traced (register_shapes.py / the #outlines editor) against ONE specific
  // board — the LIVE board_config image + hold map — and hold_shapes.json records
  // that board's updated_at in __meta.board_updated_at. They only fit that board,
  // so the overlay stays off unless board_config supplied the map AND its version
  // still matches the traced one. That covers the offline/bundled fallback (the
  // bundled ProjectBoard.png has different framing) and a board that has been
  // re-mapped since — which bumps updated_at and drops everyone back to the
  // always-correct dot overlay until the shapes are re-traced and published.
  let hsMaskSeq = 0;
  function shapesUsable() {
    if (!HOLD_SHAPES || !HOLD_MAP) return false;
    const meta = HOLD_SHAPES.__meta;
    if (!meta || !meta.board_updated_at) return false;
    // The outlines must belong to the board the map in use came from: the live
    // board, or (offline) the one the bundled snapshot was taken from.
    const mapVersion = configHasMap ? boardConfigVersion : bundledMapVersion;
    if (meta.board_updated_at !== mapVersion) return false;
    return Object.keys(HOLD_SHAPES).length > 1;      // more than just __meta
  }

  // Traced outlines are drawn as a closed Catmull-Rom curve through every traced
  // point, not straight segments. The tension runs 0 = the straight polygon to
  // 1 = fully rounded (can bulge a little past the traced points). It is set in
  // the #outlines editor and published with the outlines as __meta.smooth;
  // SHAPE_SMOOTH is the default for a set without one (e.g. the bundled file).
  // The viewBox is stretched, but the curve is affine-invariant so it stays true.
  // The editor passes its own unpublished `smooth`; everything else uses the set's.
  const SHAPE_SMOOTH = 0.7;
  function shapeSmooth() {
    const s = HOLD_SHAPES && HOLD_SHAPES.__meta && HOLD_SHAPES.__meta.smooth;
    return (typeof s === 'number' && s >= 0 && s <= 1) ? s : SHAPE_SMOOTH;
  }
  function smoothShapePath(pts, smooth = shapeSmooth()) {
    const n = pts.length, k = smooth / 6;
    const f = v => +v.toFixed(3);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += `C${f(p1[0] + (p2[0] - p0[0]) * k)},${f(p1[1] + (p2[1] - p0[1]) * k)}`
        + ` ${f(p2[0] - (p3[0] - p1[0]) * k)},${f(p2[1] - (p3[1] - p1[1]) * k)}`
        + ` ${f(p2[0])},${f(p2[1])}`;
    }
    return d + 'Z';
  }

  // roles: { holdId -> 'start' | 'int' | 'finish' }. `mirror` pulls each hold's
  // position AND shape from its mirror partner (roles preserved). `dim` adds the
  // darken-the-rest mask (detail views); create/edit passes dim:false so the whole
  // board stays visible. `fresh` (a hold id) marks the hold the circuit Play
  // preview has just lit, which pulses once. A used hold with no traced polygon
  // falls back to a dot.
  // The mask lives in its OWN svg so the outline svg can carry a plain CSS
  // drop-shadow: a CSS filter on an svg *child* resolves its lengths in the
  // stretched viewBox units, but on the outermost svg it resolves in CSS pixels.
  function holdShapeLayerHtml(roles, { mirror = false, dim = false, fresh = null } = {}) {
    if (!shapesUsable()) return null;
    const maskId = 'hsmask-' + (++hsMaskSeq);
    // viewBox is 0..100 on both axes with preserveAspectRatio:none, so a <circle>
    // would paint as an ellipse. Scale ry by the board aspect (w/h) to get a dot
    // that is round on screen, matching the .hold-dot it stands in for.
    const rx = 2.3, ry = +(rx * (boardAspect || 1)).toFixed(2);
    const holes = [], outlines = [];
    Object.keys(roles).forEach(h => {
      const key = mirror ? mirrorHold(h) : h;
      const pts = HOLD_SHAPES[key];
      const pos = HOLD_MAP[key];
      const role = roles[h] + (h === fresh ? ' hs-fresh' : '');
      if (pts && pts.length >= 3) {
        const d = smoothShapePath(pts);
        holes.push(`<path d="${d}" fill="#000"/>`);
        outlines.push(`<path d="${d}" class="hs ${role}"/>`);
      } else if (pos) {                       // no traced shape yet — show a dot
        const e = `cx="${pos.x}" cy="${pos.y}" rx="${rx}" ry="${ry}"`;
        holes.push(`<ellipse ${e} fill="#000"/>`);
        outlines.push(`<ellipse ${e} class="hs ${role}"/>`);
      }
    });
    const dimSvg = dim
      ? `<svg class="hold-shape-layer hs-dim" viewBox="0 0 100 100" preserveAspectRatio="none">`
        + `<mask id="${maskId}" maskUnits="userSpaceOnUse"><rect width="100" height="100" fill="#fff"/>${holes.join('')}</mask>`
        + `<rect width="100" height="100" fill="#000" opacity="0.62" mask="url(#${maskId})"/></svg>`
      : '';
    return dimSvg
      + `<svg class="hold-shape-layer hs-lines" viewBox="0 0 100 100" preserveAspectRatio="none">${outlines.join('')}</svg>`;
  }

  // Problem-detail entry point: derive roles from the (un-inverted) hold order.
  function boardShapeOverlayHtml(p, opts = {}) {
    const order = problemHoldOrder(p);
    if (!order.length) return null;
    return holdShapeLayerHtml(classifyHolds(order), opts);
  }

  // Map a pointer's client coords to board-relative percentages. Returns { x, y }
  // percentages plus w/h = the board's own pixel size (for distance thresholds).
  // The fullscreen viewer zooms by resizing the board-wrap and pans it with a
  // translate, both of which getBoundingClientRect reports, so the plain maths
  // holds there too.
  function boardPct(boardEl, clientX, clientY) {
    const r = boardEl.getBoundingClientRect();
    const w = r.width || 1, h = r.height || 1;
    return { x: (clientX - r.left) / w * 100, y: (clientY - r.top) / h * 100, w, h };
  }

  // Floating "expand to fullscreen" button drawn over a board. Used by the inline
  // detail/circuit-detail render templates; the static create/circuit-create
  // boards carry the same markup in index.html.
  function boardExpandBtn() {
    return '<button class="board-expand-btn" type="button" aria-label="Fullscreen board">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline>' +
      '<line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>';
  }

  // ── Fullscreen board viewer ────────────────────────────────────────────────────
  // The board photo (~1.22:1) never matches a phone's shape, so rather than
  // stretch or rotate it, fullscreen is a camera over the board:
  //   - It opens framed on the ROUTE: the holds of the problem or circuit on
  //     screen, zoomed to fill the space between the close button and the bar.
  //     Problems run up the wall, so an upright phone suits them. It glides there
  //     from the board's place on the page.
  //   - Pinch or drag to look around (wheel on desktop). Double-tap, or the bar's
  //     frame button, switches between the route and the whole board. A minimap
  //     (top-left) shows where you are whenever part of the board is off-screen;
  //     tap it for the whole board.
  //   - Round the board, a blurred copy of the photo fills the screen instead of
  //     black bars.
  //   - The bar along the bottom names the problem, steps to the previous/next one
  //     (the camera glides to the new route), and mirrors it. A single tap hides
  //     or shows the bar and buttons.
  //   - The expand button also asks for the browser's real fullscreen, which hides
  //     the status and browser bars on Android and desktop (iPhone Safari only
  //     allows that for video, so there it's the in-page viewer alone).
  // Two ways in: the expand button on any board view, and turning a touch device
  // to landscape on the read-only detail views (fsAuto; turning back closes it).
  // On create views taps still set holds: there's no tap-to-hide or double-tap,
  // and a drag or pinch never counts as a tap.
  // Zoom resizes the board-wrap itself (its overlays are %-positioned and scale
  // with it, while outlines, dots and move tags keep their pixel sizes) and pan is
  // a translate, so boardPct needs nothing special.
  const AUTO_FS_VIEWS = new Set(['detail', 'circuit-detail']);
  const FS_MAX_ZOOM = 4;        // relative to the whole board fitting the screen
  const FS_ROUTE_ZOOM = 3;      // the route framing never zooms further than this
  let fsOpen = false;
  let fsAuto = false;           // entered by turning the phone (turning back exits)
  let fsNative = false;         // we put the page into the browser's own fullscreen
  let fsAspect = 1;             // board width / height (intrinsic)
  let fsWrap = null;            // the board-wrap being shown (re-renders replace it)
  let fsBackdrop = null;        // the blurred board behind it
  let fsObserver = null;        // adopts the new board-wrap after a re-render
  let fsBase = { w: 0, h: 0 };  // the board's size when it just fits the screen
  let fsCam = { k: 1, tx: 0, ty: 0 };   // zoom (× fsBase) and top-left offset, px
  let fsFrame = 'route';        // 'route' | 'board' | 'free' (after a pinch or drag)
  let wakeLock = null;
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
  const landscapeMQ = window.matchMedia('(orientation: landscape)');
  const fsReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function activeBoardWrap() {
    const v = document.getElementById('view-' + currentView);
    return v ? v.querySelector('.board-wrap') : null;
  }
  // The read-only views, where taps belong to the viewer (not to hold editing).
  function fsReadOnly() { return AUTO_FS_VIEWS.has(currentView); }

  // The size at which the whole board just fits the screen.
  function fsMeasure() {
    const vw = window.innerWidth, vh = window.innerHeight, a = fsAspect || 1;
    const w = Math.min(vw, vh * a);
    fsBase = { w, h: w / a };
  }

  // Keep the camera sensible: zoom within bounds, and the board either centred
  // (when it fits that way) or covering the screen edge to edge (no pulling it
  // off into empty space).
  function fsClampCam({ k, tx, ty }) {
    const vw = window.innerWidth, vh = window.innerHeight;
    k = Math.max(1, Math.min(FS_MAX_ZOOM, k));
    const W = fsBase.w * k, H = fsBase.h * k;
    tx = W <= vw ? (vw - W) / 2 : Math.min(0, Math.max(vw - W, tx));
    ty = H <= vh ? (vh - H) / 2 : Math.min(0, Math.max(vh - H, ty));
    return { k, tx, ty };
  }

  function fsApply(cam, animate) {
    fsCam = fsClampCam(cam);
    if (!fsWrap) return;
    fsWrap.classList.toggle('fs-anim', !!animate && !fsReducedMotion.matches);
    fsWrap.style.width = (fsBase.w * fsCam.k) + 'px';
    fsWrap.style.transform = `translate3d(${fsCam.tx}px, ${fsCam.ty}px, 0)`;
    fsUpdateMap();
  }

  // The route on screen as a box in board percentages, or null (create views,
  // no mapped holds).
  function fsRouteBox() {
    if (!HOLD_MAP) return null;
    let holds = [];
    if (currentView === 'detail' && currentProblem) {
      holds = problemHoldOrder(currentProblem).map(h => detailMirror ? mirrorHold(h) : h);
    } else if (currentView === 'circuit-detail' && currentCircuit) {
      holds = circuitSeq(currentCircuit);
    }
    const pts = holds.map(h => HOLD_MAP[h]).filter(Boolean);
    if (!pts.length) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  // The camera for a framing: the whole board, or the route filling the space
  // left by the close button (top) and the bar (bottom), with room round the
  // outermost holds for their outlines.
  function fsFrameCam(frame) {
    const box = frame === 'route' ? fsRouteBox() : null;
    if (!box) return { k: 1, tx: 0, ty: 0 };
    const vw = window.innerWidth, vh = window.innerHeight;
    const padT = Math.min(64, vh * 0.1), padB = Math.min(96, vh * 0.2), padX = 16;
    const mX = 6, mY = 6 * (fsAspect || 1);              // % margins, equal on screen
    const x0 = Math.max(0, box.x0 - mX), x1 = Math.min(100, box.x1 + mX);
    const y0 = Math.max(0, box.y0 - mY), y1 = Math.min(100, box.y1 + mY);
    const bw = (x1 - x0) / 100 * fsBase.w, bh = (y1 - y0) / 100 * fsBase.h;
    const availW = vw - 2 * padX, availH = vh - padT - padB;
    const k = Math.max(1, Math.min(FS_ROUTE_ZOOM, availW / bw, availH / bh));
    const cx = (x0 + x1) / 200 * fsBase.w * k, cy = (y0 + y1) / 200 * fsBase.h * k;
    return { k, tx: padX + availW / 2 - cx, ty: padT + availH / 2 - cy };
  }

  function fsSetFrame(frame, animate = true) {
    fsFrame = frame;
    fsApply(fsFrameCam(frame), animate);
    fsUpdateBar();
  }

  // Re-fit after a resize (turning the phone, the browser entering fullscreen).
  // A camera the user has moved stays put, just kept within bounds.
  function sizeBoardFs() {
    if (!fsOpen) return;
    fsMeasure();
    if (fsFrame === 'free') fsApply(fsCam, false);
    else fsApply(fsFrameCam(fsFrame), fsWrap && fsWrap.classList.contains('fs-anim'));
  }

  // Take on a board-wrap: lift it into the viewer, with the blurred backdrop just
  // behind it (a sibling, so the two share a stacking context). `from` is the
  // camera to start from, so the move to the new framing is animated.
  function fsAdopt(wrap, from) {
    fsWrap = wrap;
    wrap.parentNode.insertBefore(fsBackdrop, wrap);
    const img = wrap.querySelector('.board-graphic');
    if (img && img.naturalWidth) fsAspect = img.naturalWidth / img.naturalHeight;
    fsMeasure();
    fsFrame = fsRouteBox() ? 'route' : 'board';
    fsApply(from, false);
    void wrap.offsetWidth;                                // commit the start frame
    fsSetFrame(fsFrame, true);
  }

  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { /* unsupported or refused — non-fatal */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  // auto marks an entry made by turning the phone. The browser's fullscreen
  // needs a user gesture, so it's only asked for from the expand button (auto
  // entries come from an orientation change or a route, which aren't gestures).
  function enterBoardFs(auto = false) {
    const wrap = activeBoardWrap();
    if (!wrap || fsOpen) return;
    const r = wrap.getBoundingClientRect();
    const img = wrap.querySelector('.board-graphic');
    fsAspect = (img && img.naturalWidth) ? img.naturalWidth / img.naturalHeight
             : (r.width && r.height ? r.width / r.height : 1);
    fsOpen = true;
    fsAuto = auto;
    if (!fsBackdrop) {
      fsBackdrop = document.createElement('div');
      fsBackdrop.className = 'fs-backdrop';
      fsBackdrop.innerHTML = '<div class="fs-ambient"></div>';
    }
    fsBackdrop.firstChild.style.backgroundImage = `url("${String(BOARD_IMG).replace(/["\\]/g, '\\$&')}")`;
    document.getElementById('board-fs-map-img').setAttribute('src', BOARD_IMG);
    document.body.classList.remove('fs-ui-hidden');
    document.body.classList.add('board-fs');
    fsMeasure();
    // Start where the board sat on the page, then glide to the route.
    fsAdopt(wrap, { k: r.width / (fsBase.w || 1), tx: r.left, ty: r.top });
    fsObserver = new MutationObserver(() => {
      const w = activeBoardWrap();
      if (fsOpen && w && w !== fsWrap) fsAdopt(w, fsCam);
    });
    fsObserver.observe(document.getElementById('view-' + currentView), { childList: true, subtree: true });
    fsShowHint();
    acquireWakeLock();
    if (!auto) requestNativeFs();
  }

  function exitBoardFs() {
    if (!fsOpen) return;
    fsOpen = false;
    fsAuto = false;
    if (fsObserver) { fsObserver.disconnect(); fsObserver = null; }
    if (fsBackdrop) fsBackdrop.remove();
    if (fsWrap) {
      fsWrap.classList.remove('fs-anim');
      fsWrap.style.removeProperty('width');
      fsWrap.style.removeProperty('transform');
    }
    fsWrap = null;
    clearTimeout(fsTapTimer);
    document.body.classList.remove('board-fs', 'fs-ui-hidden');
    releaseWakeLock();
    exitNativeFs();
  }

  // ── The viewer's bar, minimap and hint ─────────────────────────────────────────
  function fsUpdateBar() {
    if (!fsOpen) return;
    const name = document.getElementById('fs-name'), meta = document.getElementById('fs-meta');
    const prev = document.getElementById('fs-prev'), next = document.getElementById('fs-next');
    const mirror = document.getElementById('fs-mirror'), frameBtn = document.getElementById('fs-frame');
    const isProblem = currentView === 'detail' && currentProblem;
    const isCircuit = currentView === 'circuit-detail' && currentCircuit;
    if (isProblem) {
      name.textContent = displayName(currentProblem);
      meta.textContent = [fontGrade(currentProblem.grade) || '—', detailMirror ? 'Mirrored' : ''].filter(Boolean).join(' · ');
    } else if (isCircuit) {
      const n = circuitSeq(currentCircuit).length;
      name.textContent = circuitName(currentCircuit);
      meta.textContent = `${currentCircuit.grade || '—'} · ${n} move${n === 1 ? '' : 's'}`;
    } else {
      name.textContent = 'Tap holds to set them';
      meta.textContent = 'Pinch or drag to look around';
    }
    prev.hidden = next.hidden = !(isProblem || isCircuit);
    mirror.hidden = !isProblem;
    mirror.classList.toggle('active', !!(isProblem && detailMirror));
    mirror.setAttribute('aria-pressed', isProblem && detailMirror ? 'true' : 'false');
    frameBtn.hidden = !fsRouteBox();
    const toRoute = fsFrame !== 'route';
    frameBtn.classList.toggle('to-route', toRoute);
    frameBtn.setAttribute('aria-label', toRoute ? (isCircuit ? 'Zoom to the circuit' : 'Zoom to the problem') : 'Show the whole board');
  }

  // Minimap: shown whenever part of the board is off-screen, with a box for what's
  // in view.
  function fsUpdateMap() {
    const map = document.getElementById('board-fs-map');
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = fsBase.w * fsCam.k, H = fsBase.h * fsCam.k;
    const cropped = W > vw + 1 || H > vh + 1;
    map.classList.toggle('show', fsOpen && cropped);
    if (!cropped) return;
    const l = Math.max(0, -fsCam.tx / W), t = Math.max(0, -fsCam.ty / H);
    const r = Math.min(1, (vw - fsCam.tx) / W), b = Math.min(1, (vh - fsCam.ty) / H);
    map.style.setProperty('--map-ar', String(fsAspect || 1));
    const box = map.querySelector('.fs-map-view');
    box.style.left = (l * 100) + '%';
    box.style.top = (t * 100) + '%';
    box.style.width = ((r - l) * 100) + '%';
    box.style.height = ((b - t) * 100) + '%';
  }

  // A one-line hint the first few times the viewer opens.
  let fsHintTimer = 0;
  function fsShowHint() {
    let seen = 0;
    try { seen = +localStorage.getItem('pb-fs-hints') || 0; localStorage.setItem('pb-fs-hints', String(seen + 1)); } catch (e) {}
    if (seen >= 3) return;
    const hint = document.getElementById('board-fs-hint');
    hint.textContent = fsReadOnly() ? 'Pinch to zoom · double-tap for the whole board' : 'Pinch to zoom · tap holds to set them';
    hint.classList.add('show');
    clearTimeout(fsHintTimer);
    fsHintTimer = setTimeout(() => hint.classList.remove('show'), 2600);
  }

  // ── Viewer gestures ────────────────────────────────────────────────────────────
  // Pointer events on the board and the backdrop: one finger pans, two pinch
  // (about their midpoint). On the read-only views a tap hides/shows the bar and a
  // double-tap switches route ↔ whole board; a quick sideways swipe steps to the
  // next/previous problem when the board isn't wider than the screen (otherwise
  // a drag pans). After any drag or pinch the click that follows is swallowed,
  // so it never sets a hold on the create boards.
  const fsPtrs = new Map();     // pointerId -> { x, y }
  let fsGest = null;            // the gesture in progress, from its start
  let fsMoved = false, fsMulti = false;
  let fsSwallowClick = false;
  let fsLastTap = 0, fsTapTimer = 0;
  let fsDownAt = 0;
  let fsGest0 = { x: 0, y: 0 };  // where the first finger went down

  function fsIsBoardTarget(t) {
    if (!fsOpen || !t || !t.closest) return false;
    if (t.closest('button, a, input')) return false;
    return !!(t.closest('.fs-backdrop') || (fsWrap && fsWrap.contains(t)));
  }
  function fsGestStart() {
    const pts = [...fsPtrs.values()];
    const c = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : { ...pts[0] };
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    fsGest = { cam: { ...fsCam }, c, d, n: pts.length };
  }

  document.addEventListener('pointerdown', e => {
    if (!fsIsBoardTarget(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!fsPtrs.size) { fsMoved = false; fsMulti = false; fsDownAt = Date.now(); fsGest0 = { x: e.clientX, y: e.clientY }; }
    fsPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fsPtrs.size > 1) fsMulti = true;
    if (fsWrap) fsWrap.classList.remove('fs-anim');
    fsGestStart();
  }, true);

  document.addEventListener('pointermove', e => {
    if (!fsOpen || !fsPtrs.has(e.pointerId)) return;
    fsPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...fsPtrs.values()];
    if (!fsMoved && Math.hypot(pts[0].x - fsGest0.x, pts[0].y - fsGest0.y) < 8 && pts.length < 2) return;
    fsMoved = true;
    const g = fsGest;
    let cam;
    if (pts.length > 1 && g.n > 1) {
      const c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const k = Math.max(1, Math.min(FS_MAX_ZOOM, g.cam.k * Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / (g.d || 1)));
      const s = k / g.cam.k;               // keep the board point under the midpoint there
      cam = { k, tx: c.x - (g.c.x - g.cam.tx) * s, ty: c.y - (g.c.y - g.cam.ty) * s };
    } else {
      cam = { k: g.cam.k, tx: g.cam.tx + pts[0].x - g.c.x, ty: g.cam.ty + pts[0].y - g.c.y };
    }
    fsFrame = 'free';
    fsApply(cam, false);
  }, true);

  function fsPointerEnd(e) {
    if (!fsPtrs.has(e.pointerId)) return;
    const upAt = { x: e.clientX, y: e.clientY };
    fsPtrs.delete(e.pointerId);
    if (fsPtrs.size) { fsGestStart(); return; }        // a finger lifted mid-pinch
    fsUpdateBar();
    if (fsMoved || fsMulti) {
      fsSwallowClick = true;
      setTimeout(() => { fsSwallowClick = false; }, 400);
      // A quick sideways swipe on a board no wider than the screen steps along.
      const dx = upAt.x - fsGest0.x, dy = upAt.y - fsGest0.y;
      const cantPan = fsBase.w * fsCam.k <= window.innerWidth + 1;
      if (!fsMulti && fsReadOnly() && cantPan && e.type === 'pointerup' && Date.now() - fsDownAt < 600
          && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) fsStep(dx < 0 ? 1 : -1);
      return;
    }
    if (!fsReadOnly() || e.type !== 'pointerup') return;   // create: the click sets a hold
    const now = Date.now();
    if (now - fsLastTap < 300) {                           // double-tap
      fsLastTap = 0;
      clearTimeout(fsTapTimer);
      fsSetFrame(fsFrame === 'route' && fsRouteBox() ? 'board' : (fsRouteBox() ? 'route' : 'board'));
      return;
    }
    fsLastTap = now;
    clearTimeout(fsTapTimer);
    fsTapTimer = setTimeout(() => document.body.classList.toggle('fs-ui-hidden'), 300);
  }
  document.addEventListener('pointerup', fsPointerEnd, true);
  document.addEventListener('pointercancel', fsPointerEnd, true);
  document.addEventListener('click', e => {
    if (fsSwallowClick && fsIsBoardTarget(e.target)) { fsSwallowClick = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  // A mouse drag on the photo would start the browser's own image drag (which
  // cancels the pointer stream), so that's off in the viewer.
  document.addEventListener('dragstart', e => {
    if (fsIsBoardTarget(e.target)) e.preventDefault();
  }, true);

  // Wheel (desktop): zoom about the cursor.
  document.addEventListener('wheel', e => {
    if (!fsIsBoardTarget(e.target)) return;
    e.preventDefault();
    const k = Math.max(1, Math.min(FS_MAX_ZOOM, fsCam.k * Math.exp(-e.deltaY * 0.0015)));
    const s = k / fsCam.k;
    fsFrame = 'free';
    fsApply({ k, tx: e.clientX - (e.clientX - fsCam.tx) * s, ty: e.clientY - (e.clientY - fsCam.ty) * s }, false);
    fsUpdateBar();
  }, { passive: false });

  // Previous/next problem or circuit, as the detail swipe does. The re-render is
  // picked up by fsObserver, which glides the camera to the new route.
  function fsStep(dir) {
    if (currentView === 'detail') swipeToAdjacent(dir);
    else if (currentView === 'circuit-detail') swipeToAdjacentCircuit(dir);
  }

  // ── The browser's own fullscreen ───────────────────────────────────────────────
  // The Fullscreen API (webkit-prefixed on older Safari/iPad). Unsupported or
  // refused is fine: the in-page viewer stands.
  function nativeFsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function requestNativeFs() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req || nativeFsElement()) return;
    fsNative = true;
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      if (p && p.catch) p.catch(() => { fsNative = false; });
    } catch (e) { fsNative = false; }
  }
  function exitNativeFs() {
    if (!fsNative) return;
    fsNative = false;             // first, so the fullscreenchange below is ignored
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!nativeFsElement() || !exit) return;
    try {
      const p = exit.call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  // Leaving the browser's fullscreen some other way (Android back gesture, Esc on
  // desktop) closes the viewer too, so it's never left half-open.
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(type => {
    document.addEventListener(type, () => {
      if (fsNative && !nativeFsElement()) { fsNative = false; exitBoardFs(); }
    });
  });

  // Turning a touch device to landscape on a detail view opens the viewer;
  // returning to portrait closes it. One opened with the expand button stays open
  // either way, and re-fits (sizeBoardFs, on resize).
  function onOrientationChange() {
    if (landscapeMQ.matches) {
      if (!fsOpen && isTouchDevice && AUTO_FS_VIEWS.has(currentView)) enterBoardFs(true);
    } else if (fsOpen && fsAuto) exitBoardFs();
  }
  landscapeMQ.addEventListener('change', onOrientationChange);
  window.addEventListener('resize', sizeBoardFs);
  // Re-acquire the wake lock when the tab returns to the foreground (the OS drops it).
  document.addEventListener('visibilitychange', () => {
    if (fsOpen && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
  });

  // ── Routing ──────────────────────────────────────────────────────────────────
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || 'list';
    // After a Google redirect the hash carries OAuth tokens (or an error) — never route to that.
    if (raw.includes('access_token') || raw.includes('error=')) return { route: 'list', param: '' };
    const idx = raw.indexOf('/');
    if (idx === -1) return { route: raw, param: '' };
    // A malformed escape (a link cut short by a chat app, "#detail/abc%") makes
    // decodeURIComponent throw; keep the raw text, which then simply isn't found.
    let param = raw.slice(idx + 1);
    try { param = decodeURIComponent(param); } catch (e) {}
    return { route: raw.slice(0, idx), param };
  }

  // Close any open ⋮ overflow menu (detail / circuit-detail headers).
  function closeOverflowMenus() {
    document.querySelectorAll('.overflow-menu').forEach(m => { m.hidden = true; });
    document.querySelectorAll('[aria-haspopup="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }

  function setView(name) {
    // Clear any active fullscreen when the view changes so we never strand the
    // board-fs classes (re-entered below if still landscape on a board view).
    exitBoardFs();
    closeOverflowMenus();

    // Preserve the list's scroll position across navigation.
    if (currentView === 'list' && name !== 'list') listScroll = window.scrollY;
    if (currentView === 'circuits' && name !== 'circuits') circuitsScroll = window.scrollY;

    // The info modal belongs to the two detail views (problem and circuit).
    if (name !== 'detail' && name !== 'circuit-detail') closeInfo();
    // The circuit Play preview only runs on the circuit detail view.
    if (name !== 'circuit-detail') stopCircuitPlay(false);

    ['list','detail','create','outlines','admin','auth','profile','circuits','circuit-detail','circuit-create','leaderboard'].forEach(v => {
      document.getElementById('view-' + v).classList.toggle('active', v === name);
    });

    // Bottom nav: hidden on the focused auth screen, and in the outline editor,
    // which needs the whole screen for the board and its controls.
    document.getElementById('bottom-nav').style.display = (name === 'auth' || name === 'outlines') ? 'none' : 'flex';

    // Active nav highlight.
    const navFor = { list: 'list', detail: 'list', create: 'list', outlines: 'profile', admin: 'profile', profile: 'profile', auth: 'profile', circuits: 'circuits', 'circuit-detail': 'circuits', 'circuit-create': 'circuits', leaderboard: 'leaderboard' }[name] || 'list';
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.nav === navFor));

    const keep = name === 'list' ? listScroll : name === 'circuits' ? circuitsScroll : null;
    if (keep !== null) {
      window.scrollTo(0, keep);
      // Some engines finish their own scrolling (a fragment jump, a restore) a
      // frame after the hash changes, which would land the list back at the top.
      // Re-assert once the frame has settled, unless the user has already moved.
      requestAnimationFrame(() => { if (currentView === name && window.scrollY === 0) window.scrollTo(0, keep); });
    } else window.scrollTo(0, 0);

    currentView = name;

    // Auto-enter natural fullscreen if a touch device is already landscape on a
    // read-only board view (e.g. navigating/swiping while held sideways).
    if (isTouchDevice && landscapeMQ.matches && AUTO_FS_VIEWS.has(name)) enterBoardFs(true);
  }

  function router() {
    const { route, param } = parseHash();
    switch (route) {
      case 'detail':
        // Arriving from anywhere else starts a new swipe trail. Staying inside the
        // detail view (a swipe, or delete stepping back) keeps the one we have.
        if (currentView !== 'detail') { detailTrail = []; shuffleBack = []; shuffleFwd = []; }
        renderDetail(param); setView('detail'); break;
      case 'create':
        // Only bounce guests once we actually know the auth state — otherwise a
        // cold reload/deep-link on #create would kick a signed-in user to #auth.
        if (authReady && !session) { redirectRoute('#auth'); break; }
        // #create/<id> = admin "Edit holds" on an existing problem. Editing is
        // admin-only (DB enforces it too); bounce non-admins to that problem's detail.
        if (param && authReady && !isAdmin()) { redirectRoute('#detail/' + encodeURIComponent(param)); break; }
        initCreateView(param);
        setView('create');
        break;
      case 'calibrate':
        // The old recalibrate tool's address; the outline editor replaced it.
        redirectRoute('#outlines');
        break;
      case 'outlines':
        // Admin-only tool. Nothing is shown until auth (and the profile) is known —
        // initAuth re-runs the router then — so a non-admin never sees it, not even
        // for a moment on a cold deep link. setView first: the editor measures its
        // stage, which has no size while the view is hidden.
        if (!authReady) break;
        if (!isAdmin()) { redirectRoute('#list'); break; }
        setView('outlines');
        initOutlines();
        break;
      case 'admin':
        // Admin-only hub (Trace Holds + user management). Same gate as #outlines:
        // wait for auth + profile, then bounce non-admins.
        if (!authReady) break;
        if (!isAdmin()) { redirectRoute('#list'); break; }
        setView('admin');
        renderAdmin(param);
        break;
      // Render before setView, so the restored scroll position has its content.
      case 'circuits': renderCircuits(); setView('circuits'); break;
      case 'circuit':
        // Same swipe-trail rule as #detail.
        if (currentView !== 'circuit-detail') circuitTrail = [];
        setView('circuit-detail'); renderCircuitDetail(param); break;
      case 'circuit-create':
        // Login required, same pattern as #create — only bounce once auth is known.
        if (authReady && !session) { redirectRoute('#auth'); break; }
        initCircuitCreate();
        setView('circuit-create');
        break;
      case 'leaderboard':
        setView('leaderboard');
        renderLeaderboard();                                  // spinner / cached rows
        loadLeaderboard().then(renderLeaderboard);            // fetch, then re-render
        break;
      case 'auth':    setAuthMode('signin'); setView('auth'); break;
      case 'profile': renderProfile(); setView('profile'); break;
      case 'list':
      default:        setView('list'); break;
    }
  }

  // Swap route without a fragment navigation, for when the current entry points at
  // something that no longer exists (a just-deleted problem or circuit). Setting
  // location.hash would push a dead entry Back could return to, and a fragment
  // jump can scroll the document to the top, losing the list's scroll position.
  function replaceRoute(hash) {
    history.replaceState(history.state, '', hash);
    router();
  }

  // The same swap for a redirect: what location.replace(hash) did, minus the
  // fragment jump and without wiping this entry's stamp (below). The route runs on
  // the next tick, as a real hashchange would, so a redirect issued from inside
  // router() isn't overtaken by the rest of the case that issued it.
  function redirectRoute(hash) {
    history.replaceState(history.state, '', hash);
    setTimeout(() => window.dispatchEvent(new Event('hashchange')), 0);
  }

  // ── History stamps ───────────────────────────────────────────────────────────
  // Every history entry the app creates is stamped { pb: 1 }; the entry the app was
  // opened on is stamped { pb: 0 }. Only a pb:1 entry is sure to have one of ours
  // behind it; behind a pb:0 entry may be another site (a shared link opened in a
  // tab with history), so the in-app Back mustn't step back from it. Stamps live
  // in history.state, so they survive reloads and back/forward. Every in-app
  // replaceState passes history.state through to keep them.
  function stampOpeningEntry() {
    if (!history.state || history.state.pb === undefined) {
      history.replaceState({ ...(history.state || {}), pb: 0 }, '', location.href);
    }
  }
  // On hashchange: an unstamped entry is a new one (a link, a tap, a typed URL),
  // pushed on top of one of ours. Back/forward land on entries already stamped.
  function stampNewEntry() {
    if (!history.state || history.state.pb === undefined) {
      history.replaceState({ ...(history.state || {}), pb: 1 }, '', location.href);
    }
  }

  // Where the in-app Back goes when there's no in-app entry to step back to.
  function backParentHash() {
    const { route, param } = parseHash();
    if (route === 'circuit' || route === 'circuit-create') return '#circuits';
    if (route === 'create' && param) return '#detail/' + encodeURIComponent(param);
    if (route === 'outlines' || (route === 'admin' && param)) return '#admin';
    if (route === 'admin') return '#profile';
    return '#list';
  }

  function goBack() {
    // In fullscreen, Back closes the fullscreen first rather than leaving the view.
    if (fsOpen) { exitBoardFs(); return; }
    if (history.state && history.state.pb === 1) history.back();
    else replaceRoute(backParentHash());
  }

