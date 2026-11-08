// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, challenge, leaderboard, wall, app. This file: circuits - load, list, detail, swipe, info, cast + run screen, create, delete.
//
// Circuits are built to look and behave like problems: the same cards and grade
// tabs (tap = one grade, hold = several), pull-to-refresh, a pinned detail view
// you swipe through, the traced hold outlines over a dimmed board, and the ⋮
// menu's Information sheet. What's circuit-only: move numbers on the holds, and
// the Cast sheet (a timed run on the wall).

  // A sequence position's role: finish (last) wins over start (first N), else move.
  function circuitRole(seq, startCount, pos) {
    if (pos === seq.length - 1) return 'finish';
    if (pos < startCount) return 'start';
    return 'int';
  }

  // finish > start > int, for a hold that takes several roles across repeats.
  const strongerRole = (a, b) =>
    (a === 'finish' || b === 'finish') ? 'finish' : (a === 'start' || b === 'start') ? 'start' : 'int';

  // One entry per UNIQUE hold in a sequence: its strongest role, and the move
  // numbers (1-based) it carries, e.g. { hold235: '6/7' }. The detail, Play and
  // create boards all draw from this.
  function circuitHoldRoles(seq, startCount) {
    const roles = {}, labels = {};
    seq.forEach((h, pos) => {
      roles[h] = strongerRole(roles[h], circuitRole(seq, startCount, pos));
      labels[h] = labels[h] ? labels[h] + '/' + (pos + 1) : String(pos + 1);
    });
    return { roles, labels };
  }

  // Move-number tags for the outline overlay. A tag hangs off the bottom edge of
  // its hold's traced outline, under the hold's centre, so the number is plainly
  // that hold's without covering it. Only used when shapes are usable.
  function seqTagsHtml(labels, roles) {
    const tags = Object.keys(labels).map(h => {
      const pos = HOLD_MAP[h];
      if (!pos) return '';
      const pts = HOLD_SHAPES[h];
      const y = (pts && pts.length >= 3) ? Math.max(...pts.map(p => p[1])) : pos.y + 2.3 * (boardAspect || 1);
      return `<span class="seq-tag ${roles[h]}" style="left:${pos.x}%;top:${+y.toFixed(3)}%">${escHtml(labels[h])}</span>`;
    }).join('');
    return `<div class="seq-tag-layer">${tags}</div>`;
  }

  // The board overlay for a set of holds: traced outlines (dimming the rest of
  // the board when `dim`) with move-number tags, or numbered dots when the
  // outlines can't be used (see shapesUsable).
  function circuitLayerHtml(roles, labels, { dim = false } = {}) {
    if (!HOLD_MAP) return '';
    const shapes = holdShapeLayerHtml(roles, { dim });
    if (shapes != null) return shapes + seqTagsHtml(labels, roles);
    return Object.keys(roles).map(h => {
      const pos = HOLD_MAP[h];
      if (!pos) return '';
      return `<div class="hold-dot ${roles[h]}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${escHtml(labels[h])}</span></div>`;
    }).join('');
  }

  // The whole circuit at rest, as the detail view shows it.
  function circuitStaticOverlay(c) {
    const seq = circuitSeq(c);
    if (!seq.length) return '';
    const { roles, labels } = circuitHoldRoles(seq, c.start_count);
    return circuitLayerHtml(roles, labels, { dim: true });
  }

  function showCircuits(rows) {
    allCircuits = rows;
    circuitsLoaded = true;
    circuitsError = null;
    if (currentView === 'circuits') renderCircuits();
    else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
    wallRenderCircuits();                 // the wall screen's Circuits page (wall.js; only with WALL)
  }

  // As loadProblems: the saved list shows at once, the fresh one replaces it, and a
  // failed fetch keeps the saved one with the offline note.
  async function loadCircuits() {
    const saved = !circuitsLoaded && savedList('circuits');
    if (saved) showCircuits(saved.rows);
    const { data, error } = await sb.from('circuits').select('*');
    if (error) {
      console.warn('circuits load failed', error);
      if (saved) { setOfflineNote('circuit-offline', saved.t); return; }
      circuitsError = error;
      wallRenderCircuits();
      if (currentView === 'circuits') renderCircuits();
      else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
      return;
    }
    saveList('circuits', data || []);
    setOfflineNote('circuit-offline', 0);
    showCircuits(data || []);
  }

  // Pull-to-refresh on the circuit list (wired in app.js), as refreshProblems:
  // re-fetch in place, and keep the list that's showing if the fetch fails.
  async function refreshCircuits() {
    const [res] = await Promise.all([
      sb.from('circuits').select('*'),
      session ? loadFaves() : null,
    ]);
    if (res.error) { showToast('Couldn’t refresh circuits', 'error'); return; }
    saveList('circuits', res.data || []);
    setOfflineNote('circuit-offline', 0);
    allCircuits = res.data || [];
    circuitsLoaded = true;
    circuitsError = null;
    renderCircuits();
  }

  // ── Circuit list ───────────────────────────────────────────────────────────────
  // Sorted and filtered like the problem list (problems.js), through the same
  // Filter sheet: New (default) / Random / Easy / Hard (no Popular), the sport
  // grade range, Favourites and Looping.
  const CIRCUIT_SORTS = LIST_SORTS.filter(s => s[0] !== 'popular');
  const byCircuitName = (a, b) => circuitName(a).localeCompare(circuitName(b));
  function circuitRandomKey(c) {
    const id = String(c.id);
    if (!circuitRandom.has(id)) circuitRandom.set(id, Math.random());
    return circuitRandom.get(id);
  }
  function sortCircuits(arr) {
    const cmp = {
      new:    (a, b) => createdMs(b) - createdMs(a) || byCircuitName(a, b),
      random: (a, b) => circuitRandomKey(a) - circuitRandomKey(b),
      easy:   (a, b) => sportRank(a.grade) - sportRank(b.grade) || byCircuitName(a, b),
      hard:   (a, b) => (sportRank(a.grade) === 999) - (sportRank(b.grade) === 999)
                        || sportRank(b.grade) - sportRank(a.grade) || byCircuitName(a, b),
    }[circuitSort] || ((a, b) => 0);
    return arr.slice().sort(cmp);
  }

  // The sport-ladder grades present in the circuits, easiest first.
  function circuitGradeSteps() {
    return [...new Set(allCircuits.map(c => String(c.grade || '').toLowerCase()))]
      .filter(g => sportRank(g) !== 999)
      .sort((a, b) => sportRank(a) - sportRank(b));
  }
  const circuitGradeNarrowed = () => circuitGradeLo !== null || circuitGradeHi !== null;
  function inCircuitGradeRange(c) {
    if (!circuitGradeNarrowed()) return true;
    const r = sportRank(String(c.grade || '').toLowerCase());
    if (r === 999) return false;
    return (circuitGradeLo === null || r >= sportRank(circuitGradeLo)) && (circuitGradeHi === null || r <= sportRank(circuitGradeHi));
  }

  // Every filter, unsorted (counts, the hold picker); visibleCircuits() sorts it.
  // The hold filter: a circuit must use every picked hold somewhere in its sequence.
  const circuitHolds = c => cachedHoldSet(c, circuitSeq);
  function filteredCircuits() {
    let arr = allCircuits;
    if (circuitFavesOnly) arr = arr.filter(c => isCircuitFaved(c.id));
    if (circuitLoopOnly) arr = arr.filter(c => c.loops);
    if (circuitGradeNarrowed()) arr = arr.filter(inCircuitGradeRange);
    if (circuitHoldPicks.length) arr = arr.filter(c => usesAllHolds(circuitHolds(c), circuitHoldPicks));
    const q = searchNorm(circuitSearch);
    if (q) {
      arr = arr.filter(c =>
        searchNorm(circuitName(c)).includes(q) ||
        searchNorm(setterName(c)).includes(q) ||
        searchNorm(c.grade).includes(q)
      );
    }
    return arr;
  }
  function visibleCircuits() { return sortCircuits(filteredCircuits()); }

  // The filter icon's badge: the sort, the grade range, each quick filter, the picked holds (as one).
  const circuitFilterCount = () =>
    (circuitSort !== 'new') + circuitGradeNarrowed() + circuitFavesOnly + circuitLoopOnly + (circuitHoldPicks.length > 0);

  // Back to the defaults (Reset, Clear filters, the wall going idle). State only.
  function resetCircuitFilters() {
    circuitFavesOnly = false; circuitLoopOnly = false;
    circuitSort = 'new';
    circuitRandom = new Map();
    circuitGradeLo = null; circuitGradeHi = null;
    circuitHoldPicks = [];
  }

  // The circuit list's kind for the Filter sheet (problems.js).
  FILTER_KINDS.circuits = {
    noun: 'circuit',
    sorts: () => CIRCUIT_SORTS,
    getSort: () => circuitSort,
    setSort: key => {
      circuitSort = key;
      if (key === 'random') circuitRandom = new Map();   // a fresh shuffle every time it's chosen
    },
    steps: () => circuitGradeSteps(),
    rank: g => sportRank(g),
    fmt: g => g,                        // sport grades stay lowercase
    getRange: () => [circuitGradeLo, circuitGradeHi],
    setRange: (lo, hi) => { circuitGradeLo = lo; circuitGradeHi = hi; },
    toggles: () => (WALL ? ['loop'] : ['cfaves', 'loop']),
    count: () => filteredCircuits().length,
    getHolds: () => circuitHoldPicks,
    setHolds: picks => { circuitHoldPicks = picks; },
    matches: () => filteredCircuits(),
    holdsOf: c => circuitHolds(c),
    nOn: () => circuitFilterCount(),
    reset: () => resetCircuitFilters(),
    render: () => { renderCircuits(); wallRenderCircuits(); },
    search: 'circuit-search',
    searching: () => !!circuitSearch,
  };

  function circuitCardHtml(c) {
    const n = circuitSeq(c).length;
    const faved = isCircuitFaved(c.id);
    return `
      <div class="problem-card" data-id="${escAttr(c.id)}">
        <div class="problem-info">
          <div class="problem-name">${escHtml(circuitName(c))}</div>
          <div class="problem-meta">
            <span class="grade-badge">${escHtml(c.grade || '—')}</span>
            ${newBadgeHtml(c)}
            <span class="meta-setter">${escHtml(setterName(c))}</span>
            <span class="circuit-len">${n} move${n === 1 ? '' : 's'}</span>
            ${c.loops ? '<span class="loop-badge">↻ Loop</span>' : ''}
          </div>
        </div>
        <button class="card-fave${faved ? ' faved' : ''}" data-fave="${escAttr(c.id)}" aria-pressed="${faved}" aria-label="${faved ? 'Remove from favourites' : 'Add to favourites'}">${HEART_SVG}</button>
      </div>`;
  }

  function renderCircuits() {
    updateFilterControls();
    const container = document.getElementById('circuit-list-container');
    const countEl = document.getElementById('circuit-count');
    if (!circuitsLoaded) {
      if (circuitsError) {
        countEl.textContent = '';
        container.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>Failed to load circuits.</div>`;   // error logged in loadCircuits
      }
      return;
    }
    const list = visibleCircuits();
    countEl.textContent = `${list.length} circuit${list.length !== 1 ? 's' : ''}`;
    if (!list.length) {
      // Show the favourites onboarding hint only when faves is the *only* active
      // filter; otherwise keep it generic (the other filters may be the cause).
      const otherFilters = circuitSearch || circuitFilterCount() > 1;
      container.innerHTML = !allCircuits.length
        ? `<div class="state-msg"><div class="icon">🧗</div>No circuits yet — tap + to set the first one.</div>`
        : (circuitFavesOnly && !otherFilters)
          ? `<div class="state-msg f-empty"><div class="icon">♡</div>No favourite circuits yet. Tap the heart on a circuit to save it here.`
            + `<button class="btn-block btn-ghost f-empty-btn" type="button" data-act="clear-filters" data-kind="circuits">Clear filters</button></div>`
          : filterEmptyHtml('circuits');
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(circuitCardHtml).join('')}</div>`;
  }

  // ── Circuit detail ──────────────────────────────────────────────────────────────
  // Laid out like the problem detail: pinned to the screen, title block (with
  // Cast) + board centred, the challenge link under it.
  const CAST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';   // as the problem view's

  function renderCircuitDetail(id) {
    const wrap = document.getElementById('circuit-detail-content');
    const faveBtn = document.getElementById('circuit-detail-fave');
    faveBtn.hidden = true;
    currentCircuit = null;
    updateCircuitMenu();

    if (!circuitsLoaded) {
      currentCircuit = null;
      if (circuitsError) {
        wrap.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>Couldn’t load circuits.<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      } else {
        wrap.innerHTML = `<div class="spinner"></div>`;
      }
      return;
    }

    const c = allCircuits.find(x => String(x.id) === String(id));
    if (!c) {
      currentCircuit = null;
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That circuit couldn't be found.<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      return;
    }

    currentCircuit = c;
    updateCircuitMenu();
    faveBtn.hidden = false;
    updateCircuitFaveButton();
    const n = circuitSeq(c).length;

    wrap.innerHTML = `
      <div class="circuit-stage">
        <div class="detail-head-info">
          <div class="detail-title-row">
            <h1 class="detail-name">${escHtml(circuitName(c))}</h1>
            <button class="cast-btn title-cast cast-icon-btn" id="circuit-cast-open" type="button" aria-label="Cast to board">${CAST_ICON}Cast</button>
          </div>
          <div class="detail-meta">
            <span class="grade-badge">${escHtml(c.grade || '—')}</span>
            ${newBadgeHtml(c)}
            <span class="meta-setter">by ${escHtml(setterName(c))}</span>
            <span class="circuit-len">${n} move${n === 1 ? '' : 's'}</span>
            ${c.loops ? '<span class="loop-badge">↻ Loop</span>' : ''}
          </div>
        </div>

        <div class="board-wrap">
          <img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />
          <div class="hold-layer">${circuitStaticOverlay(c)}</div>
          ${boardExpandBtn()}
        </div>
      </div>

      <div id="circuit-challenge-slot"></div>`;

    document.getElementById('circuit-cast-open').addEventListener('click', () => openCircuitCast());
    fillCircuitChallenge(c);   // the challenge link, if a challenge uses this circuit (challenge.js)
  }

  // The ⋮ menu's Edit and Delete: Delete for the owner (no challenge on it) or an
  // admin; Edit too, but for the owner only while nobody else has logged a run of
  // it (db/39). That's asked in the background the first time; Edit appears when
  // it says no.
  function updateCircuitMenu() {
    const c = currentCircuit;
    document.getElementById('circuit-menu-delete').hidden = !canEditCircuit(c);
    if (c && !isAdmin() && canEditCircuit(c) && othersUsed('c', c.id) === undefined) {
      askOthersUsed('c', c.id, () => { if (currentCircuit === c) updateCircuitMenu(); });
    }
    document.getElementById('circuit-menu-edit').hidden = !canChangeCircuit(c);
  }

  function openCircuitEdit() {
    const c = currentCircuit;
    if (c && canChangeCircuit(c)) location.hash = '#circuit-create/' + encodeURIComponent(c.id);
  }

  // ── Swipe between circuits (detail view) ──────────────────────────────────────
  // As swipeToAdjacent for problems: the deck is the filtered + sorted list, the
  // hash is replaced (Back still returns to the list), and the view re-renders in
  // place. dir = +1 (next) / -1 (previous).
  function swipeToAdjacentCircuit(dir) {
    if (currentView !== 'circuit-detail' || !currentCircuit) return;
    const deck = visibleCircuits();
    const idx = deck.findIndex(c => String(c.id) === String(currentCircuit.id));
    if (idx === -1) return;
    const next = deck[idx + dir];
    if (!next) return;                                   // stop at the ends
    circuitTrail.push(currentCircuit.id);               // deleting `next` comes back here
    history.replaceState(history.state, '', '#circuit/' + encodeURIComponent(next.id));
    closeInfo();
    renderCircuitDetail(next.id);
  }

  // ── Info sheet (the ⋮ menu's Information) ─────────────────────────────────────
  // Shares the problem info modal; openInfo() sets its title back for problems.
  function openCircuitInfo() {
    const c = currentCircuit;
    if (!c) return;
    const n = circuitSeq(c).length;
    const starts = Math.min(c.start_count || 1, n);
    // No comments section: comments are switched off (db/30, plan.md D4).
    document.getElementById('info-title').textContent = 'Circuit info';
    document.getElementById('info-body').innerHTML = `
      <div class="info-row">
        <div class="info-label">Grade</div>
        <div class="info-value"><span class="grade-badge">${escHtml(c.grade || '—')}</span></div>
      </div>
      <div class="info-row">
        <div class="info-label">Route</div>
        <div class="info-value">${n} move${n === 1 ? '' : 's'}, starting on ${starts === 1 ? 'one hold' : 'two holds'}. ${
          c.loops ? 'It loops: the top comes back down near the start, so you can go round again.' : 'It finishes at the top.'}</div>
      </div>
      <div class="info-row">
        <div class="info-label">Cast</div>
        <div class="info-value">Lights the circuit on the wall at your speed: first a white light runs round the route, then a 5-second countdown on the start holds, then one move at a time. Solid blue is the hold to go to, amber the one after, and the hold you've just let go of fades out in red. ${
          c.loops ? 'It loops until you press Stop.' : 'At the top the route runs up in green.'} Signed in, each run is saved to your log.</div>
      </div>
    `;
    document.getElementById('info-modal').classList.add('show');
  }

  // ── Cast a circuit (Circuits Phase 2; cast contract §8) ───────────────────────────
  // The Cast button under the board opens a sheet: speed and loop, then Start sends
  // cast_circuit and the sheet becomes the run screen (the countdown with beeps, the
  // move counter, a big Stop). The Pi runs the lights itself (pi/listener/circuit.py);
  // the phone keeps its own clock from the moment the cast was accepted, so the
  // counter stays right after the screen sleeps. Stop sends `stop` with the run's
  // token. A signed-in climber's run is logged to circuit_logs when it ends (stop or
  // the top); a guest's isn't.
  const CAST_SPEEDS = [5, 3, 2];          // seconds a move: Slow, Med, Fast
  const CAST_SPEED_KEY = 'pb-circuit-speed';
  const CAST_COUNTDOWN = 5;               // as the Pi's circuit.COUNTDOWN
  const CAST_LAG_MS = 250;                // the Pi starts after reading the circuit: roughly this later
  let castSheetCircuit = null;            // the circuit the open sheet is for
  let castSpeed = CAST_SPEEDS.includes(+lsGet(CAST_SPEED_KEY)) ? +lsGet(CAST_SPEED_KEY) : 3;
  let castLoop = false;
  let circuitRun = null;                  // { c, interval, loop, token, t0, s, L, moves, beeped, ended, ... }
  let circuitRunTicker = null;
  let circuitWake = null;

  // c: the circuit on screen (the phone's detail view, or the wall's Circuits page).
  function openCircuitCast(c = currentCircuit) {
    if (!c) return;
    if (circuitRunGoing()) { document.getElementById('circuit-cast-modal').classList.add('show'); return; }
    castSheetCircuit = c;
    castLoop = !!c.loops;
    document.getElementById('cast-sheet-title').textContent = circuitName(c);
    document.getElementById('cast-sheet-error').textContent = '';
    showCastPane('setup');
    syncCastOptions();
    document.getElementById('circuit-cast-modal').classList.add('show');
  }

  const circuitRunGoing = () => !!(circuitRun && !circuitRun.ended);

  // Closes only from its buttons while nothing is running (a stray tap mustn't
  // hide the Stop button of a run that's lighting the board).
  function closeCircuitCast() {
    if (circuitRunGoing()) return;
    document.getElementById('circuit-cast-modal').classList.remove('show');
    circuitRun = null;
  }

  // The wall screen going idle (which can't start while a run goes): the sheet
  // closes. A run still going is left to the Pi.
  function abandonCircuitCast() {
    if (circuitRunGoing()) {
      circuitRun.ended = true;
      clearInterval(circuitRunTicker); circuitRunTicker = null;
      releaseCircuitWake();
    }
    circuitRun = null;
    document.getElementById('circuit-cast-modal').classList.remove('show');
  }

  function showCastPane(which) {
    ['setup', 'run', 'done'].forEach(p => { document.getElementById('cast-sheet-' + p).hidden = p !== which; });
    document.getElementById('cast-sheet-close').hidden = which === 'run';
  }

  function syncCastOptions() {
    document.querySelectorAll('#cast-sheet-speed .cc-seg-btn').forEach(b =>
      b.classList.toggle('active', +b.dataset.s === castSpeed));
    document.getElementById('cast-sheet-speed-val').textContent = `${castSpeed} s a move`;
    const lb = document.getElementById('cast-sheet-loop');
    lb.classList.toggle('on', castLoop);
    lb.setAttribute('aria-pressed', castLoop ? 'true' : 'false');
  }

  function setCastSpeed(s) {
    if (!CAST_SPEEDS.includes(s)) return;
    castSpeed = s;
    lsSet(CAST_SPEED_KEY, String(s));
    syncCastOptions();
  }
  function toggleCastLoop() { castLoop = !castLoop; syncCastOptions(); }

  function castRunToken() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // A circuit's static view (contract §8.7, 2 Nov 2026): every hold lit at once in a
  // problem's colours, no animation; the Pi shows it like a problem cast (latest wins,
  // then idle). Only the wall screen sends it, when a circuit is tapped on its
  // Circuits page. Like castByName: the lenient geofence, then only sent if
  // stillShowing() says the same circuit is still on screen. Resolves true once
  // Realtime accepted it (not proof the board lit). Not in cast_log: the wall has
  // no sign-in, so it's never a member's.
  async function showCircuitByName(name, stillShowing = null) {
    if (!name) return false;
    const fence = await ensureCastLocation();
    if (stillShowing && !stillShowing()) return false;
    if (!fence.ok) return false;
    try {
      await channel.httpSend('show_circuit',
        { circuit_name: name, source: WALL ? 'wall' : 'phone', signed_in: !!session }, { timeout: 10000 });
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  async function startCircuitCast() {
    const c = castSheetCircuit;
    const btn = document.getElementById('cast-sheet-start');
    const errEl = document.getElementById('cast-sheet-error');
    if (!c || btn.disabled) return;
    errEl.textContent = '';
    chEnsureAudio();                      // a tap: browsers allow sound from here on
    btn.disabled = true; btn.textContent = 'Locating…';
    const done = () => { btn.disabled = false; btn.textContent = 'Start on the board'; };

    // The same lenient geofence as a problem cast (admins skip it).
    const fence = await ensureCastLocation();
    const modal = document.getElementById('circuit-cast-modal');
    if (castSheetCircuit !== c || !modal.classList.contains('show') || (WALL && wallIsIdle())) { done(); return; }
    if (!fence.ok) { done(); errEl.textContent = 'Casting only works at the gym.'; return; }

    btn.textContent = 'Sending…';
    const token = castRunToken();
    const interval = castSpeed, loop = castLoop;
    const payload = { circuit_name: circuitName(c), interval, loop, run: token,
                      source: WALL ? 'wall' : 'phone', signed_in: !!session };
    try {
      await channel.httpSend('cast_circuit', payload, { timeout: 10000 });
    } catch (err) {
      done();
      errEl.textContent = 'Cast failed — check your connection.';
      console.error(err);
      return;
    }
    done();
    logCast('circuit', circuitName(c), false, token);
    const seq = circuitSeq(c), L = seq.length, s = Math.max(1, Math.min(c.start_count || 1, 2, L));
    // The phone's clock starts at the Pi's countdown: after its read (CAST_LAG_MS). No route trace
    // since 5 Nov 2026 (contract 8.3): the Pi starts the countdown at once.
    circuitRun = { c, interval, loop, token, t0: Date.now() + CAST_LAG_MS, L, s, moves: L - s,
                   beeped: -1, ended: false, stopSent: false, movesDone: 0 };
    showCastPane('run');
    document.getElementById('cast-run-stop').textContent = 'Stop';
    if (!circuitRunTicker) circuitRunTicker = setInterval(tickCircuitRun, 100);
    acquireCircuitWake();
    tickCircuitRun();
  }

  // Seconds since the Pi started, and what it's showing: as circuit.Run.moves_at().
  function circuitRunNow(r) {
    const t = (Date.now() - r.t0) / 1000;
    if (t < CAST_COUNTDOWN) return { t, phase: 'count', moves: 0 };
    const b = Math.floor((t - CAST_COUNTDOWN) / r.interval);
    if (!r.loop && b >= r.moves) return { t, phase: 'top', moves: r.moves };
    return { t, phase: 'climb', moves: b, beat: b };
  }

  function tickCircuitRun() {
    const r = circuitRun;
    if (!r || r.ended) { clearInterval(circuitRunTicker); circuitRunTicker = null; return; }
    const now = circuitRunNow(r);
    const big = document.getElementById('cast-run-big'), sub = document.getElementById('cast-run-sub');
    if (now.phase === 'count') {
      const left = Math.min(CAST_COUNTDOWN, Math.max(1, Math.ceil(CAST_COUNTDOWN - now.t)));
      const sec = Math.floor(Math.max(0, now.t));
      if (sec !== r.beeped && now.t >= 0) { r.beeped = sec; chBeep(880, 120); }      // 5, 4, 3, 2, 1
      big.textContent = String(left);
      sub.textContent = 'Get on the start holds';
      return;
    }
    if (r.beeped < CAST_COUNTDOWN) {          // go! (not when the screen wakes long after)
      r.beeped = CAST_COUNTDOWN;
      if (now.t < CAST_COUNTDOWN + 1) chBeep(1320, 380, 0.4);
    }
    if (now.phase === 'top') { endCircuitRun(r.moves, true); return; }
    const lap = Math.floor((r.s - 1 + now.beat) / r.L) + 1;
    big.textContent = String(now.moves);
    sub.textContent = r.loop ? `moves · lap ${lap}` : `of ${r.moves} moves`;
  }

  async function stopCircuitRun() {
    const r = circuitRun;
    if (!r) return;
    const btn = document.getElementById('cast-run-stop');
    if (!r.ended) endCircuitRun(circuitRunNow(r).moves, false);
    if (r.stopSent) return;
    btn.disabled = true;
    try {
      await channel.httpSend('stop', { run: r.token, source: WALL ? 'wall' : 'phone', signed_in: !!session },
                             { timeout: 10000 });
      r.stopSent = true;
      document.getElementById('cast-done-stop').hidden = true;
    } catch (err) {
      console.error(err);
      showToast('Stop didn’t reach the board — tap Stop the lights', 'error');
      document.getElementById('cast-done-stop').hidden = false;
    }
    btn.disabled = false;
  }

  // The run is over on the phone (the top, or Stop): the done pane, and the log.
  function endCircuitRun(moves, top) {
    const r = circuitRun;
    if (!r || r.ended) return;
    r.ended = true;
    r.movesDone = moves;
    clearInterval(circuitRunTicker); circuitRunTicker = null;
    releaseCircuitWake();
    if (top) { chBeep(660, 160); setTimeout(() => chBeep(880, 160), 170); setTimeout(() => chBeep(1320, 420, 0.4), 340); }
    document.getElementById('cast-done-big').textContent = top ? 'Top!' : String(moves);
    document.getElementById('cast-done-sub').textContent = top
      ? `${moves} move${moves === 1 ? '' : 's'} done`
      : `move${moves === 1 ? '' : 's'}${r.loop ? ` · ${r.L}-hold loop` : ` of ${r.moves}`}`;
    document.getElementById('cast-done-log').textContent = '';
    document.getElementById('cast-done-stop').hidden = true;
    showCastPane('done');
    logCircuitRun(r);
  }

  async function logCircuitRun(r) {
    const el = document.getElementById('cast-done-log');
    if (!r.movesDone) return;
    if (!session) { el.textContent = 'Sign in to keep a log of your runs.'; return; }
    const { error } = await sb.from('circuit_logs').insert({
      user_id: session.user.id, circuit_id: r.c.id, moves: r.movesDone, looped: r.loop, speed: r.interval });
    if (circuitRun !== r) return;
    if (error) { el.textContent = 'Couldn’t save this run to your log.'; console.warn('circuit log failed', error); }
    else el.textContent = 'Saved to your log.';
  }

  function castCircuitAgain() {
    if (circuitRunGoing()) return;
    circuitRun = null;
    document.getElementById('cast-sheet-error').textContent = '';
    showCastPane('setup');
    syncCastOptions();
  }

  // The screen stays on while a run is going (the climber's phone is on the mat).
  async function acquireCircuitWake() {
    if (circuitWake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      circuitWake = await navigator.wakeLock.request('screen');
      circuitWake.addEventListener('release', () => { circuitWake = null; });
    } catch (e) { /* refused or unsupported: the run carries on */ }
  }
  function releaseCircuitWake() {
    if (circuitWake) { try { circuitWake.release(); } catch (e) {} circuitWake = null; }
  }
  // Back from the lock screen: catch the counter up, and take the wake lock again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && circuitRun && !circuitRun.ended) {
      acquireCircuitWake();
      tickCircuitRun();
    }
  });

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

    // .select() so a delete RLS quietly filtered out (no error, zero rows) isn't
    // reported as a success.
    const { data, error } = await sb.from('circuits').delete().eq('id', c.id).select('id');
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to delete this circuit.'
        : error.code === '23503'
          ? 'A challenge uses this circuit, so it can’t be deleted.'
          : error.message;
      return;
    }
    if (!data || !data.length) {
      errEl.textContent = 'Couldn’t delete it — you may no longer have permission, or it’s already gone.';
      return;
    }

    // Where to land, as for problems: back along the swipe trail, else the
    // circuit before it in the deck (or after, if it was the first), else the list.
    const deck = visibleCircuits();
    const deckIdx = deck.findIndex(x => String(x.id) === String(c.id));
    allCircuits = allCircuits.filter(x => String(x.id) !== String(c.id));
    myCircuitFaves.delete(String(c.id));
    closeCircuitDelete();
    renderCircuits();
    showToast('Circuit deleted', 'success');

    let backTo = '';
    while (circuitTrail.length && !backTo) {
      const id = circuitTrail.pop();
      if (allCircuits.some(x => String(x.id) === String(id))) backTo = id;
    }
    if (!backTo && deckIdx !== -1) {
      const neighbour = deckIdx > 0 ? deck[deckIdx - 1] : deck[deckIdx + 1];
      if (neighbour) backTo = neighbour.id;
    }
    // replaceRoute: no Back entry that returns to the circuit that's gone.
    replaceRoute(backTo ? '#circuit/' + encodeURIComponent(backTo) : '#circuits');
  }

  // ── Create a circuit ─────────────────────────────────────────────────────────────
  // Tap holds in climbing order (repeats allowed); each tap appends to ccSeq. Holds
  // are drawn like the problem create board (filled outlines, no dim) and tagged
  // with their move numbers. Start = first ccStartCount, finish = last.
  function applyCircuitCreate() {
    const layer = document.getElementById('cc-hold-layer');
    if (layer) {
      const { roles, labels } = circuitHoldRoles(ccSeq, ccStartCount);
      layer.innerHTML = circuitLayerHtml(roles, labels, { dim: false });
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
    const { x: px, y: py, w, h: bh } = boardPct(document.getElementById('cc-board'), clientX, clientY);
    let best = null, bestD = Infinity;
    for (const h in HOLD_MAP) {
      const dx = (HOLD_MAP[h].x - px) / 100 * w;
      const dy = (HOLD_MAP[h].y - py) / 100 * bh;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = h; }
    }
    return Math.sqrt(bestD) <= w * 0.06 ? best : null;
  }

  function buildCcGrades() {
    document.getElementById('cc-grades').innerHTML =
      gradeTabButtons(SPORT_GRADE_ORDER, g => g === ccGrade);
    updateCcMoveGrade();
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

  // Create and Edit share the circuit create screen (#circuit-create, and
  // #circuit-create/<id> for Edit: the sequence, start count, loop, name and grade,
  // never the setter; db/39).
  // Move to Circuits (#move/<problem id>, admins) uses the same screen too.
  function setCircuitCreateMode(editing, moving) {
    document.getElementById('cc-title').textContent =
      moving ? 'Move to Circuits' : editing ? 'Edit circuit' : 'Create circuit';
    document.getElementById('cc-save').setAttribute('aria-label',
      moving ? 'Move to Circuits' : editing ? 'Save changes' : 'Save circuit');
    document.getElementById('cc-reset').setAttribute('aria-label',
      editing || moving ? 'Undo all changes' : 'Clear all holds');
    document.getElementById('cc-move-note').hidden = !moving;
    const feet = moving ? feetRule(moving) : 'any';
    document.getElementById('cc-move-feet').hidden = feet === 'any';
    document.getElementById('cc-move-feet-rule').textContent = feetLabel(feet);
    updateCcMoveGrade();
  }

  function resetCircuitCreate() {
    ccSeq = []; ccStartCount = 2; ccLoop = false; ccGrade = '';
    ccEditingId = null; ccEditBase = ''; ccMoveId = null;
    const nameEl = document.getElementById('cc-name'); if (nameEl) nameEl.value = '';
    document.getElementById('cc-error').textContent = '';
    setCircuitCreateMode(null);
    buildCcGrades(); buildCcStartCount(); buildCcLoop();
    applyCircuitCreate();
  }

  // What a circuit Edit has on screen, as one string: equal = nothing changed.
  function circuitEditKey() {
    const nameEl = document.getElementById('cc-name');
    return JSON.stringify([((nameEl && nameEl.value) || '').trim(), ccGrade, ccStartCount, ccLoop, ccSeq]);
  }
  const circuitEditDirty = () => !!(ccEditingId || ccMoveId) && circuitEditKey() !== ccEditBase;

  // Fill the screen from a circuit (Edit), stored in natural order (not inverted).
  function seedCircuitEdit(c) {
    ccEditingId = String(c.id);
    ccMoveId = null;
    ccSeq = circuitSeq(c).slice();
    ccStartCount = c.start_count === 1 ? 1 : 2;
    ccLoop = !!c.loops;
    ccGrade = c.grade || '';
    document.getElementById('cc-name').value = c.name || '';
    document.getElementById('cc-error').textContent = '';
    setCircuitCreateMode(c);
    ccEditBase = circuitEditKey();
  }

  // ── Move a problem into Circuits (admins only, db/40) ──────────────────────────
  // The problem's holds in problemHoldOrder() order (starts, then intermediates,
  // then the finish), on the unmirrored side (there are no mirrored circuits). A
  // lone start is stored twice, so it becomes one start. The feet signs are never
  // holds. The middle holds are in the order they were first tapped when the
  // problem was set, not necessarily climbing order: the screen asks the admin to
  // check before saving.
  function problemAsCircuit(p) {
    const order = problemHoldOrder(p).filter(h => !FEET_LIGHT_HOLDS.has(h));
    if (order.length < 2) return { seq: order, startCount: 1 };
    const one = order[0] === order[1];
    return { seq: one ? order.slice(1) : order, startCount: one ? 1 : 2 };
  }
  const movingProblem = () => ccMoveId ? allProblems.find(x => String(x.id) === String(ccMoveId)) : null;

  // The problem's Font grade beside the picked sport grade, to sanity-check the
  // conversion (FONT_TO_SPORT in state.js).
  function updateCcMoveGrade() {
    const el = document.getElementById('cc-move-grade');
    if (!el) return;
    const p = movingProblem();
    el.hidden = !p;
    if (!p) return;
    const guess = FONT_TO_SPORT[p.grade];
    const was = isGraded(p) ? `<b>${escHtml(fontGrade(p.grade))}</b> (Font)` : `<b>${escHtml(p.grade || 'no grade')}</b>, no sport guess`;
    el.innerHTML = `As a problem: ${was}. ` + (
      !ccGrade ? 'Pick a sport grade below.'
      : ccGrade === guess ? `Picked <b>${escHtml(ccGrade)}</b> (sport), a best guess: check it.`
      : `Picked <b>${escHtml(ccGrade)}</b> (sport).`);
  }

  function seedCircuitMove(p) {
    ccEditingId = null;
    ccMoveId = String(p.id);
    const { seq, startCount } = problemAsCircuit(p);
    ccSeq = seq;
    ccStartCount = startCount;
    ccLoop = false;                               // the circuit defaults
    ccGrade = FONT_TO_SPORT[p.grade] || '';       // "Project" or unknown: the admin picks
    document.getElementById('cc-name').value = p.name || '';
    document.getElementById('cc-error').textContent = '';
    setCircuitCreateMode(null, p);
    ccEditBase = circuitEditKey();
  }

  // #move/<problem id>: seed as we land on it; the router running again while it's
  // open keeps the changes (as Edit does).
  function initCircuitMove(pid) {
    const same = String(ccMoveId) === String(pid);
    if (!same || (currentView !== 'circuit-create' && !circuitEditDirty())) {
      const p = allProblems.find(x => String(x.id) === String(pid));
      if (!p) { redirectRoute('#detail/' + encodeURIComponent(pid)); return; }
      seedCircuitMove(p);
    }
    buildCcGrades(); buildCcStartCount(); buildCcLoop();
    applyCircuitCreate();
  }

  // The confirm sheet, with the counts the move will delete (an admin-only RPC:
  // ticks and favourites are private to each climber).
  async function openMoveConfirm(p) {
    const errEl = document.getElementById('cc-error');
    const btn = document.getElementById('cc-save');
    btn.disabled = true; btn.classList.add('casting');
    const { data, error } = await sb.rpc('admin_problem_move_counts', { pid: p.id });
    btn.disabled = false; btn.classList.remove('casting');
    if (error) {
      if (error.code === '42501') { errEl.textContent = 'Only admins can move problems: you may no longer be one.'; recheckAdmin(); }
      else errEl.textContent = 'Couldn’t check its ticks and favourites — try again.';
      return;
    }
    if (currentView !== 'circuit-create' || String(ccMoveId) !== String(p.id)) return;
    const row = (data && data[0]) || { ticks: 0, favourites: 0 };
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    document.getElementById('move-text').innerHTML =
      `This deletes the problem <b>${escHtml(displayName(p))}</b> and its ` +
      `${plural(row.ticks, 'tick')} and ${plural(row.favourites, 'favourite')}. This can’t be undone.`;
    document.getElementById('move-error').textContent = '';
    document.getElementById('move-modal').classList.add('show');
  }
  function closeMoveConfirm() { document.getElementById('move-modal').classList.remove('show'); }

  // The move, in one transaction (db/40): the circuit is created with the
  // problem's setter, then its ticks, favourites and the problem are deleted.
  async function doMoveToCircuits() {
    const p = movingProblem();
    const errEl = document.getElementById('move-error');
    if (!p) { errEl.textContent = 'Couldn’t find that problem — it may have been deleted.'; return; }
    const name = document.getElementById('cc-name').value.trim();
    const btn = document.getElementById('move-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Moving…';
    const { data: cid, error } = await sb.rpc('admin_move_problem_to_circuit', {
      pid: p.id, p_name: name, p_grade: ccGrade, p_sequence: ccSeq.slice(),
      p_start_count: ccStartCount, p_loops: ccLoop
    });
    btn.disabled = false; btn.textContent = prev;
    if (error || !cid) {
      const m = (error && error.message) || '';
      if (error && error.code === '23505') {
        closeMoveConfirm();
        document.getElementById('cc-error').textContent = 'A circuit already has that name — rename it, then save.';
        document.getElementById('cc-name').focus();
        return;
      }
      errEl.textContent =
        error && error.code === '42501' ? 'Only admins can move problems: you may no longer be one.'
        : m === 'benchmark' ? 'It’s a benchmark now: remove the benchmark first.'
        : m === 'not_found' ? 'That problem has already gone.'
        : error && error.code === '23514' ? 'The circuit isn’t valid (grade or holds): check them and try again.'
        : 'Couldn’t move it: ' + (m || 'try again.');
      if (error && error.code === '42501') recheckAdmin();
      return;
    }

    // Read the new circuit back as the list loads it; build it here if that fails.
    let c = null;
    const got = await sb.from('circuits').select('*').eq('id', cid).maybeSingle();
    if (!got.error && got.data) c = got.data;
    if (!c) c = { id: cid, name, grade: ccGrade, setter_id: p.setter_id, setter: p.setter || '', comment: '',
                  hold_sequence: ccSeq.slice(), start_count: ccStartCount, loops: ccLoop,
                  created_at: new Date().toISOString(), led_track: null };

    const id = String(p.id);
    allProblems = allProblems.filter(x => String(x.id) !== id);
    myTicks.delete(id); myTicksNormal.delete(id); myTicksMirrored.delete(id); myFaves.delete(id);
    allCircuits.push(c);
    saveList('problems', allProblems);
    saveList('circuits', allCircuits);
    leaderboardLoaded = false;
    closeMoveConfirm();
    resetCircuitCreate();
    renderList();
    renderCircuits();
    showToast('Moved to Circuits ✓', 'success');
    redirectRoute('#circuit/' + encodeURIComponent(c.id));
  }

  // On entry: with an editId, seed from that circuit as we land on it (the router
  // running again while it's open keeps the changes); without, a create, which
  // keeps what was set before as it always has, unless that was an Edit.
  function initCircuitCreate(editId) {
    if (editId) {
      const same = String(ccEditingId) === String(editId);
      if (!same || (currentView !== 'circuit-create' && !circuitEditDirty())) {
        const c = allCircuits.find(x => String(x.id) === String(editId));
        if (!c) {   // not loaded yet (deep link / refresh): its detail loads it
          redirectRoute('#circuit/' + encodeURIComponent(editId));
          return;
        }
        seedCircuitEdit(c);
        // An owner: check (fresh) that nobody else has logged a run since.
        if (!isAdmin() && session) {
          askOthersUsed('c', c.id, used => {
            if (used !== true || currentView !== 'circuit-create' || String(ccEditingId) !== String(c.id)) return;
            showToast('Someone else has climbed this, so only an admin can edit it now', 'error');
            resetCircuitCreate();
            redirectRoute('#circuit/' + encodeURIComponent(c.id));
          });
        }
      }
    } else if (ccEditingId || ccMoveId) {
      resetCircuitCreate();
    }
    buildCcGrades(); buildCcStartCount(); buildCcLoop();
    applyCircuitCreate();
  }

  // The header bin: clears everything in Create; in Edit it puts the circuit back
  // as saved (there's no undo for the whole circuit, so it never wipes the name).
  function onCircuitCreateReset() {
    const p = movingProblem();
    if (p) {   // Move: back to the problem as converted
      seedCircuitMove(p);
      buildCcGrades(); buildCcStartCount(); buildCcLoop();
      applyCircuitCreate();
      return;
    }
    if (ccEditingId) {
      const c = allCircuits.find(x => String(x.id) === String(ccEditingId));
      if (c) {
        seedCircuitEdit(c);
        buildCcGrades(); buildCcStartCount(); buildCcLoop();
        applyCircuitCreate();
      }
      return;
    }
    resetCircuitCreate();
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

    // Names must be unique (a circuit is cast by name, like a problem), ignoring
    // case, leaving out the circuit being edited.
    const editing = ccEditingId ? allCircuits.find(c => String(c.id) === String(ccEditingId)) : null;
    if (ccEditingId && !editing) { errEl.textContent = 'Couldn’t find that circuit — go back and reopen it.'; return; }
    const lname = name.toLowerCase();
    if (allCircuits.some(c => c !== editing && circuitName(c).toLowerCase() === lname)) {
      errEl.textContent = ccMoveId ? 'A circuit already has that name — rename it, then save.' : 'That name is taken — pick another.';
      return;
    }

    // Move to Circuits (admins): confirm, then one RPC does the lot (db/40).
    if (ccMoveId) {
      const p = movingProblem();
      if (!p) { errEl.textContent = 'Couldn’t find that problem — it may have been deleted.'; return; }
      if (!isAdmin()) { errEl.textContent = 'Only admins can move problems.'; return; }
      if (p.is_benchmark) { errEl.textContent = 'It’s a benchmark: remove the benchmark first.'; return; }
      openMoveConfirm(p);
      return;
    }

    const btn = document.getElementById('cc-save');

    if (editing) {
      // One Edit: the sequence, start count, loop, name and grade (never the
      // setter). Admins may edit any circuit; the owner theirs while no challenge
      // uses it and nobody else has logged a run (RLS, db/39; its guard refuses
      // any other column). A rename changes the cast key: the Pi reads the circuit
      // by name when cast_circuit / show_circuit arrives, so the next cast uses it.
      const update = { name, grade: ccGrade, hold_sequence: ccSeq.slice(), start_count: ccStartCount, loops: ccLoop };
      btn.disabled = true; btn.classList.add('casting');
      const { data, error } = await sb.from('circuits').update(update).eq('id', editing.id).select('id');
      btn.disabled = false; btn.classList.remove('casting');
      if (error) {
        errEl.textContent =
          error.code === '23505' ? 'That name is taken — pick another.'
          : error.code === '42501' ? 'You don’t have permission to change that.'
          : error.message;
        return;
      }
      if (!data || !data.length) {
        if (isAdmin()) {
          errEl.textContent = 'Couldn’t save: you’re no longer an admin, or the circuit has been deleted.';
          recheckAdmin();
        } else {
          errEl.textContent = 'Couldn’t save: only an admin can edit this now (someone else has climbed it, or a challenge uses it).';
          othersKnown.delete(othersKey('c', editing.id));
        }
        showToast('Couldn’t save the circuit', 'error');
        return;
      }
      Object.assign(editing, update);    // update in place (same object lives in allCircuits)
      saveList('circuits', allCircuits);
      const id = editing.id;
      resetCircuitCreate();
      renderCircuits();
      showToast('Changes saved ✓', 'success');
      redirectRoute('#circuit/' + encodeURIComponent(id));
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

    btn.disabled = true; btn.classList.add('casting');
    const { data, error } = await sb.from('circuits').insert(row).select().single();
    btn.disabled = false; btn.classList.remove('casting');
    if (error) {
      errEl.textContent =
        error.code === '42501' ? 'You don’t have permission to create circuits yet.'
        : error.code === '23505' ? 'That name is taken — pick another.'
        : error.message;
      return;
    }

    allCircuits.push(data);
    renderCircuits();
    resetCircuitCreate();
    showToast('Circuit created ✓', 'success');
    redirectRoute('#circuit/' + encodeURIComponent(data.id));
  }
