// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: circuits - load, list, detail, Play preview, create, delete.

  // A sequence position's role: finish (last) wins over start (first N), else move.
  function circuitRole(seq, startCount, pos) {
    if (pos === seq.length - 1) return 'finish';
    if (pos < startCount) return 'start';
    return 'int';
  }

  async function loadCircuits() {
    const { data, error } = await sb.from('circuits').select('*');
    if (error) {
      circuitsError = error;
      console.warn('circuits load failed', error);
      if (currentView === 'circuits') renderCircuits();
      else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
      return;
    }
    allCircuits = data || [];
    circuitsLoaded = true;
    circuitsError = null;
    if (currentView === 'circuits') renderCircuits();
    else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
  }

  // ── Circuit list ───────────────────────────────────────────────────────────────
  function visibleCircuits() {
    let arr = allCircuits;
    if (circuitFavesOnly) arr = arr.filter(c => isCircuitFaved(c.id));
    if (circuitLoopOnly) arr = arr.filter(c => c.loops);
    // circuitExcludeDone: no-op until Phase 2 completion logging exists
    if (activeCircuitGrade) arr = arr.filter(c => c.grade === activeCircuitGrade);
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

  function buildCircuitGradeTabs() {
    const present = [...new Set(allCircuits.map(c => c.grade).filter(Boolean))]
      .sort((a, b) => sportRank(a) - sportRank(b) || a.localeCompare(b));
    if (activeCircuitGrade && !present.includes(activeCircuitGrade)) activeCircuitGrade = '';
    document.getElementById('circuit-grade-tabs').innerHTML =
      gradeTabButtons(['all', ...present], g => g === 'all' ? !activeCircuitGrade : g === activeCircuitGrade);
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
        container.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>${
          circuitsTableMissing(circuitsError)
            ? 'Circuits aren’t set up yet — run <b>db/14</b> in the Supabase SQL editor.'
            : 'Failed to load circuits.'}</div>`;
      }
      return;
    }
    const list = visibleCircuits();
    countEl.textContent = `${list.length} circuit${list.length !== 1 ? 's' : ''}`;
    if (!list.length) {
      // Show the favourites onboarding hint only when faves is the *only* active
      // filter; otherwise keep it generic (the other filters may be the cause).
      const otherFilters = circuitSearch || activeCircuitGrade || circuitLoopOnly || circuitExcludeDone;
      container.innerHTML = (circuitFavesOnly && !otherFilters)
        ? `<div class="state-msg"><div class="icon">♡</div>No favourite circuits yet. Tap the heart on a circuit to save it here.</div>`
        : `<div class="state-msg"><div class="icon">🧗</div>${
            allCircuits.length ? 'None match these filters.' : 'No circuits yet — tap + to set the first one.'}</div>`;
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(circuitCardHtml).join('')}</div>`;
  }

  // ── Circuit detail (+ in-app Play preview) ──────────────────────────────────────
  // Static overlay: one dot per UNIQUE hold, coloured by role, badged with its move
  // number(s). The Play engine animates a 4-hold moving window over the sequence.
  function circuitStaticOverlay(c) {
    const seq = circuitSeq(c);
    if (!HOLD_MAP || !seq.length) return '';
    const byHold = {};   // hold -> { positions:[], role }
    seq.forEach((h, pos) => {
      if (!byHold[h]) byHold[h] = { positions: [], role: 'int' };
      byHold[h].positions.push(pos);
      const r = circuitRole(seq, c.start_count, pos);
      // finish > start > int when a hold takes several roles across repeats.
      if (r === 'finish' || (r === 'start' && byHold[h].role !== 'finish')) byHold[h].role = r;
    });
    return Object.keys(byHold).map(h => {
      const pos = HOLD_MAP[h];
      if (!pos) return '';
      const o = byHold[h];
      const label = o.positions.map(p => p + 1).join('/');
      return `<div class="hold-dot ${o.role}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${label}</span></div>`;
    }).join('');
  }

  function renderCircuitDetail(id) {
    stopCircuitPlay(false);
    const wrap = document.getElementById('circuit-detail-content');
    const titleEl = document.getElementById('circuit-detail-title');
    const menuWrap = document.getElementById('circuit-menu-wrap');
    const faveBtn = document.getElementById('circuit-detail-fave');
    menuWrap.hidden = true;
    if (faveBtn) faveBtn.hidden = true;

    if (!circuitsLoaded) {
      currentCircuit = null;
      if (circuitsError) {
        wrap.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>${
          circuitsTableMissing(circuitsError)
            ? 'Circuits aren’t set up yet — run <b>db/14</b> in Supabase.'
            : 'Couldn’t load circuits.'}<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      } else {
        wrap.innerHTML = `<div class="spinner"></div>`;
      }
      return;
    }

    const c = allCircuits.find(x => String(x.id) === String(id));
    if (!c) {
      currentCircuit = null;
      titleEl.textContent = 'Circuit';
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That circuit couldn't be found.<br><a class="link" href="#circuits">Back to circuits</a></div>`;
      return;
    }

    currentCircuit = c;
    titleEl.textContent = circuitName(c);
    menuWrap.hidden = !canEditCircuit(c);
    if (faveBtn) faveBtn.hidden = false;
    updateCircuitFaveButton();
    const n = circuitSeq(c).length;
    const comment = String(c.comment || '').trim();

    wrap.innerHTML = `
      <div class="detail-head-info">
        <h1 class="detail-name">${escHtml(circuitName(c))}</h1>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(c.grade || '—')}</span>
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

      <div class="circuit-play-panel">
        <button class="btn-block btn-primary" id="circuit-play-btn">▶ Play preview</button>
        <div class="circuit-speed">
          <span class="circuit-speed-label">Speed</span>
          <button class="circuit-speed-btn" id="circuit-speed-down" aria-label="Faster">−</button>
          <span class="circuit-speed-val" id="circuit-speed-val"></span>
          <button class="circuit-speed-btn" id="circuit-speed-up" aria-label="Slower">+</button>
        </div>
        ${comment ? `<p class="detail-comment" style="margin-top:14px">${escHtml(comment)}</p>` : ''}
        <p class="cc-hint">Preview runs a 4-hold moving window up the route${c.loops ? ', looping until you stop it' : ''}. Real casting to the board comes next.</p>
      </div>`;

    document.getElementById('circuit-play-btn').addEventListener('click', toggleCircuitPlay);
    document.getElementById('circuit-speed-down').addEventListener('click', () => setPlaySpeed(playIntervalMs - 100));
    document.getElementById('circuit-speed-up').addEventListener('click', () => setPlaySpeed(playIntervalMs + 100));
    updateSpeedLabel();
  }

  // ── Play engine (moving 4-hold window) ──────────────────────────────────────────
  // Same logic will drive the Phase-2 cast-screen move timing. The lit window is the
  // up-to-4 most-recent holds ending at the current tick; wrapping for loops. Speed
  // is a live preview control (0.1s steps), not stored per circuit — the agreed
  // design sets speed at cast time, so this is the same kind of knob.
  const PLAY_WINDOW = 4;
  const PLAY_MIN_MS = 200, PLAY_MAX_MS = 3000;
  let playIntervalMs = 1000;   // default 1.0s between holds
  let playTimer = null;
  let playDraw = null;         // the running draw fn (so a speed change can restart the timer)

  function updateSpeedLabel() {
    const el = document.getElementById('circuit-speed-val');
    if (el) el.textContent = (playIntervalMs / 1000).toFixed(1) + 's';
  }

  // Adjust preview speed; if a play is in progress, restart the timer at the new
  // interval (keeps the current position via the live draw closure).
  function setPlaySpeed(ms) {
    playIntervalMs = Math.max(PLAY_MIN_MS, Math.min(PLAY_MAX_MS, ms));
    updateSpeedLabel();
    if (playTimer && playDraw) { clearInterval(playTimer); playTimer = setInterval(playDraw, playIntervalMs); }
  }

  function stopCircuitPlay(restore) {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    playDraw = null;
    const btn = document.getElementById('circuit-play-btn');
    if (btn) btn.innerHTML = '▶ Play preview';
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
    const btn = document.getElementById('circuit-play-btn');
    if (btn) btn.innerHTML = '■ Stop';
    let tick = 0;
    const L = seq.length;
    const loop = !!c.loops;
    const draw = () => {
      // Window = the up-to-4 most-recent holds ending at `tick`. Each slot carries
      // its wrapped position `p` and the colour to light it.
      const slots = [];
      for (let d = PLAY_WINDOW - 1; d >= 0; d--) {
        const i = tick - d;
        if (i < 0) continue;
        if (loop) {
          const p = ((i % L) + L) % L;
          // A looping route has no real finish, so the finish hold reads blue; the
          // start holds only glow green on the first lap (i < L), blue thereafter.
          const role = (p < c.start_count && i < L) ? 'start' : 'int';
          slots.push({ p, role });
        } else {
          if (i >= L) continue;
          slots.push({ p: i, role: circuitRole(seq, c.start_count, i) });
        }
      }
      const layer = document.getElementById('circuit-play-layer');
      if (layer) {
        layer.innerHTML = slots.map(s => {
          const pos = HOLD_MAP[seq[s.p]];
          if (!pos) return '';
          return `<div class="hold-dot ${s.role} lit" style="left:${pos.x}%;top:${pos.y}%"></div>`;
        }).join('');
      }
      tick++;
      // Non-loop: stop once the window has slid off the end (route finished).
      if (!loop && tick > L - 1 + (PLAY_WINDOW - 1)) {
        clearInterval(playTimer); playTimer = null; playDraw = null;
        setTimeout(() => stopCircuitPlay(true), 400);
      }
    };
    playDraw = draw;
    draw();
    playTimer = setInterval(draw, playIntervalMs);
  }

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

    const { error } = await sb.from('circuits').delete().eq('id', c.id);
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to delete this circuit.'
        : error.message;
      return;
    }
    allCircuits = allCircuits.filter(x => String(x.id) !== String(c.id));
    myCircuitFaves.delete(String(c.id));
    closeCircuitDelete();
    showToast('Circuit deleted', 'success');
    location.hash = '#circuits';
  }

  // ── Create a circuit ─────────────────────────────────────────────────────────────
  // Tap holds in climbing order (repeats allowed); each tap appends to ccSeq. Dots
  // are numbered with their move order. Start = first ccStartCount, finish = last.
  function applyCircuitCreate() {
    const layer = document.getElementById('cc-hold-layer');
    if (layer) {
      // One dot per unique hold; badge lists its move number(s).
      const byHold = {};
      ccSeq.forEach((h, pos) => {
        if (!byHold[h]) byHold[h] = { positions: [], role: 'int' };
        byHold[h].positions.push(pos);
        const r = circuitRole(ccSeq, ccStartCount, pos);
        if (r === 'finish' || (r === 'start' && byHold[h].role !== 'finish')) byHold[h].role = r;
      });
      layer.innerHTML = Object.keys(byHold).map(h => {
        const pos = HOLD_MAP && HOLD_MAP[h];
        if (!pos) return '';
        const o = byHold[h];
        return `<div class="hold-dot ${o.role}" style="left:${pos.x}%;top:${pos.y}%"><span class="seq-num">${o.positions.map(p => p + 1).join('/')}</span></div>`;
      }).join('');
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
        circuitsTableMissing(error) ? 'Circuits aren’t set up yet — run db/14 in Supabase.'
        : error.code === '42501' ? 'You don’t have permission to create circuits yet.'
        : error.code === '23505' ? 'That name is taken — pick another.'
        : error.message;
      return;
    }

    allCircuits.push(data);
    renderCircuits();
    resetCircuitCreate();
    showToast('Circuit created ✓', 'success');
    location.replace('#circuit/' + encodeURIComponent(data.id));
  }

