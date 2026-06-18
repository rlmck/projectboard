// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: problem list, detail, swipe, info, cast, board loaders, tick/delete/grade buttons.

  // ── List: filter + sort ──────────────────────────────────────────────────────
  function visibleProblems() {
    let arr = allProblems;
    if (favesOnly) arr = arr.filter(p => isFaved(p.id));
    if (activeGrades.size) arr = arr.filter(p => activeGrades.has(p.grade));
    const q = searchNorm(searchQuery);
    if (q) {
      arr = arr.filter(p =>
        searchNorm(p.name).includes(q) ||
        searchNorm(setterName(p)).includes(q) ||
        searchNorm(p.grade).includes(q)
      );
    }
    return arr.slice().sort((a, b) =>
      gradeRank(a.grade) - gradeRank(b.grade) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    );
  }

  function cardHtml(p) {
    const faved = isFaved(p.id);
    return `
      <div class="problem-card" data-id="${escAttr(p.id)}">
        <div class="problem-info">
          <div class="problem-name">${escHtml(displayName(p))}</div>
          <div class="problem-meta">
            <span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span>
            <span class="meta-setter">${escHtml(setterName(p))}</span>
            ${starsHtml(p.stars)}
            ${isTicked(p.id) ? '<span class="tick-flag" title="Sent">✓</span>' : ''}
          </div>
        </div>
        <button class="card-fave${faved ? ' faved' : ''}" data-fave="${escAttr(p.id)}" aria-pressed="${faved}" aria-label="${faved ? 'Remove from favourites' : 'Add to favourites'}">${HEART_SVG}</button>
      </div>`;
  }

  function renderList() {
    const container = document.getElementById('list-container');
    const list = visibleProblems();
    document.getElementById('count').textContent = `${list.length} problem${list.length !== 1 ? 's' : ''}`;

    if (list.length === 0) {
      container.innerHTML = favesOnly
        ? `<div class="state-msg"><div class="icon">♡</div>No favourites yet. Tap the heart on a problem to save it here.</div>`
        : `<div class="state-msg"><div class="icon">🔎</div>No problems match.</div>`;
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(cardHtml).join('')}</div>`;
  }

  // Shared grade-tab markup. `isActive(g)` decides the highlight; 'all' renders as
  // "All". `fmt` (optional) formats the LABEL only — data-grade keeps the raw value
  // for matching. Problem tabs pass fontGrade (capitalised); circuit tabs don't.
  function gradeTabButtons(grades, isActive, fmt) {
    return grades.map(g =>
      `<button class="grade-tab${isActive(g) ? ' active' : ''}" data-grade="${escAttr(g)}" type="button">${g === 'all' ? 'All' : escHtml(fmt ? fmt(g) : g)}</button>`
    ).join('');
  }

  function buildGradeTabs() {
    const present = [...new Set(allProblems.map(p => p.grade).filter(Boolean))]
      .sort((a, b) => gradeRank(a) - gradeRank(b) || a.localeCompare(b));
    // Drop any active filter whose grade no longer exists (last problem deleted/regraded),
    // otherwise visibleProblems() would filter on an absent grade and show nothing.
    [...activeGrades].forEach(g => { if (!present.includes(g)) activeGrades.delete(g); });
    document.getElementById('grade-tabs').innerHTML =
      gradeTabButtons(['all', ...present], g => g === 'all' ? activeGrades.size === 0 : activeGrades.has(g), fontGrade);
  }

  // ── Detail ───────────────────────────────────────────────────────────────────
  function renderDetail(id) {
    const wrap = document.getElementById('detail-content');

    if (!loaded) {
      currentProblem = null;
      updateTickButton();
      updateFaveButton();
      wrap.innerHTML = `<div class="spinner"></div>`;
      return;
    }

    const p = allProblems.find(x => String(x.id) === String(id));
    if (!p) {
      currentProblem = null;
      updateTickButton();
      updateFaveButton();
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That problem couldn't be found.<br><a class="link" href="#list">Back to problems</a></div>`;
      return;
    }

    // Moving to a different problem resets the mirror toggle to normal orientation.
    if (!currentProblem || String(currentProblem.id) !== String(p.id)) detailMirror = false;
    currentProblem = p;
    updateTickButton();
    updateFaveButton();
    updateMirrorButton();

    wrap.innerHTML = `
      <div class="detail-head-info">
        <h1 class="detail-name">${escHtml(displayName(p))}</h1>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span>
          <span class="meta-setter">by ${escHtml(setterName(p))}</span>
          ${starsHtml(p.stars)}
          ${p.is_benchmark ? `<span class="bench-badge">★ Benchmark</span>` : ''}
          ${(myTicksNormal.has(String(p.id)) && myTicksMirrored.has(String(p.id))) ? `<span class="both-badge">✓ both sides</span>` : ''}
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
        <div class="info-value"><span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span></div>
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

  // ── Cast geofence ─────────────────────────────────────────────────────────────
  // Casting to the board is only meant to happen at the gym. We check the phone's
  // location against a fence around The Hangout. By design this is LENIENT: a cast
  // is only blocked when we get a fix that is *confidently* outside the fence (even
  // the near edge of its accuracy circle is beyond the radius). Denied permission,
  // a timeout, an imprecise fix, or no Geolocation support all ALLOW the cast — so
  // we never falsely lock someone out indoors. Admins bypass the check entirely
  // (so casts can be tested off-site). Browsing/creating problems is unaffected.
  // Reusable for the Phase-2 circuit cast (call ensureCastLocation() there too).
  const GYM_GEOFENCE = {
    lat: 50.53,      // The Hangout, Southwell Business Park, Portland DT5
    lng: -2.4525,
    radiusM: 300     // generous — covers the building + immediate surrounds
  };
  let lastFix = null; // { lat, lng, accuracy, t } — cached so rapid casts don't re-prompt

  // Great-circle distance between two lat/lng points, in metres (haversine).
  function distanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function getPosition(opts) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, opts);
    });
  }

  // Resolve { ok } for whether a cast is permitted from the current location.
  // Lenient (see GYM_GEOFENCE): admins always pass; any error/uncertainty passes;
  // only a confidently-far fix returns { ok:false }.
  async function ensureCastLocation() {
    if (profile && profile.is_admin) return { ok: true };
    let fix = (lastFix && Date.now() - lastFix.t < 60000) ? lastFix : null;
    if (!fix) {
      try {
        // High accuracy off: a coarse Wi-Fi/cell fix is faster (esp. indoors) and
        // plenty for a 300 m fence; the near-edge test below absorbs its coarseness.
        const pos = await getPosition({ enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 });
        fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0, t: Date.now() };
        lastFix = fix;
      } catch (_) {
        return { ok: true }; // denied / timeout / unsupported → allow
      }
    }
    const dist = distanceMeters(fix.lat, fix.lng, GYM_GEOFENCE.lat, GYM_GEOFENCE.lng);
    // Confidently far = even the nearest edge of the accuracy circle is outside.
    if (dist - fix.accuracy > GYM_GEOFENCE.radiusM) return { ok: false, dist };
    return { ok: true };
  }

  // ── Cast a problem (broadcast contract unchanged) ─────────────────────────────
  async function castByName(name, btn, mirror = false) {
    if (!name) return;
    // Icon-only cast buttons keep their icon; text buttons swap to status text.
    const isIcon = btn.classList.contains('cast-icon-btn');
    const prev = btn.innerHTML;
    btn.classList.add('casting');
    btn.disabled = true;
    if (!isIcon) btn.innerHTML = 'Locating';

    // Geofence gate — only blocks on a fix that's confidently away from the gym
    // (admins bypass; missing/uncertain fixes are allowed). May briefly wait for GPS.
    const fence = await ensureCastLocation();
    if (!fence.ok) {
      btn.classList.remove('casting');
      btn.disabled = false;
      if (!isIcon) btn.innerHTML = prev;
      showToast('Casting only works at the gym', 'error');
      return;
    }
    if (!isIcon) btn.innerHTML = 'Sending';

    const payload = { problem_name: name };
    if (mirror) payload.mirror = true;

    try {
      // send() resolves (never throws) with 'ok' | 'error' | 'timed out'. With
      // broadcast.ack on, this reflects whether the Realtime server actually
      // received the cast, so treat anything but 'ok' as a failure.
      const status = await channel.send({
        type: 'broadcast',
        event: 'cast_problem',
        payload
      });
      if (status !== 'ok') throw new Error(`broadcast ${status}`);
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
    // The tick reflects (and toggles) the orientation currently shown.
    const set = detailMirror ? myTicksMirrored : myTicksNormal;
    const ticked = currentProblem && set.has(String(currentProblem.id));
    btn.classList.toggle('ticked', !!ticked);
    btn.setAttribute('aria-label', ticked
      ? `Sent${detailMirror ? ' (mirrored)' : ''} — tap to remove`
      : `Tick — mark ${detailMirror ? 'mirrored ' : ''}as completed`);
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
    myTicksNormal.delete(String(p.id));
    myTicksMirrored.delete(String(p.id));
    myFaves.delete(String(p.id));
    leaderboardLoaded = false;           // its ticks cascade away — refetch the board next view
    closeDeleteConfirm();
    buildGradeTabs();
    renderList();
    showToast('Problem deleted', 'success');
    location.hash = '#list';
  }

  // ── Edit a problem (admins only) — chooser: grade or holds ───────────────────
  function openEditChoice() {
    if (!currentProblem || !(profile && profile.is_admin)) return;
    document.getElementById('edit-choice-name').textContent = displayName(currentProblem);
    document.getElementById('edit-choice-modal').classList.add('show');
  }
  function closeEditChoice() { document.getElementById('edit-choice-modal').classList.remove('show'); }

  // ── Edit a problem's grade (admins only; DB enforces it via RLS) ─────────────
  let editGrade = '';
  function buildGradeEditOptions() {
    document.getElementById('grade-edit-options').innerHTML =
      gradeTabButtons(GRADE_ORDER, g => g === editGrade, fontGrade);
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

    // Grade only — never touch the name. Name and grade are independent (see
    // displayName); changing a climb's grade must not alter its name.
    const update = { grade: editGrade };

    const { error } = await sb.from('problems').update(update).eq('id', p.id);
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to edit problems.'   // not an admin (RLS)
        : error.message;
      return;
    }

    p.grade = editGrade;                 // update in place (same object lives in allProblems)
    leaderboardLoaded = false;           // base points depend on grade — refetch the board next view
    closeGradeEdit();
    buildGradeTabs();                    // a new grade may add/remove a filter tab
    renderList();
    if (currentView === 'detail') renderDetail(p.id);
    showToast('Grade updated', 'success');
  }

