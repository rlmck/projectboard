// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: event wiring, PWA service worker + install banner, and boot (loaded LAST).

  // ── Wire up events ────────────────────────────────────────────────────────────
  // Search — the clear "×" stays visible whenever the field has text (not just
  // while focused, unlike the native control), and re-focuses for a fresh search.
  const searchInput = document.getElementById('search');
  const searchClear = document.getElementById('search-clear');
  searchInput.addEventListener('input', e => {
    searchQuery = e.target.value.trim().toLowerCase();
    searchClear.hidden = !e.target.value;
    renderList();
    // Jump back to the top so refined results aren't hidden below a scrolled fold.
    window.scrollTo(0, 0);
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    renderList();
    window.scrollTo(0, 0);
    searchInput.focus(); // pop the keyboard, ready for a fresh search
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
  //   • single-select (0–1 active) → switch to just this grade; tapping the active
  //     grade again clears back to "All".
  //   • multi-select  (2+ active)  → toggle this grade in/out. Dropping back to
  //     one grade returns to single-select, so the next tap switches again.
  function tapGrade(g) {
    if (g === 'all') {
      activeGrades.clear();
    } else if (activeGrades.size >= 2) {        // multi-select: tap toggles
      if (activeGrades.has(g)) activeGrades.delete(g);
      else activeGrades.add(g);
    } else if (activeGrades.has(g)) {            // tapping the active grade → All
      activeGrades.clear();
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

  // List clicks: heart toggles favourite (without opening), card opens detail.
  document.getElementById('list-container').addEventListener('click', e => {
    const fav = e.target.closest('.card-fave');
    if (fav) { e.stopPropagation(); toggleFave(fav.dataset.fave); return; }
    const card = e.target.closest('.problem-card');
    if (card) location.hash = '#detail/' + encodeURIComponent(card.dataset.id);
  });

  // Filter pills (under the grade tabs). A pill toggles a filter state, lights up,
  // and re-renders. Auth-only pills (favourites / exclude-done) show a non-invasive
  // toast for guests instead of filtering (and render muted via updateFaveControls).
  function wirePill(id, getActive, setActive, rerender, opts = {}) {
    const el = document.getElementById(id);
    el.addEventListener('click', () => {
      if (opts.needsAuth && !session) { showToast(opts.guestMsg, 'success'); return; }
      setActive(!getActive());
      el.classList.toggle('active', getActive());
      el.setAttribute('aria-pressed', getActive() ? 'true' : 'false');
      rerender();
    });
  }
  wirePill('pill-faves', () => favesOnly,   v => favesOnly = v,   renderList, { needsAuth: true, guestMsg: 'Sign in to filter favourites' });
  wirePill('pill-bench', () => benchOnly,   v => benchOnly = v,   renderList);
  wirePill('pill-done',  () => excludeDone, v => excludeDone = v, renderList, { needsAuth: true, guestMsg: 'Sign in to filter your sends' });

  // Detail back
  document.getElementById('back-btn').addEventListener('click', goBack);

  // ── Fullscreen board ──────────────────────────────────────────────────────────
  // Expand button (on any board) → rotated landscape fullscreen. Capture phase +
  // stopPropagation so a tap on the button over an interactive board (create /
  // circuit-create / calibrate) doesn't also cycle/append a hold or, in calibrate
  // nudge mode, start dragging a corner hold via the board's pointerdown handler.
  ['pointerdown', 'click'].forEach(type => {
    document.addEventListener(type, e => {
      if (!e.target.closest('.board-expand-btn')) return;
      e.stopPropagation();
      if (type === 'click') { e.preventDefault(); enterBoardFs('rotated'); }
    }, true);
  });
  document.getElementById('board-fs-close').addEventListener('click', exitBoardFs);

  // Detail actions (live in the header; operate on the current problem)
  document.getElementById('detail-cast').addEventListener('click', e => {
    if (currentProblem) castByName(currentProblem.name, e.currentTarget, detailMirror);
  });
  document.getElementById('detail-mirror').addEventListener('click', toggleDetailMirror);
  document.getElementById('detail-tick').addEventListener('click', toggleTick);
  document.getElementById('detail-fave').addEventListener('click', () => { if (currentProblem) toggleFave(currentProblem.id); });
  document.getElementById('detail-delete').addEventListener('click', openDeleteConfirm);
  document.getElementById('detail-edit').addEventListener('click', openEditChoice);

  // Edit chooser modal (grade vs holds)
  document.getElementById('edit-choice-close').addEventListener('click', closeEditChoice);
  document.getElementById('edit-choice-modal').addEventListener('click', e => {
    if (e.target.id === 'edit-choice-modal') closeEditChoice();
  });
  document.getElementById('edit-choice-grade').addEventListener('click', () => { closeEditChoice(); openGradeEdit(); });
  document.getElementById('edit-choice-holds').addEventListener('click', () => {
    const p = currentProblem;
    closeEditChoice();
    if (p) location.hash = '#create/' + encodeURIComponent(p.id);
  });

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
  document.getElementById('create-reset').addEventListener('click', onCreateReset);

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
  const circuitSearchInput = document.getElementById('circuit-search');
  const circuitSearchClear = document.getElementById('circuit-search-clear');
  circuitSearchInput.addEventListener('input', e => {
    circuitSearch = e.target.value.trim().toLowerCase();
    circuitSearchClear.hidden = !e.target.value;
    renderCircuits();
    // Jump back to the top so refined results aren't hidden below a scrolled fold.
    window.scrollTo(0, 0);
  });
  circuitSearchClear.addEventListener('click', () => {
    circuitSearchInput.value = '';
    circuitSearch = '';
    circuitSearchClear.hidden = true;
    renderCircuits();
    window.scrollTo(0, 0);
    circuitSearchInput.focus(); // pop the keyboard, ready for a fresh search
  });
  document.getElementById('circuit-grade-tabs').addEventListener('click', e => {
    const t = e.target.closest('.grade-tab');
    if (!t) return;
    const g = t.dataset.grade;
    activeCircuitGrade = (g === 'all' || g === activeCircuitGrade) ? '' : g;
    renderCircuits();
  });
  document.getElementById('circuit-list-container').addEventListener('click', e => {
    const fav = e.target.closest('.card-fave');
    if (fav) { e.stopPropagation(); toggleCircuitFave(fav.dataset.fave); return; }
    const card = e.target.closest('.problem-card');
    if (card) location.hash = '#circuit/' + encodeURIComponent(card.dataset.id);
  });
  wirePill('cpill-faves', () => circuitFavesOnly,   v => circuitFavesOnly = v,   renderCircuits, { needsAuth: true, guestMsg: 'Sign in to filter favourites' });
  wirePill('cpill-loop',  () => circuitLoopOnly,    v => circuitLoopOnly = v,    renderCircuits);
  wirePill('cpill-done',  () => circuitExcludeDone, v => circuitExcludeDone = v, renderCircuits, { needsAuth: true, guestMsg: 'Sign in to filter your sends' });
  document.getElementById('circuit-create-btn').addEventListener('click', () => {
    location.hash = session ? '#circuit-create' : '#auth';
  });

  // Circuit detail: back, delete, (Play wired per-render).
  document.getElementById('circuit-back').addEventListener('click', goBack);
  document.getElementById('circuit-detail-fave').addEventListener('click', () => { if (currentCircuit) toggleCircuitFave(currentCircuit.id); });
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

  // Leaderboard (#leaderboard): force a refresh from the RPC.
  document.getElementById('leaderboard-refresh').addEventListener('click', () => {
    leaderboardLoaded = false;
    renderLeaderboard();                                 // spinner
    loadLeaderboard(true).then(renderLeaderboard);
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

  // True while the user has in-progress create-form state that a hard reload
  // would silently discard (tapped holds + typed name/grade live only in memory).
  function hasUnsavedWork() {
    if (currentView === 'create') {
      if (Object.keys(createRoles).length) return true;
      if (createGrade) return true;
      const n = document.getElementById('create-name');
      if (n && n.value.trim()) return true;
    }
    if (currentView === 'circuit-create') {
      if (ccSeq.length) return true;
      if (ccGrade) return true;
      const n = document.getElementById('cc-name');
      if (n && n.value.trim()) return true;
    }
    return false;
  }

  // ── PWA: service worker + install (Add to Home Screen) ───────────────────────
  if ('serviceWorker' in navigator) {
    // Was the page already controlled at load? If not, the first controllerchange
    // is the initial install claim (none -> present), not an update — reloading
    // then just causes a pointless first-run flash.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    let pendingReload = false;

    // Reload to show the update, but never yank an in-progress create form out
    // from under the user — defer until they've left it / it's empty.
    function applyUpdate() {
      if (reloading) return;
      if (hasUnsavedWork()) { pendingReload = true; return; }
      reloading = true;
      window.location.reload();
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;   // first install: already on latest, nothing to reload to
      applyUpdate();
    });

    // Take a deferred reload once the unsaved work is gone. hashchange covers
    // in-app navigation away from the create form; the router updates currentView
    // first, so check on the next tick.
    window.addEventListener('hashchange', () => {
      if (pendingReload) setTimeout(applyUpdate, 0);
    });

    window.addEventListener('load', () => {
      // updateViaCache:'none' = always fetch sw.js from the network, never the
      // HTTP cache. A stale sw.js served from cache is the classic reason SW
      // updates stall and a device gets stranded on old code — this prevents it.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
        // Check for a new version now, and whenever the app regains focus.
        reg.update();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            reg.update();
            if (pendingReload) applyUpdate();
          }
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
