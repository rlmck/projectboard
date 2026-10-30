// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, challenge, leaderboard, wall, app. This file: circuits - load, list, detail, swipe, info, Play preview, cast + run screen, create, delete.
//
// Circuits are built to look and behave like problems: the same cards and grade
// tabs (tap = one grade, hold = several), pull-to-refresh, a pinned detail view
// you swipe through, the traced hold outlines over a dimmed board, and the ⋮
// menu's Information sheet. What's circuit-only: move numbers on the holds, the
// Play preview in a panel under the board, and the Cast sheet (a timed run on the wall).

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
  // outlines can't be used (see shapesUsable). `lit` = drawn by the Play preview;
  // `fresh` = the hold it has just lit.
  function circuitLayerHtml(roles, labels, { dim = false, lit = false, fresh = null } = {}) {
    if (!HOLD_MAP) return '';
    const shapes = holdShapeLayerHtml(roles, { dim, fresh });
    if (shapes != null) return shapes + seqTagsHtml(labels, roles);
    return Object.keys(roles).map(h => {
      const pos = HOLD_MAP[h];
      if (!pos) return '';
      return `<div class="hold-dot ${roles[h]}${lit ? ' lit' : ''}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${escHtml(labels[h])}</span></div>`;
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
  function visibleCircuits() {
    let arr = allCircuits;
    if (circuitFavesOnly) arr = arr.filter(c => isCircuitFaved(c.id));
    if (circuitLoopOnly) arr = arr.filter(c => c.loops);
    // circuitExcludeDone: still a no-op. Runs are logged to circuit_logs now, but what counts as "done" isn't decided
    if (activeCircuitGrades.size) arr = arr.filter(c => activeCircuitGrades.has(c.grade));
    const q = searchNorm(circuitSearch);
    if (q) {
      arr = arr.filter(c =>
        searchNorm(circuitName(c)).includes(q) ||
        searchNorm(setterName(c)).includes(q) ||
        searchNorm(c.grade).includes(q)
      );
    }
    return arr.slice().sort((a, b) =>
      sportRank(a.grade) - sportRank(b.grade) || circuitName(a).localeCompare(circuitName(b))
    );
  }

  // Rebuilt on every render (search keystrokes included), so it keeps the
  // strip's horizontal scroll rather than jumping back to "All".
  function buildCircuitGradeTabs() {
    const present = [...new Set(allCircuits.map(c => c.grade).filter(Boolean))]
      .sort((a, b) => sportRank(a) - sportRank(b) || a.localeCompare(b));
    // Drop a filter whose grade no longer exists (its last circuit deleted).
    [...activeCircuitGrades].forEach(g => { if (!present.includes(g)) activeCircuitGrades.delete(g); });
    const el = document.getElementById('circuit-grade-tabs');
    const scroll = el.scrollLeft;
    el.innerHTML = gradeTabButtons(['all', ...present],
      g => g === 'all' ? activeCircuitGrades.size === 0 : activeCircuitGrades.has(g));
    el.scrollLeft = scroll;
  }

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
    buildCircuitGradeTabs();
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
      const otherFilters = circuitSearch || activeCircuitGrades.size || circuitLoopOnly || circuitExcludeDone;
      container.innerHTML = (circuitFavesOnly && !otherFilters)
        ? `<div class="state-msg"><div class="icon">♡</div>No favourite circuits yet. Tap the heart on a circuit to save it here.</div>`
        : allCircuits.length
          ? `<div class="state-msg"><div class="icon">🔎</div>None match these filters.</div>`
          : `<div class="state-msg"><div class="icon">🧗</div>No circuits yet — tap + to set the first one.</div>`;
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(circuitCardHtml).join('')}</div>`;
  }

  // ── Circuit detail ──────────────────────────────────────────────────────────────
  // Laid out like the problem detail: pinned to the screen, title block + board
  // centred, with the Play panel held at the bottom so the board sits in the same
  // place on every circuit you swipe to.
  const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z"/></svg>';
  const CAST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';   // as the problem view's
  const STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  function renderCircuitDetail(id) {
    stopCircuitPlay(false);
    const wrap = document.getElementById('circuit-detail-content');
    const faveBtn = document.getElementById('circuit-detail-fave');
    const delItem = document.getElementById('circuit-menu-delete');
    faveBtn.hidden = true;
    delItem.hidden = true;

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
    delItem.hidden = !canEditCircuit(c);
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
          <div class="hold-layer" id="circuit-play-layer">${circuitStaticOverlay(c)}</div>
          ${boardExpandBtn()}
        </div>
      </div>

      <div id="circuit-challenge-slot"></div>
      <div class="circuit-play-panel">
        <button class="circuit-play-btn" id="circuit-play-btn" type="button" aria-label="Play preview">${PLAY_ICON}</button>
        <div class="circuit-play-body">
          <div class="circuit-play-top">
            <span class="circuit-play-status" id="circuit-play-status">Play preview</span>
            <span class="circuit-speed-val" id="circuit-speed-val"></span>
          </div>
          <div class="circuit-speed-row">
            <span>Slow</span>
            <input class="circuit-speed" id="circuit-speed" type="range" min="${PLAY_MIN_MS}" max="${PLAY_MAX_MS}" step="100" aria-label="Preview speed" />
            <span>Fast</span>
          </div>
        </div>
      </div>`;

    document.getElementById('circuit-play-btn').addEventListener('click', toggleCircuitPlay);
    document.getElementById('circuit-cast-open').addEventListener('click', openCircuitCast);
    const speed = document.getElementById('circuit-speed');
    speed.value = speedToSlider(playIntervalMs);
    speed.addEventListener('input', () => setPlaySpeed(sliderToSpeed(+speed.value)));
    updateSpeedLabel();
    fillCircuitChallenge(c);   // the challenge link, if a challenge uses this circuit (challenge.js)
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
        <div class="info-value">Lights the circuit on the wall at your speed: a 5-second countdown on the start holds, then one move at a time. Solid blue is the hold to go to, amber the one after, and the hold you've just let go of fades out in red. ${
          c.loops ? 'It loops until you press Stop.' : 'At the top the route runs up in green.'} Signed in, each run is saved to your log.</div>
      </div>
      <div class="info-row">
        <div class="info-label">Play preview</div>
        <div class="info-value">Lights four holds at a time and moves up the route one hold per step${c.loops ? ', looping until you stop it' : ''}. Set how long each step lasts with the speed slider.</div>
      </div>
    `;
    document.getElementById('info-modal').classList.add('show');
  }

  // ── Play engine (moving 4-hold window) ──────────────────────────────────────────
  // The phone's preview only: a cast's look is the Pi's (pi/listener/circuit.py). The lit window is the
  // up-to-4 most-recent holds ending at the current tick; wrapping for loops. Speed
  // is a live preview control (0.1s steps), not stored per circuit — the agreed
  // design sets speed at cast time, so this is the same kind of knob. The slider
  // runs Slow → Fast, so its value is the step time flipped end to end.
  const PLAY_WINDOW = 4;
  const PLAY_MIN_MS = 200, PLAY_MAX_MS = 3000;
  let playIntervalMs = 1000;   // default 1.0s between holds
  let playTimer = null;
  let playDraw = null;         // the running draw fn (so a speed change can restart the timer)
  const speedToSlider = ms => PLAY_MIN_MS + PLAY_MAX_MS - ms;
  const sliderToSpeed = v => PLAY_MIN_MS + PLAY_MAX_MS - v;

  function updateSpeedLabel() {
    const el = document.getElementById('circuit-speed-val');
    if (el) el.textContent = (playIntervalMs / 1000).toFixed(1) + ' s per move';
  }

  function setPlayStatus(text) {
    const el = document.getElementById('circuit-play-status');
    if (el) el.textContent = text;
  }

  // Adjust preview speed; if a play is in progress, restart the timer at the new
  // interval (keeps the current position via the live draw closure).
  function setPlaySpeed(ms) {
    playIntervalMs = Math.max(PLAY_MIN_MS, Math.min(PLAY_MAX_MS, Math.round(ms / 100) * 100));
    updateSpeedLabel();
    if (playTimer && playDraw) { clearInterval(playTimer); playTimer = setInterval(playDraw, playIntervalMs); }
  }

  function setPlayButton(playing) {
    const btn = document.getElementById('circuit-play-btn');
    if (!btn) return;
    btn.innerHTML = playing ? STOP_ICON : PLAY_ICON;
    btn.classList.toggle('playing', playing);
    btn.setAttribute('aria-label', playing ? 'Stop preview' : 'Play preview');
  }

  function stopCircuitPlay(restore) {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    playDraw = null;
    setPlayButton(false);
    setPlayStatus('Play preview');
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
    setPlayButton(true);
    let tick = 0;
    const L = seq.length;
    const loop = !!c.loops;
    const draw = () => {
      // Window = the up-to-4 most-recent holds ending at `tick`. Each slot carries
      // its wrapped position `p` and the colour to light it.
      const roles = {}, labels = {};
      let fresh = null;
      for (let d = PLAY_WINDOW - 1; d >= 0; d--) {
        const i = tick - d;
        if (i < 0) continue;
        let p, role;
        if (loop) {
          p = ((i % L) + L) % L;
          // A looping route has no real finish, so the finish hold reads blue; the
          // start holds only glow green on the first lap (i < L), blue thereafter.
          role = (p < c.start_count && i < L) ? 'start' : 'int';
        } else {
          if (i >= L) continue;
          p = i;
          role = circuitRole(seq, c.start_count, i);
        }
        const h = seq[p];
        roles[h] = strongerRole(roles[h], role);
        labels[h] = labels[h] ? labels[h] + '/' + (p + 1) : String(p + 1);
        if (d === 0) fresh = h;
      }
      const layer = document.getElementById('circuit-play-layer');
      if (layer) layer.innerHTML = circuitLayerHtml(roles, labels, { dim: true, lit: true, fresh });
      const move = loop ? tick % L + 1 : Math.min(tick + 1, L);
      const lap = loop ? Math.floor(tick / L) + 1 : 1;
      setPlayStatus(`Move ${move} of ${L}${lap > 1 ? ` · lap ${lap}` : ''}`);
      tick++;
      // Non-loop: stop once the window has slid off the end (route finished).
      if (!loop && tick > L - 1 + (PLAY_WINDOW - 1)) {
        clearInterval(playTimer); playTimer = null; playDraw = null;
        setTimeout(() => { if (!playTimer) stopCircuitPlay(true); }, 400);
      }
    };
    playDraw = draw;
    draw();
    playTimer = setInterval(draw, playIntervalMs);
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

  function openCircuitCast() {
    const c = currentCircuit;
    if (!c) return;
    if (circuitRun && !circuitRun.ended) { document.getElementById('circuit-cast-modal').classList.add('show'); return; }
    stopCircuitPlay(true);
    castSheetCircuit = c;
    castLoop = !!c.loops;
    document.getElementById('cast-sheet-title').textContent = circuitName(c);
    document.getElementById('cast-sheet-error').textContent = '';
    showCastPane('setup');
    syncCastOptions();
    document.getElementById('circuit-cast-modal').classList.add('show');
  }

  // Closes only from its buttons while nothing is running (a stray tap mustn't
  // hide the Stop button of a run that's lighting the board).
  function closeCircuitCast() {
    if (circuitRun && !circuitRun.ended) return;
    document.getElementById('circuit-cast-modal').classList.remove('show');
    circuitRun = null;
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
    if (castSheetCircuit !== c || !modal.classList.contains('show')) { done(); return; }
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
    const seq = circuitSeq(c), L = seq.length, s = Math.max(1, Math.min(c.start_count || 1, 2, L));
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
    if (circuitRun && !circuitRun.ended) return;
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
