// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file: the signed-in user's data: ticks, favourites, auth, profile.

  // Load the signed-in user's ticks into myTicks; clear for guests. RLS limits
  // the rows to this user, so we never see anyone else's sends.
  async function loadTicks() {
    if (!session) { myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set(); return; }
    const { data, error } = await sb.from('ticks').select('problem_id, mirrored').eq('user_id', session.user.id);
    if (error) { console.warn('ticks load failed', error); return; }
    myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set();
    (data || []).forEach(r => {
      const id = String(r.problem_id);
      myTicks.add(id);
      (r.mirrored ? myTicksMirrored : myTicksNormal).add(id);
    });
  }

  // Keep the "ticked in any orientation" union in sync after one orientation flips.
  function recomputeAnyTick(id) {
    id = String(id);
    if (myTicksNormal.has(id) || myTicksMirrored.has(id)) myTicks.add(id);
    else myTicks.delete(id);
  }

  // ── Toggle writes (ticks + favourites) ──────────────────────────────────────
  // Each toggle flips the UI at once (optimistic), then brings the database into
  // line. Only one write per item is ever in flight: a tap while one is running
  // just flips the UI again, and when the write lands the loop sends one more if
  // the screen now wants the other state. Without this, a double tap sent an
  // insert and a delete together, and whichever the server ran last won, so the
  // database could end up ticked while the screen showed unticked.
  //   key     — one per item and kind ('tick:<id>:<mirrored>', 'fave:<id>', …)
  //   was     — the state the database held before this tap
  //   wanted  — reads the state the screen shows now
  //   write   — (state) => the insert (true) or delete (false) request
  //   revert  — (dbState, error) => put the UI back to what the database holds
  //   done    — (dbState) => the success toast, once the loop settles on a change
  const togglesInFlight = new Set();

  async function settleToggle(key, was, wanted, write, revert, done) {
    if (togglesInFlight.has(key)) return;   // the running loop picks up the new state
    togglesInFlight.add(key);
    let db = was;
    try {
      while (session && wanted() !== db) {
        const target = wanted();
        const res = await write(target);
        // 23505 = unique violation: the row already exists, which is the state
        // we wanted, so it counts as success.
        if (res.error && res.error.code !== '23505') { revert(db, res.error); return; }
        db = target;
      }
      if (db !== was) done(db);
    } finally {
      togglesInFlight.delete(key);
    }
  }

  // Toggle the current problem's tick, in the orientation the detail view shows.
  async function toggleTick() {
    if (!session) { showToast('Sign in to track ticks', 'success'); location.hash = '#auth'; return; }
    const p = currentProblem;
    if (!p) return;
    const id = String(p.id);
    const mirrored = !!detailMirror;
    // Read the set afresh each time: loadTicks replaces it on a sign-in event.
    const orientSet = () => mirrored ? myTicksMirrored : myTicksNormal;
    const wasTicked = orientSet().has(id);
    const setTicked = on => {
      if (on) orientSet().add(id); else orientSet().delete(id);
      recomputeAnyTick(id);
      updateTickButton();
      renderList();
    };
    setTicked(!wasTicked);   // optimistic

    await settleToggle(`tick:${id}:${mirrored}`, wasTicked, () => orientSet().has(id),
      on => on
        ? sb.from('ticks').insert({ user_id: session.user.id, problem_id: id, mirrored })
        : sb.from('ticks').delete().eq('user_id', session.user.id).eq('problem_id', id).eq('mirrored', mirrored),
      db => { setTicked(db); showToast('Could not save — check connection', 'error'); },
      on => {
        leaderboardLoaded = false;   // points changed — refresh on next leaderboard/profile view
        showToast(on ? 'Ticked ✓' : 'Removed tick', 'success');
      });
  }

  // ── Favourites (personal "saved" list — private to the signed-in user) ───────
  // Problems live in the existing `likes` table; circuits in `circuit_likes`
  // (needs db/15). Both mirror the ticks pattern: optimistic toggle, revert on
  // failure, idempotent via the (user, item) primary key.

  function updateFaveButton() {
    const btn = document.getElementById('detail-fave');
    if (!btn) return;
    const faved = !!(currentProblem && isFaved(currentProblem.id));
    btn.classList.toggle('faved', faved);
    btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    btn.setAttribute('aria-label', faved ? 'Remove from favourites' : 'Add to favourites');
  }

  function updateCircuitFaveButton() {
    const btn = document.getElementById('circuit-detail-fave');
    if (!btn) return;
    const faved = !!(currentCircuit && isCircuitFaved(currentCircuit.id));
    btn.classList.toggle('faved', faved);
    btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    btn.setAttribute('aria-label', faved ? 'Remove from favourites' : 'Add to favourites');
  }

  // Sync the filter pills' enabled + lit state. The auth-only pills (favourites /
  // exclude-done) render muted for a guest and reset their state; they stay clickable
  // so a tap can show the "sign in" toast. Benchmarks/Looping are never disabled.
  function updateFaveControls() {
    if (!session) { favesOnly = false; excludeDone = false; circuitFavesOnly = false; circuitExcludeDone = false; }
    // [pill id, active state, needs-auth] for both lists.
    const pills = [
      ['pill-faves',  favesOnly,           true],
      ['pill-bench',  benchOnly,           false],
      ['pill-done',   excludeDone,         true],
      ['cpill-faves', circuitFavesOnly,    true],
      ['cpill-loop',  circuitLoopOnly,     false],
      ['cpill-done',  circuitExcludeDone,  true],
    ];
    pills.forEach(([id, active, needsAuth]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
      el.classList.toggle('disabled', needsAuth && !session);
    });
  }

  // Load both favourite sets for the signed-in user; clear for guests. RLS limits
  // the rows to this user. A missing circuit_likes table (db/15 not applied yet)
  // just leaves circuit favourites empty rather than breaking the load.
  async function loadFaves() {
    if (!session) { myFaves = new Set(); myCircuitFaves = new Set(); return; }
    const [pf, cf] = await Promise.all([
      sb.from('likes').select('problem_id').eq('user_id', session.user.id),
      sb.from('circuit_likes').select('circuit_id').eq('user_id', session.user.id),
    ]);
    if (pf.error) console.warn('favourites load failed', pf.error);
    else myFaves = new Set((pf.data || []).map(r => String(r.problem_id)));
    if (cf.error) console.warn('circuit favourites load failed', cf.error);
    else myCircuitFaves = new Set((cf.data || []).map(r => String(r.circuit_id)));
  }

  // Toggle a problem's favourite (optimistic; see settleToggle).
  async function toggleFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isFaved(id);
    const setFaved = on => {
      if (on) myFaves.add(id); else myFaves.delete(id);
      updateFaveButton();
      renderList();
    };
    setFaved(!was);

    await settleToggle('fave:' + id, was, () => isFaved(id),
      on => on
        ? sb.from('likes').insert({ user_id: session.user.id, problem_id: id })
        : sb.from('likes').delete().eq('user_id', session.user.id).eq('problem_id', id),
      db => { setFaved(db); showToast('Could not save — check connection', 'error'); },
      on => showToast(on ? 'Added to favourites ♥' : 'Removed from favourites', 'success'));
  }

  // Toggle a circuit's favourite. Same shape; needs the db/15 circuit_likes table.
  async function toggleCircuitFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isCircuitFaved(id);
    const setFaved = on => {
      if (on) myCircuitFaves.add(id); else myCircuitFaves.delete(id);
      updateCircuitFaveButton();
      renderCircuits();
    };
    setFaved(!was);

    await settleToggle('cfave:' + id, was, () => isCircuitFaved(id),
      on => on
        ? sb.from('circuit_likes').insert({ user_id: session.user.id, circuit_id: id })
        : sb.from('circuit_likes').delete().eq('user_id', session.user.id).eq('circuit_id', id),
      (db, err) => {
        setFaved(db);
        console.warn('circuit favourite failed', err);
        showToast('Could not save — check connection', 'error');
      },
      on => showToast(on ? 'Added to favourites ♥' : 'Removed from favourites', 'success'));
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  // A failed OAuth sign-in comes back with error params in the hash (implicit flow)
  // or the query string. Show the reason once and strip them, rather than dropping
  // the user on the list, still signed out, with no idea why.
  function takeOAuthError() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(location.search);
    const src = hash.has('error') ? hash : query.has('error') ? query : null;
    if (!src) return null;
    const msg = src.get('error_description') || src.get('error');
    ['error', 'error_code', 'error_description'].forEach(k => query.delete(k));
    const qs = query.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + (src === hash ? '#list' : location.hash));
    return msg;
  }

  async function initAuth() {
    const oauthError = takeOAuthError();
    if (oauthError) showToast('Sign-in failed: ' + oauthError, 'error');
    // A password-reset email link lands here signed in, with type=recovery in the
    // hash. Read it before getSession() consumes the hash (supabase-js reads the URL
    // asynchronously, after this synchronous boot code).
    const recovering = new URLSearchParams(location.hash.replace(/^#/, '')).get('type') === 'recovery';
    const { data } = await sb.auth.getSession();   // also consumes any OAuth redirect in the URL
    session = data.session || null;
    // Not ready until the profile has loaded too: admin-only routes judge is_admin
    // from it, and a router() run in between (loadProblems calls it) would bounce
    // an admin, or let a non-admin see an admin screen.
    if (session) await loadProfile();
    authReady = true;
    if (session) { await loadTicks(); await loadFaves(); }
    if (recovering && session) openPasswordModal();
    updateFaveControls();
    renderProfile();
    if (loaded) renderList();   // refresh tick + fave flags (skip if problems still loading)
    if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
    if (currentView === 'circuits') renderCircuits();
    if (currentView === 'circuit-detail') updateCircuitFaveButton();
    if (location.hash.includes('access_token')) redirectRoute('#list');
    else router();              // re-evaluate the route now auth is known (gates #create for guests)

    sb.auth.onAuthStateChange((event, s) => {
      session = s || null;
      // INITIAL_SESSION fires the moment this is registered and repeats what
      // initAuth has just loaded; TOKEN_REFRESHED (hourly) only swaps the token.
      // Neither changes who is signed in, so neither reloads anything.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      // supabase-js runs this callback while holding its auth lock, and a Supabase
      // query awaited in here would wait on that lock, so do the work after it returns.
      setTimeout(() => onAuthChanged(event), 0);
    });
  }

  // A real change of who's signed in (SIGNED_IN, SIGNED_OUT, USER_UPDATED,
  // PASSWORD_RECOVERY): reload or clear the user's data and re-render.
  async function onAuthChanged(event) {
    if (event === 'PASSWORD_RECOVERY') openPasswordModal();   // recovery that lands after boot
    if (session) { await loadProfile(); await loadTicks(); await loadFaves(); }
    else {
      profile = null; myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set(); myFaves = new Set(); myCircuitFaves = new Set(); leaderboardLoaded = false;
      adminUsers = []; adminUsersLoaded = false;   // every member's email: don't keep it after an admin signs out
    }
    updateFaveControls();
    renderProfile();
    if (loaded) renderList();
    if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
    if (currentView === 'circuits') renderCircuits();
    if (currentView === 'circuit-detail') updateCircuitFaveButton();
    // Signed out (or lost admin) while on an admin screen: route away from it.
    if ((currentView === 'outlines' || currentView === 'admin') && !isAdmin()) router();
  }

  async function loadProfile() {
    if (!session) { profile = null; return; }
    const { data, error } = await sb
      .from('profiles').select('id, username, is_admin').eq('id', session.user.id).maybeSingle();
    // A load *error* is not the same as "no profile" — don't null an existing profile
    // or wrongly prompt an existing user to pick a name (which then 23505s on insert).
    if (error) { console.warn('profile load failed', error); return; }
    profile = data || null;
    // New users haven't chosen a name yet: the sign-up trigger (db/26) gives them a
    // placeholder, or no profile at all if the placeholder clashed. Either way, ask.
    if (session && needsDisplayName()) promptDisplayName();
  }

  // An admin-only write that RLS refused (no error, 0 rows) most likely means this
  // account was demoted since the profile loaded. Re-read the profile so the admin
  // controls disappear, and leave an admin screen if we're on one.
  async function recheckAdmin() {
    await loadProfile();
    updateAdminUI();
    renderProfile();
    if ((currentView === 'outlines' || currentView === 'admin') && !isAdmin()) router();
  }

  // The sign-up trigger's placeholder username. Keep in sync with db/26, whose
  // handle_new_user() inserts 'climber-' || left(replace(new.id::text, '-', ''), 8).
  const PLACEHOLDER_NAME = /^climber-[0-9a-f]{8}$/i;
  const needsDisplayName = () => !profile || PLACEHOLDER_NAME.test(profile.username || '');

  async function authEmail() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Enter your email and password.'; return; }
    const btn = document.getElementById('auth-submit');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = '…';
    // emailRedirectTo: once email confirmation is on, the confirm link returns to
    // THIS app (staging or production) instead of Supabase's Site URL.
    const res = authMode === 'signup'
      ? await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
      : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = prev;
    if (res.error) { errEl.textContent = res.error.message; return; }
    if (authMode === 'signup' && !res.data.session) {   // email confirmation is on
      showToast('Check your email to confirm your account', 'success');
      return;
    }
    location.hash = '#list';   // onAuthStateChange handles profile + display-name prompt
  }

  // ── Password reset ───────────────────────────────────────────────────────────
  // Supabase's built-in mailer only delivers to project team members, so the
  // "Forgot password?" link stays hidden until custom SMTP is live (see "Email
  // setup" in docs/codebase-overview.md). Flip this to true as the last step.
  // The recovery half (the "Set a new password" modal) is always on.
  const PASSWORD_RESET_ENABLED = false;

  async function authForgot() {
    const email = document.getElementById('auth-email').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.textContent = '';
    if (!email) { errEl.textContent = 'Enter your email above, then tap Forgot password.'; return; }
    const link = document.getElementById('auth-forgot-link');
    if (link.dataset.busy) return;
    link.dataset.busy = '1';
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    delete link.dataset.busy;
    if (error) { errEl.textContent = error.message; return; }
    // Same message whether or not the account exists (Supabase doesn't say either).
    showToast('If there’s an account for that email, a reset link is on its way', 'success');
  }

  function openPasswordModal() {
    document.getElementById('password-input').value = '';
    document.getElementById('password-error').textContent = '';
    document.getElementById('password-modal').classList.add('show');
    setTimeout(() => document.getElementById('password-input').focus(), 50);
  }
  function closePasswordModal() { document.getElementById('password-modal').classList.remove('show'); }

  async function savePassword() {
    const errEl = document.getElementById('password-error');
    const password = document.getElementById('password-input').value;
    if (password.length < 6) { errEl.textContent = 'Use at least 6 characters.'; return; }
    if (!session) { errEl.textContent = 'That reset link has expired. Request a new one.'; return; }
    const btn = document.getElementById('password-save'); btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password });
    btn.disabled = false;
    if (error) { errEl.textContent = error.message; return; }
    closePasswordModal();
    showToast('Password updated', 'success');
  }

  async function authGoogle() {
    const redirectTo = location.origin + location.pathname;   // back to the app, no hash
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) showToast(error.message, 'error');
  }

  // Signs out this device only: 'local' leaves the account's other devices signed
  // in (the default, 'global', revoked every one of them). supabase-js 2.116 drops
  // the local session even when the server call fails (offline), which is what
  // matters here, so judge by whether a session is left, not by the error.
  async function doSignOut() {
    const { error } = await sb.auth.signOut({ scope: 'local' });
    if (error) console.warn('sign-out request failed', error);
    const { data } = await sb.auth.getSession();
    if (data.session) { showToast('Couldn’t sign out — check connection', 'error'); return; }
    showToast('Signed out', 'success');
    location.hash = '#list';
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    document.getElementById('auth-title').textContent = signup ? 'Create account' : 'Sign in';
    document.getElementById('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
    document.getElementById('auth-password').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    document.getElementById('auth-forgot').hidden = signup || !PASSWORD_RESET_ENABLED;
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
    // First sign-in starts empty on purpose: pre-filling the email prefix nudged
    // people into publishing part of their email address as their public name.
    document.getElementById('name-input').value = editing ? ((profile && profile.username) || '') : '';
    document.getElementById('name-error').textContent = '';
    document.getElementById('name-modal').classList.add('show');
    setTimeout(() => document.getElementById('name-input').focus(), 50);
  }
  function promptDisplayName() {   // first sign-in (mandatory: no Cancel)
    // loadProfile can run more than once on start-up; don't reset a half-typed name.
    if (document.getElementById('name-modal').classList.contains('show')) return;
    openNameModal('create');
  }
  function closeNameModal() { document.getElementById('name-modal').classList.remove('show'); }

  async function saveDisplayName() {
    const errEl = document.getElementById('name-error');
    const name = document.getElementById('name-input').value.trim();
    if (name.length < 2) { errEl.textContent = 'Pick a name (at least 2 characters).'; return; }
    if (PLACEHOLDER_NAME.test(name)) { errEl.textContent = 'Pick a name of your own.'; return; }
    if (!session) { errEl.textContent = 'Session expired — please sign in again.'; return; }
    const wasEditing = !needsDisplayName();
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
        ? `<span class="grade-badge">${escHtml(fontGrade(hardest.grade))}</span> <span class="hardest-name">${escHtml(displayName(hardest))}</span>`
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
        <div class="profile-row"><span class="k">Total points</span><span class="v" id="profile-points">${leaderboardLoaded ? userPoints() : '…'}</span></div>
        <div class="profile-row"><span class="k">Total ticks</span><span class="v">${total}</span></div>
        <div class="profile-row"><span class="k">Hardest send</span><span class="v">${hardestHtml}</span></div>
        ${profile.is_admin ? `<a class="btn-block btn-ghost" href="#admin" style="display:block;text-align:center;text-decoration:none;margin-top:18px">Admin tools</a>` : ''}`;
      document.getElementById('profile-signout').addEventListener('click', doSignOut);
      document.getElementById('profile-edit-name').addEventListener('click', () => openNameModal('edit'));
      // Total points comes from the leaderboard RPC (single source of truth); fill async.
      loadLeaderboard().then(() => {
        const pe = document.getElementById('profile-points');
        if (pe) pe.textContent = leaderboardError ? '—' : userPoints();
      });
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

