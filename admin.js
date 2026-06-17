// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: admin hub (#admin) - recalibrate entry point + user management.

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

