  // ── Supabase client ──────────────────────────────────────────────────────────
  const { createClient } = supabase;
  const SUPA_URL = 'https://uqirowyfqwiceyjznosl.supabase.co';
  const sb = createClient(
    SUPA_URL,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA'
  );

  // ── Realtime channel for casting (unchanged contract: board:HangoutPortland) ──
  const channel = sb.channel('board:HangoutPortland');
  channel.subscribe();

  // ── Grade ordering (French bouldering) ───────────────────────────────────────
  const GRADE_ORDER = ['3','4a','4b','4c','5a','5b','5b+','5c','5c+','6a','6a+','6b','6b+','6c','6c+','7a','7a+','7b','7b+','7c','7c+','8a'];
  // Unknown grades (e.g. "Project") sort to the end.
  const gradeRank = g => { const i = GRADE_ORDER.indexOf(g); return i === -1 ? 999 : i; };

  // ── State ────────────────────────────────────────────────────────────────────
  let allProblems = [];
  let activeGrades = new Set();   // selected grade filters; empty = "All"
  let searchQuery = '';
  let loaded = false;
  let currentView = 'list';
  let listScroll = 0;
  let currentProblem = null;
  let HOLD_MAP = null;   // hold id -> {x,y} %, from board_config (admin) or bundled hold_map.json
  let MIRROR_MAP = null; // hold id -> mirror-partner hold id (bundled mirror_map.json); self = centre/no-partner
  let detailMirror = false; // detail view is showing the left/right-mirrored problem
  let BOARD_IMG = 'ProjectBoard.png';   // resolved board image URL (Supabase upload, else bundled)
  let configHasMap = false;             // true once board_config supplied a hold map (suppresses the bundled fallback)
  let configHasMirror = false;          // true once board_config supplied a mirror map (suppresses the bundled fallback)
  const BOARD_BUCKET = 'board';         // Supabase Storage bucket holding the uploaded board image
  // The 189 real holds on the board (ground truth from the DTB layout). Used by the
  // calibrate "Add" mode to offer holds that are absent from the current map.
  const VALID_HOLD_IDS = [1,3,4,5,7,8,10,12,14,16,17,19,20,22,23,24,25,27,28,30,31,32,33,34,35,36,38,39,41,42,43,44,45,46,47,48,49,50,51,53,54,55,58,59,60,61,62,63,64,65,69,70,71,72,73,74,75,76,79,80,81,82,83,85,86,87,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,143,145,146,147,148,149,150,151,152,154,155,156,157,158,160,161,162,163,164,165,166,167,168,169,171,172,174,175,176,177,178,179,180,185,186,188,189,190,191,192,194,195,196,198,199,202,203,205,206,207,208,212,213,216,218,219,221,222,230,231,233,234,235,236,237,239,242,243,244,245,246];
  let session = null;    // Supabase auth session (null = guest)
  let authReady = false; // true once getSession has resolved (don't gate routes before then)
  let profile = null;    // { id, username, is_admin } for the signed-in user
  let profileNames = {}; // account id -> current username (for live setter names)
  let myTicks = new Set(); // problem_ids the signed-in user has ticked (sent)
  let authMode = 'signin'; // 'signin' | 'signup' for the #auth form

  // ── Create-a-problem state ───────────────────────────────────────────────────
  let createRoles = {};        // hold id -> 'start' | 'int' | 'finish'
  let createGrade = '';        // selected grade

  // ── Circuits ──────────────────────────────────────────────────────────────────
  // Sport grades (lowercase French), a different ladder from boulder problems.
  const SPORT_GRADE_ORDER = ['4','5a','5b','5c','6a','6a+','6b','6b+','6c','6c+','7a','7a+','7b','7b+','7c','7c+','8a','8a+','8b'];
  const sportRank = g => { const i = SPORT_GRADE_ORDER.indexOf(g); return i === -1 ? 999 : i; };

  let allCircuits = [];
  let circuitsLoaded = false;
  let circuitsError = null;          // last load error (for the "run db/14" message)
  let activeCircuitGrade = '';       // single-select grade filter ('' = All)
  let circuitSearch = '';
  let currentCircuit = null;

  // Create-a-circuit state. The route is one ORDERED sequence (dups allowed);
  // start = the first ccStartCount holds, finish = the last hold.
  let ccSeq = [];          // ordered hold ids
  let ccStartCount = 2;    // 1 or 2
  let ccLoop = false;
  let ccGrade = '';

  const isTicked = id => myTicks.has(String(id));

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

  // Name with the trailing grade stripped: "4beginnerz 5b" -> "4beginnerz".
  // The grade is shown separately as a badge, so it's redundant in the name.
  function displayName(p) {
    let name = String(p.name || '').trim();
    const g = String(p.grade || '').trim();
    if (g) {
      const re = new RegExp('\\s*' + g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
      const stripped = name.replace(re, '').trim();
      if (stripped) name = stripped;
    }
    return name || '(unnamed)';
  }

  // The setter to show. App-created problems carry setter_id (the owner's account
  // id), so we resolve the *live* display name from profileNames — that way a rename
  // propagates everywhere. Legacy/migrated rows have no owner, so fall back to the
  // text setter captured at creation.
  function setterName(p) {
    if (p.setter_id && profileNames[p.setter_id]) return profileNames[p.setter_id];
    return p.setter || 'unknown';
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

    ['list','detail','create','calibrate','admin','auth','profile','circuits','circuit-detail','circuit-create'].forEach(v => {
      document.getElementById('view-' + v).classList.toggle('active', v === name);
    });

    // Bottom nav: hidden on the focused auth screen.
    document.getElementById('bottom-nav').style.display = name === 'auth' ? 'none' : 'flex';

    // Active nav highlight.
    const navFor = { list: 'list', detail: 'list', create: 'list', calibrate: 'profile', admin: 'profile', profile: 'profile', auth: 'profile', circuits: 'circuits', 'circuit-detail': 'circuits', 'circuit-create': 'circuits' }[name] || 'list';
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
        initCreateView();
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

  // ── List: filter + sort ──────────────────────────────────────────────────────
  function visibleProblems() {
    let arr = allProblems;
    if (activeGrades.size) arr = arr.filter(p => activeGrades.has(p.grade));
    if (searchQuery) {
      const q = searchQuery;
      arr = arr.filter(p =>
        String(p.name || '').toLowerCase().includes(q) ||
        setterName(p).toLowerCase().includes(q) ||
        String(p.grade || '').toLowerCase().includes(q)
      );
    }
    return arr.slice().sort((a, b) =>
      gradeRank(a.grade) - gradeRank(b.grade) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  function cardHtml(p) {
    return `
      <div class="problem-card" data-id="${escAttr(p.id)}">
        <div class="problem-info">
          <div class="problem-name">${escHtml(displayName(p))}</div>
          <div class="problem-meta">
            <span class="grade-badge">${escHtml(p.grade || '—')}</span>
            <span class="meta-setter">${escHtml(setterName(p))}</span>
            ${starsHtml(p.stars)}
            ${isTicked(p.id) ? '<span class="tick-flag" title="Sent">✓</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  function renderList() {
    const container = document.getElementById('list-container');
    const list = visibleProblems();
    document.getElementById('count').textContent = `${list.length} problem${list.length !== 1 ? 's' : ''}`;

    if (list.length === 0) {
      container.innerHTML = `<div class="state-msg"><div class="icon">🔎</div>No problems match.</div>`;
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(cardHtml).join('')}</div>`;
  }

  // Shared grade-tab markup. `isActive(g)` decides the highlight; 'all' renders as "All".
  function gradeTabButtons(grades, isActive) {
    return grades.map(g =>
      `<button class="grade-tab${isActive(g) ? ' active' : ''}" data-grade="${escAttr(g)}" type="button">${g === 'all' ? 'All' : escHtml(g)}</button>`
    ).join('');
  }

  function buildGradeTabs() {
    const present = [...new Set(allProblems.map(p => p.grade).filter(Boolean))]
      .sort((a, b) => gradeRank(a) - gradeRank(b) || a.localeCompare(b));
    // Drop any active filter whose grade no longer exists (last problem deleted/regraded),
    // otherwise visibleProblems() would filter on an absent grade and show nothing.
    [...activeGrades].forEach(g => { if (!present.includes(g)) activeGrades.delete(g); });
    document.getElementById('grade-tabs').innerHTML =
      gradeTabButtons(['all', ...present], g => g === 'all' ? activeGrades.size === 0 : activeGrades.has(g));
  }

  // ── Detail ───────────────────────────────────────────────────────────────────
  function renderDetail(id) {
    const wrap = document.getElementById('detail-content');

    if (!loaded) {
      currentProblem = null;
      updateTickButton();
      wrap.innerHTML = `<div class="spinner"></div>`;
      return;
    }

    const p = allProblems.find(x => String(x.id) === String(id));
    if (!p) {
      currentProblem = null;
      updateTickButton();
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That problem couldn't be found.<br><a class="link" href="#list">Back to problems</a></div>`;
      return;
    }

    // Moving to a different problem resets the mirror toggle to normal orientation.
    if (!currentProblem || String(currentProblem.id) !== String(p.id)) detailMirror = false;
    currentProblem = p;
    updateTickButton();
    updateMirrorButton();

    wrap.innerHTML = `
      <div class="detail-head-info">
        <h1 class="detail-name">${escHtml(displayName(p))}</h1>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(p.grade || '—')}</span>
          <span class="meta-setter">by ${escHtml(setterName(p))}</span>
          ${starsHtml(p.stars)}
          ${p.is_benchmark ? `<span class="bench-badge">★ Benchmark</span>` : ''}
        </div>
      </div>

      <div class="board-wrap">
        <img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />
        ${boardOverlayHtml(p, detailMirror)}
      </div>
    `;
  }

  // Reflect the mirror toggle's lit state on the detail header button.
  function updateMirrorButton() {
    const btn = document.getElementById('detail-mirror');
    if (!btn) return;
    btn.classList.toggle('active', detailMirror);
    btn.setAttribute('aria-pressed', detailMirror ? 'true' : 'false');
    btn.setAttribute('aria-label', detailMirror ? 'Mirrored — tap to show normal' : 'Mirror the problem');
  }

  // Flip the detail board between normal and left/right-mirrored. Casting while
  // lit sends the mirror (the Pi applies the same partner table, as Gareth's did).
  function toggleDetailMirror() {
    if (!currentProblem) return;
    detailMirror = !detailMirror;
    updateMirrorButton();
    if (currentView === 'detail') renderDetail(currentProblem.id);
    // The only hold with no real partner is I12 — flag if this problem uses it.
    if (detailMirror && problemHoldOrder(currentProblem).includes('hold218')) {
      showToast('I12 has no mirror — left in place', 'success');
    }
  }

  // ── Swipe between problems (detail view) ──────────────────────────────────────
  // The "deck" is the same filtered + sorted list the cards came from, so swiping
  // honours the active grade tab and search. dir = +1 (next) / -1 (previous).
  function swipeToAdjacent(dir) {
    if (currentView !== 'detail' || !currentProblem) return;
    const deck = visibleProblems();
    const idx = deck.findIndex(p => String(p.id) === String(currentProblem.id));
    if (idx === -1) return;                       // current isn't in the filtered deck
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= deck.length) return;   // stop at the ends
    const next = deck[nextIdx];
    // Replace the hash (don't push history) so Back still returns to the list,
    // then render in place — the view stays put, only its content swaps.
    history.replaceState(null, '', '#detail/' + encodeURIComponent(next.id));
    closeInfo();
    renderDetail(next.id);
  }

  // ── Info modal ─────────────────────────────────────────────────────────────────
  function openInfo() {
    const p = currentProblem;
    if (!p) return;
    const comment = String(p.comment || '').trim();
    const showComment = comment && !/^no comments?\.?$/i.test(comment);
    const stars = Math.max(0, Math.min(3, Number(p.stars) || 0));

    document.getElementById('info-body').innerHTML = `
      <div class="info-row">
        <div class="info-label">Consensus grade</div>
        <div class="info-value"><span class="grade-badge">${escHtml(p.grade || '—')}</span></div>
      </div>
      <div class="info-row">
        <div class="info-label">Rating</div>
        <div class="info-value">${starsHtml(stars)} &nbsp;${stars}/3</div>
      </div>
      <div class="info-row">
        <div class="info-label">Comments</div>
        <div class="info-value">${showComment ? escHtml(comment) : 'No comments yet.'}</div>
      </div>
    `;
    document.getElementById('info-modal').classList.add('show');
  }
  function closeInfo() { document.getElementById('info-modal').classList.remove('show'); }

  // ── Cast a problem (broadcast contract unchanged) ─────────────────────────────
  async function castByName(name, btn, mirror = false) {
    if (!name) return;
    // Icon-only cast buttons keep their icon; text buttons swap to status text.
    const isIcon = btn.classList.contains('cast-icon-btn');
    const prev = btn.innerHTML;
    btn.classList.add('casting');
    btn.disabled = true;
    if (!isIcon) btn.innerHTML = 'Sending';

    const payload = { problem_name: name };
    if (mirror) payload.mirror = true;

    try {
      await channel.send({
        type: 'broadcast',
        event: 'cast_problem',
        payload
      });
      btn.classList.remove('casting');
      btn.classList.add('sent');
      if (!isIcon) btn.innerHTML = 'Sent';
      showToast(`${mirror ? 'Mirror cast' : 'Cast'}: ${name}`, 'success');
      setTimeout(() => {
        if (!isIcon) btn.innerHTML = prev;
        btn.classList.remove('sent');
        btn.disabled = false;
      }, 2000);
    } catch (err) {
      btn.classList.remove('casting');
      btn.disabled = false;
      if (!isIcon) btn.innerHTML = prev;
      showToast('Cast failed — check connection', 'error');
      console.error(err);
    }
  }

  // Re-render whatever board-bearing view is showing once positions/image change.
  function refreshBoardViews() {
    if (currentView === 'detail') router();
    if (currentView === 'create') applyCreateRoles();
    if (currentView === 'calibrate') initCalibrate();
    if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
    if (currentView === 'circuit-create') applyCircuitCreate();
  }

  // Point every static board <img> (create + calibrate + circuit create) at the
  // current BOARD_IMG. The detail views' <img> is built per-render, so it reads
  // BOARD_IMG directly.
  function applyBoardImage() {
    document.querySelectorAll('#create-board .board-graphic, #cc-board .board-graphic, #cal-img').forEach(img => {
      if (img.getAttribute('src') !== BOARD_IMG) img.setAttribute('src', BOARD_IMG);
    });
  }

  // ── Load hold position map (bundled fallback for the board overlay) ──────────
  // board_config (loadBoardConfig) is the source of truth when an admin has saved
  // one; this bundled file is the first-paint / offline fallback. Don't clobber a
  // map that already came from board_config.
  async function loadHoldMap() {
    if (configHasMap) return;
    try {
      const res = await fetch('hold_map.json', { cache: 'no-cache' });
      if (res.ok && !configHasMap) HOLD_MAP = await res.json();
    } catch (err) {
      console.warn('hold_map.json load failed — board overlay disabled', err);
    }
    refreshBoardViews();
  }

  // ── Load the mirror partner map (bundled; hold id -> mirror hold id) ─────────
  // Keyed by hold id, so it's independent of the board image / recalibration.
  // board_config (loadBoardConfig) is the source of truth once an admin has saved
  // an edited map; this bundled file is the first-paint / offline fallback. Don't
  // clobber a map that already came from board_config.
  async function loadMirrorMap() {
    if (configHasMirror) return;
    try {
      const res = await fetch('mirror_map.json', { cache: 'no-cache' });
      if (res.ok && !configHasMirror) MIRROR_MAP = await res.json();
    } catch (err) {
      console.warn('mirror_map.json load failed — mirror disabled', err);
    }
    if (currentView === 'detail' && detailMirror) router();
  }

  // ── Load the admin-saved board (image + hold map) from Supabase ──────────────
  // Overrides the bundled image/map when present. Cache-busts the image on
  // updated_at so a re-upload to the same path is never served stale.
  async function loadBoardConfig() {
    try {
      const { data, error } = await sb
        .from('board_config').select('hold_map, mirror_map, image_path, updated_at')
        .eq('wall', 'HangoutPortland').maybeSingle();
      if (error || !data) return;
      if (data.image_path) {
        const ver = data.updated_at ? `?v=${encodeURIComponent(data.updated_at)}` : '';
        BOARD_IMG = `${SUPA_URL}/storage/v1/object/public/${BOARD_BUCKET}/${data.image_path}${ver}`;
        applyBoardImage();
      }
      if (data.hold_map && typeof data.hold_map === 'object' && Object.keys(data.hold_map).length) {
        HOLD_MAP = data.hold_map;
        configHasMap = true;
      }
      if (data.mirror_map && typeof data.mirror_map === 'object' && Object.keys(data.mirror_map).length) {
        MIRROR_MAP = data.mirror_map;
        configHasMirror = true;
      }
      refreshBoardViews();
    } catch (err) {
      console.warn('board_config load failed — using bundled board', err);
    }
  }

  // ── Load the id -> username map (so setters show the live display name) ───────
  async function loadProfileNames() {
    const { data, error } = await sb.from('profiles').select('id, username');
    if (error) { console.warn('profile names load failed', error); return; }
    profileNames = Object.fromEntries((data || []).map(r => [r.id, r.username]));
    if (loaded) renderList();                       // refresh setters once names arrive
    if (currentView === 'detail') router();
    if (currentView === 'circuits') renderCircuits();
    else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
  }

  // ── Load problems ─────────────────────────────────────────────────────────────
  async function loadProblems() {
    const { data, error } = await sb.from('problems').select('*');

    if (error) {
      document.getElementById('list-container').innerHTML =
        `<div class="state-msg"><div class="icon">⚠️</div>Failed to load problems.<br><small style="opacity:.6">${escHtml(error.message)}</small></div>`;
      document.getElementById('count').textContent = '';
      return;
    }

    allProblems = data || [];
    loaded = true;
    buildGradeTabs();
    renderList();
    // Re-run the router in case we booted straight into #detail/<id>.
    router();
  }

  // ── Ticks (personal sends — private to the signed-in user) ───────────────────
  // Reflect the current problem's tick state on the detail header button.
  function updateTickButton() {
    const btn = document.getElementById('detail-tick');
    if (!btn) return;
    const ticked = currentProblem && isTicked(currentProblem.id);
    btn.classList.toggle('ticked', !!ticked);
    btn.setAttribute('aria-label', ticked ? 'Ticked — tap to remove' : 'Tick — mark as completed');
    updateAdminUI();
  }

  // Every .admin-only control appears only for admins, on a real problem.
  function updateAdminUI() {
    const show = !!(profile && profile.is_admin && currentProblem);
    document.querySelectorAll('.admin-only').forEach(btn => { btn.hidden = !show; });
  }

  // ── Delete a problem (admins only; the DB enforces it via RLS) ───────────────
  function openDeleteConfirm() {
    if (!currentProblem || !(profile && profile.is_admin)) return;
    document.getElementById('delete-name').textContent = displayName(currentProblem);
    document.getElementById('delete-error').textContent = '';
    document.getElementById('delete-modal').classList.add('show');
  }
  function closeDeleteConfirm() { document.getElementById('delete-modal').classList.remove('show'); }

  async function doDeleteProblem() {
    const p = currentProblem;
    if (!p) return;
    const errEl = document.getElementById('delete-error');
    const btn = document.getElementById('delete-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Deleting…';

    const { error } = await sb.from('problems').delete().eq('id', p.id);
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to delete problems.'   // not an admin (RLS)
        : error.message;
      return;
    }

    allProblems = allProblems.filter(x => String(x.id) !== String(p.id));
    myTicks.delete(String(p.id));
    closeDeleteConfirm();
    buildGradeTabs();
    renderList();
    showToast('Problem deleted', 'success');
    location.hash = '#list';
  }

  // ── Edit a problem's grade (admins only; DB enforces it via RLS) ─────────────
  let editGrade = '';
  function buildGradeEditOptions() {
    document.getElementById('grade-edit-options').innerHTML =
      gradeTabButtons(GRADE_ORDER, g => g === editGrade);
  }
  function openGradeEdit() {
    if (!currentProblem || !(profile && profile.is_admin)) return;
    editGrade = currentProblem.grade || '';
    document.getElementById('grade-problem-name').textContent = displayName(currentProblem);
    document.getElementById('grade-error').textContent = '';
    buildGradeEditOptions();
    document.getElementById('grade-modal').classList.add('show');
  }
  function closeGradeEdit() { document.getElementById('grade-modal').classList.remove('show'); }

  async function saveGradeEdit() {
    const p = currentProblem;
    if (!p) return;
    const errEl = document.getElementById('grade-error');
    if (!editGrade) { errEl.textContent = 'Pick a grade.'; return; }
    if (editGrade === p.grade) { closeGradeEdit(); return; }   // no change
    const btn = document.getElementById('grade-save');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';

    const { error } = await sb.from('problems').update({ grade: editGrade }).eq('id', p.id);
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to edit problems.'   // not an admin (RLS)
        : error.message;
      return;
    }

    p.grade = editGrade;                 // update in place (same object lives in allProblems)
    closeGradeEdit();
    buildGradeTabs();                    // a new grade may add/remove a filter tab
    renderList();
    if (currentView === 'detail') renderDetail(p.id);
    showToast('Grade updated', 'success');
  }

  // ── Admin hub (#admin) — board recalibration + user management ───────────────
  // Three sub-screens, all under the one #admin view, driven by the hash param:
  //   #admin            -> hub: cards for Recalibrate board + Users
  //   #admin/users      -> the user list (rows are links, no inline delete)
  //   #admin/user/<id>  -> one user's stats, with the delete button down there
  // User listing/deletion can't be done with the anon key (email lives in
  // auth.users; deleting an account needs elevated rights), so both go through
  // SECURITY DEFINER RPCs gated on is_admin() — see db/12_admin_users.sql.
  let adminUsers = [];                // cached rows from admin_list_users()
  let adminUsersLoaded = false;       // true once a fetch has populated adminUsers
  let pendingDeleteUser = null;       // { id, name } awaiting confirmation

  const boardIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8" cy="8" r="1.4"></circle><circle cx="16" cy="8" r="1.4"></circle><circle cx="8" cy="16" r="1.4"></circle><circle cx="16" cy="16" r="1.4"></circle></svg>';
  const usersIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
  const chevSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

  function fmtJoinDate(s) {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const userInitial = name => (String(name || '?').trim()[0] || '?').toUpperCase();

  // Surface "the db/12 RPCs aren't deployed yet" distinctly from a real failure.
  const rpcMissing = err =>
    !!err && (err.code === '42883' || err.code === 'PGRST202' || /Could not find the function|does not exist/i.test(err.message || ''));
  const usersErrorHtml = err => `<div class="state-msg"><div class="icon">⚠️</div>${
    rpcMissing(err)
      ? 'User management isn’t set up yet — run <b>db/12</b> in the Supabase SQL editor.'
      : 'Couldn’t load users.'}</div>`;

  // Set the admin header's title + whether the reload button shows (list only).
  function adminSetHeader(title, showRefresh) {
    document.getElementById('admin-title').textContent = title;
    document.getElementById('admin-refresh').hidden = !showRefresh;
  }

  // Fetch the user list once and cache it; `force` re-fetches (the reload button
  // and post-delete). Returns { ok, error } so callers can render the right state.
  async function ensureAdminUsers(force) {
    if (adminUsersLoaded && !force) return { ok: true };
    const { data, error } = await sb.rpc('admin_list_users');
    if (error) { console.warn('admin_list_users failed', error); return { ok: false, error }; }
    adminUsers = data || [];
    adminUsersLoaded = true;
    return { ok: true };
  }

  // Single entry point from the router; `sub` is the hash param after '#admin/'.
  function renderAdmin(sub) {
    if (!(document.getElementById('admin-content'))) return;
    if (!(profile && profile.is_admin)) { document.getElementById('admin-content').innerHTML = ''; return; }
    sub = sub || '';
    if (sub === 'users') return renderAdminUsers();
    if (sub.startsWith('user/')) return renderAdminUserDetail(sub.slice(5));
    return renderAdminHub();
  }

  function renderAdminHub() {
    adminSetHeader('Admin', false);
    document.getElementById('admin-content').innerHTML = `
      <div class="admin-hub">
        <a class="admin-card" href="#calibrate">
          <div class="admin-card-icon">${boardIconSvg}</div>
          <div class="admin-card-text">
            <div class="admin-card-title">Recalibrate board</div>
            <div class="admin-card-sub">Re-map holds onto a new board photo and publish it.</div>
          </div>
          <div class="admin-card-chev">${chevSvg}</div>
        </a>
        <a class="admin-card" href="#admin/users">
          <div class="admin-card-icon">${usersIconSvg}</div>
          <div class="admin-card-text">
            <div class="admin-card-title">Users</div>
            <div class="admin-card-sub">View accounts and manage members.</div>
          </div>
          <div class="admin-card-chev">${chevSvg}</div>
        </a>
      </div>`;
  }

  async function renderAdminUsers() {
    adminSetHeader('Users', true);
    const el = document.getElementById('admin-content');
    el.innerHTML = `<div class="spinner"></div>`;
    const res = await ensureAdminUsers(false);
    if (!onAdminSub('users')) return;                       // navigated away mid-load
    if (!res.ok) { el.innerHTML = usersErrorHtml(res.error); return; }
    if (!adminUsers.length) { el.innerHTML = `<div class="state-msg">No users yet.</div>`; return; }
    el.innerHTML = adminUsers.map(u => `
      <a class="admin-card user-link" href="#admin/user/${encodeURIComponent(u.id)}">
        <div class="user-avatar">${escHtml(userInitial(u.username))}</div>
        <div class="admin-card-text">
          <div class="admin-card-title">${escHtml(u.username)}${u.is_admin ? '<span class="user-badge">Admin</span>' : ''}</div>
          <div class="admin-card-sub">${escHtml(u.email || '—')}</div>
        </div>
        <div class="admin-card-chev">${chevSvg}</div>
      </a>`).join('');
  }

  async function renderAdminUserDetail(id) {
    adminSetHeader('User', false);
    const el = document.getElementById('admin-content');
    el.innerHTML = `<div class="spinner"></div>`;
    const res = await ensureAdminUsers(false);
    if (!onAdminSub('user/' + id)) return;                  // navigated away mid-load
    if (!res.ok) { el.innerHTML = usersErrorHtml(res.error); return; }
    const u = adminUsers.find(x => String(x.id) === String(id));
    if (!u) {
      el.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>User not found.<br><a class="link" href="#admin/users">Back to users</a></div>`;
      return;
    }
    adminSetHeader(u.username, false);
    const isSelf = String(u.id) === String(profile.id);
    const routes = Number(u.route_count) || 0;
    const sends = Number(u.tick_count) || 0;
    // Actions. Self: nothing (can't change own role/delete self). Otherwise an
    // admin toggle, plus delete for members only (demote an admin first).
    let action;
    if (isSelf) {
      action = `<p class="user-detail-note">This is your account.</p>`;
    } else if (u.is_admin) {
      action = `<button class="btn-block btn-ghost" id="user-demote-btn">Remove admin</button>
        <p class="user-detail-note">Remove admin before deleting this account.</p>`;
    } else {
      action = `<button class="btn-block btn-primary" id="user-promote-btn">Make admin</button>
        <button class="btn-block btn-danger" id="user-delete-btn">Delete user</button>`;
    }
    el.innerHTML = `
      <div class="user-detail-head">
        <div class="user-avatar lg">${escHtml(userInitial(u.username))}</div>
        <div class="user-detail-name">${escHtml(u.username)}${u.is_admin ? '<span class="user-badge">Admin</span>' : ''}</div>
        <div class="user-detail-email">${escHtml(u.email || '—')}</div>
      </div>
      <div class="profile-row"><span class="k">Role</span><span class="v">${u.is_admin ? 'Admin' : 'Member'}</span></div>
      <div class="profile-row"><span class="k">Joined</span><span class="v">${fmtJoinDate(u.created_at)}</span></div>
      <div class="profile-row"><span class="k">Routes set</span><span class="v">${routes}</span></div>
      <div class="profile-row"><span class="k">Sends</span><span class="v">${sends}</span></div>
      <div class="user-detail-actions">${action}</div>`;
    const promote = document.getElementById('user-promote-btn');
    if (promote) promote.addEventListener('click', () => openAdminChange(u.id, u.username, true));
    const demote = document.getElementById('user-demote-btn');
    if (demote) demote.addEventListener('click', () => openAdminChange(u.id, u.username, false));
    const delBtn = document.getElementById('user-delete-btn');
    if (delBtn) delBtn.addEventListener('click', () => openUserDelete(u.id, u.username));
  }

  // Are we still on the admin sub-screen a render started for? Guards async writes
  // against a fast navigation that happened mid-fetch.
  function onAdminSub(sub) {
    const { route, param } = parseHash();
    return currentView === 'admin' && route === 'admin' && (param || '') === sub;
  }

  function adminRefreshUsers() {
    adminUsersLoaded = false;
    renderAdminUsers();
  }

  // ── Promote / demote a user (admins only; the RPC re-checks is_admin and
  //    refuses self-changes) — see db/13_admin_promote.sql ─────────────────────
  let pendingAdminChange = null;   // { id, name, make }

  function openAdminChange(id, name, make) {
    pendingAdminChange = { id, name, make };
    document.getElementById('user-admin-modal-title').textContent = make ? 'Make admin?' : 'Remove admin?';
    document.getElementById('user-admin-modal-text').innerHTML = make
      ? `Give <b>${escHtml(name)}</b> admin rights? They’ll be able to delete and re-grade problems, recalibrate the board, and manage users.`
      : `Remove admin rights from <b>${escHtml(name)}</b>? They’ll go back to a normal member.`;
    document.getElementById('user-admin-error').textContent = '';
    const confirm = document.getElementById('user-admin-confirm');
    confirm.className = 'btn-block ' + (make ? 'btn-primary' : 'btn-danger');
    document.getElementById('user-admin-modal').classList.add('show');
  }
  function closeAdminChange() {
    document.getElementById('user-admin-modal').classList.remove('show');
    pendingAdminChange = null;
  }

  async function doAdminChange() {
    if (!pendingAdminChange) return;
    const { id, make } = pendingAdminChange;
    const errEl = document.getElementById('user-admin-error');
    const btn = document.getElementById('user-admin-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Saving…';

    const { error } = await sb.rpc('admin_set_admin', { target: id, make_admin: make });
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = rpcMissing(error)
        ? 'Not set up yet — run db/13 in Supabase.'
        : (error.message || 'Couldn’t update — check connection.');
      return;
    }

    const u = adminUsers.find(x => String(x.id) === String(id));
    if (u) u.is_admin = make;
    closeAdminChange();
    showToast(make ? 'Promoted to admin' : 'Admin removed', 'success');
    renderAdmin('user/' + id);   // re-render the detail with the new role + buttons
  }

  function openUserDelete(id, name) {
    pendingDeleteUser = { id, name };
    document.getElementById('user-delete-name').textContent = name;
    document.getElementById('user-delete-error').textContent = '';
    document.getElementById('user-delete-modal').classList.add('show');
  }
  function closeUserDelete() {
    document.getElementById('user-delete-modal').classList.remove('show');
    pendingDeleteUser = null;
  }

  async function doDeleteUser() {
    if (!pendingDeleteUser) return;
    const { id } = pendingDeleteUser;
    const errEl = document.getElementById('user-delete-error');
    const btn = document.getElementById('user-delete-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Deleting…';

    const { error } = await sb.rpc('admin_delete_user', { target: id });
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = rpcMissing(error)
        ? 'Not set up yet — run db/12 in Supabase.'
        : (error.message || 'Delete failed — check connection.');
      return;
    }

    adminUsers = adminUsers.filter(u => String(u.id) !== String(id));
    closeUserDelete();
    // Their problems lost the owner link (setter_id SET NULL) — refresh the live
    // setter-name map and the list so displayed setters fall back cleanly.
    await loadProfileNames();
    if (loaded) renderList();
    showToast('User deleted', 'success');
    location.hash = '#admin/users';   // back to the (now shorter) list
  }

  // Load the signed-in user's ticks into myTicks; clear for guests. RLS limits
  // the rows to this user, so we never see anyone else's sends.
  async function loadTicks() {
    if (!session) { myTicks = new Set(); return; }
    const { data, error } = await sb.from('ticks').select('problem_id').eq('user_id', session.user.id);
    if (error) { console.warn('ticks load failed', error); return; }
    myTicks = new Set((data || []).map(r => String(r.problem_id)));
  }

  // Toggle the current problem's tick. Optimistic: flip the UI first, revert on
  // failure. The unique(user_id, problem_id) constraint keeps it idempotent.
  async function toggleTick() {
    if (!session) { showToast('Sign in to track ticks', 'success'); location.hash = '#auth'; return; }
    const p = currentProblem;
    if (!p) return;
    const id = String(p.id);
    const wasTicked = isTicked(id);

    // Optimistic UI.
    if (wasTicked) myTicks.delete(id); else myTicks.add(id);
    updateTickButton();
    renderList();

    const res = wasTicked
      ? await sb.from('ticks').delete().eq('user_id', session.user.id).eq('problem_id', id)
      : await sb.from('ticks').insert({ user_id: session.user.id, problem_id: id });

    // 23505 = unique violation → the tick already exists, which is the state we
    // wanted, so treat it as success rather than rolling back.
    if (res.error && res.error.code !== '23505') {
      if (wasTicked) myTicks.add(id); else myTicks.delete(id);   // revert
      updateTickButton();
      renderList();
      showToast('Could not save — check connection', 'error');
      return;
    }
    showToast(wasTicked ? 'Removed tick' : 'Ticked ✓', 'success');
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  async function initAuth() {
    const { data } = await sb.auth.getSession();   // also consumes any OAuth redirect in the URL
    session = data.session || null;
    authReady = true;
    if (session) { await loadProfile(); await loadTicks(); }
    renderProfile();
    if (loaded) renderList();   // refresh tick flags (skip if problems still loading)
    if (currentView === 'detail') updateTickButton();
    if (location.hash.includes('access_token')) location.replace(location.pathname + '#list');
    else router();              // re-evaluate the route now auth is known (gates #create for guests)

    sb.auth.onAuthStateChange(async (_event, s) => {
      session = s || null;
      if (session) { await loadProfile(); await loadTicks(); }
      else { profile = null; myTicks = new Set(); }
      renderProfile();
      if (loaded) renderList();
      if (currentView === 'detail') updateTickButton();
    });
  }

  async function loadProfile() {
    if (!session) { profile = null; return; }
    const { data, error } = await sb
      .from('profiles').select('id, username, is_admin').eq('id', session.user.id).maybeSingle();
    // A load *error* is not the same as "no profile" — don't null an existing profile
    // or wrongly prompt an existing user to pick a name (which then 23505s on insert).
    if (error) { console.warn('profile load failed', error); return; }
    profile = data || null;
    if (session && !profile) promptDisplayName();   // genuinely new user (Google or email)
  }

  async function authEmail() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
    const btn = document.getElementById('auth-submit');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = '…';
    const res = authMode === 'signup'
      ? await sb.auth.signUp({ email, password })
      : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = prev;
    if (res.error) { errEl.textContent = res.error.message; return; }
    if (authMode === 'signup' && !res.data.session) {   // email confirmation is on
      showToast('Check your email to confirm your account', 'success');
      return;
    }
    location.hash = '#list';   // onAuthStateChange handles profile + display-name prompt
  }

  async function authGoogle() {
    const redirectTo = location.origin + location.pathname;   // back to the app, no hash
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) showToast(error.message, 'error');
  }

  async function doSignOut() {
    await sb.auth.signOut();
    showToast('Signed out', 'success');
    location.hash = '#list';
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    document.getElementById('auth-title').textContent = signup ? 'Create account' : 'Sign in';
    document.getElementById('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
    document.getElementById('auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    document.getElementById('auth-toggle-text').textContent = signup ? 'Already have an account?' : 'New here?';
    document.getElementById('auth-toggle-link').textContent = signup ? 'Sign in' : 'Create an account';
    const e = document.getElementById('auth-error'); if (e) e.textContent = '';
  }

  // The name modal does double duty: mandatory first-sign-in (no profile yet,
  // no Cancel) and editing later from the profile page (Cancel allowed).
  function openNameModal(mode) {
    const editing = mode === 'edit';
    document.getElementById('name-modal-title').textContent = editing ? 'Edit display name' : 'Choose a display name';
    document.getElementById('name-cancel').hidden = !editing;
    const email = (session && session.user && session.user.email) || '';
    document.getElementById('name-input').value = editing
      ? ((profile && profile.username) || '')
      : (email.split('@')[0] || '').trim();
    document.getElementById('name-error').textContent = '';
    document.getElementById('name-modal').classList.add('show');
    if (editing) setTimeout(() => document.getElementById('name-input').focus(), 50);
  }
  function promptDisplayName() { openNameModal('create'); }   // first sign-in
  function closeNameModal() { document.getElementById('name-modal').classList.remove('show'); }

  async function saveDisplayName() {
    const errEl = document.getElementById('name-error');
    const name = document.getElementById('name-input').value.trim();
    if (name.length < 2) { errEl.textContent = 'Pick a name (at least 2 characters).'; return; }
    if (!session) { errEl.textContent = 'Session expired — please sign in again.'; return; }
    const btn = document.getElementById('name-save'); btn.disabled = true;
    // Update if a profile row already exists (editing), otherwise create it.
    const { error } = profile
      ? await sb.from('profiles').update({ username: name }).eq('id', session.user.id)
      : await sb.from('profiles').insert({ id: session.user.id, username: name });
    btn.disabled = false;
    if (error) {
      errEl.textContent = error.code === '23505' ? 'That name is taken — try another.' : error.message;
      return;
    }
    const wasEditing = !!profile;
    closeNameModal();
    await loadProfile();
    profileNames[session.user.id] = name;   // reflect the rename on this user's problems
    renderProfile();
    renderList();
    if (currentView === 'detail') router();
    showToast(wasEditing ? 'Name updated' : 'Welcome, ' + name, 'success');
  }

  // Personal stats from the user's ticks (private to them).
  function tickStats() {
    const total = myTicks.size;
    let hardest = null;
    allProblems.forEach(p => {
      if (!isTicked(p.id) || gradeRank(p.grade) === 999) return;   // skip un-ticked / ungraded
      if (!hardest || gradeRank(p.grade) > gradeRank(hardest.grade)) hardest = p;
    });
    return { total, hardest };
  }

  function renderProfile() {
    const el = document.getElementById('profile-content');
    if (!el) return;
    const userSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    if (session && profile) {
      const editSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
      const { total, hardest } = tickStats();
      const hardestHtml = hardest
        ? `<span class="grade-badge">${escHtml(hardest.grade)}</span> <span class="hardest-name">${escHtml(displayName(hardest))}</span>`
        : '—';
      el.innerHTML = `
        <div class="shell-card" style="margin:8px auto 18px;text-align:center">
          <div class="shell-icon">${userSvg}</div>
          <div class="profile-name-row">
            <div class="shell-title" style="margin-bottom:0">${escHtml(profile.username)}</div>
            <button class="icon-btn profile-edit" id="profile-edit-name" aria-label="Edit display name">${editSvg}</button>
          </div>
          <div class="shell-sub" style="margin-top:6px">${escHtml((session.user && session.user.email) || '')}</div>
          <button class="btn-block btn-ghost" id="profile-signout">Sign out</button>
        </div>
        <div class="profile-row"><span class="k">Total ticks</span><span class="v">${total}</span></div>
        <div class="profile-row"><span class="k">Hardest send</span><span class="v">${hardestHtml}</span></div>
        ${profile.is_admin ? `<a class="btn-block btn-ghost" href="#admin" style="display:block;text-align:center;text-decoration:none;margin-top:18px">Admin tools</a>` : ''}`;
      document.getElementById('profile-signout').addEventListener('click', doSignOut);
      document.getElementById('profile-edit-name').addEventListener('click', () => openNameModal('edit'));
    } else {
      el.innerHTML = `
        <div class="shell-card" style="margin:8px auto 18px;text-align:center">
          <div class="shell-icon">${userSvg}</div>
          <div class="shell-title">Browsing as guest</div>
          <div class="shell-sub">Sign in to set problems and track your sends.</div>
          <button class="btn-block btn-primary" id="profile-signin">Sign in</button>
        </div>`;
      document.getElementById('profile-signin').addEventListener('click', () => { location.hash = '#auth'; });
    }
  }

  // ── Create a problem ──────────────────────────────────────────────────────────
  // Holds keep their physical role in createRoles; the board shows every hold as a
  // faint dot (reference) and colours the assigned ones. On save we build the
  // canonical display order and store it INVERTED so the existing renderer
  // (problemHoldOrder) un-inverts it back to the right colours — see CLAUDE.md.

  const holdsWithRole = role => Object.keys(createRoles).filter(h => createRoles[h] === role);

  // The finish zone is the TOP 25% of the board by height. Any hold sitting in that
  // band is finish-eligible — or may instead be an intermediate (e.g. a traverse
  // along the top) — and no start holds are allowed up there. Holds below the band
  // are start/intermediate only. The threshold is derived from the live hold map's
  // y span (so it tracks whatever board image board_config serves) rather than a
  // fixed hold count — hold numbering doesn't map to visual rows on this hand-set
  // board. Computed fresh per call (cheap, and immune to the map being swapped for
  // the live board_config one after first use).
  function topZoneThreshold() {
    if (!HOLD_MAP) return -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    for (const h in HOLD_MAP) {
      const y = HOLD_MAP[h].y;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    return ymin + (ymax - ymin) * 0.25;
  }
  function inTopZone(h) {
    return !!(HOLD_MAP && HOLD_MAP[h]) && HOLD_MAP[h].y <= topZoneThreshold();
  }

  // Draw a coloured dot for each assigned hold (only assigned ones — no faint
  // reference dots) and refresh the running count summary.
  function applyCreateRoles() {
    const layer = document.getElementById('create-hold-layer');
    if (layer) {
      layer.innerHTML = Object.keys(createRoles).map(h => {
        const pos = HOLD_MAP && HOLD_MAP[h];
        if (!pos) return '';
        return `<div class="hold-dot ${createRoles[h]}" style="left:${pos.x}%;top:${pos.y}%"></div>`;
      }).join('');
    }
    const s = holdsWithRole('start').length, i = holdsWithRole('int').length, f = holdsWithRole('finish').length;
    const counts = document.getElementById('create-counts');
    if (counts) {
      counts.innerHTML =
        `<span class="c-start">${s} start</span>` +
        `<span class="c-int">${i} hold${i === 1 ? '' : 's'}</span>` +
        `<span class="c-finish">${f} finish</span>`;
    }
  }

  // Nearest hold to a tap (in pixel space, since x/y are % of different axes).
  // Returns null if the tap is too far from any hold to count.
  function nearestHold(clientX, clientY) {
    if (!HOLD_MAP) return null;
    const r = document.getElementById('create-board').getBoundingClientRect();
    const px = (clientX - r.left) / r.width * 100;
    const py = (clientY - r.top) / r.height * 100;
    let best = null, bestD = Infinity;
    for (const h in HOLD_MAP) {
      const dx = (HOLD_MAP[h].x - px) / 100 * r.width;
      const dy = (HOLD_MAP[h].y - py) / 100 * r.height;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = h; }
    }
    return Math.sqrt(bestD) <= r.width * 0.06 ? best : null;   // ~half a hold spacing
  }

  // Tap to cycle a hold's role:
  //   • top-zone hold (top 25% of the board), no finish set yet → hold (blue) →
  //     finish (red) → off. Once a finish exists, the other top holds cycle
  //     hold (blue) → off only (so promotion to red happens just once — no
  //     finish-stealing); the finish hold itself toggles red → off to clear it.
  //     No starts are allowed up there.
  //   • any other hold → start (green) → hold (blue) → off, where a fresh tap
  //     starts green while fewer than two starts exist, otherwise blue.
  function cycleHold(h) {
    const cur = createRoles[h];
    if (inTopZone(h)) {
      if (cur === 'finish') {
        delete createRoles[h];
      } else if (cur === 'int') {
        if (holdsWithRole('finish').length) delete createRoles[h];   // finish taken → blue → off
        else createRoles[h] = 'finish';                             // no finish yet → blue → red
      } else {
        createRoles[h] = 'int';
      }
    } else if (cur === 'start') {
      createRoles[h] = 'int';
    } else if (cur === 'int') {
      delete createRoles[h];
    } else {
      createRoles[h] = holdsWithRole('start').length < 2 ? 'start' : 'int';
    }
    applyCreateRoles();
  }

  function buildCreateGrades() {
    document.getElementById('create-grades').innerHTML =
      gradeTabButtons(GRADE_ORDER, g => g === createGrade);
  }

  function resetCreate() {
    createRoles = {}; createGrade = '';
    const nameEl = document.getElementById('create-name'); if (nameEl) nameEl.value = '';
    document.getElementById('create-error').textContent = '';
    buildCreateGrades();
    applyCreateRoles();
  }

  // Prepare the create view on entry.
  function initCreateView() {
    buildCreateGrades();
    applyCreateRoles();
  }

  async function saveProblem() {
    const errEl = document.getElementById('create-error');
    errEl.textContent = '';
    if (!session) { location.hash = '#auth'; return; }

    const name = document.getElementById('create-name').value.trim();
    const starts = holdsWithRole('start');
    const ints = holdsWithRole('int');
    const fins = holdsWithRole('finish');

    if (!name) { errEl.textContent = 'Give your problem a name.'; return; }
    if (!createGrade) { errEl.textContent = 'Pick a grade.'; return; }
    if (starts.length < 1) { errEl.textContent = 'Add at least one start hold.'; return; }
    if (ints.length < 1) { errEl.textContent = 'Add at least one intermediate hold.'; return; }
    if (fins.length !== 1) { errEl.textContent = 'Add exactly one finish hold.'; return; }

    // Names must be unique — they're how a problem is cast. Compare on the *displayed*
    // name (grade stripped) so a new "Crimpy" can't collide with a migrated "Crimpy 6a".
    const newDisplay = displayName({ name, grade: createGrade }).toLowerCase();
    if (allProblems.some(p => displayName(p).toLowerCase() === newDisplay)) {
      errEl.textContent = 'That name is taken — pick another.';
      return;
    }

    // Canonical display order D = [start, start, …intermediates, finish].
    // A single (matched) start is duplicated so the renderer's "first two = start"
    // rule paints it green; the overlay de-dupes the repeated dot.
    const startPair = starts.length === 1 ? [starts[0], starts[0]] : starts.slice(0, 2);
    const D = [...startPair, ...ints, fins[0]];

    // Store INVERTED to match the migrated rows (see CLAUDE.md / problemHoldOrder):
    //   finish_hold = D[0], intermediate_holds = D[1..n-2], start_holds = last two.
    const row = {
      name,
      grade: createGrade,
      setter: (profile && profile.username) || '',     // snapshot (NOT NULL); display uses setter_id
      setter_id: session.user.id,                      // owner — drives the live setter name
      finish_hold: D[0],
      intermediate_holds: D.slice(1, D.length - 2),
      start_holds: D.slice(D.length - 2),
      feet_mode: 'any',
      is_benchmark: false
    };

    const btn = document.getElementById('create-save');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
    const { data, error } = await sb.from('problems').insert(row).select().single();
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent =
        error.code === '42501' ? 'You don’t have permission to create problems yet.'   // RLS INSERT policy missing
        : error.code === '23505' ? 'That name is taken — pick another.'                // unique-name backstop
        : error.message;
      return;
    }

    allProblems.push(data);
    buildGradeTabs();
    renderList();
    resetCreate();
    showToast('Problem created ✓', 'success');
    // Replace the #create history entry with the new problem's detail, so Back
    // from there returns to the list (not into the create form).
    location.replace('#detail/' + encodeURIComponent(data.id));
  }

  // ── Recalibrate board (admin tool) ───────────────────────────────────────────
  // Swap in a new board image and re-anchor the existing hold positions onto it.
  // The hold→dot LABELLING never changes (it's frozen in hold_map.json); only each
  // hold's x/y % shifts when the image's framing/aspect changes. So we fit a single
  // least-squares affine from the saved positions to a few user-placed anchors, snap
  // every hold at once, then export a fresh hold_map.json. No Python / ICP needed.
  const CAL = {
    base: null,      // immutable copy of the saved hold_map { hold: {x,y} } — the fit source
    pos: null,       // working positions (drawn + exported)
    anchors: [],     // [{ hold, x, y }] true positions the user has pinned
    selected: null,  // hold id awaiting its anchor target (anchor mode) / first tap (mirror mode)
    mode: 'anchor',  // 'anchor' | 'nudge' | 'add' | 'mirror'
    drag: null,      // hold currently being dragged (nudge mode)
    imgFile: null,   // a newly-picked board image awaiting upload on Save
    mirror: null,    // working copy of the mirror map { hold: partner } (mirror mode); self = no mirror
  };

  const isAdmin = () => !!(profile && profile.is_admin);

  function initCalibrate() {
    const status = document.getElementById('cal-status');
    if (!CAL.pos) {
      if (!HOLD_MAP) { if (status) status.textContent = 'Hold map still loading…'; return; }
      CAL.base = JSON.parse(JSON.stringify(HOLD_MAP));
      CAL.pos = JSON.parse(JSON.stringify(HOLD_MAP));
    }
    // Seed the working mirror map from whatever's live (board_config or bundled).
    if (!CAL.mirror) CAL.mirror = MIRROR_MAP ? JSON.parse(JSON.stringify(MIRROR_MAP)) : {};
    document.querySelectorAll('#cal-mode .cal-seg').forEach(b => b.classList.toggle('active', b.dataset.mode === CAL.mode));
    document.getElementById('cal-board').classList.toggle('nudging', CAL.mode === 'nudge');
    renderCal();
  }

  function renderCal() {
    const layer = document.getElementById('cal-layer');
    if (!layer || !CAL.pos) return;
    const anchored = new Set(CAL.anchors.map(a => a.hold));
    const mirroring = CAL.mode === 'mirror';
    const selPartner = mirroring && CAL.selected ? CAL.mirror[CAL.selected] : null;
    let html = Object.keys(CAL.pos).map(h => {
      const p = CAL.pos[h];
      let cls;
      if (mirroring) {
        cls = h === CAL.selected ? 'sel'
            : h === selPartner ? 'partner'
            : (CAL.mirror[h] === h || !(h in CAL.mirror)) ? 'selfmirror' : '';
      } else {
        cls = h === CAL.selected ? 'sel' : (anchored.has(h) ? 'anchored' : '');
      }
      return `<div class="cal-dot ${cls}" style="left:${p.x}%;top:${p.y}%"></div>`;
    }).join('');
    if (!mirroring) html += CAL.anchors.map(a => `<div class="cal-anchor" style="left:${a.x}%;top:${a.y}%"></div>`).join('');
    layer.innerHTML = html;

    document.getElementById('cal-anchor-count').textContent =
      `${CAL.anchors.length} anchor${CAL.anchors.length === 1 ? '' : 's'}`;
    document.getElementById('cal-fit').disabled = CAL.anchors.length < 3;

    const status = document.getElementById('cal-status');
    if (CAL.mode === 'add') {
      const miss = calMissingHolds();
      status.textContent = miss.length
        ? `Tap where hold ${holdNum(miss[0])} (${gridName(holdNum(miss[0]))}) goes — ${miss.length} hold${miss.length === 1 ? '' : 's'} missing.`
        : 'All 189 holds are placed — none missing.';
    }
    else if (CAL.mode === 'mirror') {
      const s = CAL.selected;
      if (s) {
        const part = CAL.mirror[s];
        status.textContent = (!part || part === s)
          ? `${holdNum(s)} (${gridName(holdNum(s))}) has no mirror. Tap its partner to pair it, or tap ${holdNum(s)} again to keep it unmirrored.`
          : `${holdNum(s)} (${gridName(holdNum(s))}) ↔ ${holdNum(part)} (${gridName(holdNum(part))}). Tap a new partner to repair, or tap ${holdNum(s)} again for "no mirror".`;
      } else {
        status.textContent = 'Mirror mode — tap a hold to see its partner; amber dots have no mirror.';
      }
    }
    else if (CAL.mode === 'nudge') status.textContent = 'Nudge mode — drag any dot to fine-tune.';
    else if (CAL.selected) status.textContent = `Now tap where hold ${holdNum(CAL.selected)} really is.`;
    else if (CAL.anchors.length < 3) status.textContent = `Tap a dot, then its true spot — ${3 - CAL.anchors.length} more to fit.`;
    else status.textContent = 'Ready to fit — or add more anchors for accuracy.';
  }

  // Real holds (ground truth) that aren't in the working map yet, lowest id first.
  function calMissingHolds() {
    return VALID_HOLD_IDS.map(n => 'hold' + n).filter(h => !(h in CAL.pos));
  }

  // Add mode: tap to place the next missing hold at that spot.
  function calAddTap(e) {
    const miss = calMissingHolds();
    if (!miss.length) return;
    const { x, y } = calPct(e.clientX, e.clientY);
    CAL.pos[miss[0]] = { x: +x.toFixed(2), y: +y.toFixed(2) };
    // A freshly-added hold has no "saved" source, so seed base too — otherwise a
    // later Fit (which maps from base) would drop it again.
    CAL.base[miss[0]] = { x: CAL.pos[miss[0]].x, y: CAL.pos[miss[0]].y };
    renderCal();
    showToast(`Placed ${miss[0]} (${gridName(holdNum(miss[0]))})`, 'success');
  }

  // Mirror mode: first tap selects a hold (and shows its current partner); second
  // tap either pairs it with another hold, sets "no mirror" (tap the same hold
  // again), or cancels (tap empty space). Pairs are kept symmetric — repairing one
  // hold orphans its old partner to "no mirror" so the map stays an involution.
  function setMirrorPair(a, b) {
    const m = CAL.mirror;
    if (a === b) {                              // mark a as self / no mirror
      const old = m[a];
      if (old && old !== a) m[old] = old;
      m[a] = a;
      return;
    }
    const oa = m[a], ob = m[b];
    if (oa && oa !== a && oa !== b) m[oa] = oa; // a's old partner -> no mirror
    if (ob && ob !== b && ob !== a) m[ob] = ob; // b's old partner -> no mirror
    m[a] = b; m[b] = a;
  }

  function calMirrorTap(e) {
    const h = calNearest(e.clientX, e.clientY);
    if (!CAL.selected) { if (h) CAL.selected = h; renderCal(); return; }
    if (!h) { CAL.selected = null; renderCal(); return; }   // tapped away = cancel
    const a = CAL.selected;
    setMirrorPair(a, h);
    CAL.selected = null;
    renderCal();
    showToast(a === h ? `${holdNum(a)} set to no mirror`
                      : `${holdNum(a)} ↔ ${holdNum(h)}`, 'success');
  }

  // Pointer event → board-relative %, plus the board rect (for distance maths).
  function calPct(clientX, clientY) {
    const r = document.getElementById('cal-board').getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * 100, y: (clientY - r.top) / r.height * 100, r };
  }

  // Nearest working dot to a tap (pixel distance), or null if too far to count.
  function calNearest(clientX, clientY) {
    const { x: px, y: py, r } = calPct(clientX, clientY);
    let best = null, bestD = Infinity;
    for (const h in CAL.pos) {
      const dx = (CAL.pos[h].x - px) / 100 * r.width;
      const dy = (CAL.pos[h].y - py) / 100 * r.height;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = h; }
    }
    return Math.sqrt(bestD) <= r.width * 0.06 ? best : null;
  }

  // Anchor mode: first tap selects the nearest dot, second tap pins its true spot.
  function calAnchorTap(e) {
    const { x, y } = calPct(e.clientX, e.clientY);
    if (!CAL.selected) {
      const h = calNearest(e.clientX, e.clientY);
      if (h) CAL.selected = h;
    } else {
      CAL.anchors = CAL.anchors.filter(a => a.hold !== CAL.selected);   // one anchor per hold
      CAL.anchors.push({ hold: CAL.selected, x: +x.toFixed(2), y: +y.toFixed(2) });
      CAL.selected = null;
    }
    renderCal();
  }

  // 3×3 linear solve (Gaussian elimination, partial pivot). Returns null if singular.
  function solve3(M, v) {
    const a = M.map((row, i) => [...row, v[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-9) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  }

  // Fit a least-squares affine (saved positions → anchors) and apply to every hold.
  function calFit() {
    if (CAL.anchors.length < 3) return;
    const M = [[0,0,0],[0,0,0],[0,0,0]];
    const bx = [0,0,0], by = [0,0,0];
    for (const a of CAL.anchors) {
      const s = CAL.base[a.hold];
      if (!s) continue;
      const row = [s.x, s.y, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j];
        bx[i] += row[i] * a.x;
        by[i] += row[i] * a.y;
      }
    }
    const cx = solve3(M, bx), cy = solve3(M, by);
    if (!cx || !cy) {
      document.getElementById('cal-status').textContent = 'Anchors are too close to a line — pick spread-out holds.';
      return;
    }
    for (const h in CAL.pos) {
      const s = CAL.base[h];
      CAL.pos[h] = {
        x: +(cx[0]*s.x + cx[1]*s.y + cx[2]).toFixed(2),
        y: +(cy[0]*s.x + cy[1]*s.y + cy[2]).toFixed(2),
      };
    }
    // Anchors have done their job — clear them so the board shows the clean fitted
    // placement, not the leftover anchor markers / pre-fit dots.
    CAL.anchors = [];
    CAL.selected = null;
    renderCal();
    showToast('Holds fitted to anchors ✓', 'success');
  }

  // Nudge mode: drag the nearest dot to a new spot (pointer events = mouse + touch).
  function calDragStart(e) {
    if (CAL.mode !== 'nudge') return;
    const h = calNearest(e.clientX, e.clientY);
    if (!h) return;
    CAL.drag = h;
    const board = document.getElementById('cal-board');
    if (board.setPointerCapture) board.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function calDragMove(e) {
    if (!CAL.drag) return;
    const { x, y } = calPct(e.clientX, e.clientY);
    CAL.pos[CAL.drag] = { x: +x.toFixed(2), y: +y.toFixed(2) };
    renderCal();
    e.preventDefault();
  }
  function calDragEnd() { CAL.drag = null; }

  function calSetMode(mode) {
    CAL.mode = mode; CAL.selected = null; CAL.drag = null;
    document.getElementById('cal-board').classList.toggle('nudging', mode === 'nudge');
    document.querySelectorAll('#cal-mode .cal-seg').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderCal();
  }

  function calReset() {
    if (!CAL.base) return;
    CAL.pos = JSON.parse(JSON.stringify(CAL.base));
    CAL.anchors = []; CAL.selected = null;
    renderCal();
    showToast('Reset to saved positions', 'success');
  }
  function calClearAnchors() { CAL.anchors = []; CAL.selected = null; renderCal(); }

  function calLoadImage(file) {
    if (!file) return;
    CAL.imgFile = file;   // held for upload on Save
    // Dots are positioned in % of the image, so they re-land on the new framing.
    document.getElementById('cal-img').src = URL.createObjectURL(file);
    document.getElementById('cal-status').textContent = 'New image loaded — re-anchor, then Save.';
  }

  // Build the hold map in hold-number order (stable + readable in the DB).
  function calOrderedMap() {
    const out = {};
    Object.keys(CAL.pos)
      .sort((a, b) => (+holdNum(a)) - (+holdNum(b)))
      .forEach(h => { out[h] = { x: +CAL.pos[h].x, y: +CAL.pos[h].y }; });
    return out;
  }

  // Save board → publish image (if a new one was picked) + hold map to Supabase.
  // Admin-only; the DB/storage RLS is the real gate (the button is just UX).
  async function calSave() {
    if (!CAL.pos) return;
    const btn = document.getElementById('cal-save');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
    const status = document.getElementById('cal-status');
    try {
      const row = { wall: 'HangoutPortland', hold_map: calOrderedMap(), updated_at: new Date().toISOString() };
      // Publish the mirror map alongside positions so manual mirror fixes go live.
      if (CAL.mirror && Object.keys(CAL.mirror).length) row.mirror_map = CAL.mirror;

      // Upload the new image first (fixed object name; cache-busted on load by updated_at).
      if (CAL.imgFile) {
        const ext = (CAL.imgFile.type === 'image/jpeg') ? 'jpg' : (CAL.imgFile.type === 'image/webp') ? 'webp' : 'png';
        const objName = 'board.' + ext;
        const up = await sb.storage.from(BOARD_BUCKET)
          .upload(objName, CAL.imgFile, { upsert: true, cacheControl: '3600', contentType: CAL.imgFile.type });
        if (up.error) throw up.error;
        row.image_path = objName;
      }

      const { error } = await sb.from('board_config').upsert(row, { onConflict: 'wall' });
      if (error) throw error;

      // Reflect the save locally so it's live without a reload.
      HOLD_MAP = JSON.parse(JSON.stringify(CAL.pos));
      configHasMap = true;
      if (CAL.mirror && Object.keys(CAL.mirror).length) {
        MIRROR_MAP = JSON.parse(JSON.stringify(CAL.mirror));
        configHasMirror = true;
      }
      if (CAL.imgFile) {
        BOARD_IMG = `${SUPA_URL}/storage/v1/object/public/${BOARD_BUCKET}/${row.image_path}?v=${encodeURIComponent(row.updated_at)}`;
        CAL.imgFile = null;
        applyBoardImage();
      }
      // Show the clean saved placement — drop any leftover anchors/selection.
      CAL.anchors = [];
      CAL.selected = null;
      renderCal();
      btn.disabled = false; btn.textContent = prev;
      document.getElementById('cal-saved-modal').classList.add('show');
    } catch (err) {
      btn.disabled = false; btn.textContent = prev;
      const msg = (err && err.code === '42501')
        ? 'You don’t have permission to save the board.'   // not an admin (RLS)
        : (err && err.message) || 'Save failed — check connection.';
      status.textContent = msg;
      showToast('Save failed', 'error');
      console.error('board save failed', err);
    }
  }

  // ══ CIRCUITS ═══════════════════════════════════════════════════════════════════
  // A circuit is a long sport-style route: one ordered hold sequence (duplicates
  // allowed), 1–2 starts (the first holds), one finish (the last hold), optional
  // loop. Phase 1 = browse / create / detail with an in-app Play preview of the
  // moving-window animation. No real casting yet (that's Phase 2).

  const circuitName = c => String((c && c.name) || '').trim() || '(unnamed)';
  const circuitSeq  = c => (Array.isArray(c && c.hold_sequence) ? c.hold_sequence : []);
  const canEditCircuit = c =>
    !!(c && profile && (profile.is_admin || (session && c.setter_id === session.user.id)));

  // Surface "db/14 isn't applied yet" distinctly from a real failure.
  const circuitsTableMissing = err =>
    !!err && (err.code === '42P01' || err.code === 'PGRST205' ||
      /Could not find the table|relation .* does not exist|schema cache/i.test(err.message || ''));

  // A sequence position's role: finish (last) wins over start (first N), else move.
  function circuitRole(seq, startCount, pos) {
    if (pos === seq.length - 1) return 'finish';
    if (pos < startCount) return 'start';
    return 'int';
  }

  async function loadCircuits() {
    const { data, error } = await sb.from('circuits').select('*');
    if (error) {
      circuitsError = error;
      console.warn('circuits load failed', error);
      if (currentView === 'circuits') renderCircuits();
      else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
      return;
    }
    allCircuits = data || [];
    circuitsLoaded = true;
    circuitsError = null;
    if (currentView === 'circuits') renderCircuits();
    else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
  }

  // ── Circuit list ───────────────────────────────────────────────────────────────
  function visibleCircuits() {
    let arr = allCircuits;
    if (activeCircuitGrade) arr = arr.filter(c => c.grade === activeCircuitGrade);
    if (circuitSearch) {
      const q = circuitSearch;
      arr = arr.filter(c =>
        circuitName(c).toLowerCase().includes(q) ||
        setterName(c).toLowerCase().includes(q) ||
        String(c.grade || '').toLowerCase().includes(q)
      );
    }
    return arr.slice().sort((a, b) =>
      sportRank(a.grade) - sportRank(b.grade) || circuitName(a).localeCompare(circuitName(b))
    );
  }

  function buildCircuitGradeTabs() {
    const present = [...new Set(allCircuits.map(c => c.grade).filter(Boolean))]
      .sort((a, b) => sportRank(a) - sportRank(b) || a.localeCompare(b));
    if (activeCircuitGrade && !present.includes(activeCircuitGrade)) activeCircuitGrade = '';
    document.getElementById('circuit-grade-tabs').innerHTML =
      gradeTabButtons(['all', ...present], g => g === 'all' ? !activeCircuitGrade : g === activeCircuitGrade);
  }

  function circuitCardHtml(c) {
    const n = circuitSeq(c).length;
    return `
      <div class="problem-card" data-id="${escAttr(c.id)}">
        <div class="problem-info">
          <div class="problem-name">${escHtml(circuitName(c))}</div>
          <div class="problem-meta">
            <span class="grade-badge">${escHtml(c.grade || '—')}</span>
            <span class="meta-setter">${escHtml(setterName(c))}</span>
            <span class="circuit-len">${n} move${n === 1 ? '' : 's'}</span>
            ${c.loops ? '<span class="loop-badge">↻ Loop</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  function renderCircuits() {
    buildCircuitGradeTabs();
    const container = document.getElementById('circuit-list-container');
    const countEl = document.getElementById('circuit-count');
    if (!circuitsLoaded) {
      if (circuitsError) {
        countEl.textContent = '';
        container.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>${
          circuitsTableMissing(circuitsError)
            ? 'Circuits aren’t set up yet — run <b>db/14</b> in the Supabase SQL editor.'
            : 'Failed to load circuits.'}</div>`;
      }
      return;
    }
    const list = visibleCircuits();
    countEl.textContent = `${list.length} circuit${list.length !== 1 ? 's' : ''}`;
    if (!list.length) {
      container.innerHTML = `<div class="state-msg"><div class="icon">🧗</div>${
        allCircuits.length ? 'No circuits match.' : 'No circuits yet — tap + to set the first one.'}</div>`;
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(circuitCardHtml).join('')}</div>`;
  }

  // ── Circuit detail (+ in-app Play preview) ──────────────────────────────────────
  // Static overlay: one dot per UNIQUE hold, coloured by role, badged with its move
  // number(s). The Play engine animates a 4-hold moving window over the sequence.
  function circuitStaticOverlay(c) {
    const seq = circuitSeq(c);
    if (!HOLD_MAP || !seq.length) return '';
    const byHold = {};   // hold -> { positions:[], role }
    seq.forEach((h, pos) => {
      if (!byHold[h]) byHold[h] = { positions: [], role: 'int' };
      byHold[h].positions.push(pos);
      const r = circuitRole(seq, c.start_count, pos);
      // finish > start > int when a hold takes several roles across repeats.
      if (r === 'finish' || (r === 'start' && byHold[h].role !== 'finish')) byHold[h].role = r;
    });
    return Object.keys(byHold).map(h => {
      const pos = HOLD_MAP[h];
      if (!pos) return '';
      const o = byHold[h];
      const label = o.positions.map(p => p + 1).join('/');
      return `<div class="hold-dot ${o.role}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${label}</span></div>`;
    }).join('');
  }

  function renderCircuitDetail(id) {
    stopCircuitPlay(false);
    const wrap = document.getElementById('circuit-detail-content');
    const titleEl = document.getElementById('circuit-detail-title');
    const delBtn = document.getElementById('circuit-detail-delete');
    delBtn.hidden = true;

    if (!circuitsLoaded) {
      currentCircuit = null;
      if (circuitsError) {
        wrap.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>${
          circuitsTableMissing(circuitsError)
            ? 'Circuits aren’t set up yet — run <b>db/14</b> in Supabase.'
            : 'Couldn’t load circuits.'}<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      } else {
        wrap.innerHTML = `<div class="spinner"></div>`;
      }
      return;
    }

    const c = allCircuits.find(x => String(x.id) === String(id));
    if (!c) {
      currentCircuit = null;
      titleEl.textContent = 'Circuit';
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That circuit couldn't be found.<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      return;
    }

    currentCircuit = c;
    titleEl.textContent = circuitName(c);
    delBtn.hidden = !canEditCircuit(c);
    const n = circuitSeq(c).length;
    const comment = String(c.comment || '').trim();

    wrap.innerHTML = `
      <div class="detail-head-info">
        <h1 class="detail-name">${escHtml(circuitName(c))}</h1>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(c.grade || '—')}</span>
          <span class="meta-setter">by ${escHtml(setterName(c))}</span>
          <span class="circuit-len">${n} move${n === 1 ? '' : 's'}</span>
          ${c.loops ? '<span class="loop-badge">↻ Loop</span>' : ''}
        </div>
      </div>

      <div class="board-wrap">
        <img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />
        <div class="hold-layer" id="circuit-play-layer">${circuitStaticOverlay(c)}</div>
      </div>

      <div class="circuit-play-panel">
        <button class="btn-block btn-primary" id="circuit-play-btn">▶ Play preview</button>
        <div class="circuit-speed">
          <span class="circuit-speed-label">Speed</span>
          <button class="circuit-speed-btn" id="circuit-speed-down" aria-label="Faster">−</button>
          <span class="circuit-speed-val" id="circuit-speed-val"></span>
          <button class="circuit-speed-btn" id="circuit-speed-up" aria-label="Slower">+</button>
        </div>
        ${comment ? `<p class="detail-comment" style="margin-top:14px">${escHtml(comment)}</p>` : ''}
        <p class="cc-hint">Preview runs a 4-hold moving window up the route${c.loops ? ', looping until you stop it' : ''}. Real casting to the board comes next.</p>
      </div>`;

    document.getElementById('circuit-play-btn').addEventListener('click', toggleCircuitPlay);
    document.getElementById('circuit-speed-down').addEventListener('click', () => setPlaySpeed(playIntervalMs - 100));
    document.getElementById('circuit-speed-up').addEventListener('click', () => setPlaySpeed(playIntervalMs + 100));
    updateSpeedLabel();
  }

  // ── Play engine (moving 4-hold window) ──────────────────────────────────────────
  // Same logic will drive the Phase-2 cast-screen move timing. The lit window is the
  // up-to-4 most-recent holds ending at the current tick; wrapping for loops. Speed
  // is a live preview control (0.1s steps), not stored per circuit — the agreed
  // design sets speed at cast time, so this is the same kind of knob.
  const PLAY_WINDOW = 4;
  const PLAY_MIN_MS = 200, PLAY_MAX_MS = 3000;
  let playIntervalMs = 1000;   // default 1.0s between holds
  let playTimer = null;
  let playDraw = null;         // the running draw fn (so a speed change can restart the timer)

  function updateSpeedLabel() {
    const el = document.getElementById('circuit-speed-val');
    if (el) el.textContent = (playIntervalMs / 1000).toFixed(1) + 's';
  }

  // Adjust preview speed; if a play is in progress, restart the timer at the new
  // interval (keeps the current position via the live draw closure).
  function setPlaySpeed(ms) {
    playIntervalMs = Math.max(PLAY_MIN_MS, Math.min(PLAY_MAX_MS, ms));
    updateSpeedLabel();
    if (playTimer && playDraw) { clearInterval(playTimer); playTimer = setInterval(playDraw, playIntervalMs); }
  }

  function stopCircuitPlay(restore) {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    playDraw = null;
    const btn = document.getElementById('circuit-play-btn');
    if (btn) btn.innerHTML = '▶ Play preview';
    if (restore && currentCircuit) {
      const layer = document.getElementById('circuit-play-layer');
      if (layer) layer.innerHTML = circuitStaticOverlay(currentCircuit);
    }
  }

  function toggleCircuitPlay() {
    if (playTimer) { stopCircuitPlay(true); return; }
    const c = currentCircuit;
    const seq = circuitSeq(c);
    if (!c || !HOLD_MAP || seq.length < 1) { showToast('Nothing to play', 'error'); return; }
    const btn = document.getElementById('circuit-play-btn');
    if (btn) btn.innerHTML = '■ Stop';
    let tick = 0;
    const L = seq.length;
    const loop = !!c.loops;
    const draw = () => {
      // Window = the up-to-4 most-recent holds ending at `tick`. Each slot carries
      // its wrapped position `p` and the colour to light it.
      const slots = [];
      for (let d = PLAY_WINDOW - 1; d >= 0; d--) {
        const i = tick - d;
        if (i < 0) continue;
        if (loop) {
          const p = ((i % L) + L) % L;
          // A looping route has no real finish, so the finish hold reads blue; the
          // start holds only glow green on the first lap (i < L), blue thereafter.
          const role = (p < c.start_count && i < L) ? 'start' : 'int';
          slots.push({ p, role });
        } else {
          if (i >= L) continue;
          slots.push({ p: i, role: circuitRole(seq, c.start_count, i) });
        }
      }
      const layer = document.getElementById('circuit-play-layer');
      if (layer) {
        layer.innerHTML = slots.map(s => {
          const pos = HOLD_MAP[seq[s.p]];
          if (!pos) return '';
          return `<div class="hold-dot ${s.role} lit" style="left:${pos.x}%;top:${pos.y}%"></div>`;
        }).join('');
      }
      tick++;
      // Non-loop: stop once the window has slid off the end (route finished).
      if (!loop && tick > L - 1 + (PLAY_WINDOW - 1)) {
        clearInterval(playTimer); playTimer = null; playDraw = null;
        setTimeout(() => stopCircuitPlay(true), 400);
      }
    };
    playDraw = draw;
    draw();
    playTimer = setInterval(draw, playIntervalMs);
  }

  // ── Delete a circuit (owner / admin; the DB enforces it via RLS) ─────────────────
  function openCircuitDelete() {
    const c = currentCircuit;
    if (!c || !canEditCircuit(c)) return;
    document.getElementById('circuit-delete-name').textContent = circuitName(c);
    document.getElementById('circuit-delete-error').textContent = '';
    document.getElementById('circuit-delete-modal').classList.add('show');
  }
  function closeCircuitDelete() { document.getElementById('circuit-delete-modal').classList.remove('show'); }

  async function doDeleteCircuit() {
    const c = currentCircuit;
    if (!c) return;
    const errEl = document.getElementById('circuit-delete-error');
    const btn = document.getElementById('circuit-delete-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Deleting…';

    const { error } = await sb.from('circuits').delete().eq('id', c.id);
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to delete this circuit.'
        : error.message;
      return;
    }
    allCircuits = allCircuits.filter(x => String(x.id) !== String(c.id));
    closeCircuitDelete();
    showToast('Circuit deleted', 'success');
    location.hash = '#circuits';
  }

  // ── Create a circuit ─────────────────────────────────────────────────────────────
  // Tap holds in climbing order (repeats allowed); each tap appends to ccSeq. Dots
  // are numbered with their move order. Start = first ccStartCount, finish = last.
  function applyCircuitCreate() {
    const layer = document.getElementById('cc-hold-layer');
    if (layer) {
      // One dot per unique hold; badge lists its move number(s).
      const byHold = {};
      ccSeq.forEach((h, pos) => {
        if (!byHold[h]) byHold[h] = { positions: [], role: 'int' };
        byHold[h].positions.push(pos);
        const r = circuitRole(ccSeq, ccStartCount, pos);
        if (r === 'finish' || (r === 'start' && byHold[h].role !== 'finish')) byHold[h].role = r;
      });
      layer.innerHTML = Object.keys(byHold).map(h => {
        const pos = HOLD_MAP && HOLD_MAP[h];
        if (!pos) return '';
        const o = byHold[h];
        return `<div class="hold-dot ${o.role}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${o.positions.map(p => p + 1).join('/')}</span></div>`;
      }).join('');
    }
    const sum = document.getElementById('cc-seq-summary');
    if (sum) {
      const n = ccSeq.length;
      sum.innerHTML = n
        ? `<span class="c-start">${Math.min(ccStartCount, n)} start</span>` +
          `<span class="c-int">${Math.max(0, n - ccStartCount - (n > ccStartCount ? 1 : 0))} move${n - ccStartCount - 1 === 1 ? '' : 's'}</span>` +
          `<span class="c-finish">${n > ccStartCount ? '1 finish' : 'no finish yet'}</span>`
        : `<span class="muted">Tap the board to add the first hold.</span>`;
    }
  }

  function ccNearestHold(clientX, clientY) {
    if (!HOLD_MAP) return null;
    const r = document.getElementById('cc-board').getBoundingClientRect();
    const px = (clientX - r.left) / r.width * 100;
    const py = (clientY - r.top) / r.height * 100;
    let best = null, bestD = Infinity;
    for (const h in HOLD_MAP) {
      const dx = (HOLD_MAP[h].x - px) / 100 * r.width;
      const dy = (HOLD_MAP[h].y - py) / 100 * r.height;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = h; }
    }
    return Math.sqrt(bestD) <= r.width * 0.06 ? best : null;
  }

  function buildCcGrades() {
    document.getElementById('cc-grades').innerHTML =
      gradeTabButtons(SPORT_GRADE_ORDER, g => g === ccGrade);
  }
  function buildCcStartCount() {
    document.querySelectorAll('#cc-start-count .cc-seg-btn').forEach(b =>
      b.classList.toggle('active', +b.dataset.count === ccStartCount));
  }
  function buildCcLoop() {
    const btn = document.getElementById('cc-loop');
    btn.classList.toggle('on', ccLoop);
    btn.setAttribute('aria-pressed', ccLoop ? 'true' : 'false');
  }

  function resetCircuitCreate() {
    ccSeq = []; ccStartCount = 2; ccLoop = false; ccGrade = '';
    const nameEl = document.getElementById('cc-name'); if (nameEl) nameEl.value = '';
    document.getElementById('cc-error').textContent = '';
    buildCcGrades(); buildCcStartCount(); buildCcLoop();
    applyCircuitCreate();
  }

  function initCircuitCreate() {
    buildCcGrades(); buildCcStartCount(); buildCcLoop();
    applyCircuitCreate();
  }

  async function saveCircuit() {
    const errEl = document.getElementById('cc-error');
    errEl.textContent = '';
    if (!session) { location.hash = '#auth'; return; }

    const name = document.getElementById('cc-name').value.trim();
    if (!name) { errEl.textContent = 'Give your circuit a name.'; return; }
    if (!ccGrade) { errEl.textContent = 'Pick a grade.'; return; }
    if (ccSeq.length < ccStartCount + 1) {
      errEl.textContent = `Add at least ${ccStartCount + 1} holds — ${ccStartCount} start${ccStartCount === 1 ? '' : 's'} and a finish.`;
      return;
    }

    // Names must be unique (a circuit is cast by name, like a problem).
    const lname = name.toLowerCase();
    if (allCircuits.some(c => circuitName(c).toLowerCase() === lname)) {
      errEl.textContent = 'That name is taken — pick another.';
      return;
    }

    const row = {
      name,
      grade: ccGrade,
      setter_id: session.user.id,
      comment: '',
      hold_sequence: ccSeq,       // stored in natural climbing order (no inversion)
      start_count: ccStartCount,
      loops: ccLoop
    };

    const btn = document.getElementById('cc-save');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
    const { data, error } = await sb.from('circuits').insert(row).select().single();
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent =
        circuitsTableMissing(error) ? 'Circuits aren’t set up yet — run db/14 in Supabase.'
        : error.code === '42501' ? 'You don’t have permission to create circuits yet.'
        : error.code === '23505' ? 'That name is taken — pick another.'
        : error.message;
      return;
    }

    allCircuits.push(data);
    renderCircuits();
    resetCircuitCreate();
    showToast('Circuit created ✓', 'success');
    location.replace('#circuit/' + encodeURIComponent(data.id));
  }

  // ── Wire up events ────────────────────────────────────────────────────────────
  // Search
  document.getElementById('search').addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    renderList();
  });

  // Grade tabs — simple tap selects one grade, tap-and-hold builds a multi-select.
  const gradeTabsEl = document.getElementById('grade-tabs');

  // Re-render the tabs + list, preserving the strip's horizontal scroll.
  function refreshGradeFilter() {
    const scroll = gradeTabsEl.scrollLeft;
    buildGradeTabs();
    gradeTabsEl.scrollLeft = scroll;
    renderList();
  }

  // Simple tap — meaning depends on how many grades are selected:
  //   • single-select (0–1 active) → switch to just this grade ("All" clears).
  //   • multi-select  (2+ active)  → toggle this grade in/out. Dropping back to
  //     one grade returns to single-select, so the next tap switches again.
  function tapGrade(g) {
    if (g === 'all') {
      activeGrades.clear();
    } else if (activeGrades.size >= 2) {        // multi-select: tap toggles
      if (activeGrades.has(g)) activeGrades.delete(g);
      else activeGrades.add(g);
    } else {                                     // single-select: tap switches
      activeGrades.clear();
      activeGrades.add(g);
    }
    refreshGradeFilter();
  }

  // Tap-and-hold: the way to grow a selection — adds this grade (entering
  // multi-select from a single grade). On an already-selected grade it removes
  // it, unless it's the only one left (then keep it). "All" just clears.
  function toggleGrade(g) {
    if (g === 'all') activeGrades.clear();
    else if (activeGrades.has(g)) { if (activeGrades.size > 1) activeGrades.delete(g); }
    else activeGrades.add(g);
    refreshGradeFilter();
  }

  let holdTimer = null, holdStartX = 0, holdStartY = 0, suppressTabClick = false;
  const HOLD_MS = 450;

  gradeTabsEl.addEventListener('touchstart', e => {
    const tab = e.target.closest('.grade-tab');
    if (!tab || e.touches.length !== 1) return;
    suppressTabClick = false;
    holdStartX = e.touches[0].clientX;
    holdStartY = e.touches[0].clientY;
    const g = tab.dataset.grade;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      suppressTabClick = true;                 // swallow the click that follows touchend
      if (navigator.vibrate) navigator.vibrate(15);
      toggleGrade(g);
    }, HOLD_MS);
  }, { passive: true });

  // A drag means the user is scrolling the strip, not holding — cancel the hold.
  gradeTabsEl.addEventListener('touchmove', e => {
    if (!holdTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - holdStartX) > 10 || Math.abs(t.clientY - holdStartY) > 10) {
      clearTimeout(holdTimer); holdTimer = null;
    }
  }, { passive: true });

  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  gradeTabsEl.addEventListener('touchend', cancelHold, { passive: true });
  gradeTabsEl.addEventListener('touchcancel', cancelHold, { passive: true });

  // Click handles the simple tap (mouse + touch). Skipped right after a hold fired.
  gradeTabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.grade-tab');
    if (!tab) return;
    if (suppressTabClick) { suppressTabClick = false; return; }
    tapGrade(tab.dataset.grade);
  });

  // Suppress the long-press context menu on the tabs (mobile + desktop).
  gradeTabsEl.addEventListener('contextmenu', e => e.preventDefault());

  // List clicks: open detail (delegated)
  document.getElementById('list-container').addEventListener('click', e => {
    const card = e.target.closest('.problem-card');
    if (card) location.hash = '#detail/' + encodeURIComponent(card.dataset.id);
  });

  // Detail back
  document.getElementById('back-btn').addEventListener('click', goBack);

  // Detail actions (live in the header; operate on the current problem)
  document.getElementById('detail-cast').addEventListener('click', e => {
    if (currentProblem) castByName(currentProblem.name, e.currentTarget, detailMirror);
  });
  document.getElementById('detail-mirror').addEventListener('click', toggleDetailMirror);
  document.getElementById('detail-tick').addEventListener('click', toggleTick);
  document.getElementById('detail-delete').addEventListener('click', openDeleteConfirm);
  document.getElementById('detail-edit').addEventListener('click', openGradeEdit);

  // Delete confirm modal
  document.getElementById('delete-cancel').addEventListener('click', closeDeleteConfirm);
  document.getElementById('delete-confirm').addEventListener('click', doDeleteProblem);
  document.getElementById('delete-modal').addEventListener('click', e => {
    if (e.target.id === 'delete-modal') closeDeleteConfirm();
  });

  // Edit grade modal
  document.getElementById('grade-edit-options').addEventListener('click', e => {
    const t = e.target.closest('.grade-tab');
    if (!t) return;
    editGrade = t.dataset.grade;
    buildGradeEditOptions();
  });
  document.getElementById('grade-save').addEventListener('click', saveGradeEdit);
  document.getElementById('grade-cancel').addEventListener('click', closeGradeEdit);
  document.getElementById('grade-close').addEventListener('click', closeGradeEdit);
  document.getElementById('grade-modal').addEventListener('click', e => {
    if (e.target.id === 'grade-modal') closeGradeEdit();
  });

  // Swipe left/right on the detail board to step through the filtered deck.
  // Attached to the stable <main> (detail-content is replaced on every render).
  // Listeners are passive + never preventDefault, so taps on the header buttons
  // and the cast/tick actions are unaffected.
  (function wireDetailSwipe() {
    const area = document.querySelector('#view-detail main');
    if (!area) return;
    let startX = 0, startY = 0, tracking = false;
    area.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { tracking = false; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    area.addEventListener('touchend', e => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < 55) return;                    // too short to be a swipe
      if (Math.abs(dx) < Math.abs(dy) * 1.4) return;    // too vertical
      swipeToAdjacent(dx < 0 ? 1 : -1);                 // swipe left = next
    }, { passive: true });
  })();

  // Arrow keys step through the deck too (handy for desktop testing).
  document.addEventListener('keydown', e => {
    if (currentView !== 'detail') return;
    if (document.getElementById('info-modal').classList.contains('show')) return;
    if (e.key === 'ArrowRight') swipeToAdjacent(1);
    else if (e.key === 'ArrowLeft') swipeToAdjacent(-1);
  });

  // Create — open from list (login required), back returns to list
  document.getElementById('create-btn').addEventListener('click', () => {
    location.hash = session ? '#create' : '#auth';
  });
  document.getElementById('create-back').addEventListener('click', goBack);
  document.getElementById('create-reset').addEventListener('click', resetCreate);

  // Tap the board: cycle the nearest hold's role.
  document.getElementById('create-board').addEventListener('click', e => {
    const h = nearestHold(e.clientX, e.clientY);
    if (h) cycleHold(h);
  });

  // Grade picker (single select).
  document.getElementById('create-grades').addEventListener('click', e => {
    const t = e.target.closest('.grade-tab');
    if (!t) return;
    createGrade = createGrade === t.dataset.grade ? '' : t.dataset.grade;
    buildCreateGrades();
  });

  document.getElementById('create-save').addEventListener('click', saveProblem);

  // ── Circuits wiring ─────────────────────────────────────────────────────────
  // List: search + single-select grade tabs + open detail + create.
  document.getElementById('circuit-search').addEventListener('input', e => {
    circuitSearch = e.target.value.trim().toLowerCase();
    renderCircuits();
  });
  document.getElementById('circuit-grade-tabs').addEventListener('click', e => {
    const t = e.target.closest('.grade-tab');
    if (!t) return;
    const g = t.dataset.grade;
    activeCircuitGrade = (g === 'all' || g === activeCircuitGrade) ? '' : g;
    renderCircuits();
  });
  document.getElementById('circuit-list-container').addEventListener('click', e => {
    const card = e.target.closest('.problem-card');
    if (card) location.hash = '#circuit/' + encodeURIComponent(card.dataset.id);
  });
  document.getElementById('circuit-create-btn').addEventListener('click', () => {
    location.hash = session ? '#circuit-create' : '#auth';
  });

  // Circuit detail: back, delete, (Play wired per-render).
  document.getElementById('circuit-back').addEventListener('click', goBack);
  document.getElementById('circuit-detail-delete').addEventListener('click', openCircuitDelete);
  document.getElementById('circuit-delete-cancel').addEventListener('click', closeCircuitDelete);
  document.getElementById('circuit-delete-confirm').addEventListener('click', doDeleteCircuit);
  document.getElementById('circuit-delete-modal').addEventListener('click', e => {
    if (e.target.id === 'circuit-delete-modal') closeCircuitDelete();
  });

  // Circuit create: back, undo, reset, board taps, options, grade, save.
  document.getElementById('cc-back').addEventListener('click', goBack);
  document.getElementById('cc-undo').addEventListener('click', () => { ccSeq.pop(); applyCircuitCreate(); });
  document.getElementById('cc-reset').addEventListener('click', resetCircuitCreate);
  document.getElementById('cc-board').addEventListener('click', e => {
    const h = ccNearestHold(e.clientX, e.clientY);
    if (h) { ccSeq.push(h); applyCircuitCreate(); }
  });
  document.getElementById('cc-start-count').addEventListener('click', e => {
    const b = e.target.closest('.cc-seg-btn');
    if (!b) return;
    ccStartCount = +b.dataset.count;
    buildCcStartCount();
    applyCircuitCreate();
  });
  document.getElementById('cc-loop').addEventListener('click', () => { ccLoop = !ccLoop; buildCcLoop(); });
  document.getElementById('cc-grades').addEventListener('click', e => {
    const t = e.target.closest('.grade-tab');
    if (!t) return;
    ccGrade = ccGrade === t.dataset.grade ? '' : t.dataset.grade;
    buildCcGrades();
  });
  document.getElementById('cc-save').addEventListener('click', saveCircuit);

  // Calibrate (admin board recalibration)
  document.getElementById('cal-back').addEventListener('click', goBack);
  document.getElementById('cal-reset').addEventListener('click', calReset);
  document.getElementById('cal-load').addEventListener('click', () => document.getElementById('cal-file').click());
  document.getElementById('cal-file').addEventListener('change', e => calLoadImage(e.target.files[0]));
  document.getElementById('cal-clear-anchors').addEventListener('click', calClearAnchors);
  document.getElementById('cal-fit').addEventListener('click', calFit);
  document.getElementById('cal-save').addEventListener('click', calSave);
  document.getElementById('cal-saved-ok').addEventListener('click', () => document.getElementById('cal-saved-modal').classList.remove('show'));
  document.getElementById('cal-mode').addEventListener('click', e => {
    const b = e.target.closest('.cal-seg'); if (b) calSetMode(b.dataset.mode);
  });
  const calBoard = document.getElementById('cal-board');
  calBoard.addEventListener('click', e => {
    if (CAL.mode === 'anchor') calAnchorTap(e);
    else if (CAL.mode === 'add') calAddTap(e);
    else if (CAL.mode === 'mirror') calMirrorTap(e);
  });
  calBoard.addEventListener('pointerdown', calDragStart);
  calBoard.addEventListener('pointermove', calDragMove);
  calBoard.addEventListener('pointerup', calDragEnd);
  calBoard.addEventListener('pointercancel', calDragEnd);

  // Admin hub (#admin): board recalibration link + user management
  document.getElementById('admin-back').addEventListener('click', goBack);
  document.getElementById('admin-refresh').addEventListener('click', adminRefreshUsers);
  document.getElementById('user-delete-cancel').addEventListener('click', closeUserDelete);
  document.getElementById('user-delete-confirm').addEventListener('click', doDeleteUser);
  document.getElementById('user-delete-modal').addEventListener('click', e => {
    if (e.target.id === 'user-delete-modal') closeUserDelete();
  });
  document.getElementById('user-admin-cancel').addEventListener('click', closeAdminChange);
  document.getElementById('user-admin-confirm').addEventListener('click', doAdminChange);
  document.getElementById('user-admin-modal').addEventListener('click', e => {
    if (e.target.id === 'user-admin-modal') closeAdminChange();
  });

  // Info modal: open from header button, close via X, overlay tap, or Escape
  document.getElementById('info-btn').addEventListener('click', openInfo);
  document.getElementById('info-close').addEventListener('click', closeInfo);
  document.getElementById('info-modal').addEventListener('click', e => {
    if (e.target.id === 'info-modal') closeInfo();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeInfo(); closeDeleteConfirm(); closeGradeEdit(); closeUserDelete(); closeAdminChange(); closeCircuitDelete(); } });

  // Auth view actions
  document.getElementById('auth-back').addEventListener('click', () => { location.hash = '#list'; });
  document.getElementById('auth-google').addEventListener('click', authGoogle);
  document.getElementById('auth-submit').addEventListener('click', authEmail);
  document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') authEmail(); });
  document.getElementById('auth-toggle-link').addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup'));
  document.getElementById('name-save').addEventListener('click', saveDisplayName);
  document.getElementById('name-cancel').addEventListener('click', closeNameModal);
  document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveDisplayName(); });

  // ── PWA: service worker + install (Add to Home Screen) ───────────────────────
  if ('serviceWorker' in navigator) {
    // When a new service worker takes control, reload once to show the update.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', () => {
      // updateViaCache:'none' = always fetch sw.js from the network, never the
      // HTTP cache. A stale sw.js served from cache is the classic reason SW
      // updates stall and a device gets stranded on old code — this prevents it.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        // Check for a new version now, and whenever the app regains focus.
        reg.update();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update();
        });
      }).catch(err => console.warn('SW registration failed', err));
    });
  }

  const DISMISS_KEY = 'pb-install-dismissed';
  const installBanner = document.getElementById('install-banner');
  const installAdd = document.getElementById('install-add');
  let deferredPrompt = null;

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const dismissed = () => localStorage.getItem(DISMISS_KEY) === '1';

  function showInstallBanner() { installBanner.classList.add('show'); }
  function hideInstallBanner() { installBanner.classList.remove('show'); }

  // Chrome / Android / desktop: capture the native prompt and offer our own UI.
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isStandalone() && !dismissed()) showInstallBanner();
  });

  installAdd.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    hideInstallBanner();
  });

  document.getElementById('install-dismiss').addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    hideInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
    localStorage.setItem(DISMISS_KEY, '1');
  });

  // iOS Safari never fires beforeinstallprompt — show manual instructions instead.
  if (isIOS() && !isStandalone() && !dismissed()) {
    document.getElementById('install-msg').innerHTML =
      '<b>Install this app:</b> tap the Share icon, then “Add to Home Screen”.';
    installAdd.style.display = 'none';
    showInstallBanner();
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  window.addEventListener('hashchange', router);
  router();        // show initial view (list shows its loading spinner)
  loadProblems();     // fetch, then render + re-route
  loadCircuits();     // fetch circuits (Phase 1 entity)
  loadProfileNames(); // id -> username map so setters show the live display name
  // Prefer the admin-saved board (image + hold map) from Supabase; fall back to the
  // bundled hold_map.json only if no saved map exists.
  loadBoardConfig().then(() => { loadHoldMap(); loadMirrorMap(); });
  initAuth();      // restore session, wire auth state, handle Google redirect

  // Splash: linger briefly, then fade out and remove from the DOM.
  const splash = document.getElementById('splash');
  if (splash) {
    setTimeout(() => {
      splash.classList.add('hide');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }, 1800);
  }
