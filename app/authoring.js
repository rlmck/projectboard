// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, challenge, leaderboard, wall, trace, setup, holdedit, app. This file: create-a-problem (and Edit), the live LEDs while setting, who may do what, and circuit helpers.

  // ── Create a problem ──────────────────────────────────────────────────────────
  // The create view is laid out like the problem view: pinned, the same title
  // block (the name is typed in place as the title, the grade is the badge, tap
  // it for the grade sheet) and the board in the same place. The wall is dimmed
  // to the problem view's level with every hold left bright, and a strip under
  // the board shows what's set and what
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
      if (!isHandHold(h)) continue;                 // the finish zone: hand holds only
      const y = HOLD_MAP[h].y;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    return ymin + (ymax - ymin) * 0.25;
  }
  function inTopZone(h) {
    return !!(HOLD_MAP && HOLD_MAP[h]) && HOLD_MAP[h].y <= topZoneThreshold();
  }

  // Draw the board (dimmed wall, bright holds, the assigned ones outlined in their
  // role colour) and refresh the progress strip. The finish zone still applies
  // (cycleHold) but isn't drawn on the board (2 Nov 2026).
  // The board's layer: the holds' outlines (or dots). The phone's create view and
  // the wall screen's Create page both draw it.
  function createLayerHtml() {
    const svg = holdShapeLayerHtml(createRoles, { mirror: false, dim: true, lightAll: true, feet: createFeetHolds });
    // Without traced outlines (an old board version), fall back to dots.
    return (svg != null) ? svg : Object.keys(createRoles).map(h => {
      const pos = HOLD_MAP && HOLD_MAP[h];
      if (!pos) return '';
      return `<div class="hold-dot ${createRoles[h]}" style="left:${pos.x}%;top:${pos.y}%"></div>`;
    }).join('') + footDotsHtml(createFeetHolds);
  }

  function applyCreateRoles() {
    const layer = document.getElementById('create-hold-layer');
    if (layer) layer.innerHTML = createLayerHtml();
    updateCreateStatus();
    if (WALL) wallCreateRender();
  }

  // The steps (start, holds, finish), each ticked off when it's right, and one
  // line saying what to do next. nameHint: where the name is typed.
  function createStatus(name, nameHint) {
    const s = holdsWithRole('start').length, i = holdsWithRole('int').length, f = holdsWithRole('finish').length;
    const step = (cls, n, label, done) =>
      `<span class="create-step ${cls}${done ? ' done' : ''}"><i></i>${n} ${label}</span>`;
    return {
      steps: step('c-start', s, 'start', s >= 1 && s <= 2) +
             step('c-int', i, i === 1 ? 'hold' : 'holds', i >= 1) +
             step('c-finish', f, 'finish', f === 1),
      next: !HOLD_MAP ? 'Loading the board…'          // taps wait for the hold map
        : !s ? 'Tap a start hold, low on the wall'
        : !i ? 'Now tap the holds in between'
        : !f ? 'Tap a finish-zone hold twice to finish'
        : !name ? nameHint
        : !createGrade ? 'Pick a grade'
        : null,
      ready: !!(s && i && f && name && createGrade)
    };
  }

  // The strip under the board on the phone.
  function updateCreateStatus() {
    const steps = document.getElementById('create-steps');
    const next = document.getElementById('create-next');
    if (!steps || !next) return;
    const name = (document.getElementById('create-name').value || '').trim();
    const st = createStatus(name, 'Name it at the top');
    steps.innerHTML = st.steps;
    next.textContent = st.next === 'Pick a grade' ? 'Tap Grade to pick one'
      : st.next || (editingProblemId ? 'Ready — tap ✓ to save your changes' : 'Ready — tap ✓ to save');
    next.classList.toggle('ready', st.ready);
    const undo = document.getElementById('create-undo');
    if (undo) undo.disabled = !createUndo.length;
    if (fsOpen) fsUpdateBar();   // the fullscreen bar shows the same counts
  }

  // A tap on Create's board (the phone's, in or out of the viewer, or the wall's).
  // A hand hold cycles, a foothold (Specific feet) is picked or dropped: hitHold() in
  // core.js, with footholds.
  function createTap(clientX, clientY, boardEl = document.getElementById('create-board')) {
    const pick = hitHold(boardEl, clientX, clientY, { kinds: ['hand', 'foot'] });
    if (!pick) return;
    if (pick.foot) toggleFootHold(pick.id);
    else cycleHold(pick.id);
  }

  // Remember the holds and the feet as they are, for Undo (capped; it's a phone).
  const createSnap = () => ({ roles: { ...createRoles }, feet: createFeet, feetHolds: createFeetHolds.slice() });
  function pushCreateUndo(snap = createSnap()) {
    createUndo.push(snap);
    if (createUndo.length > 60) createUndo.shift();
  }
  function undoCreate() {
    if (!createUndo.length) return;
    const snap = createUndo.pop();
    createRoles = snap.roles;
    createFeet = snap.feet;
    createFeetHolds = snap.feetHolds;
    updateCreateFeet();
    applyCreateRoles();
    previewEdited();
  }

  // Specific feet: a tap on a foothold adds it (yellow outline) or takes it off.
  // The first one makes the problem Specific feet (dropping Orange or Black only);
  // taking the last one off makes it Any feet again. Footholds are never lit and
  // Specific feet lights no sign, so the board only hears about it when a sign
  // goes off (Orange or Black only -> Specific feet).
  function toggleFootHold(f) {
    const i = createFeetHolds.indexOf(f);
    if (i < 0 && createFeetHolds.length >= FEET_MAX) {
      showToast(`Specific feet: ${FEET_MAX} footholds at most`, 'error');
      return;
    }
    const before = createFeet;
    pushCreateUndo();
    createFeetHolds = i >= 0 ? createFeetHolds.filter(x => x !== f) : createFeetHolds.concat(f);
    createFeet = createFeetHolds.length ? 'specific' : 'any';
    const signOff = before === 'orange' || before === 'black';
    if (signOff) showToast(`Specific feet now: ${feetLabel(before)} is off`, 'success');
    updateCreateFeet();
    applyCreateRoles();
    if (signOff) previewEdited();
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
    previewEdited();
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

  // The feet rule: three options side by side (under the phone's board, in the
  // wall's panel).
  // With Specific feet none of the three is chosen, and a line under them says
  // how many footholds are picked (or that the limit is reached).
  function updateCreateFeet() {
    document.querySelectorAll('#create-feet .feet-opt, #wall-c-feet .feet-opt').forEach(b =>
      b.setAttribute('aria-checked', b.dataset.feet === createFeet ? 'true' : 'false'));
    const n = createFeetHolds.length;
    const text = !n ? ''
      : n >= FEET_MAX ? `Specific feet (${n}): that’s the most a problem can have`
      : `Specific feet (${n}): tap a yellow one again to drop it`;
    let moved = false;
    document.querySelectorAll('#create-feet-note, #wall-c-feet-note').forEach(el => {
      el.textContent = text;
      if (el.hidden !== !n) { el.hidden = !n; moved = true; }
    });
    if (moved && currentView === 'create') requestAnimationFrame(fitCreateStatus);   // the strip grew or shrank
  }
  // Any, Orange only or Black only. With footholds picked (Specific feet) it
  // clears them, with a note; Undo brings them back.
  function setCreateFeet(k) {
    if (!FEET_RULES.some(r => r.key === k)) return;
    const changed = k !== createFeet;
    if (createFeetHolds.length) {
      const n = createFeetHolds.length;
      pushCreateUndo();
      createFeetHolds = [];
      applyCreateRoles();
      showToast(`${n} foothold${n === 1 ? '' : 's'} cleared · Undo brings ${n === 1 ? 'it' : 'them'} back`, 'success');
    }
    createFeet = k;
    updateCreateFeet();
    if (changed) previewEdited();   // the feet sign lights with the holds
  }

  // Create and Edit share one screen; these say which it is (the title, the save
  // button's name, the bin's, the benchmark warning).
  function setCreateMode(editing) {
    setCreateTitle(editing ? 'Edit problem' : 'New problem');
    const save = document.getElementById('create-save');
    if (save) save.setAttribute('aria-label', editing ? 'Save changes' : 'Save problem');
    const bin = document.getElementById('create-reset');
    if (bin) bin.setAttribute('aria-label', editing ? 'Undo all changes' : 'Clear all holds');
    const warn = document.getElementById('create-warn');
    if (warn) warn.hidden = !(editing && editing.is_benchmark);
  }

  function resetCreate() {
    createRoles = {}; createGrade = ''; editingProblemId = null; createUndo = []; createEditBase = '';
    createFeet = 'any'; createFeetHolds = []; updateCreateFeet();
    const nameEl = document.getElementById('create-name');
    if (nameEl) nameEl.value = '';
    setCreateMode(null);
    buildCreateGrades();
    applyCreateRoles();
  }

  // What an Edit has on screen, as one string: equal strings = nothing changed.
  function problemEditKey() {
    const nameEl = document.getElementById('create-name');
    const roles = Object.keys(createRoles).sort().map(h => h + ':' + createRoles[h]).join(',');
    return JSON.stringify([((nameEl && nameEl.value) || '').trim(), createGrade, createFeet, roles,
                           createFeetHolds.slice().sort().join(',')]);
  }
  const problemEditDirty = () => !!editingProblemId && problemEditKey() !== createEditBase;

  // Seed the create form from an existing problem: Edit (an admin, or the owner
  // while nobody else has ticked it; db/39) changes its holds, name, grade and feet
  // rule in one go. Roles come from the canonical (un-inverted) order —
  // problemHoldOrder + classifyHolds is the exact round-trip the renderer uses, so
  // loading can't drift from how saveProblem re-inverts on the way out. The setter
  // is never editable.
  function seedEdit(p) {
    editingProblemId = String(p.id);
    const order = problemHoldOrder(p);
    const cls = classifyHolds(order);
    createRoles = {};
    createUndo = [];
    // The feet signs (B1/B2) were listed as holds in problems migrated before
    // db/33; they're the feet rule now, never holds.
    order.forEach(h => { if (!FEET_LIGHT_HOLDS.has(h)) createRoles[h] = cls[h]; });
    createGrade = p.grade || '';
    createFeet = feetRule(p);
    createFeetHolds = problemFeetHolds(p);
    updateCreateFeet();
    const nameEl = document.getElementById('create-name');
    if (nameEl) nameEl.value = p.name || '';
    setCreateMode(p);
    createEditBase = problemEditKey();
  }

  // Prepare the create view on entry. With an editId (Edit) seed from that problem
  // as we land on it; the router running again while the edit is open (data
  // arriving) keeps the changes in progress. No editId = fresh create.
  function initCreateView(editId) {
    if (editId) {
      const same = String(editingProblemId) === String(editId);
      if (!same || (currentView !== 'create' && !problemEditDirty())) {
        const p = allProblems.find(x => String(x.id) === String(editId));
        if (!p) {   // not loaded yet (deep link / refresh) — bounce to its detail, which loads it
          redirectRoute('#detail/' + encodeURIComponent(editId));
          return;
        }
        seedEdit(p);
        // An owner: check (fresh) that nobody else has ticked it since; if someone
        // has, it's admin-only now, so back to the problem.
        if (!isAdmin() && session) {
          askOthersUsed('p', p.id, used => {
            if (used !== true || currentView !== 'create' || String(editingProblemId) !== String(p.id)) return;
            showToast('Someone else has ticked this, so only an admin can edit it now', 'error');
            resetCreate();
            redirectRoute('#detail/' + encodeURIComponent(p.id));
          });
        }
      }
    } else if (editingProblemId) {
      resetCreate();   // leaving an edit for a fresh create — start blank
    }
    buildCreateGrades();
    applyCreateRoles();
    requestAnimationFrame(fitCreateStatus);   // once the view is showing
  }

  // The strip under the board (feet rule, steps, what next) normally floats in the
  // space the problem view leaves empty there, so the board sits exactly where it
  // does on a problem. On a short or wide screen that space is too small and the
  // strip would cover the lowest holds (the starts); then it joins the layout
  // instead, and the board moves up to make room. Re-checked on resize and when the
  // board image loads.
  function fitCreateStatus() {
    if (currentView !== 'create') return;
    const main = document.querySelector('#view-create main');
    const board = document.getElementById('create-board');
    const status = document.querySelector('#view-create .create-status');
    if (!main || !board || !status) return;
    main.classList.remove('status-stacked');
    if (status.getBoundingClientRect().top < board.getBoundingClientRect().bottom) {
      main.classList.add('status-stacked');
    }
  }

  // The header bin. In edit mode it reverts to the problem as saved (holds, name,
  // grade, feet rule: discard your edits); in create mode it clears the holds.
  // Either way Undo brings the holds back.
  // Specific feet's footholds go with the holds (and come back with Undo).
  function onCreateReset() {
    const before = createSnap();
    if (editingProblemId) {
      const p = allProblems.find(x => String(x.id) === String(editingProblemId));
      if (p) {
        seedEdit(p);
        createUndo = [before];
        buildCreateGrades(); applyCreateRoles(); return;
      }
    }
    if (!Object.keys(createRoles).length && !createFeetHolds.length) return;
    pushCreateUndo(before);
    createRoles = {};
    if (createFeetHolds.length) { createFeetHolds = []; createFeet = 'any'; updateCreateFeet(); }
    applyCreateRoles();
    previewEdited();
  }

  // A save that's missing something says so in a toast and takes you to it.
  function createMissing(msg, then) {
    showToast(msg, 'error');
    if (then) then();
  }

  // What a save is missing, in the order it's asked for, or null when it's ready:
  // { field: 'start' | 'int' | 'finish' | 'name' | 'grade', msg }. The phone and
  // the wall screen check the same things (and db/35 checks the wall's again).
  // Names must be unique: they're how a problem is cast (the DB also has a
  // UNIQUE constraint). Checked ignoring case, leaving out the problem being edited.
  function createProblemMissing(name, editing) {
    if (holdsWithRole('start').length < 1) return { field: 'start', msg: 'Add a start hold.' };
    if (holdsWithRole('int').length < 1) return { field: 'int', msg: 'Add at least one hold between start and finish.' };
    if (holdsWithRole('finish').length !== 1) return { field: 'finish', msg: 'Add a finish hold (tap a finish-zone hold twice).' };
    if (!name) return { field: 'name', msg: 'Give your problem a name.' };
    if (!createGrade) return { field: 'grade', msg: 'Pick a grade.' };
    const lower = name.toLowerCase();
    if (allProblems.some(p => p !== editing && String(p.name || '').trim().toLowerCase() === lower)) {
      return { field: 'name', msg: 'That name is already used — pick another.' };
    }
    return null;
  }

  // problems.feet_holds for a save: Specific feet's footholds, else empty
  // (problems_guard_feet empties it for any other rule anyway).
  const createFeetCol = () => createFeet === 'specific' ? createFeetHolds.slice() : [];

  async function saveProblem() {
    if (!session) { location.hash = '#auth'; return; }

    // In edit mode we're updating this existing row (holds, name, grade, feet rule).
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

    const miss = createProblemMissing(name, editing);
    if (miss) {
      return createMissing(miss.msg, miss.field === 'name' ? () => nameEl.focus()
                                   : miss.field === 'grade' ? openCreateGrade : null);
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
      // One Edit: holds, name, grade and feet rule (never the setter). Admins may
      // edit any problem; the owner theirs while it isn't a benchmark and nobody
      // else has ticked it (RLS, db/39; its guard refuses any other column). Same
      // invert-on-save scheme as create. A rename changes the cast key: the Pi
      // looks a cast's name up when it arrives, so the next cast uses the new one.
      const update = { name, grade: createGrade, feet_mode: createFeet, feet_holds: createFeetCol(), ...holdCols };
      // .select() so a write RLS silently refused (no error, 0 rows) isn't
      // mistaken for success.
      const { data, error } = await sb.from('problems').update(update).eq('id', editing.id).select('id');
      btn.disabled = false; btn.classList.remove('casting');
      if (error) {
        console.warn('problem save failed', error);
        return createMissing(
          error.code === '42501' ? 'You don’t have permission to change that.'          // RLS / the db/39 guard
          : dbErrorText(error),                                                       // 23505 name taken, 23514 a rule
          error.code === '23505' ? () => nameEl.focus() : null);
      }
      if (!data || !data.length) {
        if (isAdmin()) {
          createMissing('Couldn’t save: you’re no longer an admin, or the problem has been deleted.');
          recheckAdmin();
        } else {
          createMissing('Couldn’t save: only an admin can edit this now (someone else has ticked it, or it’s a benchmark).');
          othersKnown.delete(othersKey('p', editing.id));
        }
        return;
      }
      Object.assign(editing, update);   // update in place (same object lives in allProblems)
      saveList('problems', allProblems); // the saved copy (offline, next start) gets the new name and holds
      leaderboardLoaded = false;         // edit may change grade -> base points; refetch next view
      const id = editing.id;
      resetCreate();
      renderList();
      showToast('Changes saved ✓', 'success');
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
      feet_mode: createFeet,
      feet_holds: createFeetCol(),
      is_benchmark: false
    };

    const { data, error } = await sb.from('problems').insert(row).select().single();
    btn.disabled = false; btn.classList.remove('casting');
    if (error) {
      console.warn('problem create failed', error);
      return createMissing(
        error.code === '42501' ? 'You don’t have permission to create problems yet.'   // RLS INSERT policy missing
        : dbErrorText(error),                                                        // 23505 name taken, 23514 a rule
        error.code === '23505' ? () => nameEl.focus() : null);
    }

    allProblems.push(data);
    saveList('problems', allProblems);   // the saved copy (offline, next start) too (APP-04)
    renderList();
    resetCreate();
    showToast('Problem created ✓', 'success');
    // Replace the #create history entry with the new problem's detail, so Back
    // from there returns to the list (not into the create form).
    redirectRoute('#detail/' + encodeURIComponent(data.id));
  }

  // ── Leaving an Edit ──────────────────────────────────────────────────────────
  // The name of what's being edited when leaving would lose changes (the discard
  // sheet names it), or null when nothing would be lost. Create doesn't ask.
  function editLeaveName() {
    if (currentView === 'create' && problemEditDirty()) {
      const p = allProblems.find(x => String(x.id) === String(editingProblemId));
      return p ? displayName(p) : 'this problem';
    }
    if (currentView === 'circuit-create' && circuitEditDirty()) {
      if (ccMoveId) {
        const p = allProblems.find(x => String(x.id) === String(ccMoveId));
        return p ? displayName(p) : 'this problem';
      }
      const c = allCircuits.find(x => String(x.id) === String(ccEditingId));
      return c ? circuitName(c) : 'this circuit';
    }
    return null;
  }
  // Discard: forget the edit, so opening Edit again starts from what's saved.
  function discardEdits() {
    if (currentView === 'create' && editingProblemId) resetCreate();
    if (currentView === 'circuit-create' && (ccEditingId || ccMoveId)) resetCircuitCreate();
  }

  // ── Live LEDs while setting (cast contract §9) ────────────────────────────────
  // While someone sets a problem (the phone's Create or Edit, or the wall
  // screen's Create page), every change lights the board in a cast's colours:
  // preview_holds carries the whole selection and a session token, never a diff,
  // so a lost message corrects itself with the next. One message is in flight at
  // a time and the next carries whatever is on screen when it lands, so fast
  // taps coalesce. A keep-alive every PREVIEW_PING_MS keeps the Pi showing it (it
  // gives up after 60 s of silence); `end` is sent on Save, Cancel or leaving, after
  // any message still in flight (and the Pi ignores a session once it has ended).
  // Phones only send inside the geofence, with no admin bypass (an admin editing
  // holds at home mustn't light the gym's board); outside it, setting works and a
  // note says why the board isn't lit. A problem cast, a circuit's static view
  // (show_circuit, from the wall) or someone else's preview takes the board (the latest wins), and the Pi then ignores this session until
  // it says `show`: while setting, the app listens on the channel (the only time
  // it opens a socket) so it can offer "Show on board" when that happens.
  const PREVIEW_PING_MS = 20000;
  const PREVIEW_RETRY_MS = 2000;
  // { token, first, show, dirty, sending, inflight, locating, outside, paused, ping, listen }
  let preview = null;

  // Setting is on screen: the phone's create view (in front), or the wall's Create page.
  const previewWanted = () => WALL
    ? wallCreateOn && !wallOffline()
    : currentView === 'create' && document.visibilityState === 'visible';

  // Called after each change to the holds or the feet rule.
  function previewEdited() {
    if (!previewWanted()) return;
    if (!preview) previewStart();
    preview.dirty = true;
    previewPump();
  }

  function previewStart() {
    const p = preview = { token: castRunToken(), first: true, show: false, dirty: false, sending: false,
                          locating: !WALL, outside: false, paused: false, listen: null,
                          ping: setInterval(() => previewPump(true), PREVIEW_PING_MS) };
    if (WALL) {
      previewListen(p);
    } else {
      ensureCastLocation({ adminBypass: false }).then(fence => {
        if (preview !== p) return;
        p.locating = false;
        p.outside = !fence.ok;
        if (p.outside) { clearInterval(p.ping); previewRenderNote(); return; }
        previewListen(p);
        previewPump();
        previewRenderNote();
      });
    }
    previewRenderNote();
  }

  function previewBody(p, extra) {
    return { session: p.token, ...extra, source: WALL ? 'wall' : 'phone', signed_in: !!session };
  }

  // Send what's on screen now, unless a send is in flight (it sends again when it lands).
  function previewPump(ping = false) {
    const p = preview;
    if (!p || p.locating || p.outside || p.paused || p.sending) return;
    if (!p.dirty && !ping) return;
    const flags = {};
    if (p.first) flags.first = true;
    if (p.show) flags.show = true;
    if (ping && !p.dirty) flags.ping = true;
    p.dirty = false;
    p.sending = true;
    const body = previewBody(p, {
      start: holdsWithRole('start'), hold: holdsWithRole('int'), finish: holdsWithRole('finish'),
      feet: createFeet, ...flags });
    p.inflight = channel.httpSend('preview_holds', body, { timeout: 8000 });
    p.inflight.then(() => {
      p.sending = false;
      if (flags.first) p.first = false;
      if (flags.show) p.show = false;
      if (preview === p) previewPump();
    }, err => {
      p.sending = false;
      p.dirty = true;
      console.warn('preview not sent', err);
      setTimeout(() => { if (preview === p) previewPump(); }, PREVIEW_RETRY_MS);
    });
  }

  // Show on board: take the board back after a cast or someone else's preview.
  function previewShowAgain() {
    const p = preview;
    if (!p || !p.paused) return;
    p.paused = false;
    p.show = true;
    p.dirty = true;
    previewRenderNote();
    previewPump();
  }

  // Save, Cancel, leaving the screen, the app going to the background.
  function previewEnd() {
    const p = preview;
    if (!p) return;
    preview = null;
    clearInterval(p.ping);
    previewUnlisten(p);
    if (!p.first || p.sending) {   // something may have reached the Pi
      // After the message in flight has settled, so `end` can't be overtaken by it
      // (review SEAM-03; the Pi also ignores a session's messages once it has ended).
      const body = previewBody(p, { end: true });
      Promise.resolve(p.inflight).catch(() => {})
        .then(() => channel.httpSend('preview_holds', body, { timeout: 8000 }))
        .catch(err => console.warn('preview end not sent', err));
    }
    previewRenderNote();
  }

  // Hear the casts and the other previews that take the board. supabase-js hands
  // back one channel object per topic, so this is the same `channel` the app sends
  // on (or, after a removeChannel, a fresh one): sending works either way, since
  // httpSend is a REST POST that doesn't use the socket.
  function previewListen(p) {
    if (p.listen) return;
    const ch = sb.channel('board:HangoutPortland');
    const taken = () => {
      if (preview !== p || p.paused) return;
      p.paused = true;
      previewRenderNote();
    };
    // A problem cast, or a circuit's static view (the Pi shows it as a cast: review SEAM-01).
    // A circuit run doesn't take it: the preview waits and comes back when the run ends.
    ch.on('broadcast', { event: 'cast_problem' }, taken)
      .on('broadcast', { event: 'show_circuit' }, taken)
      .on('broadcast', { event: 'preview_holds' }, msg => {
        const b = msg && msg.payload;
        // Only a session starting, or one taking the board back, takes it from us (contract §9).
        if (b && b.session !== p.token && !b.end && (b.first || b.show)) taken();
      })
      .subscribe();
    p.listen = ch;
  }
  function previewUnlisten(p) {
    if (!p.listen) return;
    sb.removeChannel(p.listen).catch(() => {});
    p.listen = null;
  }

  // The note by the board: lit as you tap / only at the gym / Show on board.
  function previewRenderNote() {
    const p = preview;
    const html = !p ? (WALL ? '<i class="lights-dot"></i>Each tap lights the board' : '')
      : p.outside ? 'The board lights up as you set only at the gym'
      : p.paused ? `Someone else lit the board <button class="lights-show" type="button">Show on board</button>`
      : p.locating ? ''
      : '<i class="lights-dot on"></i>Lit on the board as you tap';
    ['create-lights', 'wall-c-lights'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = html;
      el.hidden = !html;
      el.classList.toggle('paused', !!(p && p.paused));
    });
  }

  // ── Who may do what (UI only: RLS and the RPCs are the real gate) ───────────────
  const isAdmin = () => !!(profile && profile.is_admin);
  // The super admin (db/44) alone works on the board: #setup (Board Setup, Edit holds).
  // Always an admin too.
  const isSuperAdmin = () => !!(profile && profile.is_super_admin);

  // ══ CIRCUITS ═══════════════════════════════════════════════════════════════════
  // A circuit is a long sport-style route: one ordered hold sequence (duplicates
  // allowed), 1–2 starts (the first holds), one finish (the last hold), optional
  // loop. Browse / create / detail, and a cast that runs the circuit on the wall
  // (circuits.js, contract section 8).

  const circuitName = c => String((c && c.name) || '').trim() || '(unnamed)';
  const circuitSeq  = c => (Array.isArray(c && c.hold_sequence) ? c.hold_sequence : []);
  // A circuit a challenge uses is admins-only (db/31), so its owner loses Delete.
  const canEditCircuit = c =>
    !!(c && profile && (profile.is_admin
      || (session && c.setter_id === session.user.id && !challengeForCircuit(c.id))));
  // Edit (db/39): as canEditCircuit, and for the owner, only while nobody else has
  // logged a run of it (circuit_has_other_logs; asked in the background, problems.js).
  const canChangeCircuit = c =>
    !!(c && (isAdmin() || (canEditCircuit(c) && othersUsed('c', c.id) === false)));
  const mayOpenCircuitEdit = c =>
    !!(c && (isAdmin() || (canEditCircuit(c) && othersUsed('c', c.id) !== true)));


