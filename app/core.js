// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: escape/toast/render helpers, hold + board-overlay helpers, and hash routing.

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
  // 19 columns (A–S) × 13 rows, numbered row-major. Used to label holds in the
  // calibrate "Add" mode so the admin knows which physical hold to place.
  function gridName(n) {
    n = +n;
    if (!n || n < 1) return 'hold' + n;
    return String.fromCharCode(65 + (n - 1) % 19) + (Math.floor((n - 1) / 19) + 1);
  }

  function holdChips(arr, cls) {
    if (!Array.isArray(arr)) arr = (arr === null || arr === undefined) ? [] : [arr];
    return arr.map(h => `<span class="chip ${cls}" title="${escAttr(h)}">${escHtml(holdNum(h))}</span>`).join('');
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

  // A hold's left/right mirror partner (mirror_map.json). Self for centre-line
  // holds and the lone hold with no real partner (I12) — so mirroring leaves them
  // in place. Falls back to the hold itself if the map hasn't loaded.
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

  // ── Hold-shape overlay (problems only — circuits keep the .hold-dot path) ────
  // Draws each used hold as its *real traced outline* (hold_shapes.json) instead
  // of a circle, and on the detail view dims the rest of the board so only the
  // used holds stay bright. Returns null when shapes can't be used so callers
  // fall back to boardOverlayHtml().
  //
  // Shapes are traced (register_shapes.py / trace_holds.html) against ONE specific
  // board — the LIVE board_config image + hold map — and hold_shapes.json records
  // that board's updated_at in __meta.board_updated_at. They only fit that board,
  // so the overlay stays off unless board_config supplied the map AND its version
  // still matches the traced one. That covers the offline/bundled fallback (the
  // bundled ProjectBoard.png has different framing) and an admin recalibrating the
  // board — which bumps updated_at and drops everyone back to the always-correct
  // dot overlay until the shapes are re-traced and re-committed.
  let hsMaskSeq = 0;
  function shapesUsable() {
    if (!HOLD_SHAPES || !HOLD_MAP || !configHasMap) return false;
    const meta = HOLD_SHAPES.__meta;
    if (!meta || !meta.board_updated_at) return false;
    if (meta.board_updated_at !== boardConfigVersion) return false;
    return Object.keys(HOLD_SHAPES).length > 1;      // more than just __meta
  }

  // Traced outlines are drawn as a closed Catmull-Rom curve through every traced
  // point, not straight segments. SHAPE_SMOOTH is the tension: 0 = the straight
  // polygon, 1 = fully rounded (can bulge a little past the traced points). The
  // viewBox is stretched, but the curve is affine-invariant so it stays true.
  // Keep in step with SMOOTH in tools/trace_holds.html so the editor matches.
  const SHAPE_SMOOTH = 0.9;
  function smoothShapePath(pts) {
    const n = pts.length, k = SHAPE_SMOOTH / 6;
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
  // darken-the-rest mask (detail view); create/edit passes dim:false so the whole
  // board stays visible. A used hold with no traced polygon falls back to a dot.
  // The mask lives in its OWN svg so the outline svg can carry a plain CSS
  // drop-shadow: a CSS filter on an svg *child* resolves its lengths in the
  // stretched viewBox units, but on the outermost svg it resolves in CSS pixels.
  function holdShapeLayerHtml(roles, { mirror = false, dim = false } = {}) {
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
      const role = roles[h];
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

  // Map a pointer's client coords to board-relative percentages. Accounts for the
  // rotated fullscreen mode, where the board-wrap is CSS-rotated 90° about its
  // centre — its getBoundingClientRect is then the axis-aligned bounding box, not
  // the element's own frame, which would break the naive (clientX - r.left)/r.width
  // maths. We use the rect *centre* (rotation-invariant) plus offsetWidth/Height
  // (the layout box, unaffected by transforms) and invert the rotation. Returns
  // { x, y } percentages plus w/h = the board's own pixel size (for distance
  // thresholds). When NOT rotated this is identical to the old inline maths.
  function boardPct(boardEl, clientX, clientY) {
    const r = boardEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const w = boardEl.offsetWidth, h = boardEl.offsetHeight;
    let dx = clientX - cx, dy = clientY - cy;
    if (document.body.classList.contains('board-fs-rotated')) {
      [dx, dy] = [dy, -dx];                       // inverse of a 90° CW rotation
    }
    return { x: (dx + w / 2) / w * 100, y: (dy + h / 2) / h * 100, w, h };
  }

  // Floating "expand to fullscreen" button drawn over a board. Used by the inline
  // detail/circuit-detail render templates; the static create/circuit-create/
  // calibrate boards carry the same markup in index.html.
  function boardExpandBtn() {
    return '<button class="board-expand-btn" type="button" aria-label="Fullscreen board">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline>' +
      '<line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg></button>';
  }

  // ── Fullscreen board mode ──────────────────────────────────────────────────────
  // Two ways in: the expand button enters a CSS-rotated landscape fullscreen on any
  // board view; turning a touch device to landscape auto-enters a natural (un-rotated)
  // fullscreen on the read-only detail views (create/calibrate are excluded — a
  // fullscreen board would cover their form + save controls). Both hide the header +
  // bottom nav. The board-wrap is positioned fixed and sized via the --fs-bw CSS var
  // (computed here), and its %-positioned overlay scales with it, so dots stay aligned.
  const AUTO_FS_VIEWS = new Set(['detail', 'circuit-detail']);
  let fsMode = null;            // null | 'natural' | 'rotated'
  let fsAspect = 1;             // board width / height (intrinsic)
  let wakeLock = null;
  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
  const landscapeMQ = window.matchMedia('(orientation: landscape)');

  function activeBoardWrap() {
    const v = document.getElementById('view-' + currentView);
    return v ? v.querySelector('.board-wrap') : null;
  }

  // Size the fullscreen board so its long edge fits the viewport, preserving aspect.
  // Natural fills width×height; rotated fits the board's width down the phone's long
  // axis (the whole point of rotating a wide board on a portrait phone).
  function sizeBoardFs() {
    if (!fsMode) return;
    const wrap = activeBoardWrap();
    const img = wrap && wrap.querySelector('.board-graphic');
    if (img && img.naturalWidth && img.naturalHeight) fsAspect = img.naturalWidth / img.naturalHeight;
    const vw = window.innerWidth, vh = window.innerHeight, a = fsAspect || 1;
    const bw = fsMode === 'rotated' ? Math.min(vh, vw * a) : Math.min(vw, vh * a);
    document.body.style.setProperty('--fs-bw', bw + 'px');
  }

  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { /* unsupported or refused — non-fatal */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  function enterBoardFs(mode) {
    const wrap = activeBoardWrap();
    if (!wrap || fsMode) return;
    const r = wrap.getBoundingClientRect();
    const img = wrap.querySelector('.board-graphic');
    fsAspect = (img && img.naturalWidth) ? img.naturalWidth / img.naturalHeight
             : (r.width && r.height ? r.width / r.height : 1);
    if (img && !img.naturalWidth) img.addEventListener('load', sizeBoardFs, { once: true });
    fsMode = mode;
    document.body.classList.add('board-fs');
    if (mode === 'rotated') document.body.classList.add('board-fs-rotated');
    sizeBoardFs();
    acquireWakeLock();
  }

  function exitBoardFs() {
    if (!fsMode) return;
    fsMode = null;
    document.body.classList.remove('board-fs', 'board-fs-rotated');
    document.body.style.removeProperty('--fs-bw');
    releaseWakeLock();
  }

  // Turning a touch device to landscape on a detail view auto-enters natural FS;
  // returning to portrait exits it. A user-invoked rotated FS is left alone.
  function onOrientationChange() {
    if (landscapeMQ.matches) {
      if (!fsMode && isTouchDevice && AUTO_FS_VIEWS.has(currentView)) enterBoardFs('natural');
      else if (fsMode) sizeBoardFs();
    } else {
      if (fsMode === 'natural') exitBoardFs();
      else if (fsMode) sizeBoardFs();
    }
  }
  landscapeMQ.addEventListener('change', onOrientationChange);
  window.addEventListener('resize', sizeBoardFs);
  // Re-acquire the wake lock when the tab returns to the foreground (the OS drops it).
  document.addEventListener('visibilitychange', () => {
    if (fsMode && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
  });

  // ── Routing ──────────────────────────────────────────────────────────────────
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || 'list';
    // After a Google redirect the hash carries OAuth tokens (or an error) — never route to that.
    if (raw.includes('access_token') || raw.includes('error=')) return { route: 'list', param: '' };
    const idx = raw.indexOf('/');
    if (idx === -1) return { route: raw, param: '' };
    return { route: raw.slice(0, idx), param: decodeURIComponent(raw.slice(idx + 1)) };
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

    // The info modal only belongs to the detail view.
    if (name !== 'detail') closeInfo();
    // The circuit Play preview only runs on the circuit detail view.
    if (name !== 'circuit-detail') stopCircuitPlay(false);

    ['list','detail','create','calibrate','admin','auth','profile','circuits','circuit-detail','circuit-create','leaderboard'].forEach(v => {
      document.getElementById('view-' + v).classList.toggle('active', v === name);
    });

    // Bottom nav: hidden on the focused auth screen.
    document.getElementById('bottom-nav').style.display = name === 'auth' ? 'none' : 'flex';

    // Active nav highlight.
    const navFor = { list: 'list', detail: 'list', create: 'list', calibrate: 'profile', admin: 'profile', profile: 'profile', auth: 'profile', circuits: 'circuits', 'circuit-detail': 'circuits', 'circuit-create': 'circuits', leaderboard: 'leaderboard' }[name] || 'list';
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.nav === navFor));

    if (name === 'list') {
      window.scrollTo(0, listScroll);
      // Some engines finish their own scrolling (a fragment jump, a restore) a
      // frame after the hash changes, which would land the list back at the top.
      // Re-assert once the frame has settled, unless the user has already moved.
      requestAnimationFrame(() => { if (currentView === 'list' && window.scrollY === 0) window.scrollTo(0, listScroll); });
    } else window.scrollTo(0, 0);

    currentView = name;

    // Auto-enter natural fullscreen if a touch device is already landscape on a
    // read-only board view (e.g. navigating/swiping while held sideways).
    if (isTouchDevice && landscapeMQ.matches && AUTO_FS_VIEWS.has(name)) enterBoardFs('natural');
  }

  function router() {
    const { route, param } = parseHash();
    switch (route) {
      case 'detail':
        // Arriving from anywhere else starts a new swipe trail. Staying inside the
        // detail view (a swipe, or delete stepping back) keeps the one we have.
        if (currentView !== 'detail') detailTrail = [];
        renderDetail(param); setView('detail'); break;
      case 'create':
        // Only bounce guests once we actually know the auth state — otherwise a
        // cold reload/deep-link on #create would kick a signed-in user to #auth.
        if (authReady && !session) { location.replace(location.pathname + '#auth'); break; }
        // #create/<id> = admin "Edit holds" on an existing problem. Editing is
        // admin-only (DB enforces it too); bounce non-admins to that problem's detail.
        if (param && authReady && !isAdmin()) { location.replace(location.pathname + '#detail/' + encodeURIComponent(param)); break; }
        initCreateView(param);
        setView('create');
        break;
      case 'calibrate':
        // Admin-only tool. Bounce non-admins once auth is known (don't kick during
        // a cold load before the profile has resolved).
        if (authReady && !isAdmin()) { location.replace(location.pathname + '#list'); break; }
        initCalibrate();
        setView('calibrate');
        break;
      case 'admin':
        // Admin-only hub (board recalibration + user management). Bounce non-admins
        // once auth is known (don't kick during a cold load before profile resolves).
        if (authReady && !isAdmin()) { location.replace(location.pathname + '#list'); break; }
        setView('admin');
        renderAdmin(param);
        break;
      case 'circuits': setView('circuits'); renderCircuits(); break;
      case 'circuit':  setView('circuit-detail'); renderCircuitDetail(param); break;
      case 'circuit-create':
        // Login required, same pattern as #create — only bounce once auth is known.
        if (authReady && !session) { location.replace(location.pathname + '#auth'); break; }
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
    history.replaceState(null, '', hash);
    router();
  }

  function goBack() {
    // In fullscreen, Back closes the fullscreen first rather than leaving the view.
    if (fsMode) { exitBoardFs(); return; }
    if (history.length > 1) history.back();
    else location.hash = '#list';
  }

