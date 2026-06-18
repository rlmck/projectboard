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

  // ── Routing ──────────────────────────────────────────────────────────────────
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || 'list';
    // After a Google redirect the hash carries OAuth tokens (or an error) — never route to that.
    if (raw.includes('access_token') || raw.includes('error=')) return { route: 'list', param: '' };
    const idx = raw.indexOf('/');
    if (idx === -1) return { route: raw, param: '' };
    return { route: raw.slice(0, idx), param: decodeURIComponent(raw.slice(idx + 1)) };
  }

  function setView(name) {
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

    if (name === 'list') window.scrollTo(0, listScroll);
    else window.scrollTo(0, 0);

    currentView = name;
  }

  function router() {
    const { route, param } = parseHash();
    switch (route) {
      case 'detail':  renderDetail(param); setView('detail'); break;
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

  function goBack() {
    if (history.length > 1) history.back();
    else location.hash = '#list';
  }

