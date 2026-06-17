// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: the signed-in user's data: ticks, favourites, auth, profile.

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

  // ── Favourites (personal "saved" list — private to the signed-in user) ───────
  // Problems live in the existing `likes` table; circuits in `circuit_likes`
  // (needs db/15). Both mirror the ticks pattern: optimistic toggle, revert on
  // failure, idempotent via the (user, item) primary key.

  // db/15 not applied → circuit_likes missing (42P01/schema cache); likes has had
  // its policy since db/01, so a problem fave failing that way is unexpected.
  const favSetupNeeded = err => !!err && (err.code === '42501' || circuitsTableMissing(err));

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

  // Show/hide the list filter toggles (a guest has no favourites to filter to) and
  // sync their lit state. Detail/card hearts stay visible — tapping prompts sign-in.
  function updateFaveControls() {
    if (!session) { favesOnly = false; circuitFavesOnly = false; }
    const ff = document.getElementById('fave-filter');
    const cff = document.getElementById('circuit-fave-filter');
    if (ff)  { ff.hidden = !session;  ff.classList.toggle('active', favesOnly); }
    if (cff) { cff.hidden = !session; cff.classList.toggle('active', circuitFavesOnly); }
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
    if (cf.error) { if (!circuitsTableMissing(cf.error)) console.warn('circuit favourites load failed', cf.error); }
    else myCircuitFaves = new Set((cf.data || []).map(r => String(r.circuit_id)));
  }

  // Toggle a problem's favourite. Optimistic, revert on failure.
  async function toggleFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isFaved(id);
    if (was) myFaves.delete(id); else myFaves.add(id);
    updateFaveButton();
    renderList();

    const res = was
      ? await sb.from('likes').delete().eq('user_id', session.user.id).eq('problem_id', id)
      : await sb.from('likes').insert({ user_id: session.user.id, problem_id: id });

    if (res.error && res.error.code !== '23505') {
      if (was) myFaves.add(id); else myFaves.delete(id);   // revert
      updateFaveButton();
      renderList();
      showToast('Could not save — check connection', 'error');
      return;
    }
    showToast(was ? 'Removed from favourites' : 'Added to favourites ♥', 'success');
  }

  // Toggle a circuit's favourite. Same shape; needs the db/15 circuit_likes table.
  async function toggleCircuitFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isCircuitFaved(id);
    if (was) myCircuitFaves.delete(id); else myCircuitFaves.add(id);
    updateCircuitFaveButton();
    renderCircuits();

    const res = was
      ? await sb.from('circuit_likes').delete().eq('user_id', session.user.id).eq('circuit_id', id)
      : await sb.from('circuit_likes').insert({ user_id: session.user.id, circuit_id: id });

    if (res.error && res.error.code !== '23505') {
      if (was) myCircuitFaves.add(id); else myCircuitFaves.delete(id);   // revert
      updateCircuitFaveButton();
      renderCircuits();
      showToast(favSetupNeeded(res.error)
        ? 'Favourites need setup — run db/15 in Supabase'
        : 'Could not save — check connection', 'error');
      return;
    }
    showToast(was ? 'Removed from favourites' : 'Added to favourites ♥', 'success');
  }

  // ── Auth ────────────────────────────────────────────────────────────────────
  async function initAuth() {
    const { data } = await sb.auth.getSession();   // also consumes any OAuth redirect in the URL
    session = data.session || null;
    authReady = true;
    if (session) { await loadProfile(); await loadTicks(); await loadFaves(); }
    updateFaveControls();
    renderProfile();
    if (loaded) renderList();   // refresh tick + fave flags (skip if problems still loading)
    if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
    if (currentView === 'circuits') renderCircuits();
    if (currentView === 'circuit-detail') updateCircuitFaveButton();
    if (location.hash.includes('access_token')) location.replace(location.pathname + '#list');
    else router();              // re-evaluate the route now auth is known (gates #create for guests)

    sb.auth.onAuthStateChange(async (_event, s) => {
      session = s || null;
      if (session) { await loadProfile(); await loadTicks(); await loadFaves(); }
      else { profile = null; myTicks = new Set(); myFaves = new Set(); myCircuitFaves = new Set(); }
      updateFaveControls();
      renderProfile();
      if (loaded) renderList();
      if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
      if (currentView === 'circuits') renderCircuits();
      if (currentView === 'circuit-detail') updateCircuitFaveButton();
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

