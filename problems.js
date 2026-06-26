// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: problem list, detail, swipe, info, cast, board loaders, tick/delete/grade buttons.

  // ── List: filter + sort ──────────────────────────────────────────────────────
  function visibleProblems() {
    let arr = allProblems;
    if (favesOnly) arr = arr.filter(p => isFaved(p.id));
    if (benchOnly) arr = arr.filter(p => p.is_benchmark);
    if (excludeDone) arr = arr.filter(p => !isFullyDone(p.id));
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

  // Grade -> colour band for the catalogue tiles ('5'/'6'/'7'/'8' by the leading
  // digit; 'x' for anything else, e.g. Project/ungraded). Drives the --band CSS var.
  function gradeBand(g) {
    const c = String(g || '').trim()[0];
    return (c === '5' || c === '6' || c === '7' || c === '8') ? c : 'x';
  }

  // Is this problem ticked in a specific orientation? (myTicks is the any-orientation
  // union; the per-orientation sets back the feed/detail tick buttons.)
  function tickedOrient(id, mirrored) {
    return (mirrored ? myTicksMirrored : myTicksNormal).has(String(id));
  }

  // One full-screen panel in the immersive board feed. Carries the full per-card
  // action bar (tick · favourite · mirror · cast · info) so browsing IS viewing —
  // the same actions you have on the detail screen, acting on this problem. The
  // board is built lazily (data-built) as the panel nears focus; data-mirror tracks
  // its orientation. The actions use .deck-act[data-act][data-id] (app.js dispatch).
  function deckPanelHtml(p) {
    const id = escAttr(p.id);
    const faved = isFaved(p.id);
    const ticked = tickedOrient(p.id, false);
    const showStars = Number(p.stars) > 0;
    return `
      <div class="problem-card deck-panel grade-band-${gradeBand(p.grade)}" data-id="${id}" data-built="0" data-mirror="0">
        <div class="deck-top">
          <div class="deck-grade">${escHtml(fontGrade(p.grade) || '—')}</div>
          <div class="deck-name">${escHtml(displayName(p))}</div>
          <div class="deck-sub">
            <span class="meta-setter">by ${escHtml(setterName(p))}</span>
            ${showStars ? starsHtml(p.stars) : ''}
            ${p.is_benchmark ? '<span class="cat-bench" title="Benchmark">★</span>' : ''}
          </div>
        </div>
        <div class="board-wrap"></div>
        <div class="deck-actions">
          <button class="deck-act${ticked ? ' on' : ''}" data-act="tick" data-id="${id}" aria-label="Tick">${TICK_SVG}</button>
          <button class="deck-act fave-act${faved ? ' faved' : ''}" data-act="fave" data-id="${id}" aria-label="Favourite">${HEART_SVG}</button>
          <button class="deck-act" data-act="mirror" data-id="${id}" aria-label="Mirror">${MIRROR_SVG}</button>
          <button class="deck-act cast-icon-btn" data-act="cast" data-id="${id}" aria-label="Cast to board">${CAST_SVG}</button>
          <button class="deck-act" data-act="info" data-id="${id}" aria-label="Information">${INFO_SVG}</button>
        </div>
      </div>`;
  }

  // Plain list row (the classic "List View"). Keeps the .problem-card[data-id] +
  // .card-fave[data-fave] hooks the list click/fave wiring (app.js) relies on.
  function listRowHtml(p) {
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

  // Fisher–Yates shuffle (returns the same array, shuffled). Feed mode renders a
  // shuffled order so "every swipe is a shuffle".
  function shuffleArr(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Reflect the current mode on #view-list (CSS) + the #view-toggle button. The
  // toggle is an .icon-btn (consistent with the + create button): a list icon in
  // feed mode (tap → plain list), a shuffle icon in list mode (tap → shuffled feed).
  function applyListMode() {
    document.getElementById('view-list').classList.toggle('feed-on', feedMode);
    const btn = document.getElementById('view-toggle');
    if (!btn) return;
    btn.innerHTML = feedMode ? LIST_SVG : SHUFFLE_SVG;
    btn.setAttribute('aria-label', feedMode ? 'Switch to list view' : 'Shuffle cards');
  }

  function renderList() {
    const container = document.getElementById('list-container');
    const list = visibleProblems();
    document.getElementById('count').textContent = `${list.length} problem${list.length !== 1 ? 's' : ''}`;
    applyListMode();

    if (list.length === 0) {
      // Only show the favourites onboarding hint when faves is the *only* active
      // filter — otherwise the empty result may be down to the other filters, so
      // keep the message generic.
      const otherFilters = searchQuery || activeGrades.size || benchOnly || excludeDone;
      container.innerHTML = (favesOnly && !otherFilters)
        ? `<div class="state-msg"><div class="icon">♡</div>No favourites yet. Tap the heart on a problem to save it here.</div>`
        : `<div class="state-msg"><div class="icon">🔎</div>None match these filters.</div>`;
      return;
    }
    if (feedMode) {
      container.innerHTML = shuffleArr(list.slice()).map(deckPanelHtml).join('');
      initDeck(container);
    } else {
      container.innerHTML = `<div class="problem-list">${list.map(listRowHtml).join('')}</div>`;
    }
  }

  // A state-only refresh (after a tick/fave) — avoid rebuilding the feed (which
  // would reshuffle + lose your place). If the visible set changed (e.g. Exclude
  // Done hid the just-ticked climb), rebuild; otherwise just update card states.
  function refreshLists() {
    const container = document.getElementById('list-container');
    if (!container) return;
    if (!feedMode) { renderList(); return; }
    const rendered = Array.from(container.querySelectorAll('.deck-panel')).map(p => p.dataset.id);
    const visIds = visibleProblems().map(p => String(p.id));
    const same = rendered.length === visIds.length && visIds.every(id => rendered.includes(id));
    if (!same) { renderList(); return; }
    container.querySelectorAll('.deck-panel').forEach(panel => {
      const id = panel.dataset.id;
      const tickBtn = panel.querySelector('[data-act="tick"]');
      if (tickBtn) tickBtn.classList.toggle('on', tickedOrient(id, panel.dataset.mirror === '1'));
      const faveBtn = panel.querySelector('[data-act="fave"]');
      if (faveBtn) faveBtn.classList.toggle('faved', isFaved(id));
    });
  }

  // Per-card action dispatch (called from the #list-container click handler in
  // app.js). Each action operates on THIS card's problem + orientation, reusing the
  // same logic as the detail view.
  function handleFeedAction(actEl) {
    const id = actEl.dataset.id;
    const p = allProblems.find(x => String(x.id) === String(id));
    if (!p) return;
    const panel = actEl.closest('.deck-panel');
    const mirrored = panel && panel.dataset.mirror === '1';
    currentProblem = p;        // so info (and any currentProblem-based action) targets this card
    switch (actEl.dataset.act) {
      case 'fave':   toggleFave(id); break;
      case 'tick':   tickProblem(p, !!mirrored); break;     // refreshLists() updates the button
      case 'cast':   castByName(p.name, actEl, !!mirrored); break;
      case 'mirror': feedToggleMirror(panel, actEl); break;
      case 'info':   openInfo(); break;
    }
  }

  // Flip one feed card between normal and mirrored: rebuild just that card's board
  // overlay and replay its reveal; the tick button follows the shown orientation.
  function feedToggleMirror(panel, actEl) {
    if (!panel) return;
    const mir = panel.dataset.mirror !== '1';
    panel.dataset.mirror = mir ? '1' : '0';
    actEl.classList.toggle('on', mir);
    const p = allProblems.find(x => String(x.id) === String(panel.dataset.id));
    const wrap = panel.querySelector('.board-wrap');
    if (p && wrap) {
      wrap.innerHTML = `<img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="" />`
        + (boardShapeOverlayHtml(p, { mirror: mir, dim: true }) || boardOverlayHtml(p, mir) || '');
      animateBoardReveal(wrap, FEED_REVEAL);
    }
    const tickBtn = panel.querySelector('[data-act="tick"]');
    if (tickBtn) tickBtn.classList.toggle('on', tickedOrient(panel.dataset.id, mir));
    if (mir && p && problemHoldOrder(p).includes('hold218')) {
      showToast('I12 has no mirror — left in place', 'success');
    }
  }

  // ── Immersive board feed controller ──────────────────────────────────────────
  // Per render, two IntersectionObservers (root = the #list-container scroller):
  //   • buildIO  — builds each panel's board within a ~1.5-screen window and tears
  //                down the rest, so only a few boards are ever live (cheap at 270).
  //   • focusIO  — the centred panel (≥60% visible) plays its light-up reveal and
  //                slides its caption in; leaving resets it so it replays next time.
  // Re-init on every render (filter/search); previous observers are disconnected.
  const FEED_REVEAL = { startHold: 0.2, step: 0.06, fade: 0.28 };   // snappier than the detail reveal

  function deckProblem(panel) {
    return allProblems.find(x => String(x.id) === String(panel.dataset.id));
  }
  function buildPanelBoard(panel) {
    if (panel.dataset.built === '1') return;
    const p = deckProblem(panel);
    const wrap = panel.querySelector('.board-wrap');
    if (!p || !wrap) return;
    const mir = panel.dataset.mirror === '1';
    wrap.innerHTML = `<img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="" />`
      + (boardShapeOverlayHtml(p, { mirror: mir, dim: true }) || boardOverlayHtml(p, mir) || '');
    panel.dataset.built = '1';
  }
  function teardownPanelBoard(panel) {
    if (panel.dataset.built !== '1' || panel.dataset.focused === '1') return;
    const wrap = panel.querySelector('.board-wrap');
    if (wrap) wrap.innerHTML = '';
    panel.dataset.built = '0';
  }
  function focusDeckPanel(panel) {
    if (panel.dataset.focused === '1') return;
    panel.dataset.focused = '1';
    buildPanelBoard(panel);
    const wrap = panel.querySelector('.board-wrap');
    const animate = window.gsap && !prefersReducedMotion();
    if (wrap && animate) {
      gsap.fromTo(wrap, { scale: 0.9, opacity: 0.5 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'power3.out' });
    }
    animateBoardReveal(wrap, FEED_REVEAL);
    if (animate) {
      gsap.from(panel.querySelectorAll('.deck-top > *, .deck-actions'),
        { y: 16, opacity: 0, duration: 0.45, stagger: 0.06, ease: 'power3.out' });
    }
  }
  function blurDeckPanel(panel) {
    panel.dataset.focused = '0';
  }
  function initDeck(scroller) {
    const panels = Array.from(scroller.querySelectorAll('.deck-panel'));
    if (!panels.length) return;
    (scroller._deckIOs || []).forEach(io => io.disconnect());
    if (typeof IntersectionObserver === 'undefined') { panels.forEach(buildPanelBoard); return; }

    const buildIO = new IntersectionObserver(entries => {
      entries.forEach(e => e.isIntersecting ? buildPanelBoard(e.target) : teardownPanelBoard(e.target));
    }, { root: scroller, rootMargin: '0px 150%', threshold: 0 });   // horizontal window: pre-build side neighbours

    const focusIO = new IntersectionObserver(entries => {
      entries.forEach(e => e.intersectionRatio >= 0.6 ? focusDeckPanel(e.target) : blurDeckPanel(e.target));
    }, { root: scroller, threshold: [0, 0.6, 0.95] });

    panels.forEach(p => { buildIO.observe(p); focusIO.observe(p); });
    scroller._deckIOs = [buildIO, focusIO];

    // Build + focus the opening panel up front (IO fires async — avoids a first blank).
    buildPanelBoard(panels[0]);
    requestAnimationFrame(() => focusDeckPanel(panels[0]));
  }

  // Shared grade-tab markup. `isActive(g)` decides the highlight; 'all' renders as
  // "All". `fmt` (optional) formats the LABEL only — data-grade keeps the raw value
  // for matching. Problem tabs pass fontGrade (capitalised); circuit tabs don't.
  function gradeTabButtons(grades, isActive, fmt) {
    return grades.map(g =>
      `<button class="grade-tab${isActive(g) ? ' active' : ''}" data-grade="${escAttr(g)}" type="button">${g === 'all' ? 'All' : escHtml(fmt ? fmt(g) : g)}</button>`
    ).join('');
  }

  // Grade filter = a dual-thumb RANGE slider over the grades present in the data.
  // It writes the classic `activeGrades` Set (full range = empty = "All"), so
  // visibleProblems() and everything downstream is unchanged. Wired in app.js.
  function buildGradeTabs() {
    // Only real ladder grades (gradeRank < 999) — excludes "Project"/ungraded so the
    // slider tops out at the highest actual grade present.
    const present = [...new Set(allProblems.map(p => p.grade).filter(Boolean))]
      .filter(g => gradeRank(g) !== 999)
      .sort((a, b) => gradeRank(a) - gradeRank(b) || a.localeCompare(b));
    [...activeGrades].forEach(g => { if (!present.includes(g)) activeGrades.delete(g); });
    gradePresent = present;
    const el = document.getElementById('grade-tabs');
    const n = present.length;
    if (n <= 1) { el.innerHTML = ''; activeGrades.clear(); return; }   // nothing to range over

    // Seed the thumbs from any existing range (else full span).
    let lo = 0, hi = n - 1;
    if (activeGrades.size) {
      const idxs = present.map((g, i) => activeGrades.has(g) ? i : -1).filter(i => i >= 0);
      if (idxs.length) { lo = Math.min(...idxs); hi = Math.max(...idxs); }
    }
    el.innerHTML = `
      <div class="grade-slider">
        <div class="gs-label"><span id="gs-low"></span><span class="gs-dash">–</span><span id="gs-high"></span></div>
        <div class="gs-track">
          <div class="gs-rail"></div>
          <div class="gs-fill" id="gs-fill"></div>
          <input type="range" id="gs-min" min="0" max="${n - 1}" value="${lo}" step="1" aria-label="Lowest grade">
          <input type="range" id="gs-max" min="0" max="${n - 1}" value="${hi}" step="1" aria-label="Highest grade">
        </div>
      </div>`;
    updateGradeSliderUi();
  }

  // Sync the slider's fill + labels and rewrite activeGrades from the two thumbs.
  function updateGradeSliderUi() {
    const present = gradePresent, n = present.length;
    const minEl = document.getElementById('gs-min'), maxEl = document.getElementById('gs-max');
    if (!minEl || !maxEl || n <= 1) return;
    let lo = +minEl.value, hi = +maxEl.value;
    if (lo > hi) [lo, hi] = [hi, lo];          // thumbs can cross — use the span
    const max = n - 1;
    document.getElementById('gs-low').textContent = fontGrade(present[lo]);
    document.getElementById('gs-high').textContent = fontGrade(present[hi]);
    const fill = document.getElementById('gs-fill');
    fill.style.left = (lo / max * 100) + '%';
    fill.style.right = ((max - hi) / max * 100) + '%';
    activeGrades.clear();
    if (!(lo === 0 && hi === max)) for (let i = lo; i <= hi; i++) activeGrades.add(present[i]);
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
        ${boardShapeOverlayHtml(p, { mirror: detailMirror, dim: true }) || boardOverlayHtml(p, detailMirror)}
        ${boardExpandBtn()}
      </div>
    `;

    // GSAP "light-up" reveal (no-ops without GSAP / reduced motion). Skipped once
    // when mirroring back to normal — see toggleDetailMirror. The flag is a one-shot,
    // so leaving and re-entering the detail view animates again.
    const skipReveal = suppressDetailReveal;
    suppressDetailReveal = false;
    if (!skipReveal) animateBoardReveal(wrap.querySelector('.board-wrap'));
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
    // Mirroring ON re-animates the reveal; mirroring back to normal does not.
    suppressDetailReveal = !detailMirror;
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

  // ── Load hold outline shapes (bundled; hold id -> [[x,y],…] % polygon) ───────
  // Tied to the bundled ProjectBoard.png illustration, so bundled-only (no
  // board_config). Drives the problem detail/create shape overlay; absent or empty
  // → the overlay falls back to circles.
  async function loadHoldShapes() {
    try {
      const res = await fetch('hold_shapes.json', { cache: 'no-cache' });
      if (res.ok) HOLD_SHAPES = await res.json();
    } catch (err) {
      console.warn('hold_shapes.json load failed — shape overlay disabled', err);
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

