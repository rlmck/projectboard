  // ── Supabase client ──────────────────────────────────────────────────────────
  const { createClient } = supabase;
  const sb = createClient(
    'https://uqirowyfqwiceyjznosl.supabase.co',
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
  let HOLD_MAP = null;   // hold id -> {x,y} %, loaded from hold_map.json
  let session = null;    // Supabase auth session (null = guest)
  let profile = null;    // { id, username } for the signed-in user
  let myTicks = new Set(); // problem_ids the signed-in user has ticked (sent)
  let authMode = 'signin'; // 'signin' | 'signup' for the #auth form

  // ── Create-a-problem state ───────────────────────────────────────────────────
  let createRoles = {};        // hold id -> 'start' | 'int' | 'finish'
  let createGrade = '';        // selected grade

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

  // Display a hold id compactly: "hold235" -> "235", otherwise raw.
  function holdNum(id) {
    const m = /^hold(\d+)$/i.exec(String(id));
    return m ? m[1] : String(id);
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

  // Coloured dots positioned over the board from hold_map.json (loaded async).
  function boardOverlayHtml(p) {
    const order = problemHoldOrder(p);
    if (!HOLD_MAP || !order.length) return '';
    const cls = classifyHolds(order);
    const seen = new Set();
    const dots = order.filter(h => (seen.has(h) ? false : seen.add(h))).map(h => {
      const pos = HOLD_MAP[h];
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

    ['list','detail','create','auth','profile'].forEach(v => {
      document.getElementById('view-' + v).classList.toggle('active', v === name);
    });

    // Bottom nav: hidden on the focused auth screen.
    document.getElementById('bottom-nav').style.display = name === 'auth' ? 'none' : 'flex';

    // Active nav highlight.
    const navFor = { list: 'list', detail: 'list', create: 'list', profile: 'profile', auth: 'profile' }[name] || 'list';
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
        if (!session) { location.replace(location.pathname + '#auth'); break; }
        initCreateView();
        setView('create');
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
        String(p.setter || '').toLowerCase().includes(q) ||
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
            <span class="meta-setter">${escHtml(p.setter || '—')}</span>
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

  function buildGradeTabs() {
    const present = [...new Set(allProblems.map(p => p.grade).filter(Boolean))]
      .sort((a, b) => gradeRank(a) - gradeRank(b) || a.localeCompare(b));
    const tabs = ['all', ...present];
    document.getElementById('grade-tabs').innerHTML = tabs.map(g => {
      const active = g === 'all' ? activeGrades.size === 0 : activeGrades.has(g);
      return `<button class="grade-tab${active ? ' active' : ''}" data-grade="${escAttr(g)}">${g === 'all' ? 'All' : escHtml(g)}</button>`;
    }).join('');
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

    currentProblem = p;
    updateTickButton();

    wrap.innerHTML = `
      <div class="detail-head-info">
        <h1 class="detail-name">${escHtml(displayName(p))}</h1>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(p.grade || '—')}</span>
          <span class="meta-setter">by ${escHtml(p.setter || 'unknown')}</span>
          ${starsHtml(p.stars)}
          ${p.is_benchmark ? `<span class="bench-badge">★ Benchmark</span>` : ''}
        </div>
      </div>

      <div class="board-wrap">
        <img class="board-graphic" src="ProjectBoard.png" alt="The Hangout symmetry board" />
        ${boardOverlayHtml(p)}
      </div>
    `;
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

  // ── Load hold position map (for the board overlay) ───────────────────────────
  async function loadHoldMap() {
    try {
      const res = await fetch('hold_map.json', { cache: 'no-cache' });
      if (res.ok) HOLD_MAP = await res.json();
    } catch (err) {
      console.warn('hold_map.json load failed — board overlay disabled', err);
    }
    // If we're already on a detail/create view, render now that positions exist.
    if (currentView === 'detail') router();
    if (currentView === 'create') applyCreateRoles();
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
    if (session) { await loadProfile(); await loadTicks(); }
    renderProfile();
    if (loaded) renderList();   // refresh tick flags (skip if problems still loading)
    if (currentView === 'detail') updateTickButton();
    if (location.hash.includes('access_token')) location.replace(location.pathname + '#list');

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
      .from('profiles').select('id, username').eq('id', session.user.id).maybeSingle();
    if (error) console.warn('profile load failed', error);
    profile = data || null;
    if (session && !profile) promptDisplayName();   // brand-new user (Google or email)
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

  function promptDisplayName() {
    const email = (session && session.user && session.user.email) || '';
    document.getElementById('name-input').value = (email.split('@')[0] || '').trim();
    document.getElementById('name-error').textContent = '';
    document.getElementById('name-modal').classList.add('show');
  }

  async function saveDisplayName() {
    const errEl = document.getElementById('name-error');
    const name = document.getElementById('name-input').value.trim();
    if (name.length < 2) { errEl.textContent = 'Pick a name (at least 2 characters).'; return; }
    if (!session) { errEl.textContent = 'Session expired — please sign in again.'; return; }
    const btn = document.getElementById('name-save'); btn.disabled = true;
    const { error } = await sb.from('profiles').insert({ id: session.user.id, username: name });
    btn.disabled = false;
    if (error) {
      errEl.textContent = error.code === '23505' ? 'That name is taken — try another.' : error.message;
      return;
    }
    document.getElementById('name-modal').classList.remove('show');
    await loadProfile();
    renderProfile();
    showToast('Welcome, ' + name, 'success');
  }

  function renderProfile() {
    const el = document.getElementById('profile-content');
    if (!el) return;
    const userSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    if (session && profile) {
      el.innerHTML = `
        <div class="shell-card" style="margin:8px auto 18px;text-align:center">
          <div class="shell-icon">${userSvg}</div>
          <div class="shell-title">${escHtml(profile.username)}</div>
          <div class="shell-sub">${escHtml((session.user && session.user.email) || '')}</div>
          <button class="btn-block btn-ghost" id="profile-signout">Sign out</button>
        </div>
        <div class="profile-row"><span class="k">Total ticks</span><span class="v">—</span></div>
        <div class="profile-row"><span class="k">Hardest send</span><span class="v">—</span></div>`;
      document.getElementById('profile-signout').addEventListener('click', doSignOut);
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

  // The top row is the finish zone — tapping any of those holds sets the finish.
  // hold numbering doesn't map cleanly to visual rows (the board is hand-set), so
  // identify the top row by position: the 12 highest holds in hold_map.json (there
  // is a clean vertical gap after them — y ≈ 1.6–3.3, then jumps to ≈ 7.6).
  let topHoldsSet = null;
  function topHolds() {
    if (topHoldsSet) return topHoldsSet;
    if (!HOLD_MAP) return new Set();
    const byHeight = Object.keys(HOLD_MAP).sort((a, b) => HOLD_MAP[a].y - HOLD_MAP[b].y);
    topHoldsSet = new Set(byHeight.slice(0, 12));
    return topHoldsSet;
  }
  function isTopHold(h) { return topHolds().has(h); }

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
  //   • top-row hold → finish (red) ↔ off  (only one finish at a time)
  //   • any other   → start (green) → hold (blue) → off, where a fresh tap starts
  //     green while fewer than two starts exist, otherwise blue.
  function cycleHold(h) {
    const cur = createRoles[h];
    if (isTopHold(h)) {
      if (cur === 'finish') delete createRoles[h];
      else {
        holdsWithRole('finish').forEach(x => delete createRoles[x]);   // single finish
        createRoles[h] = 'finish';
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
    document.getElementById('create-grades').innerHTML = GRADE_ORDER.map(g =>
      `<button class="grade-tab${g === createGrade ? ' active' : ''}" data-grade="${escAttr(g)}" type="button">${escHtml(g)}</button>`
    ).join('');
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

    // Names must be unique (case-insensitive) — they're how a problem is cast.
    const nameKey = name.toLowerCase();
    if (allProblems.some(p => String(p.name || '').trim().toLowerCase() === nameKey)) {
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
      setter: (profile && profile.username) || null,
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
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to create problems yet.'   // RLS INSERT policy missing
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
    if (currentProblem) castByName(currentProblem.name, e.currentTarget);
  });
  document.getElementById('detail-mirror').addEventListener('click', e => {
    if (currentProblem) castByName(currentProblem.name, e.currentTarget, true);
  });
  document.getElementById('detail-tick').addEventListener('click', toggleTick);

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

  // Info modal: open from header button, close via X, overlay tap, or Escape
  document.getElementById('info-btn').addEventListener('click', openInfo);
  document.getElementById('info-close').addEventListener('click', closeInfo);
  document.getElementById('info-modal').addEventListener('click', e => {
    if (e.target.id === 'info-modal') closeInfo();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfo(); });

  // Auth view actions
  document.getElementById('auth-back').addEventListener('click', () => { location.hash = '#list'; });
  document.getElementById('auth-google').addEventListener('click', authGoogle);
  document.getElementById('auth-submit').addEventListener('click', authEmail);
  document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') authEmail(); });
  document.getElementById('auth-toggle-link').addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup'));
  document.getElementById('name-save').addEventListener('click', saveDisplayName);
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
  loadProblems();  // fetch, then render + re-route
  loadHoldMap();   // fetch hold positions for the detail board overlay
  initAuth();      // restore session, wire auth state, handle Google redirect

  // Splash: linger briefly, then fade out and remove from the DOM.
  const splash = document.getElementById('splash');
  if (splash) {
    setTimeout(() => {
      splash.classList.add('hide');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }, 1800);
  }
