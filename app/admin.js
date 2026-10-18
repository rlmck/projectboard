// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file: admin hub (#admin) - the hold outlines entry point + user management.

  // ── Admin hub (#admin) — hold outlines + user management ─────────────────────
  // Three sub-screens, all under the one #admin view, driven by the hash param:
  //   #admin            -> hub: cards for Trace Holds + Users
  //   #admin/users      -> the user list, with a nickname search (rows are links)
  //   #admin/user/<id>  -> one user: stats, recent activity, and the actions
  // Accounts hold no email (db/30): a row is a nickname, its roles and its counts.
  // Listing, activity, rename, promote and delete go through SECURITY DEFINER RPCs
  // gated on is_admin() (db/12, db/13, db/30); a new passphrase goes through the
  // Edge Function admin-reset-passphrase, which holds the service-role key. Every
  // one of those actions is logged server-side in admin_actions (db/30).
  let adminUsers = [];                // cached rows from admin_list_users()
  let adminUsersLoaded = false;       // true once a fetch has populated adminUsers
  let adminUsersAt = 0;               // when that fetch landed (the cache lasts ADMIN_USERS_TTL)
  const ADMIN_USERS_TTL = 60000;
  let adminUserSearch = '';           // the user list's nickname filter
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

  // The error itself (with its code) is in the console; ensureAdminUsers logs it.
  const usersErrorHtml = () => `<div class="state-msg"><div class="icon">⚠️</div>Couldn’t load users.</div>`;

  // Set the admin header's title + whether the reload button shows (users + user).
  function adminSetHeader(title, showRefresh) {
    document.getElementById('admin-title').textContent = title;
    document.getElementById('admin-refresh').hidden = !showRefresh;
  }

  // Fetch the user list and cache it for a minute, so drilling list → user → list
  // doesn't refetch but the counts (Routes set, Sends) never go far out of date;
  // `force` re-fetches (the reload button). Returns { ok, error } so callers can
  // render the right state.
  async function ensureAdminUsers(force) {
    if (adminUsersLoaded && !force && Date.now() - adminUsersAt < ADMIN_USERS_TTL) return { ok: true };
    const { data, error } = await sb.rpc('admin_list_users');
    if (error) { console.warn('admin_list_users failed', error); return { ok: false, error }; }
    adminUsers = data || [];
    adminUsersLoaded = true;
    adminUsersAt = Date.now();
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
        <a class="admin-card" href="#outlines">
          <div class="admin-card-icon">${boardIconSvg}</div>
          <div class="admin-card-text">
            <div class="admin-card-title">Trace Holds</div>
            <div class="admin-card-sub">Fine-tune the outline of each hold and publish it.</div>
          </div>
          <div class="admin-card-chev">${chevSvg}</div>
        </a>
        <a class="admin-card" href="#admin/users">
          <div class="admin-card-icon">${usersIconSvg}</div>
          <div class="admin-card-text">
            <div class="admin-card-title">Users</div>
            <div class="admin-card-sub">Find an account, rename it, or give it a new passphrase.</div>
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
    el.innerHTML = `
      <input class="fld admin-search" id="admin-user-search" type="search" placeholder="Search nicknames…"
             autocomplete="off" autocapitalize="none" spellcheck="false" />
      <div id="admin-user-rows"></div>`;
    const search = document.getElementById('admin-user-search');
    search.value = adminUserSearch;
    search.addEventListener('input', () => { adminUserSearch = search.value; renderAdminUserRows(); });
    renderAdminUserRows();
  }

  // The rows only, so typing in the search box keeps its focus.
  function renderAdminUserRows() {
    const rowsEl = document.getElementById('admin-user-rows');
    if (!rowsEl) return;
    const q = adminUserSearch.trim().toLowerCase();
    const rows = q ? adminUsers.filter(u => String(u.username || '').toLowerCase().includes(q)) : adminUsers;
    if (!adminUsers.length) { rowsEl.innerHTML = `<div class="state-msg">No users yet.</div>`; return; }
    if (!rows.length) { rowsEl.innerHTML = `<div class="state-msg">No nickname matches “${escHtml(adminUserSearch.trim())}”.</div>`; return; }
    rowsEl.innerHTML = rows.map(u => {
      const sends = Number(u.tick_count) || 0;
      return `
      <a class="admin-card user-link" href="#admin/user/${encodeURIComponent(u.id)}">
        <div class="user-avatar">${escHtml(userInitial(u.username))}</div>
        <div class="admin-card-text">
          <div class="admin-card-title">${escHtml(u.username)}${u.is_admin ? '<span class="user-badge">Admin</span>' : ''}${u.is_public ? '<span class="user-badge public">On Ranks</span>' : ''}</div>
          <div class="admin-card-sub">Joined ${escHtml(fmtJoinDate(u.created_at))} · ${sends} send${sends === 1 ? '' : 's'}</div>
        </div>
        <div class="admin-card-chev">${chevSvg}</div>
      </a>`;
    }).join('');
  }

  async function renderAdminUserDetail(id) {
    adminSetHeader('User', true);
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
    adminSetHeader(u.username, true);
    const isSelf = String(u.id) === String(profile.id);
    const routes = Number(u.route_count) || 0;
    const sends = Number(u.tick_count) || 0;
    // Actions. Everyone can be renamed. Not on yourself: a new passphrase (ask
    // another admin), the admin toggle (db/13) or delete (use Profile). Delete is
    // for members only: remove admin first.
    let action = `<button class="btn-block btn-ghost" id="user-rename-btn">Rename</button>`;
    if (isSelf) {
      action += `<p class="user-detail-note">This is your account. Another admin can give you a new passphrase.</p>`;
    } else {
      action += `<button class="btn-block btn-primary" id="user-reset-btn">Generate new passphrase</button>`;
      if (u.is_admin) {
        action += `<button class="btn-block btn-ghost" id="user-demote-btn">Remove admin</button>
          <p class="user-detail-note">Remove admin before deleting this account.</p>`;
      } else {
        action += `<button class="btn-block btn-ghost" id="user-promote-btn">Make admin</button>
          <button class="btn-block btn-danger" id="user-delete-btn">Delete user</button>`;
      }
    }
    el.innerHTML = `
      <div class="user-detail-head">
        <div class="user-avatar lg">${escHtml(userInitial(u.username))}</div>
        <div class="user-detail-name">${escHtml(u.username)}${u.is_admin ? '<span class="user-badge">Admin</span>' : ''}</div>
      </div>
      <div class="profile-row"><span class="k">Role</span><span class="v">${u.is_admin ? 'Admin' : 'Member'}</span></div>
      <div class="profile-row"><span class="k">Joined</span><span class="v">${fmtJoinDate(u.created_at)}</span></div>
      <div class="profile-row"><span class="k">On Ranks</span><span class="v">${u.is_public ? 'Yes' : 'No'}</span></div>
      <div class="profile-row"><span class="k">Routes set</span><span class="v">${routes}</span></div>
      <div class="profile-row"><span class="k">Sends</span><span class="v">${sends}</span></div>
      <div class="section-label user-activity-label">Recent activity</div>
      <div id="user-activity"><div class="spinner"></div></div>
      <div class="user-detail-actions">${action}</div>`;
    document.getElementById('user-rename-btn').addEventListener('click', () => openUserRename(u.id, u.username));
    const reset = document.getElementById('user-reset-btn');
    if (reset) reset.addEventListener('click', () => openUserReset(u.id, u.username));
    const promote = document.getElementById('user-promote-btn');
    if (promote) promote.addEventListener('click', () => openAdminChange(u.id, u.username, true));
    const demote = document.getElementById('user-demote-btn');
    if (demote) demote.addEventListener('click', () => openAdminChange(u.id, u.username, false));
    const delBtn = document.getElementById('user-delete-btn');
    if (delBtn) delBtn.addEventListener('click', () => openUserDelete(u.id, u.username));
    loadUserActivity(u.id);
  }

  // The account's last 10 ticks (db/30 admin_user_activity), so staff can ask
  // "what did you climb last time?" before giving someone a new passphrase.
  async function loadUserActivity(id) {
    const { data, error } = await sb.rpc('admin_user_activity', { target: id });
    if (!onAdminSub('user/' + id)) return;
    const box = document.getElementById('user-activity');
    if (!box) return;
    if (error) {
      console.warn('admin_user_activity failed', error);
      box.innerHTML = `<p class="user-detail-note">Couldn’t load their recent ticks.</p>`;
      return;
    }
    if (!data || !data.length) { box.innerHTML = `<p class="user-detail-note">No ticks yet.</p>`; return; }
    box.innerHTML = `<div class="activity-list">${data.map(t => `
      <div class="activity-row">
        <span class="grade-badge">${escHtml(fontGrade(t.grade) || '—')}</span>
        <span class="activity-name">${escHtml(t.name || '(deleted problem)')}${t.mirrored ? ' <span class="activity-mirror">mirrored</span>' : ''}</span>
        <span class="activity-date">${escHtml(fmtJoinDate(t.ticked_at))}</span>
      </div>`).join('')}</div>`;
  }

  // Are we still on the admin sub-screen a render started for? Guards async writes
  // against a fast navigation that happened mid-fetch.
  function onAdminSub(sub) {
    const { route, param } = parseHash();
    return currentView === 'admin' && route === 'admin' && (param || '') === sub;
  }

  // The reload button: re-fetch, then re-render whichever screen it was pressed on.
  function adminRefreshUsers() {
    adminUsersLoaded = false;
    renderAdmin(parseHash().param);
  }

  // ── Rename a user (admins only; db/30 admin_rename_user) ─────────────────────
  // The same rules as everyone's nickname, except admins may use reserved words.
  let pendingRename = null;   // { id, name }
  const renameChecker = () => getNickChecker('rename', 'user-rename-input', 'user-rename-check', {
    allowReserved: true,
    same: n => !!(pendingRename && n.toLowerCase() === String(pendingRename.name).toLowerCase()),
  });

  function openUserRename(id, name) {
    pendingRename = { id, name };
    document.getElementById('user-rename-name').textContent = name;
    document.getElementById('user-rename-input').value = name;
    document.getElementById('user-rename-error').textContent = '';
    renameChecker().clear();
    document.getElementById('user-rename-modal').classList.add('show');
    setTimeout(() => document.getElementById('user-rename-input').focus(), 50);
  }
  function closeUserRename() {
    document.getElementById('user-rename-modal').classList.remove('show');
    pendingRename = null;
  }

  async function doUserRename() {
    if (!pendingRename) return;
    const { id, name: oldName } = pendingRename;
    const errEl = document.getElementById('user-rename-error');
    const btn = document.getElementById('user-rename-save');
    const name = document.getElementById('user-rename-input').value.trim();
    errEl.textContent = '';
    if (name === oldName) { closeUserRename(); return; }
    btn.disabled = true;
    const code = await renameChecker().run();
    if (code) {
      btn.disabled = false;
      if (code === 'empty') errEl.textContent = 'Type a nickname.';
      return;
    }
    const { error } = await sb.rpc('admin_rename_user', { target: id, new_name: name });
    btn.disabled = false;
    if (error) {
      console.warn('admin_rename_user failed', error);
      errEl.textContent = nickSaveError(error);
      return;
    }
    const u = adminUsers.find(x => String(x.id) === String(id));
    if (u) u.username = name;
    if (profileNames[id]) profileNames[id] = name;   // their routes show the new name
    if (profile && String(profile.id) === String(id)) { profile.username = name; renderProfile(); }
    leaderboardLoaded = false;
    closeUserRename();
    if (loaded) renderList();
    showToast('Renamed to ' + name, 'success');
    renderAdmin('user/' + id);
  }

  // ── A new passphrase (admins only; the Edge Function admin-reset-passphrase) ──
  // The function checks the caller is an admin, sets a new four-word passphrase,
  // signs the account out on every device (plan.md D5), logs it and returns it
  // ONCE. It's shown here, then wiped from the page when the sheet closes.
  let pendingReset = null;   // { id, name }

  function openUserReset(id, name) {
    pendingReset = { id, name };
    document.getElementById('user-reset-title').textContent = 'New passphrase?';
    document.getElementById('user-reset-name').textContent = name;
    document.getElementById('user-reset-error').textContent = '';
    document.getElementById('user-reset-ask').hidden = false;
    document.getElementById('user-reset-done').hidden = true;
    document.getElementById('user-reset-pass').textContent = '';
    document.getElementById('user-reset-modal').classList.add('show');
  }
  function closeUserReset() {
    document.getElementById('user-reset-modal').classList.remove('show');
    document.getElementById('user-reset-pass').textContent = '';   // shown once: don't leave it in the page
    pendingReset = null;
  }

  async function doUserReset() {
    if (!pendingReset) return;
    const { id, name } = pendingReset;
    const errEl = document.getElementById('user-reset-error');
    const btn = document.getElementById('user-reset-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Working…';
    const { data, error } = await sb.functions.invoke('admin-reset-passphrase', { body: { target: id } });
    btn.disabled = false; btn.textContent = prev;
    if (error || !data || !data.passphrase) {
      let msg = 'Couldn’t reset — check your connection.';
      try {
        const body = error && error.context && typeof error.context.json === 'function' ? await error.context.json() : null;
        if (body && body.error) msg = body.error;
      } catch (e) {}
      console.warn('admin-reset-passphrase failed', error);
      errEl.textContent = msg;
      return;
    }
    if (!pendingReset || pendingReset.id !== id) return;   // closed meanwhile
    document.getElementById('user-reset-title').textContent = 'New passphrase for ' + name;
    document.getElementById('user-reset-pass').textContent = data.passphrase;
    const note = document.getElementById('user-reset-note');
    note.hidden = data.signedOut !== false;
    note.textContent = 'Their other devices couldn’t be signed out automatically. The old passphrase no longer works.';
    document.getElementById('user-reset-ask').hidden = true;
    document.getElementById('user-reset-done').hidden = false;
  }

  // ── Promote / demote a user (admins only; the RPC re-checks is_admin and
  //    refuses self-changes) — see db/13_admin_promote.sql ─────────────────────
  let pendingAdminChange = null;   // { id, name, make }

  function openAdminChange(id, name, make) {
    pendingAdminChange = { id, name, make };
    document.getElementById('user-admin-modal-title').textContent = make ? 'Make admin?' : 'Remove admin?';
    document.getElementById('user-admin-modal-text').innerHTML = make
      ? `Give <b>${escHtml(name)}</b> admin rights? They’ll be able to delete and re-grade problems, edit the hold outlines, and manage users, including renaming them and giving them new passphrases.`
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
      console.warn('admin_set_admin failed', error);
      errEl.textContent = error.message || 'Couldn’t update — check connection.';
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
      console.warn('admin_delete_user failed', error);
      errEl.textContent = error.message || 'Delete failed — check connection.';
      return;
    }

    adminUsers = adminUsers.filter(u => String(u.id) !== String(id));
    delete profileNames[id];
    leaderboardLoaded = false;   // their ticks went with them: Ranks and Total points refetch
    closeUserDelete();
    // Their routes lost the owner link (setter_id SET NULL) and now carry their
    // nickname as a snapshot (db/30): refresh the setter names and the list.
    await loadProfileNames();
    if (loaded) renderList();
    showToast('User deleted', 'success');
    location.hash = '#admin/users';   // back to the (now shorter) list
  }
