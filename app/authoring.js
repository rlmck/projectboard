// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, leaderboard, app. This file: create-a-problem, the hold outlines editor (#outlines), and circuit helpers.

  // ── Create a problem ──────────────────────────────────────────────────────────
  // The create view is laid out like the problem view: pinned, the same title
  // block (the name is typed in place as the title, the grade is the badge, tap
  // it for the grade sheet) and the board in the same place. The wall is dimmed
  // to the problem view's level with every hold left bright, the finish zone is
  // marked on the board, and a strip under the board shows what's set and what
  // to tap next, instead of a paragraph of rules.
  // Holds keep their physical role in createRoles. On save we build the canonical
  // display order and store it INVERTED so the existing renderer
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

  // Where to draw the finish zone's edge on the board (a % from the top): midway
  // between the lowest hold inside the zone and the highest one below it, so the
  // line never cuts through a hold.
  function finishZoneEdge() {
    if (!HOLD_MAP) return null;
    const t = topZoneThreshold();
    let lastIn = -Infinity, firstOut = Infinity;
    for (const h in HOLD_MAP) {
      const y = HOLD_MAP[h].y;
      if (typeof y !== 'number') continue;
      if (y <= t) lastIn = Math.max(lastIn, y);
      else firstOut = Math.min(firstOut, y);
    }
    return (isFinite(lastIn) && isFinite(firstOut)) ? (lastIn + firstOut) / 2 : null;
  }

  // Draw the board (dimmed wall, bright holds, the assigned ones outlined in their
  // role colour, the finish zone marked) and refresh the progress strip.
  function applyCreateRoles() {
    const layer = document.getElementById('create-hold-layer');
    if (layer) {
      const svg = holdShapeLayerHtml(createRoles, { mirror: false, dim: true, lightAll: true });
      const edge = finishZoneEdge();
      const zone = edge == null ? ''
        : `<div class="finish-zone" style="height:${edge}%"><span>Finish zone</span></div>`;
      // Without traced outlines (an old board version), fall back to dots. The
      // zone goes last so its edge and label sit above the dimming.
      layer.innerHTML = ((svg != null) ? svg : Object.keys(createRoles).map(h => {
        const pos = HOLD_MAP && HOLD_MAP[h];
        if (!pos) return '';
        return `<div class="hold-dot ${createRoles[h]}" style="left:${pos.x}%;top:${pos.y}%"></div>`;
      }).join('')) + zone;
    }
    updateCreateStatus();
  }

  // The strip under the board: three steps (start, holds, finish), each ticked
  // off when it's right, and one line saying what to do next.
  function updateCreateStatus() {
    const s = holdsWithRole('start').length, i = holdsWithRole('int').length, f = holdsWithRole('finish').length;
    const steps = document.getElementById('create-steps');
    const next = document.getElementById('create-next');
    if (!steps || !next) return;
    const step = (cls, n, label, done) =>
      `<span class="create-step ${cls}${done ? ' done' : ''}"><i></i>${n} ${label}</span>`;
    steps.innerHTML =
      step('c-start', s, 'start', s >= 1 && s <= 2) +
      step('c-int', i, i === 1 ? 'hold' : 'holds', i >= 1) +
      step('c-finish', f, 'finish', f === 1);
    const name = (document.getElementById('create-name').value || '').trim();
    next.textContent =
      !s ? 'Tap a start hold, low on the wall'
      : !i ? 'Now tap the holds in between'
      : !f ? 'Tap a finish-zone hold twice to finish'
      : !name ? 'Name it at the top'
      : !createGrade ? 'Tap Grade to pick one'
      : 'Ready — tap ✓ to save';
    next.classList.toggle('ready', !!(s && i && f && name && createGrade));
    const undo = document.getElementById('create-undo');
    if (undo) undo.disabled = !createUndo.length;
    if (fsOpen) fsUpdateBar();   // the fullscreen bar shows the same counts
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

  // Remember the holds as they are, for Undo (capped; it's a phone).
  function pushCreateUndo() {
    createUndo.push({ ...createRoles });
    if (createUndo.length > 60) createUndo.shift();
  }
  function undoCreate() {
    if (!createUndo.length) return;
    createRoles = createUndo.pop();
    applyCreateRoles();
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
    pushCreateUndo();
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

  // ── Name, grade and setter (the title block) ────────────────────────────────
  function updateCreateHead() {
    const btn = document.getElementById('create-grade-btn');
    btn.textContent = createGrade ? fontGrade(createGrade) : 'Grade';
    btn.classList.toggle('unset', !createGrade);
    btn.setAttribute('aria-label', createGrade ? `Grade ${fontGrade(createGrade)}, tap to change` : 'Pick a grade');
    const editing = editingProblemId && allProblems.find(p => String(p.id) === String(editingProblemId));
    document.getElementById('create-setter').textContent =
      'by ' + (editing ? setterName(editing) : ((profile && profile.username) || 'you'));
    updateCreateStatus();
  }

  function buildCreateGrades() {
    document.getElementById('create-grades').innerHTML =
      gradeTabButtons(GRADE_ORDER, g => g === createGrade, fontGrade);
    updateCreateHead();
  }

  function openCreateGrade() {
    buildCreateGrades();
    document.getElementById('create-grade-modal').classList.add('show');
  }
  function closeCreateGrade() { document.getElementById('create-grade-modal').classList.remove('show'); }
  function pickCreateGrade(g) {
    createGrade = g;
    buildCreateGrades();
    closeCreateGrade();
  }

  function setCreateTitle(t) {
    const el = document.getElementById('create-title');
    if (el) el.textContent = t;
  }

  function resetCreate() {
    createRoles = {}; createGrade = ''; editingProblemId = null; createUndo = [];
    const nameEl = document.getElementById('create-name');
    if (nameEl) { nameEl.value = ''; nameEl.disabled = false; }
    setCreateTitle('New problem');
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
    createUndo = [];
    order.forEach(h => { createRoles[h] = cls[h]; });
    createGrade = p.grade || '';
    const nameEl = document.getElementById('create-name');
    if (nameEl) { nameEl.value = p.name || ''; nameEl.disabled = true; }
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
          redirectRoute('#detail/' + encodeURIComponent(editId));
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

  // The header bin. In edit mode it reverts to the problem's saved holds + grade
  // (discard your edits); in create mode it clears the holds. Either way Undo
  // brings the holds back.
  function onCreateReset() {
    const before = { ...createRoles };
    if (editingProblemId) {
      const p = allProblems.find(x => String(x.id) === String(editingProblemId));
      if (p) {
        seedEdit(p);
        createUndo = [before];
        buildCreateGrades(); applyCreateRoles(); return;
      }
    }
    if (!Object.keys(createRoles).length) return;
    pushCreateUndo();
    createRoles = {};
    applyCreateRoles();
  }

  // A save that's missing something says so in a toast and takes you to it.
  function createMissing(msg, then) {
    showToast(msg, 'error');
    if (then) then();
  }

  async function saveProblem() {
    if (!session) { location.hash = '#auth'; return; }

    // In edit mode we're updating this existing row (holds + grade only).
    const editing = editingProblemId
      ? allProblems.find(p => String(p.id) === String(editingProblemId))
      : null;
    if (editingProblemId && !editing) {   // lost the row (e.g. deleted elsewhere)
      createMissing('Couldn’t find that problem — go back and reopen it.');
      return;
    }

    const nameEl = document.getElementById('create-name');
    const name = nameEl.value.trim();
    const starts = holdsWithRole('start');
    const ints = holdsWithRole('int');
    const fins = holdsWithRole('finish');

    if (starts.length < 1) return createMissing('Add a start hold.');
    if (ints.length < 1) return createMissing('Add at least one hold between start and finish.');
    if (fins.length !== 1) return createMissing('Add a finish hold (tap a finish-zone hold twice).');
    if (!name) return createMissing('Give your problem a name.', () => nameEl.focus());
    if (!createGrade) return createMissing('Pick a grade.', openCreateGrade);

    // Names must be unique — they're how a problem is cast (the DB also enforces a
    // UNIQUE constraint on name). Pre-check case-insensitively, excluding the problem
    // being edited (its own name is unchanged — the field is locked in edit mode).
    const newName = name.toLowerCase();
    if (allProblems.some(p => p !== editing && String(p.name || '').trim().toLowerCase() === newName)) {
      return createMissing('That name is taken — pick another.', () => nameEl.focus());
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
      // .select() so a write RLS silently refused (no error, 0 rows) isn't
      // mistaken for success.
      const { data, error } = await sb.from('problems').update(update).eq('id', editing.id).select('id');
      btn.disabled = false; btn.classList.remove('casting');
      if (error) {
        return createMissing(error.code === '42501'
          ? 'You don’t have permission to edit problems.'   // not an admin (RLS)
          : error.message);
      }
      if (!data || !data.length) {
        createMissing('Couldn’t save: you’re no longer an admin, or the problem has been deleted.');
        recheckAdmin();
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
      redirectRoute('#detail/' + encodeURIComponent(id));
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
      return createMissing(
        error.code === '42501' ? 'You don’t have permission to create problems yet.'   // RLS INSERT policy missing
        : error.code === '23505' ? 'That name is taken — pick another.'                // unique-name backstop
        : error.message);
    }

    allProblems.push(data);
    buildGradeTabs();
    renderList();
    resetCreate();
    showToast('Problem created ✓', 'success');
    // Replace the #create history entry with the new problem's detail, so Back
    // from there returns to the list (not into the create form).
    redirectRoute('#detail/' + encodeURIComponent(data.id));
  }

  // ── Hold outlines editor (#outlines, admin) ──────────────────────────────────
  // Fine-tune the traced outline of every hold, on a phone, and publish the set to
  // board_config.hold_shapes (db/28) so every client draws it on its next load.
  // It replaced both the old #calibrate tool and the desktop tools/trace_holds.html.
  //
  // Admin → Trace Holds. Touch: pinch to zoom, two fingers (or one on empty board) to pan. Tap a hold to
  // select it, double-tap to zoom to it. Drag a point to move it (a magnifier shows
  // it above the finger); drag or tap the small circle on an edge to add a point;
  // drag inside the outline to move the whole shape. The panel nudges the selected
  // point (or the whole outline) in fine steps. Desktop: wheel zooms, arrows nudge
  // (shift ×10, alt ÷5), Delete removes a point, ctrl+Z / ctrl+Y, n / p, f, 0.
  //
  // Outlines are % of the LIVE board image, pinned to the board version in
  // __meta.board_updated_at. Publishing writes hold_shapes ALONE — never updated_at,
  // which is the version these outlines are pinned to (shapesUsable() in core.js).
  // Hold positions (hold_map) are never changed here. Work in progress is kept as
  // a draft in localStorage until it's published or discarded.
  const isAdmin = () => !!(profile && profile.is_admin);

  const OL_DRAFT_KEY = 'pb-outline-draft';
  const OL_MAX_W = 8000;          // px: the widest the zoomed board gets (a hold is then ~350px across on a phone)
  const OL_SLOP = 6;              // px a pointer must travel before a press becomes a drag
  const OL_HIT = isTouchDevice ? 22 : 10;   // px grab radius for points
  const OL_MID_MIN = OL_HIT * 2;  // px: an edge shorter than this gets no add-point handle
  const OL_TINY = 36;             // px: an outline smaller than this on screen shows no handles
  const OL_NUDGE = 0.05;          // % per nudge

  const OL = {
    ready: false,
    srcKey: '',          // what the baseline was seeded from; a change re-seeds an untouched editor
    holds: [],           // hold ids in number order (from the live map)
    shapes: {},          // working outlines: hold -> [[x,y],…] (no __meta)
    baseline: {},        // the published copy the change count measures against
    meta: null,          // the baseline's __meta (board_updated_at, …)
    smooth: SHAPE_SMOOTH, publishedSmooth: SHAPE_SMOOTH,
    staleDraft: false,   // the restored draft was started against a different published copy
    cur: 0, sel: null, drawing: false,
    undo: [], redo: [],
    showOthers: true, preview: false, previewRole: 'int', previewUsable: true,
    aspect: 0, fitW: 0, s: 1, tx: 0, ty: 0, cw: 0, sw: 0, sh: 0,   // view: fit width, zoom, pan, laid-out width, stage size
    ptrs: new Map(), gesture: null, lastTap: null, raf: 0,
    publishing: false, statusT: 0, previewKey: '',
  };

  const olClone = o => JSON.parse(JSON.stringify(o));
  const olR2 = n => Math.round(n * 100) / 100;
  const olSame = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
  const olOkSmooth = s => typeof s === 'number' && isFinite(s) && s >= 0 && s <= 1;
  const olCurHold = () => OL.holds[OL.cur];
  const olPts = () => OL.shapes[olCurHold()] || [];
  const olW = () => OL.fitW * OL.s;
  const olH = () => olW() / (OL.aspect || 1);
  const olLabel = h => `${gridName(holdNum(h))} · hold ${holdNum(h)}`;
  function olStrip(src) {
    const out = {};
    Object.keys(src || {}).forEach(k => { if (k !== '__meta' && Array.isArray(src[k])) out[k] = src[k]; });
    return out;
  }
  function olHash(o) {             // cheap fingerprint of the published copy a draft was based on
    const s = JSON.stringify(o);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + s.length;
  }
  const olChanged = () => OL.holds.filter(h => !olSame(OL.shapes[h], OL.baseline[h]));
  const olSmoothChanged = () => Math.abs(OL.smooth - OL.publishedSmooth) > 1e-9;
  const olDirty = () => OL.ready && (olSmoothChanged() || olChanged().length > 0);
  const olVersionOk = () => !!(OL.meta && OL.meta.board_updated_at && OL.meta.board_updated_at === boardConfigVersion);

  // ── entry + seeding ──
  // Called by the router on entry and by refreshBoardViews() whenever board data
  // lands. Editing only starts against the LIVE board (outlines are % of its image).
  function initOutlines() {
    if (!configHasMap || !HOLD_MAP || !HOLD_SHAPES) {
      olSetNote(navigator.onLine === false ? 'Offline — the live board is needed to edit outlines.' : 'Loading the live board…');
      return;
    }
    const key = (configHasShapes ? 'live' : 'file') + '|' + boardConfigVersion;
    if (!OL.ready || (OL.srcKey !== key && !olDirty() && !OL.undo.length)) olSeed(key);
    const img = document.getElementById('ol-img');
    if (img.getAttribute('src') !== BOARD_IMG) { img.setAttribute('src', BOARD_IMG); document.getElementById('ol-loupe-img').setAttribute('src', BOARD_IMG); }
    else if (img.naturalWidth) olImgReady();
    olRenderStatic(); olRenderCur(); olStatus();
  }

  function olSeed(key) {
    const src = HOLD_SHAPES || {};
    OL.meta = src.__meta ? Object.assign({}, src.__meta) : null;
    OL.baseline = olClone(olStrip(src));
    OL.publishedSmooth = OL.meta && olOkSmooth(OL.meta.smooth) ? OL.meta.smooth : SHAPE_SMOOTH;
    OL.holds = Object.keys(HOLD_MAP).sort((a, b) => holdNum(a) - holdNum(b));
    OL.shapes = olClone(OL.baseline);
    OL.smooth = OL.publishedSmooth;
    OL.undo = []; OL.redo = []; OL.sel = null; OL.staleDraft = false;
    if (!OL.ready) {                      // first seed this page: pick up a saved draft
      const d = olReadDraft();
      if (d && d.version === boardConfigVersion && d.shapes && typeof d.shapes === 'object') {
        OL.shapes = olStrip(d.shapes);
        if (olOkSmooth(d.smooth)) OL.smooth = d.smooth;
        if (Number.isInteger(d.cur)) OL.cur = d.cur;
        OL.staleDraft = d.base !== olHash(OL.baseline);
        OL.ready = true;
        if (olDirty()) showToast('Restored your unpublished changes', 'success');
      }
    }
    OL.cur = Math.max(0, Math.min(OL.holds.length - 1, OL.cur || 0));
    OL.drawing = olPts().length < 3;
    OL.ready = true;
    OL.srcKey = key;
  }

  function olReadDraft() {
    try { return JSON.parse(localStorage.getItem(OL_DRAFT_KEY) || 'null'); } catch (e) { return null; }
  }
  function olSaveDraft() {
    try {
      if (!olDirty()) { localStorage.removeItem(OL_DRAFT_KEY); return; }
      localStorage.setItem(OL_DRAFT_KEY, JSON.stringify({
        version: boardConfigVersion, base: olHash(OL.baseline),
        shapes: OL.shapes, smooth: OL.smooth, cur: OL.cur
      }));
    } catch (e) { /* storage blocked or full — the edits still live in memory */ }
  }

  // ── view: zoom + pan ──
  // The canvas is laid out at its real zoomed pixel size (so the photo and the
  // outlines stay sharp and strokes keep their width) and moved with a translate.
  // During a pinch it's scaled with a transform instead, then laid out once the
  // fingers lift.
  function olImgReady() {
    const img = document.getElementById('ol-img');
    const a = img.naturalWidth / img.naturalHeight;
    if (!(a > 0)) return;
    if (Math.abs(a - OL.aspect) > 0.001 || !OL.fitW) { OL.aspect = a; olLayout(false); }
    else olLayout(true);
  }

  function olLayout(keep) {
    const st = document.getElementById('ol-stage');
    const sw = st.clientWidth, sh = st.clientHeight;
    if (!sw || !sh || !OL.aspect) return;
    const fitW = Math.max(100, Math.min(sw - 16, (sh - 16) * OL.aspect));
    if (keep && OL.fitW && OL.sw) {
      const bx = (OL.sw / 2 - OL.tx) / olW(), by = (OL.sh / 2 - OL.ty) / olH();
      OL.fitW = fitW;
      OL.s = Math.min(OL.s, olMaxS());
      OL.tx = sw / 2 - bx * olW(); OL.ty = sh / 2 - by * olH();
    } else {
      OL.fitW = fitW; OL.s = 1;
      OL.tx = (sw - olW()) / 2; OL.ty = (sh - olH()) / 2;
    }
    OL.sw = sw; OL.sh = sh;
    olClamp(); olApply(false);
  }

  const olMaxS = () => Math.max(2, OL_MAX_W / (OL.fitW || 1));

  // Keep the board on screen: centred while it fits, else no more than a margin of
  // empty stage past either edge (generous, so a hold on the board's edge can
  // still be brought to the middle, clear of the note and the magnifier).
  function olClamp() {
    const m = Math.min(OL.sw, OL.sh) * 0.4, w = olW(), h = olH();
    OL.tx = w <= OL.sw ? (OL.sw - w) / 2 : Math.min(m, Math.max(OL.sw - w - m, OL.tx));
    OL.ty = h <= OL.sh ? (OL.sh - h) / 2 : Math.min(m, Math.max(OL.sh - h - m, OL.ty));
  }

  function olApply(live) {
    const c = document.getElementById('ol-canvas');
    const w = olW();
    if (live && OL.cw) {
      c.style.transform = `translate(${OL.tx}px,${OL.ty}px) scale(${w / OL.cw})`;
      return;
    }
    if (Math.abs(w - OL.cw) > 0.01) {
      OL.cw = w;
      c.style.width = w + 'px';
      c.style.height = olH() + 'px';
      olRenderCur();                    // handle visibility depends on on-screen size
    }
    c.style.transform = `translate(${OL.tx}px,${OL.ty}px)`;
  }

  // Zoom to `s`, keeping the board point under stage coords (sx, sy) where it is.
  function olZoomAt(s, sx, sy) {
    const bx = (sx - OL.tx) / olW(), by = (sy - OL.ty) / olH();
    OL.s = Math.max(1, Math.min(olMaxS(), s));
    OL.tx = sx - bx * olW(); OL.ty = sy - by * olH();
    olClamp();
  }

  function olBBox(pts) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  function olZoomToHold(h) {
    if (!OL.fitW || !h) return;
    const pts = OL.shapes[h], pos = HOLD_MAP[h];
    const b = pts && pts.length >= 3 ? olBBox(pts)
      : pos ? { x0: pos.x - 2, x1: pos.x + 2, y0: pos.y - 2, y1: pos.y + 2 } : null;
    if (!b) return;
    const wPct = Math.max(3, (b.x1 - b.x0) * 2.6), hPct = Math.max(3, (b.y1 - b.y0) * 2.6);
    const fitH = OL.fitW / OL.aspect;
    OL.s = Math.max(1, Math.min(olMaxS(), Math.min(OL.sw / (OL.fitW * wPct / 100), OL.sh / (fitH * hPct / 100))));
    OL.tx = OL.sw / 2 - (b.x0 + b.x1) / 200 * olW();
    OL.ty = OL.sh / 2 - (b.y0 + b.y1) / 200 * olH();
    olClamp(); olApply(false);
  }

  function olFit() { OL.s = 1; olClamp(); olApply(false); }

  // Client coords → board % (the live transform included, so it's right mid-pinch too).
  function olPct(clientX, clientY) {
    const r = document.getElementById('ol-stage').getBoundingClientRect();
    return [(clientX - r.left - OL.tx) / olW() * 100, (clientY - r.top - OL.ty) / olH() * 100];
  }
  function olStageXY(clientX, clientY) {
    const r = document.getElementById('ol-stage').getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
  }

  // ── history ── (a snapshot is one hold's points, or the whole set for bulk actions)
  function olSnap(h) {
    return h === '*' ? { all: olClone(OL.shapes), smooth: OL.smooth, cur: OL.cur, sel: OL.sel }
                     : { h, pts: OL.shapes[h] ? olClone(OL.shapes[h]) : null, sel: OL.sel };
  }
  function olPush(h) {
    OL.undo.push(olSnap(h || olCurHold()));
    if (OL.undo.length > 300) OL.undo.shift();
    OL.redo.length = 0;
  }
  function olRestore(s) {
    if (s.all) {
      OL.shapes = s.all; OL.smooth = s.smooth;
      OL.cur = s.cur;
      document.getElementById('ol-smooth').value = OL.smooth;
    } else {
      if (s.pts) OL.shapes[s.h] = s.pts; else delete OL.shapes[s.h];
      const i = OL.holds.indexOf(s.h);
      if (i >= 0) OL.cur = i;
    }
    OL.sel = s.sel != null && olPts()[s.sel] ? s.sel : null;
    OL.drawing = olPts().length < 3;
  }
  function olUndoRedo(from, to) {
    if (!from.length) return;
    const s = from.pop();
    to.push(olSnap(s.all ? '*' : s.h));
    olRestore(s);
    olRenderStatic(); olRenderCur(); olStatus();
  }
  function olUndo() { olUndoRedo(OL.undo, OL.redo); }
  function olRedo() { olUndoRedo(OL.redo, OL.undo); }

  // ── rendering ──
  // Split in two: olRenderStatic() redraws the other 188 holds (on a hold switch or
  // a toggle), olRenderCur() just the hold being edited, so dragging stays smooth.
  function olRenderStatic() {
    if (!OL.ready) return;
    const h = olCurHold();
    const others = document.getElementById('ol-others');
    const dots = document.getElementById('ol-dots');
    const pv = document.getElementById('ol-preview');
    if (OL.preview) {
      others.innerHTML = ''; dots.innerHTML = '';
      olRenderPreview(true);
      return;
    }
    pv.innerHTML = ''; OL.previewKey = '';
    let paths = '', ds = '';
    OL.holds.forEach(g => {
      if (g === h) return;
      const pts = OL.shapes[g];
      if (pts && pts.length >= 3) {
        if (OL.showOthers) {
          const chg = !olSame(pts, OL.baseline[g]);
          paths += `<path class="ol-other${chg ? ' chg' : ''}" d="${smoothShapePath(pts, OL.smooth)}"/>`;
        }
      } else {
        const p = HOLD_MAP[g];
        if (p) ds += `<div class="ol-dot" style="left:${p.x}%;top:${p.y}%"></div>`;
      }
    });
    others.innerHTML = paths;
    dots.innerHTML = ds;
  }

  // The app's own renderer (core.js), fed the working outlines: what a phone will
  // show once this is published. null from holdShapeLayerHtml = the app would draw dots.
  function olPreviewHtml() {
    const roles = {};
    OL.holds.forEach(h => { roles[h] = OL.previewRole; });
    const saved = HOLD_SHAPES;
    let html;
    try { HOLD_SHAPES = olPayload(); html = holdShapeLayerHtml(roles, { dim: true }); }
    finally { HOLD_SHAPES = saved; }
    return { html: html || '', usable: html != null };
  }

  // Preview is a working mode, not a view: everything stays editable, and the app's
  // rendering is redrawn whenever the current outline settles (not on every frame
  // of a drag — the gold outline tracks the finger meanwhile). Other holds only
  // change through bulk actions, which go through olRenderStatic (force).
  function olRenderPreview(force) {
    const key = [OL.cur, OL.smooth, OL.previewRole, JSON.stringify(olPts())].join('|');
    if (!force && key === OL.previewKey) return;
    OL.previewKey = key;
    const r = olPreviewHtml();
    document.getElementById('ol-preview').innerHTML = r.html;
    OL.previewUsable = r.usable;
  }
  const olDragging = () => !!(OL.gesture && OL.gesture.moved && (OL.gesture.type === 'vtx' || OL.gesture.type === 'poly'));

  function olMids(pts) {
    const pxX = OL.cw / 100, pxY = OL.cw / (OL.aspect || 1) / 100, out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot((b[0] - a[0]) * pxX, (b[1] - a[1]) * pxY) >= OL_MID_MIN) {
        out.push({ after: i, pt: [olR2((a[0] + b[0]) / 2), olR2((a[1] + b[1]) / 2)] });
      }
    }
    return out;
  }

  // Too small on screen to grab a point accurately — ask for a zoom instead.
  function olTiny(pts) {
    if (pts.length < 3 || !OL.cw) return false;
    const b = olBBox(pts);
    return Math.max((b.x1 - b.x0) * OL.cw / 100, (b.y1 - b.y0) * OL.cw / OL.aspect / 100) < OL_TINY;
  }

  function olRenderCur() {
    if (!OL.ready) return;
    const h = olCurHold(), pts = olPts();
    let svg = '', html = '';
    const ptsStr = pts.map(p => p[0] + ',' + p[1]).join(' ');
    // In preview the app's own drawing shows the settled outline, so the gold one
    // only appears while a drag is moving it.
    const gold = !OL.preview || olDragging();
    if (pts.length >= 3) {
      svg = `<polygon class="ol-skel" points="${ptsStr}"/>`
        + (gold ? `<path class="ol-poly" d="${smoothShapePath(pts, OL.smooth)}"/>` : '');
    } else if (pts.length === 2) {
      svg = `<polyline class="ol-poly open" points="${ptsStr}"/>`;
    }
    if (!olTiny(pts)) {
      pts.forEach((p, i) => { html += `<div class="ol-v${i === OL.sel ? ' sel' : ''}" style="left:${p[0]}%;top:${p[1]}%"></div>`; });
      if (!OL.drawing) olMids(pts).forEach(m => { html += `<div class="ol-m" style="left:${m.pt[0]}%;top:${m.pt[1]}%"></div>`; });
    }
    const c = HOLD_MAP[h];
    if (c) html += `<div class="ol-x" style="left:${c.x}%;top:${c.y}%"></div>`;
    if (OL.preview && !olDragging()) olRenderPreview(false);
    document.getElementById('ol-cur').innerHTML = svg;
    document.getElementById('ol-handles').innerHTML = html;

    document.getElementById('ol-undo').disabled = !OL.undo.length;
    document.getElementById('ol-redo').disabled = !OL.redo.length;
    document.getElementById('ol-del').disabled = OL.sel == null;
    const pvb = document.getElementById('ol-preview-btn');
    pvb.classList.toggle('on', OL.preview);
    pvb.setAttribute('aria-pressed', OL.preview ? 'true' : 'false');
    const jump = document.getElementById('ol-jump');
    if (jump.value !== String(OL.cur)) jump.value = String(OL.cur);
    olNote();
  }

  // One message at a time over the top of the board, most important first.
  function olNote() {
    const pts = olPts();
    if (!olVersionOk()) return olSetNote('These outlines were traced against a different board, so the app ignores them. Publishing is off.');
    if (OL.staleDraft) return olSetNote('Someone published outlines since this draft was saved. Publishing overwrites theirs.', 'Discard my draft');
    if (OL.drawing) {
      return olSetNote(pts.length
        ? `Tap around ${gridName(holdNum(olCurHold()))} to outline it · ${pts.length} point${pts.length === 1 ? '' : 's'}`
        : `${gridName(holdNum(olCurHold()))} has no outline. Tap around the hold to draw one.`,
        pts.length >= 3 ? 'Done' : '');
    }
    if (OL.preview) {
      const names = { int: 'blue', start: 'green', finish: 'red' };
      return olSetNote(OL.previewUsable ? 'Preview: as the app draws it'
                                        : 'The app would show dots: these outlines don’t match the live board',
                       'Colour: ' + names[OL.previewRole]);
    }
    if (olTiny(pts)) return olSetNote('Pinch or double-tap to zoom in and edit the points');
    olSetNote('');
  }
  function olSetNote(text, btn) {
    const note = document.getElementById('ol-note');
    if (!note) return;
    note.hidden = !text;
    document.getElementById('ol-note-text').textContent = text || '';
    const b = document.getElementById('ol-note-btn');
    b.hidden = !btn;
    b.textContent = btn || '';
  }
  function olNoteAction() {
    if (!olVersionOk()) {
      /* no action */
    } else if (OL.staleDraft) {
      olDiscardAll();
    } else if (OL.drawing && olPts().length >= 3) {
      OL.drawing = false; OL.sel = null;
      olRenderCur();
    } else if (OL.preview) {
      const order = ['int', 'start', 'finish'];
      OL.previewRole = order[(order.indexOf(OL.previewRole) + 1) % order.length];
      olRenderStatic(); olRenderCur();
    }
  }

  // Changed count, Publish button, hold picker and the draft save: all 189 outlines
  // get compared, so this runs a beat after edits settle, not on every pointermove.
  function olScheduleStatus() { clearTimeout(OL.statusT); OL.statusT = setTimeout(olStatus, 200); }
  function olStatus() {
    clearTimeout(OL.statusT);
    if (!OL.ready) return;
    const chg = olChanged(), smoothChg = olSmoothChanged();
    const pub = document.getElementById('ol-publish');
    pub.disabled = OL.publishing || !(chg.length || smoothChg) || !olVersionOk();
    pub.textContent = OL.publishing ? 'Publishing…'
      : chg.length ? `Publish ${chg.length} change${chg.length === 1 ? '' : 's'}`
      : smoothChg ? 'Publish roundness' : 'Published ✓';
    const chgSet = new Set(chg);
    document.getElementById('ol-jump').innerHTML = OL.holds.map((h, i) => {
      const pts = OL.shapes[h];
      const tag = chgSet.has(h) ? ' • changed' : (!pts || pts.length < 3) ? ' — no outline' : '';
      return `<option value="${i}">${olLabel(h)}${tag}</option>`;
    }).join('');
    document.getElementById('ol-jump').value = String(OL.cur);
    const sv = document.getElementById('ol-smooth-val');
    sv.textContent = OL.smooth.toFixed(2);
    sv.classList.toggle('chg', smoothChg);
    document.getElementById('ol-smooth').value = OL.smooth;
    const oth = document.getElementById('ol-m-others');
    if (oth) oth.textContent = OL.showOthers ? 'Hide other outlines' : 'Show other outlines';
    document.getElementById('ol-m-revert').disabled = olSame(OL.shapes[olCurHold()], OL.baseline[olCurHold()]);
    document.getElementById('ol-m-discard').disabled = !olDirty();
    olSaveDraft();
  }

  // Coalesce redraws while dragging to one per frame.
  function olFrame() {
    if (OL.raf) return;
    OL.raf = requestAnimationFrame(() => { OL.raf = 0; olRenderCur(); });
  }

  // ── navigation ──
  function olGoTo(idx, keepView) {
    if (!OL.ready) return;
    OL.cur = (idx + OL.holds.length) % OL.holds.length;
    OL.sel = null;
    OL.drawing = olPts().length < 3;
    olRenderStatic(); olRenderCur(); olScheduleStatus();
    if (!keepView) olZoomToHold(olCurHold());
  }
  function olNextUntraced() {
    for (let i = 1; i <= OL.holds.length; i++) {
      const idx = (OL.cur + i) % OL.holds.length;
      if ((OL.shapes[OL.holds[idx]] || []).length < 3) return olGoTo(idx);
    }
    showToast('Every hold has an outline', 'success');
  }

  // ── hit testing (screen px) ──
  function olHitHandle(clientX, clientY) {
    const pts = olPts();
    if (olTiny(pts)) return null;
    const [x, y] = olPct(clientX, clientY);
    const pxX = olW() / 100, pxY = olH() / 100;
    const dist = p => Math.hypot((p[0] - x) * pxX, (p[1] - y) * pxY);
    let best = null;
    pts.forEach((p, i) => {
      const d = dist(p);
      if (d <= OL_HIT && (!best || d < best.d)) best = { kind: 'vtx', i, d };
    });
    if (!OL.drawing) {
      olMids(pts).forEach(m => {
        const d = dist(m.pt) + 4;           // a point beats an edge handle at the same distance
        if (d <= OL_HIT + 4 && (!best || d < best.d)) best = { kind: 'mid', after: m.after, pt: m.pt, d };
      });
    }
    return best;
  }

  function olInPoly(pts, x, y) {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  // The hold under a tap: the current outline, another outline, else the nearest
  // hold centre within reach (holds with no outline yet only have their centre).
  function olHoldAt(x, y) {
    const cur = olCurHold(), pts = olPts();
    if (pts.length >= 3 && olInPoly(pts, x, y)) return cur;
    for (const g of OL.holds) {
      const p = OL.shapes[g];
      if (g !== cur && p && p.length >= 3 && olInPoly(p, x, y)) return g;
    }
    const pxX = olW() / 100, pxY = olH() / 100;
    let best = null, bestD = OL_HIT * 1.6;
    OL.holds.forEach(g => {
      const c = HOLD_MAP[g];
      if (!c) return;
      const d = Math.hypot((c.x - x) * pxX, (c.y - y) * pxY);
      if (d <= bestD) { bestD = d; best = g; }
    });
    return best;
  }

  // ── pointers ──
  function olDown(e) {
    if (!OL.ready || !OL.cw) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const stage = document.getElementById('ol-stage');
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    OL.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (OL.ptrs.size === 2) { olCancelGesture(); olStartPinch(); return; }
    if (OL.ptrs.size > 2) return;

    const g = { type: 'tap', id: e.pointerId, sx: e.clientX, sy: e.clientY, tx: OL.tx, ty: OL.ty,
                touch: e.pointerType !== 'mouse', moved: false, pushed: false };
    if (e.button === 1) g.type = 'pan';
    else {
      const [x, y] = olPct(e.clientX, e.clientY);
      g.x = x; g.y = y;
      const hit = olHitHandle(e.clientX, e.clientY);
      const pts = olPts();
      if (hit && hit.kind === 'vtx') {
        olPush(); g.pushed = true;
        OL.sel = hit.i;
        Object.assign(g, { type: 'vtx', i: hit.i, start: pts[hit.i].slice() });
        olRenderCur();
      } else if (hit && hit.kind === 'mid') {
        Object.assign(g, { type: 'mid', after: hit.after, start: hit.pt.slice() });
      } else if (!OL.drawing && pts.length >= 3 && olInPoly(pts, x, y)) {
        Object.assign(g, { type: 'poly', startPts: olClone(pts) });
      }
    }
    OL.gesture = g;
  }

  function olMove(e) {
    if (!OL.ptrs.has(e.pointerId)) return;
    OL.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = OL.gesture;
    if (!g) return;
    e.preventDefault();
    if (g.type === 'pinch') { olPinchMove(); return; }
    if (e.pointerId !== g.id) return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < OL_SLOP) return;
      g.moved = true;
      if (g.type === 'mid') {             // dragging an edge handle inserts a point there
        olPush(); g.pushed = true;
        OL.shapes[olCurHold()].splice(g.after + 1, 0, g.start.slice());
        OL.sel = g.after + 1;
        g.type = 'vtx'; g.i = OL.sel;
      } else if (g.type === 'poly') {
        olPush(); g.pushed = true;
        OL.sel = null;
      } else if (g.type === 'tap') {
        g.type = 'pan';
      }
    }
    const h = olCurHold();
    const ddx = dx / (olW() / 100), ddy = dy / (olH() / 100);
    if (g.type === 'vtx') {
      const p = [olR2(g.start[0] + ddx), olR2(g.start[1] + ddy)];
      OL.shapes[h][g.i] = p;
      if (g.touch) olLoupe(e.clientX, e.clientY, p);
      olFrame();
    } else if (g.type === 'poly') {
      OL.shapes[h] = g.startPts.map(p => [olR2(p[0] + ddx), olR2(p[1] + ddy)]);
      olFrame();
    } else if (g.type === 'pan') {
      OL.tx = g.tx + dx; OL.ty = g.ty + dy;
      olClamp(); olApply(false);
    }
  }

  function olUp(e) {
    if (!OL.ptrs.has(e.pointerId)) return;
    OL.ptrs.delete(e.pointerId);
    const g = OL.gesture;
    if (!g) return;
    if (g.type === 'pinch' || g.type === 'dead') {
      // Lifting one finger of a pinch doesn't hand over to a drag; wait for both.
      if (g.type === 'pinch') { olApply(false); OL.gesture = { type: 'dead' }; }
      if (!OL.ptrs.size) OL.gesture = null;
      return;
    }
    if (e.pointerId !== g.id) return;
    OL.gesture = null;
    olLoupe(null);
    if (e.type === 'pointercancel' && !g.moved) {
      if (g.pushed) OL.undo.pop();
      olRenderCur();
      return;
    }
    if (!g.moved) {
      if (g.type === 'vtx') { OL.undo.pop(); olRenderCur(); return; }   // a tap on a point just selects it
      if (g.type === 'mid') {                                          // a tap on an edge handle adds a point
        olPush();
        OL.shapes[olCurHold()].splice(g.after + 1, 0, g.start.slice());
        OL.sel = g.after + 1;
        olRenderCur(); olScheduleStatus();
        return;
      }
      if (g.type === 'poly' || g.type === 'tap') olTap(g);
      return;
    }
    if (g.type === 'vtx' || g.type === 'poly') {
      if (g.type === 'poly') olRenderStatic();
      olRenderCur(); olScheduleStatus();
    }
  }

  function olTap(g) {
    const now = Date.now();
    const dbl = !!(OL.lastTap && now - OL.lastTap.t < 350 && Math.hypot(g.sx - OL.lastTap.x, g.sy - OL.lastTap.y) < 30);
    OL.lastTap = dbl ? null : { t: now, x: g.sx, y: g.sy };
    if (OL.drawing) {
      const h = olCurHold();
      olPush();
      (OL.shapes[h] = OL.shapes[h] || []).push([olR2(g.x), olR2(g.y)]);
      OL.sel = OL.shapes[h].length - 1;
      olRenderCur(); olScheduleStatus();
      return;
    }
    const h = olHoldAt(g.x, g.y);
    if (dbl) { olZoomToHold(h || olCurHold()); return; }
    if (h && h !== olCurHold()) { olGoTo(OL.holds.indexOf(h), true); return; }
    OL.sel = null;
    olRenderCur();
  }

  // A second finger turns whatever the first was doing into a pinch; an edit it had
  // already started is rolled back.
  function olCancelGesture() {
    const g = OL.gesture;
    OL.gesture = null;
    olLoupe(null);
    if (g && g.pushed && OL.undo.length) {
      olRestore(OL.undo.pop());
      olRenderStatic(); olRenderCur();
    }
  }
  function olStartPinch() {
    const [a, b] = [...OL.ptrs.values()];
    const [mx, my] = olStageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
    OL.gesture = { type: 'pinch', d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                   bx: (mx - OL.tx) / olW(), by: (my - OL.ty) / olH(), s0: OL.s };
  }
  function olPinchMove() {
    const g = OL.gesture, pts = [...OL.ptrs.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const [mx, my] = olStageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
    OL.s = Math.max(1, Math.min(olMaxS(), g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0));
    OL.tx = mx - g.bx * olW(); OL.ty = my - g.by * olH();   // the pinched point follows the fingers
    olClamp(); olApply(true);
  }

  function olWheel(e) {
    if (!OL.ready || !OL.cw) return;
    e.preventDefault();
    const [sx, sy] = olStageXY(e.clientX, e.clientY);
    olZoomAt(OL.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), sx, sy);
    olApply(false);
  }

  // Right-click a point to delete it (desktop).
  function olContextMenu(e) {
    e.preventDefault();
    const hit = olHitHandle(e.clientX, e.clientY);
    if (hit && hit.kind === 'vtx') { OL.sel = hit.i; olDeletePoint(); }
  }

  // The magnifier, held above the finger so the point being dragged isn't hidden.
  function olLoupe(clientX, clientY, p) {
    const lp = document.getElementById('ol-loupe');
    if (clientX == null) { lp.hidden = true; return; }
    const L = 120, MAG = 2.5;
    const [sx, sy] = olStageXY(clientX, clientY);
    const up = sy - 80 - L / 2 > 4;
    lp.style.left = Math.max(4, Math.min(OL.sw - L - 4, sx - L / 2)) + 'px';
    lp.style.top = (up ? sy - 80 - L : sy + 80) + 'px';
    const w = olW() * MAG, h = olH() * MAG;
    const img = document.getElementById('ol-loupe-img');
    img.style.width = w + 'px'; img.style.height = h + 'px';
    img.style.left = (L / 2 - p[0] / 100 * w) + 'px';
    img.style.top = (L / 2 - p[1] / 100 * h) + 'px';
    const vw = L / w * 100, vh = L / h * 100;
    const svg = document.getElementById('ol-loupe-svg');
    svg.setAttribute('viewBox', `${p[0] - vw / 2} ${p[1] - vh / 2} ${vw} ${vh}`);
    const pts = olPts();
    svg.innerHTML = pts.length >= 3 ? `<path d="${smoothShapePath(pts, OL.smooth)}"/>` : '';
    lp.hidden = false;
  }

  // ── edits ──
  // Move the selected point, or the whole outline when none is selected.
  function olNudge(dx, dy, push = true) {
    const h = olCurHold(), pts = OL.shapes[h];
    if (!pts || !pts.length) return;
    if (push) olPush();
    if (OL.sel != null && pts[OL.sel]) pts[OL.sel] = [olR2(pts[OL.sel][0] + dx), olR2(pts[OL.sel][1] + dy)];
    else OL.shapes[h] = pts.map(p => [olR2(p[0] + dx), olR2(p[1] + dy)]);
    olRenderCur(); olScheduleStatus();
  }

  function olDeletePoint() {
    const h = olCurHold(), pts = OL.shapes[h];
    if (!pts || OL.sel == null || !pts[OL.sel]) return;
    olPush();
    pts.splice(OL.sel, 1);
    if (!pts.length) delete OL.shapes[h];
    OL.sel = null;
    if (olPts().length < 3) OL.drawing = true;
    olRenderCur(); olScheduleStatus();
  }

  function olRedraw() {
    const h = olCurHold();
    if (OL.shapes[h]) olPush();
    delete OL.shapes[h];
    OL.sel = null; OL.drawing = true;
    olRenderStatic(); olRenderCur(); olStatus();
    olZoomToHold(h);
  }

  function olRevertHold() {
    const h = olCurHold();
    if (olSame(OL.shapes[h], OL.baseline[h])) return;
    olPush();
    if (OL.baseline[h]) OL.shapes[h] = olClone(OL.baseline[h]); else delete OL.shapes[h];
    OL.sel = null; OL.drawing = olPts().length < 3;
    olRenderCur(); olStatus();
    showToast(`${gridName(holdNum(h))} is back to the published outline`, 'success');
  }

  function olDiscardAll() {
    if (!olDirty()) { OL.staleDraft = false; olRenderCur(); return; }
    olPush('*');
    OL.shapes = olClone(OL.baseline);
    OL.smooth = OL.publishedSmooth;
    OL.sel = null; OL.drawing = olPts().length < 3; OL.staleDraft = false;
    olRenderStatic(); olRenderCur(); olStatus();
    showToast('Changes discarded — Undo brings them back', 'success');
  }

  // Replace the working set with the copy shipped in the app (app/hold_shapes.json,
  // e.g. after a register_shapes.py run was deployed), to review and publish.
  async function olLoadShipped() {
    let j = null;
    try {
      const res = await fetch('hold_shapes.json', { cache: 'no-cache' });
      if (res.ok) j = await res.json();
    } catch (err) { /* offline */ }
    if (!j || typeof j !== 'object') { showToast('Couldn’t load the shipped copy', 'error'); return; }
    const ver = j.__meta && j.__meta.board_updated_at;
    if (ver !== boardConfigVersion) { showToast('The shipped copy belongs to a different board version', 'error'); return; }
    olPush('*');
    OL.shapes = olStrip(j);
    if (olOkSmooth(j.__meta.smooth)) OL.smooth = j.__meta.smooth;
    OL.sel = null; OL.drawing = olPts().length < 3;
    olRenderStatic(); olRenderCur(); olStatus();
    showToast('Loaded the shipped copy — review, then Publish', 'success');
  }

  function olSetSmooth(v) {
    const s = olR2(parseFloat(v));
    if (!olOkSmooth(s) || s === OL.smooth) return;
    // One undo step per drag of the slider, not one per tick.
    const top = OL.undo[OL.undo.length - 1];
    if (!(top && top.all && top.smoothOnly && Date.now() - top.t < 1500)) {
      olPush('*');
      Object.assign(OL.undo[OL.undo.length - 1], { smoothOnly: true });
    }
    OL.undo[OL.undo.length - 1].t = Date.now();
    OL.smooth = s;
    document.getElementById('ol-smooth-val').textContent = s.toFixed(2);
    olRenderStatic(); olRenderCur(); olScheduleStatus();
  }

  // Leaves the zoom, the pan, the hold and the selected point exactly as they are.
  function olTogglePreview() {
    OL.preview = !OL.preview;
    olRenderStatic(); olRenderCur();
  }
  function olToggleOthers() {
    OL.showOthers = !OL.showOthers;
    olRenderStatic(); olStatus();
  }

  // ── publish ──
  function olPayload() {
    const out = {};
    // __meta.board_updated_at pins the set to the board it was traced on; without
    // it the app refuses the whole set.
    if (OL.meta) out.__meta = Object.assign({}, OL.meta, { smooth: OL.smooth });
    OL.holds.forEach(h => { const p = OL.shapes[h]; if (p && p.length >= 3) out[h] = p; });
    return out;
  }

  async function olPublish() {
    if (OL.publishing || !olDirty()) return;
    if (!olVersionOk()) { showToast('These outlines belong to a different board', 'error'); return; }
    const out = olPayload();
    const n = Object.keys(out).length - 1;
    if (n < 1) { showToast('Nothing to publish', 'error'); return; }
    OL.publishing = true; olStatus();
    try {
      // hold_shapes ONLY: updated_at is the board version these outlines are pinned
      // to, and bumping it would retire the very outlines being published. .select()
      // because an update RLS blocks returns no error, just no rows.
      const { data, error } = await sb.from('board_config')
        .update({ hold_shapes: out }).eq('wall', 'HangoutPortland').select('wall');
      if (error) throw error;
      if (!data || !data.length) throw Object.assign(new Error('not admin'), { code: '42501' });
      HOLD_SHAPES = olClone(out);
      configHasShapes = true;
      OL.baseline = olStrip(olClone(out));
      OL.meta = Object.assign({}, out.__meta);
      OL.publishedSmooth = OL.smooth;
      OL.staleDraft = false;
      OL.srcKey = 'live|' + boardConfigVersion;
      showToast(`Published ${n} outlines — live on everyone’s next load`, 'success');
    } catch (err) {
      console.error('outline publish failed', err);
      showToast(err && err.code === '42501' ? 'Only admins can publish outlines' : 'Publish failed — check connection', 'error');
    }
    OL.publishing = false;
    olRenderStatic(); olRenderCur(); olStatus();
  }

  // ── desktop keys ──
  function olKey(e) {
    if (currentView !== 'outlines' || !OL.ready) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? olRedo() : olUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); olRedo(); return; }
    if (mod || e.target.type === 'range') return;
    const step = e.shiftKey ? OL_NUDGE * 10 : e.altKey ? OL_NUDGE / 5 : OL_NUDGE;
    const keys = {
      ArrowLeft: () => olNudge(-step, 0), ArrowRight: () => olNudge(step, 0),
      ArrowUp: () => olNudge(0, -step), ArrowDown: () => olNudge(0, step),
      Delete: olDeletePoint, Backspace: olDeletePoint,
      Escape: () => { OL.sel = null; olRenderCur(); },
      n: () => olGoTo(OL.cur + 1), p: () => olGoTo(OL.cur - 1),
      f: () => olZoomToHold(olCurHold()), 0: olFit,
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
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


