// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, app. This file: create-a-problem and recalibrate-board (calibrate) tools.

  // ── Create a problem ──────────────────────────────────────────────────────────
  // Holds keep their physical role in createRoles; the board shows every hold as a
  // faint dot (reference) and colours the assigned ones. On save we build the
  // canonical display order and store it INVERTED so the existing renderer
  // (problemHoldOrder) un-inverts it back to the right colours — see CLAUDE.md.

  const holdsWithRole = role => Object.keys(createRoles).filter(h => createRoles[h] === role);

  // The finish zone is the TOP 25% of the board by height. Any hold sitting in that
  // band is finish-eligible — or may instead be an intermediate (e.g. a traverse
  // along the top) — and no start holds are allowed up there. Holds below the band
  // are start/intermediate only. The threshold is derived from the live hold map's
  // y span (so it tracks whatever board image board_config serves) rather than a
  // fixed hold count — hold numbering doesn't map to visual rows on this hand-set
  // board. Computed fresh per call (cheap, and immune to the map being swapped for
  // the live board_config one after first use).
  function topZoneThreshold() {
    if (!HOLD_MAP) return -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    for (const h in HOLD_MAP) {
      const y = HOLD_MAP[h].y;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    return ymin + (ymax - ymin) * 0.25;
  }
  function inTopZone(h) {
    return !!(HOLD_MAP && HOLD_MAP[h]) && HOLD_MAP[h].y <= topZoneThreshold();
  }

  // Draw a coloured dot for each assigned hold (only assigned ones — no faint
  // reference dots) and refresh the running count summary.
  function applyCreateRoles() {
    const layer = document.getElementById('create-hold-layer');
    if (layer) {
      // Shaped outlines (no dim — the board must stay fully visible/tappable while
      // building a route); falls back to circles when shapes aren't usable.
      const svg = holdShapeLayerHtml(createRoles, { mirror: false, dim: false });
      layer.innerHTML = (svg != null) ? svg : Object.keys(createRoles).map(h => {
        const pos = HOLD_MAP && HOLD_MAP[h];
        if (!pos) return '';
        return `<div class="hold-dot ${createRoles[h]}" style="left:${pos.x}%;top:${pos.y}%"></div>`;
      }).join('');
    }
    const s = holdsWithRole('start').length, i = holdsWithRole('int').length, f = holdsWithRole('finish').length;
    const counts = document.getElementById('create-counts');
    if (counts) {
      counts.innerHTML =
        `<span class="c-start">${s} start</span>` +
        `<span class="c-int">${i} hold${i === 1 ? '' : 's'}</span>` +
        `<span class="c-finish">${f} finish</span>`;
    }
  }

  // Nearest hold to a tap (in pixel space, since x/y are % of different axes).
  // Returns null if the tap is too far from any hold to count.
  function nearestHold(clientX, clientY) {
    if (!HOLD_MAP) return null;
    const { x: px, y: py, w, h: bh } = boardPct(document.getElementById('create-board'), clientX, clientY);
    let best = null, bestD = Infinity;
    for (const h in HOLD_MAP) {
      const dx = (HOLD_MAP[h].x - px) / 100 * w;
      const dy = (HOLD_MAP[h].y - py) / 100 * bh;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = h; }
    }
    return Math.sqrt(bestD) <= w * 0.06 ? best : null;   // ~half a hold spacing
  }

  // Tap to cycle a hold's role:
  //   • top-zone hold (top 25% of the board), no finish set yet → hold (blue) →
  //     finish (red) → off. Once a finish exists, the other top holds cycle
  //     hold (blue) → off only (so promotion to red happens just once — no
  //     finish-stealing); the finish hold itself toggles red → off to clear it.
  //     No starts are allowed up there.
  //   • any other hold → start (green) → hold (blue) → off, where a fresh tap
  //     starts green while fewer than two starts exist, otherwise blue.
  function cycleHold(h) {
    const cur = createRoles[h];
    if (inTopZone(h)) {
      if (cur === 'finish') {
        delete createRoles[h];
      } else if (cur === 'int') {
        if (holdsWithRole('finish').length) delete createRoles[h];   // finish taken → blue → off
        else createRoles[h] = 'finish';                             // no finish yet → blue → red
      } else {
        createRoles[h] = 'int';
      }
    } else if (cur === 'start') {
      createRoles[h] = 'int';
    } else if (cur === 'int') {
      delete createRoles[h];
    } else {
      createRoles[h] = holdsWithRole('start').length < 2 ? 'start' : 'int';
    }
    applyCreateRoles();
  }

  function buildCreateGrades() {
    document.getElementById('create-grades').innerHTML =
      gradeTabButtons(GRADE_ORDER, g => g === createGrade, fontGrade);
  }

  function setCreateTitle(t) {
    const el = document.getElementById('create-title');
    if (el) el.textContent = t;
  }

  function resetCreate() {
    createRoles = {}; createGrade = ''; editingProblemId = null;
    const nameEl = document.getElementById('create-name');
    if (nameEl) { nameEl.value = ''; nameEl.disabled = false; }
    document.getElementById('create-error').textContent = '';
    setCreateTitle('Create problem');
    buildCreateGrades();
    applyCreateRoles();
  }

  // Seed the create form from an existing problem so an admin can edit its holds +
  // grade. Roles come from the canonical (un-inverted) order — problemHoldOrder +
  // classifyHolds is the exact round-trip the renderer uses, so loading can't drift
  // from how saveProblem re-inverts on the way out. Name is shown but LOCKED (the
  // edit is holds + grade only; name and setter are left untouched).
  function seedEdit(p) {
    editingProblemId = String(p.id);
    const order = problemHoldOrder(p);
    const cls = classifyHolds(order);
    createRoles = {};
    order.forEach(h => { createRoles[h] = cls[h]; });
    createGrade = p.grade || '';
    const nameEl = document.getElementById('create-name');
    if (nameEl) { nameEl.value = p.name || ''; nameEl.disabled = true; }
    document.getElementById('create-error').textContent = '';
    setCreateTitle('Edit problem');
  }

  // Prepare the create view on entry. With an editId (admin "Edit holds") seed from
  // that problem the first time we land on it; re-entering the same edit (e.g. the
  // SW-deferred reload) keeps in-progress changes. No editId = fresh create.
  function initCreateView(editId) {
    if (editId) {
      if (String(editingProblemId) !== String(editId)) {
        const p = allProblems.find(x => String(x.id) === String(editId));
        if (!p) {   // not loaded yet (deep link / refresh) — bounce to its detail, which loads it
          location.replace(location.pathname + '#detail/' + encodeURIComponent(editId));
          return;
        }
        seedEdit(p);
      }
    } else if (editingProblemId) {
      resetCreate();   // leaving an edit for a fresh create — start blank
    }
    buildCreateGrades();
    applyCreateRoles();
  }

  // The header reset (bin) button. In edit mode it reverts to the problem's saved
  // holds + grade (discard your edits); in create mode it clears the form.
  function onCreateReset() {
    if (editingProblemId) {
      const p = allProblems.find(x => String(x.id) === String(editingProblemId));
      if (p) { seedEdit(p); buildCreateGrades(); applyCreateRoles(); return; }
    }
    resetCreate();
  }

  async function saveProblem() {
    const errEl = document.getElementById('create-error');
    errEl.textContent = '';
    if (!session) { location.hash = '#auth'; return; }

    // In edit mode we're updating this existing row (holds + grade only).
    const editing = editingProblemId
      ? allProblems.find(p => String(p.id) === String(editingProblemId))
      : null;
    if (editingProblemId && !editing) {   // lost the row (e.g. deleted elsewhere)
      errEl.textContent = 'Couldn’t find that problem — go back and reopen it.';
      return;
    }

    const name = document.getElementById('create-name').value.trim();
    const starts = holdsWithRole('start');
    const ints = holdsWithRole('int');
    const fins = holdsWithRole('finish');

    if (!name) { errEl.textContent = 'Give your problem a name.'; return; }
    if (!createGrade) { errEl.textContent = 'Pick a grade.'; return; }
    if (starts.length < 1) { errEl.textContent = 'Add at least one start hold.'; return; }
    if (ints.length < 1) { errEl.textContent = 'Add at least one intermediate hold.'; return; }
    if (fins.length !== 1) { errEl.textContent = 'Add exactly one finish hold.'; return; }

    // Names must be unique — they're how a problem is cast (the DB also enforces a
    // UNIQUE constraint on name). Pre-check case-insensitively, excluding the problem
    // being edited (its own name is unchanged — the field is locked in edit mode).
    const newName = name.toLowerCase();
    if (allProblems.some(p => p !== editing && String(p.name || '').trim().toLowerCase() === newName)) {
      errEl.textContent = 'That name is taken — pick another.';
      return;
    }

    // Canonical display order D = [start, start, …intermediates, finish].
    // A single (matched) start is duplicated so the renderer's "first two = start"
    // rule paints it green; the overlay de-dupes the repeated dot.
    const startPair = starts.length === 1 ? [starts[0], starts[0]] : starts.slice(0, 2);
    const D = [...startPair, ...ints, fins[0]];

    // Store INVERTED to match the migrated rows (see CLAUDE.md / problemHoldOrder):
    //   finish_hold = D[0], intermediate_holds = D[1..n-2], start_holds = last two.
    const holdCols = {
      finish_hold: D[0],
      intermediate_holds: D.slice(1, D.length - 2),
      start_holds: D.slice(D.length - 2)
    };

    const btn = document.getElementById('create-save');
    btn.disabled = true; btn.classList.add('casting');

    if (editing) {
      // Holds + grade only — never touch name or setter (admin edit; DB enforces
      // admin-only UPDATE via RLS). Same invert-on-save scheme as create.
      const update = { grade: createGrade, ...holdCols };
      const { error } = await sb.from('problems').update(update).eq('id', editing.id);
      btn.disabled = false; btn.classList.remove('casting');
      if (error) {
        errEl.textContent = error.code === '42501'
          ? 'You don’t have permission to edit problems.'   // not an admin (RLS)
          : error.message;
        return;
      }
      Object.assign(editing, update);   // update in place (same object lives in allProblems)
      leaderboardLoaded = false;         // edit may change grade -> base points; refetch next view
      const id = editing.id;
      resetCreate();
      buildGradeTabs();                 // a new grade may add/remove a filter tab
      renderList();
      showToast('Problem updated ✓', 'success');
      // Replace the #create entry with the problem's (re-rendered) detail.
      location.replace('#detail/' + encodeURIComponent(id));
      return;
    }

    const row = {
      name,
      grade: createGrade,
      setter: (profile && profile.username) || '',     // snapshot (NOT NULL); display uses setter_id
      setter_id: session.user.id,                      // owner — drives the live setter name
      ...holdCols,
      feet_mode: 'any',
      is_benchmark: false
    };

    const { data, error } = await sb.from('problems').insert(row).select().single();
    btn.disabled = false; btn.classList.remove('casting');
    if (error) {
      errEl.textContent =
        error.code === '42501' ? 'You don’t have permission to create problems yet.'   // RLS INSERT policy missing
        : error.code === '23505' ? 'That name is taken — pick another.'                // unique-name backstop
        : error.message;
      return;
    }

    allProblems.push(data);
    buildGradeTabs();
    renderList();
    resetCreate();
    showToast('Problem created ✓', 'success');
    // Replace the #create history entry with the new problem's detail, so Back
    // from there returns to the list (not into the create form).
    location.replace('#detail/' + encodeURIComponent(data.id));
  }

  // ── Recalibrate board (admin tool) ───────────────────────────────────────────
  // Swap in a new board image and re-anchor the existing hold positions onto it.
  // The hold→dot LABELLING never changes (it's frozen in hold_map.json); only each
  // hold's x/y % shifts when the image's framing/aspect changes. So we fit a single
  // least-squares affine from the saved positions to a few user-placed anchors, snap
  // every hold at once, then export a fresh hold_map.json. No Python / ICP needed.
  const CAL = {
    base: null,      // immutable copy of the saved hold_map { hold: {x,y} } — the fit source
    pos: null,       // working positions (drawn + exported)
    anchors: [],     // [{ hold, x, y }] true positions the user has pinned
    selected: null,  // hold id awaiting its anchor target (anchor mode) / first tap (mirror mode)
    mode: 'anchor',  // 'anchor' | 'nudge' | 'add' | 'mirror'
    drag: null,      // hold currently being dragged (nudge mode)
    imgFile: null,   // a newly-picked board image awaiting upload on Save
    mirror: null,    // working copy of the mirror map { hold: partner } (mirror mode); self = no mirror
  };

  const isAdmin = () => !!(profile && profile.is_admin);

  function initCalibrate() {
    const status = document.getElementById('cal-status');
    if (!CAL.pos) {
      if (!HOLD_MAP) { if (status) status.textContent = 'Hold map still loading…'; return; }
      CAL.base = JSON.parse(JSON.stringify(HOLD_MAP));
      CAL.pos = JSON.parse(JSON.stringify(HOLD_MAP));
    }
    // Seed the working mirror map from whatever's live (board_config or bundled).
    if (!CAL.mirror) CAL.mirror = MIRROR_MAP ? JSON.parse(JSON.stringify(MIRROR_MAP)) : {};
    document.querySelectorAll('#cal-mode .cal-seg').forEach(b => b.classList.toggle('active', b.dataset.mode === CAL.mode));
    document.getElementById('cal-board').classList.toggle('nudging', CAL.mode === 'nudge');
    renderCal();
  }

  function renderCal() {
    const layer = document.getElementById('cal-layer');
    if (!layer || !CAL.pos) return;
    const anchored = new Set(CAL.anchors.map(a => a.hold));
    const mirroring = CAL.mode === 'mirror';
    const selPartner = mirroring && CAL.selected ? CAL.mirror[CAL.selected] : null;
    let html = Object.keys(CAL.pos).map(h => {
      const p = CAL.pos[h];
      let cls;
      if (mirroring) {
        cls = h === CAL.selected ? 'sel'
            : h === selPartner ? 'partner'
            : (CAL.mirror[h] === h || !(h in CAL.mirror)) ? 'selfmirror' : '';
      } else {
        cls = h === CAL.selected ? 'sel' : (anchored.has(h) ? 'anchored' : '');
      }
      return `<div class="cal-dot ${cls}" style="left:${p.x}%;top:${p.y}%"></div>`;
    }).join('');
    if (!mirroring) html += CAL.anchors.map(a => `<div class="cal-anchor" style="left:${a.x}%;top:${a.y}%"></div>`).join('');
    layer.innerHTML = html;

    document.getElementById('cal-anchor-count').textContent =
      `${CAL.anchors.length} anchor${CAL.anchors.length === 1 ? '' : 's'}`;
    document.getElementById('cal-fit').disabled = CAL.anchors.length < 3;

    const status = document.getElementById('cal-status');
    if (CAL.mode === 'add') {
      const miss = calMissingHolds();
      status.textContent = miss.length
        ? `Tap where hold ${holdNum(miss[0])} (${gridName(holdNum(miss[0]))}) goes — ${miss.length} hold${miss.length === 1 ? '' : 's'} missing.`
        : 'All 189 holds are placed — none missing.';
    }
    else if (CAL.mode === 'mirror') {
      const s = CAL.selected;
      if (s) {
        const part = CAL.mirror[s];
        status.textContent = (!part || part === s)
          ? `${holdNum(s)} (${gridName(holdNum(s))}) has no mirror. Tap its partner to pair it, or tap ${holdNum(s)} again to keep it unmirrored.`
          : `${holdNum(s)} (${gridName(holdNum(s))}) ↔ ${holdNum(part)} (${gridName(holdNum(part))}). Tap a new partner to repair, or tap ${holdNum(s)} again for "no mirror".`;
      } else {
        status.textContent = 'Mirror mode — tap a hold to see its partner; amber dots have no mirror.';
      }
    }
    else if (CAL.mode === 'nudge') status.textContent = 'Nudge mode — drag any dot to fine-tune.';
    else if (CAL.selected) status.textContent = `Now tap where hold ${holdNum(CAL.selected)} really is.`;
    else if (CAL.anchors.length < 3) status.textContent = `Tap a dot, then its true spot — ${3 - CAL.anchors.length} more to fit.`;
    else status.textContent = 'Ready to fit — or add more anchors for accuracy.';
  }

  // Real holds (ground truth) that aren't in the working map yet, lowest id first.
  function calMissingHolds() {
    return VALID_HOLD_IDS.map(n => 'hold' + n).filter(h => !(h in CAL.pos));
  }

  // Add mode: tap to place the next missing hold at that spot.
  function calAddTap(e) {
    const miss = calMissingHolds();
    if (!miss.length) return;
    const { x, y } = calPct(e.clientX, e.clientY);
    CAL.pos[miss[0]] = { x: +x.toFixed(2), y: +y.toFixed(2) };
    // A freshly-added hold has no "saved" source, so seed base too — otherwise a
    // later Fit (which maps from base) would drop it again.
    CAL.base[miss[0]] = { x: CAL.pos[miss[0]].x, y: CAL.pos[miss[0]].y };
    renderCal();
    showToast(`Placed ${miss[0]} (${gridName(holdNum(miss[0]))})`, 'success');
  }

  // Mirror mode: first tap selects a hold (and shows its current partner); second
  // tap either pairs it with another hold, sets "no mirror" (tap the same hold
  // again), or cancels (tap empty space). Pairs are kept symmetric — repairing one
  // hold orphans its old partner to "no mirror" so the map stays an involution.
  function setMirrorPair(a, b) {
    const m = CAL.mirror;
    if (a === b) {                              // mark a as self / no mirror
      const old = m[a];
      if (old && old !== a) m[old] = old;
      m[a] = a;
      return;
    }
    const oa = m[a], ob = m[b];
    if (oa && oa !== a && oa !== b) m[oa] = oa; // a's old partner -> no mirror
    if (ob && ob !== b && ob !== a) m[ob] = ob; // b's old partner -> no mirror
    m[a] = b; m[b] = a;
  }

  function calMirrorTap(e) {
    const h = calNearest(e.clientX, e.clientY);
    if (!CAL.selected) { if (h) CAL.selected = h; renderCal(); return; }
    if (!h) { CAL.selected = null; renderCal(); return; }   // tapped away = cancel
    const a = CAL.selected;
    setMirrorPair(a, h);
    CAL.selected = null;
    renderCal();
    showToast(a === h ? `${holdNum(a)} set to no mirror`
                      : `${holdNum(a)} ↔ ${holdNum(h)}`, 'success');
  }

  // Pointer event → board-relative % (+ board pixel size), rotation-aware.
  function calPct(clientX, clientY) {
    return boardPct(document.getElementById('cal-board'), clientX, clientY);
  }

  // Nearest working dot to a tap (pixel distance), or null if too far to count.
  function calNearest(clientX, clientY) {
    const { x: px, y: py, w, h: bh } = calPct(clientX, clientY);
    let best = null, bestD = Infinity;
    for (const hh in CAL.pos) {
      const dx = (CAL.pos[hh].x - px) / 100 * w;
      const dy = (CAL.pos[hh].y - py) / 100 * bh;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = hh; }
    }
    return Math.sqrt(bestD) <= w * 0.06 ? best : null;
  }

  // Anchor mode: first tap selects the nearest dot, second tap pins its true spot.
  function calAnchorTap(e) {
    const { x, y } = calPct(e.clientX, e.clientY);
    if (!CAL.selected) {
      const h = calNearest(e.clientX, e.clientY);
      if (h) CAL.selected = h;
    } else {
      CAL.anchors = CAL.anchors.filter(a => a.hold !== CAL.selected);   // one anchor per hold
      CAL.anchors.push({ hold: CAL.selected, x: +x.toFixed(2), y: +y.toFixed(2) });
      CAL.selected = null;
    }
    renderCal();
  }

  // 3×3 linear solve (Gaussian elimination, partial pivot). Returns null if singular.
  function solve3(M, v) {
    const a = M.map((row, i) => [...row, v[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-9) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = a[r][c] / a[c][c];
        for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  }

  // Fit a least-squares affine (saved positions → anchors) and apply to every hold.
  function calFit() {
    if (CAL.anchors.length < 3) return;
    const M = [[0,0,0],[0,0,0],[0,0,0]];
    const bx = [0,0,0], by = [0,0,0];
    for (const a of CAL.anchors) {
      const s = CAL.base[a.hold];
      if (!s) continue;
      const row = [s.x, s.y, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j];
        bx[i] += row[i] * a.x;
        by[i] += row[i] * a.y;
      }
    }
    const cx = solve3(M, bx), cy = solve3(M, by);
    if (!cx || !cy) {
      document.getElementById('cal-status').textContent = 'Anchors are too close to a line — pick spread-out holds.';
      return;
    }
    for (const h in CAL.pos) {
      const s = CAL.base[h];
      CAL.pos[h] = {
        x: +(cx[0]*s.x + cx[1]*s.y + cx[2]).toFixed(2),
        y: +(cy[0]*s.x + cy[1]*s.y + cy[2]).toFixed(2),
      };
    }
    // Anchors have done their job — clear them so the board shows the clean fitted
    // placement, not the leftover anchor markers / pre-fit dots.
    CAL.anchors = [];
    CAL.selected = null;
    renderCal();
    showToast('Holds fitted to anchors ✓', 'success');
  }

  // Nudge mode: drag the nearest dot to a new spot (pointer events = mouse + touch).
  function calDragStart(e) {
    if (CAL.mode !== 'nudge') return;
    const h = calNearest(e.clientX, e.clientY);
    if (!h) return;
    CAL.drag = h;
    const board = document.getElementById('cal-board');
    if (board.setPointerCapture) board.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function calDragMove(e) {
    if (!CAL.drag) return;
    const { x, y } = calPct(e.clientX, e.clientY);
    CAL.pos[CAL.drag] = { x: +x.toFixed(2), y: +y.toFixed(2) };
    renderCal();
    e.preventDefault();
  }
  function calDragEnd() { CAL.drag = null; }

  function calSetMode(mode) {
    CAL.mode = mode; CAL.selected = null; CAL.drag = null;
    document.getElementById('cal-board').classList.toggle('nudging', mode === 'nudge');
    document.querySelectorAll('#cal-mode .cal-seg').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderCal();
  }

  function calReset() {
    if (!CAL.base) return;
    CAL.pos = JSON.parse(JSON.stringify(CAL.base));
    CAL.anchors = []; CAL.selected = null;
    renderCal();
    showToast('Reset to saved positions', 'success');
  }
  function calClearAnchors() { CAL.anchors = []; CAL.selected = null; renderCal(); }

  function calLoadImage(file) {
    if (!file) return;
    CAL.imgFile = file;   // held for upload on Save
    // Dots are positioned in % of the image, so they re-land on the new framing.
    document.getElementById('cal-img').src = URL.createObjectURL(file);
    document.getElementById('cal-status').textContent = 'New image loaded — re-anchor, then Save.';
  }

  // Build the hold map in hold-number order (stable + readable in the DB).
  function calOrderedMap() {
    const out = {};
    Object.keys(CAL.pos)
      .sort((a, b) => (+holdNum(a)) - (+holdNum(b)))
      .forEach(h => { out[h] = { x: +CAL.pos[h].x, y: +CAL.pos[h].y }; });
    return out;
  }

  // Save board → publish image (if a new one was picked) + hold map to Supabase.
  // Admin-only; the DB/storage RLS is the real gate (the button is just UX).
  async function calSave() {
    if (!CAL.pos) return;
    const btn = document.getElementById('cal-save');
    const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
    const status = document.getElementById('cal-status');
    try {
      const row = { wall: 'HangoutPortland', hold_map: calOrderedMap(), updated_at: new Date().toISOString() };
      // Publish the mirror map alongside positions so manual mirror fixes go live.
      if (CAL.mirror && Object.keys(CAL.mirror).length) row.mirror_map = CAL.mirror;

      // Upload the new image first (fixed object name; cache-busted on load by updated_at).
      if (CAL.imgFile) {
        const ext = (CAL.imgFile.type === 'image/jpeg') ? 'jpg' : (CAL.imgFile.type === 'image/webp') ? 'webp' : 'png';
        const objName = 'board.' + ext;
        const up = await sb.storage.from(BOARD_BUCKET)
          .upload(objName, CAL.imgFile, { upsert: true, cacheControl: '3600', contentType: CAL.imgFile.type });
        if (up.error) throw up.error;
        row.image_path = objName;
      }

      const { error } = await sb.from('board_config').upsert(row, { onConflict: 'wall' });
      if (error) throw error;

      // Reflect the save locally so it's live without a reload.
      HOLD_MAP = JSON.parse(JSON.stringify(CAL.pos));
      configHasMap = true;
      if (CAL.mirror && Object.keys(CAL.mirror).length) {
        MIRROR_MAP = JSON.parse(JSON.stringify(CAL.mirror));
        configHasMirror = true;
      }
      if (CAL.imgFile) {
        BOARD_IMG = `${SUPA_URL}/storage/v1/object/public/${BOARD_BUCKET}/${row.image_path}?v=${encodeURIComponent(row.updated_at)}`;
        CAL.imgFile = null;
        applyBoardImage();
      }
      // Show the clean saved placement — drop any leftover anchors/selection.
      CAL.anchors = [];
      CAL.selected = null;
      renderCal();
      btn.disabled = false; btn.textContent = prev;
      document.getElementById('cal-saved-modal').classList.add('show');
    } catch (err) {
      btn.disabled = false; btn.textContent = prev;
      const msg = (err && err.code === '42501')
        ? 'You don’t have permission to save the board.'   // not an admin (RLS)
        : (err && err.message) || 'Save failed — check connection.';
      status.textContent = msg;
      showToast('Save failed', 'error');
      console.error('board save failed', err);
    }
  }

  // ══ CIRCUITS ═══════════════════════════════════════════════════════════════════
  // A circuit is a long sport-style route: one ordered hold sequence (duplicates
  // allowed), 1–2 starts (the first holds), one finish (the last hold), optional
  // loop. Phase 1 = browse / create / detail with an in-app Play preview of the
  // moving-window animation. No real casting yet (that's Phase 2).

  const circuitName = c => String((c && c.name) || '').trim() || '(unnamed)';
  const circuitSeq  = c => (Array.isArray(c && c.hold_sequence) ? c.hold_sequence : []);
  const canEditCircuit = c =>
    !!(c && profile && (profile.is_admin || (session && c.setter_id === session.user.id)));

  // Surface "db/14 isn't applied yet" distinctly from a real failure.
  const circuitsTableMissing = err =>
    !!err && (err.code === '42P01' || err.code === 'PGRST205' ||
      /Could not find the table|relation .* does not exist|schema cache/i.test(err.message || ''));

