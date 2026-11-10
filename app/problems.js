// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, challenge, leaderboard, wall, trace, ledmap, setup, app. This file: problem list, detail, swipe, info, cast, board loaders, tick/delete/grade/benchmark buttons.

  // ── List: filter + sort ──────────────────────────────────────────────────────
  // The phone list and the wall's list share these (the wall's list is the same
  // visibleProblems()), and so do their filter icon and one-tap pills. Everything
  // else (sort, grade range, the quick filters) is in the Filter sheet below,
  // which serves the circuit list too (FILTER_KINDS.circuits, circuits.js).
  const LIST_SORTS = [
    ['new',     'New'],
    ['random',  'Random'],       // choose it again to reshuffle
    ['easy',    'Easy'],
    ['hard',    'Hard'],
    ['popular', 'Popular'],      // most climbers have sent it (db/38)
  ];
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const createdMs = p => { const t = Date.parse(p.created_at || ''); return isNaN(t) ? 0 : t; };
  function randomKey(p) {
    const id = String(p.id);
    if (!listRandom.has(id)) listRandom.set(id, Math.random());   // a problem added since: somewhere at random
    return listRandom.get(id);
  }
  function sortProblems(arr) {
    const cmp = {
      new:    (a, b) => createdMs(b) - createdMs(a) || byName(a, b),
      random: (a, b) => randomKey(a) - randomKey(b),
      easy:   (a, b) => gradeRank(a.grade) - gradeRank(b.grade) || byName(a, b),
      // Hardest first; unknown grades (Project) still last, as in Easy.
      hard:   (a, b) => (gradeRank(a.grade) === 999) - (gradeRank(b.grade) === 999)
                        || gradeRank(b.grade) - gradeRank(a.grade) || byName(a, b),
      popular: (a, b) => tickCount(b) - tickCount(a) || byName(a, b),
    }[listSort] || ((a, b) => 0);
    return arr.slice().sort(cmp);
  }
  // Easy and Hard group the list by grade (the wall shows its grade sections and rail then).
  const sortIsByGrade = () => listSort === 'easy' || listSort === 'hard';

  // The grade range: the ladder grades present in the problems, easiest first.
  function gradeSteps() {
    return [...new Set(allProblems.map(p => String(p.grade || '').toLowerCase()))]
      .filter(g => gradeRank(g) !== 999)
      .sort((a, b) => gradeRank(a) - gradeRank(b));
  }
  const gradeNarrowed = () => gradeLo !== null || gradeHi !== null;
  function inGradeRange(p) {
    if (!gradeNarrowed()) return true;
    const r = gradeRank(p.grade);
    if (r === 999) return false;
    return (gradeLo === null || r >= gradeRank(gradeLo)) && (gradeHi === null || r <= gradeRank(gradeHi));
  }

  // Every filter, in list order unsorted (the counts and the hold picker's
  // bright holds need no sort); visibleProblems() sorts it for the list.
  function filteredProblems() {
    let arr = allProblems;
    if (favesOnly) arr = arr.filter(p => isFaved(p.id));
    if (benchOnly) arr = arr.filter(p => p.is_benchmark);
    if (excludeDone) arr = arr.filter(p => !isFullyDone(p.id));
    if (gradeNarrowed()) arr = arr.filter(inGradeRange);
    if (holdPicks.length) arr = arr.filter(p => usesAllHolds(problemHolds(p), holdPicks));
    const q = searchNorm(searchQuery);
    if (q) {
      arr = arr.filter(p =>
        searchNorm(p.name).includes(q) ||
        searchNorm(setterName(p)).includes(q) ||
        searchNorm(p.grade).includes(q)
      );
    }
    return arr;
  }
  function visibleProblems() { return sortProblems(filteredProblems()); }

  // How many settings differ from the default (the filter icon's badge): the sort,
  // the grade range, each quick filter, and the picked holds (as one).
  const problemFilterCount = () =>
    (listSort !== 'new') + gradeNarrowed() + favesOnly + benchOnly + excludeDone + (holdPicks.length > 0);
  const listFiltersAtDefault = () => problemFilterCount() === 0;

  // Back to the defaults (Reset, Clear filters, and the wall going idle). State only: the caller renders.
  function resetListFilters() {
    favesOnly = false; benchOnly = false; excludeDone = false;
    listSort = 'new';
    listRandom = new Map();
    gradeLo = null; gradeHi = null;
    holdPicks = [];
  }

  // ── The Filter: one sheet (phone) or panel (wall) for either list ─────────────
  // A "kind" says how the sheet reads and writes one list's state. The circuits'
  // kind is added in circuits.js (FILTER_KINDS.circuits), which loads later.
  const FILTER_KINDS = {
    problems: {
      noun: 'problem',
      sorts: () => LIST_SORTS,
      getSort: () => listSort,
      setSort: key => {
        listSort = key;
        if (key === 'random') listRandom = new Map();   // a fresh shuffle every time it's chosen
        if (key === 'popular') loadTickCounts();
      },
      steps: () => gradeSteps(),
      rank: g => gradeRank(g),
      fmt: g => fontGrade(g),
      getRange: () => [gradeLo, gradeHi],
      setRange: (lo, hi) => { gradeLo = lo; gradeHi = hi; },
      toggles: () => (WALL ? ['bench'] : ['bench', 'faves', 'done']),
      count: () => filteredProblems().length,
      // The hold filter: the picks, the items passing every filter, an item's holds as set.
      getHolds: () => holdPicks,
      setHolds: picks => { holdPicks = picks; },
      matches: () => filteredProblems(),
      holdsOf: p => problemHolds(p),
      nOn: () => problemFilterCount(),
      reset: () => resetListFilters(),
      render: () => renderList(),
      search: 'search',                 // the phone's search field, cleared by Clear filters
      searching: () => !!searchQuery,   // search text in (phone or wall): Clear shows
    },
  };

  // The one-tap filters: a pill in the list's row and the same toggle in the sheet
  // ([data-toggle], app.js), kept in step by syncFilterToggles (account.js).
  const FILTER_TOGGLES = {
    bench:  { kind: 'problems', label: 'Benchmarks',   get: () => benchOnly,        set: v => { benchOnly = v; } },
    faves:  { kind: 'problems', label: 'Favourites',   get: () => favesOnly,        set: v => { favesOnly = v; },        guest: 'Sign in to filter favourites' },
    done:   { kind: 'problems', label: 'Exclude Done', get: () => excludeDone,      set: v => { excludeDone = v; },      guest: 'Sign in to filter your sends' },
    cfaves: { kind: 'circuits', label: 'Favourites',   get: () => circuitFavesOnly, set: v => { circuitFavesOnly = v; }, guest: 'Sign in to filter favourites' },
    loop:   { kind: 'circuits', label: 'Looping',      get: () => circuitLoopOnly,  set: v => { circuitLoopOnly = v; } },
  };

  function toggleFilter(key) {
    const t = FILTER_TOGGLES[key];
    if (!t) return;
    if (t.guest && !session) { showToast(t.guest, 'success'); return; }
    t.set(!t.get());
    filtersChanged(t.kind);
  }

  // A filter or the sort changed: re-render (which updates every control), and
  // start the list from the top.
  function filtersChanged(kind) {
    holdsDirty = false;                 // the list now shows the picks too
    FILTER_KINDS[kind].render();
    if (!WALL && currentView === (kind === 'problems' ? 'list' : 'circuits')) window.scrollTo(0, 0);
    if (WALL) {
      if (kind === 'problems') { wallEl('wall-list').scrollTop = 0; wallMarkGrade(); }
      else wallEl('wall-clist').scrollTop = 0;
    }
  }

  // The row's Clear pill and the empty list's Clear filters, phone and wall: every
  // filter back to the default, the picked holds and the search too. Not the
  // sheet's Reset, which leaves the search alone.
  function clearFilters(kind) {
    const k = FILTER_KINDS[kind];
    if (!k) return;
    k.reset();
    if (WALL) wallSearchSet(kind, '', true);     // the wall's search (and its keyboard, closed)
    const input = !WALL && k.search && document.getElementById(k.search);
    if (input && input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));   // its own handler clears the query and the ×
    }
    if (filterKind === kind) grInit();
    filtersChanged(kind);
  }

  // The empty list, phone and wall: say so, and offer the way back.
  function filterEmptyHtml(kind) {
    return `<div class="state-msg f-empty"><div class="icon">🔎</div>No ${FILTER_KINDS[kind].noun}s match these filters.`
      + `<button class="btn-block btn-ghost f-empty-btn" type="button" data-act="clear-filters" data-kind="${kind}">Clear filters</button></div>`;
  }

  // The filter icons (both lists, phone and wall: found by data-pick + data-kind),
  // the Clear pills, the toggles, and the open sheet. Called from every render of
  // either list.
  function updateFilterControls() {
    syncFilterToggles();
    Object.keys(FILTER_KINDS).forEach(kind => {
      const n = FILTER_KINDS[kind].nOn();
      const atDefault = !n && !FILTER_KINDS[kind].searching();
      document.querySelectorAll(`.filter-clear[data-kind="${kind}"]`).forEach(b => { b.hidden = atDefault; });
      document.querySelectorAll(`[data-pick="filter"][data-kind="${kind}"]`).forEach(b => {
        b.classList.toggle('on', n > 0);
        b.setAttribute('aria-label', n ? `Filter, ${n} on` : 'Filter');
        const badge = b.querySelector('.filter-badge');
        badge.hidden = !n;
        badge.textContent = n ? String(n) : '';
      });
    });
    document.querySelectorAll('.filter-row .filter-pills').forEach(markFilterRowEdges);
    fsRender();
  }

  // A pill just tapped stays in view: Clear appearing narrows the row, and the
  // pill tapped was often the one at the right end, which would slide under the
  // fade. --pill-fade (tokens.css) is the fade's width.
  function keepPillInView(pill) {
    const row = pill && pill.closest('.filter-row .filter-pills');
    if (!row) return;
    const fade = parseFloat(getComputedStyle(row).getPropertyValue('--pill-fade')) || 0;
    const r = row.getBoundingClientRect(), t = pill.getBoundingClientRect();
    if (t.right > r.right - fade) row.scrollLeft += t.right - r.right + fade;
    else if (t.left < r.left + fade) row.scrollLeft -= r.left + fade - t.left;
    markFilterRowEdges(row);
  }

  // The pill rows' ends fade out where there's more to scroll to (.more-left /
  // .more-right, styles.css), on a phone too narrow for the row.
  function markFilterRowEdges(row) {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle('more-left', row.scrollLeft > 1);
    row.classList.toggle('more-right', row.scrollLeft < max - 1);
  }

  // ── Popular: distinct climbers who've ticked each problem (db/38) ──
  // Ticks are private, so the counts come from problem_tick_counts(), fetched when
  // Popular is chosen and with each problem load while it's the sort (at most once
  // a minute). Until they arrive (or offline) every count is 0: names A–Z.
  let tickCountsLoading = null;
  function tickCount(p) { return tickCounts.get(String(p.id)) || 0; }
  function loadTickCounts() {
    if (tickCountsLoading) return tickCountsLoading;
    if (Date.now() - tickCountsAt < 60 * 1000) return Promise.resolve();
    tickCountsLoading = (async () => {
      try {
        const { data, error } = await sb.rpc('problem_tick_counts');
        if (error) throw error;
        tickCounts = new Map((data || []).map(r => [String(r.problem_id), r.climbers || 0]));
        tickCountsAt = Date.now();
        if (listSort === 'popular') renderList();
      } catch (e) {
        console.warn('tick counts load failed', e);
      } finally {
        tickCountsLoading = null;
      }
    })();
    return tickCountsLoading;
  }

  // ── The Filter sheet / panel ──
  // Built afresh each time it opens, into the phone's #filter-sheet or the wall
  // page's panel (only one is ever open, so the gr-* ids are unique). Sections:
  // Sort, Grade, Quick filters, (Holds, next session), then Reset and Show N.
  // Every change applies at once: the list behind re-renders as it goes.
  function filterContainer(kind) {
    if (!WALL) return document.getElementById('filter-sheet');
    return wallEl(kind === 'circuits' ? 'wall-cfpanel' : 'wall-fpanel');
  }

  function filterSheetHtml(kind) {
    const k = FILTER_KINDS[kind];
    const sorts = k.sorts().map(([key, name]) =>
      `<button class="f-sort-opt" type="button" role="radio" data-fsort="${key}">${name}</button>`).join('');
    const toggles = k.toggles().map(key =>
      `<button class="filter-pill" type="button" data-toggle="${key}" aria-pressed="false">${FILTER_TOGGLES[key].label}</button>`).join('');
    return `
      <div class="modal-header f-head">
        <div class="modal-title" id="f-title">Filter</div>
        <button class="modal-close" type="button" data-f="close" aria-label="Close">✕</button>
      </div>
      <div class="f-body">
        <section class="f-section">
          <div class="f-label" id="f-sort-label">Sort</div>
          <div class="f-sort" role="radiogroup" aria-labelledby="f-sort-label">${sorts}</div>
        </section>
        <section class="f-section">
          <div class="f-label">Grade</div>
          <div class="gr-slider" id="gr-slider">
            <div class="gr-track" id="gr-track">
              <div class="gr-fill" id="gr-fill"></div>
              <div class="gr-thumb" id="gr-lo" role="slider" tabindex="0" aria-label="Easiest grade"></div>
              <div class="gr-thumb" id="gr-hi" role="slider" tabindex="0" aria-label="Hardest grade"></div>
            </div>
          </div>
          <div class="gr-ticks" id="gr-ticks"></div>
          <p class="f-none" id="gr-none" hidden>No grades yet.</p>
        </section>
        <section class="f-section">
          <div class="f-label">Quick filters</div>
          <div class="f-toggles">${toggles}</div>
        </section>
        ${filterHoldsHtml(kind)}
      </div>
      <div class="modal-actions f-foot">
        <button class="btn-block btn-ghost" type="button" data-f="reset">Reset</button>
        <button class="btn-block btn-primary" type="button" data-f="done">Show ${k.noun}s</button>
      </div>`;
  }

  // ═══ HOLDS: the hold filter ══════════════════════════════════════════════════
  // Show only the items that use ALL the picked holds, in any role (a problem's
  // starts, hand holds or finish; any hold of a circuit's hold_sequence), as set:
  // never mirrored. Client-side: the lists already hold every item's holds. The
  // picks are the kind's own (holdPicks, circuitHoldPicks in state.js), count as
  // one on the filter icon, and go with Reset, Clear filters and the wall's idle.
  // Picking: the phone's hold picker (#hp-screen, over the sheet; its board zooms
  // in the fullscreen viewer, core.js, as the 'holds' view), or the wall's board
  // while the Filter panel is open (wall.js). A tap recomputes the counts and the
  // bright holds only; the list itself re-renders when the picker or the panel
  // closes (holdsDirty), which is lighter on the wall's Pi.
  const holdSetCache = new WeakMap();   // item -> Set of its hold ids (a reload brings new objects)
  function cachedHoldSet(item, holdsFn) {
    let s = holdSetCache.get(item);
    if (!s) { s = new Set(holdsFn(item)); holdSetCache.set(item, s); }
    return s;
  }
  const problemHolds = p => cachedHoldSet(p, problemHoldOrder);
  function usesAllHolds(set, picks) {
    for (const h of picks) if (!set.has(h)) return false;
    return true;
  }

  // Holds still in play: in at least one item that passes every filter and uses
  // every pick (and the picks themselves). The picker leaves these bright.
  function holdsInPlay(kind) {
    const k = FILTER_KINDS[kind];
    const s = new Set(k.getHolds());
    k.matches().forEach(it => k.holdsOf(it).forEach(h => s.add(h)));
    return s;
  }

  // The live line: "6 problems use both holds", or how to start.
  function holdPickLine(kind) {
    const k = FILTER_KINDS[kind];
    const picks = k.getHolds();
    if (!picks.length) return `Tap holds to find ${k.noun}s that use all of them, as set. Faded holds aren’t in any of those ${k.noun}s.`;
    const n = k.count();
    const which = picks.length === 1 ? 'that hold' : picks.length === 2 ? 'both holds' : `all ${picks.length} holds`;
    return `${n ? `${n} ${k.noun}${n === 1 ? '' : 's'}` : `No ${k.noun}s`} use${n === 1 ? 's' : ''} ${which}`;
  }
  const holdLabel = h => holdName(h);

  // The picks as chips (tap one to drop it).
  function holdChipsHtml(picks) {
    return `<div class="hp-chips">${picks.map(h =>
      `<button class="hp-chip" type="button" data-unpick="${escAttr(h)}" aria-label="Drop ${escAttr(holdLabel(h))}">${escHtml(holdLabel(h))}<span aria-hidden="true">✕</span></button>`).join('')}</div>`;
  }

  // The board's layer for picking: dimmed, the holds in play cut out, the picks ringed.
  const holdPickLayerFor = kind => holdPickLayerHtml(holdsInPlay(kind), FILTER_KINDS[kind].getHolds());

  // The sheet's Holds section: filled by renderFilterHolds (it changes as holds are picked).
  function filterHoldsHtml(kind) {
    return `<section class="f-section" id="f-holds"></section>`;
  }

  const HP_CHEVRON = '<svg class="f-holds-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>';

  // Phone: a row with a thumbnail of the board (the picks lit), what's picked, and
  // a way into the picker. Wall: the picks as chips with Clear holds, or a hint
  // (the board beside the panel is the picker there).
  function renderFilterHolds() {
    const box = document.getElementById('f-holds');
    if (!box || !filterKind) return;
    const picks = FILTER_KINDS[filterKind].getHolds();
    const key = picks.join(',') + '|' + BOARD_IMG;
    if (box.dataset.key === key) return;          // nothing changed (it's called on every render)
    box.dataset.key = key;
    if (WALL) {
      box.innerHTML = `
        <div class="f-label-row"><div class="f-label">Holds</div>${picks.length ? '<button class="hp-text-btn" type="button" data-hp="clear">Clear holds</button>' : ''}</div>
        ${picks.length ? holdChipsHtml(picks)
          : `<p class="wall-holds-hint">Tap holds on the board. You’ll see ${FILTER_KINDS[filterKind].noun}s that use all of them, as set.</p>`}`;
      return;
    }
    const names = picks.map(holdLabel).join(', ');
    box.innerHTML = `
      <div class="f-label">Holds</div>
      <button class="f-holds${picks.length ? ' on' : ''}" type="button" data-hp="open" aria-label="Holds: ${escAttr(picks.length ? names : 'any')}. Pick holds">
        <span class="f-holds-thumb"><span class="board-wrap"><img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="" draggable="false" /><span class="hold-layer">${picks.length ? holdPickLayerHtml(new Set(picks), picks) : ''}</span></span></span>
        <span class="f-holds-text">
          <span class="f-holds-title">${picks.length ? `${picks.length} hold${picks.length === 1 ? '' : 's'}` : 'Any holds'}</span>
          <span class="f-holds-sub">${picks.length ? escHtml(names) : `Pick holds on the board to find ${FILTER_KINDS[filterKind].noun}s that use them`}</span>
        </span>
        ${HP_CHEVRON}
      </button>`;
  }

  // A tap on a hold (the phone's picker, its fullscreen viewer, or the wall's
  // board): pick it, or drop it if it's picked.
  function holdPickToggle(h) {
    const k = FILTER_KINDS[filterKind];
    if (!k || !h) return;
    const picks = k.getHolds().slice();
    const i = picks.indexOf(h);
    if (i === -1) picks.push(h); else picks.splice(i, 1);
    holdPicksSet(picks);
  }
  function holdPicksSet(picks) {
    const k = FILTER_KINDS[filterKind];
    if (!k) return;
    k.setHolds(picks);
    holdsDirty = true;
    updateFilterControls();             // the icon's badge, the sheet, the picker (holdPickRefresh)
  }

  // Whatever is picking right now follows the picks and the other filters: the
  // phone's picker screen (and its fullscreen bar), or the wall's board and bar.
  function holdPickRefresh() {
    if (!filterKind) return;
    if (WALL) { wallRenderPick(filterKind); return; }
    if (!holdPickerOpen) return;
    const k = FILTER_KINDS[filterKind];
    const picks = k.getHolds();
    document.getElementById('hp-layer').innerHTML = holdPickLayerFor(filterKind);
    const line = holdPickLine(filterKind);
    document.getElementById('hp-hint').innerHTML = picks.length
      ? `<b>${escHtml(line)}.</b> Tap a hold again to drop it.` : escHtml(line);
    document.getElementById('hp-picked').innerHTML = picks.length ? holdChipsHtml(picks)
      : '<p class="hp-picked-empty">No holds picked yet.</p>';
    document.getElementById('hp-clear').disabled = !picks.length;
    const n = k.count();
    const done = document.getElementById('hp-done');
    done.textContent = n ? `Show ${n} ${k.noun}${n === 1 ? '' : 's'}` : `No ${k.noun}s use all of these`;
    done.disabled = !n;
    if (fsOpen) fsUpdateBar();
  }

  // The phone's hold picker: a screen over the sheet, the whole board fitted to
  // the width. Pinch it (or its expand button) for the fullscreen viewer.
  function openHoldPicker() {
    if (WALL || !filterKind) return;
    holdPickerOpen = true;
    const img = document.querySelector('#hp-board .board-graphic');
    if (img.getAttribute('src') !== BOARD_IMG) img.src = BOARD_IMG;
    document.getElementById('hp-title').textContent = 'Holds';
    document.getElementById('hp-screen').classList.add('show');
    holdPickRefresh();
  }
  // Back to the sheet (or, from closeFilter, away with it): the list catches up.
  function closeHoldPicker() {
    if (!holdPickerOpen) return;
    if (fsOpen) exitBoardFs();
    holdPickerOpen = false;
    document.getElementById('hp-screen').classList.remove('show');
    if (holdsDirty && filterKind) filtersChanged(filterKind);
  }

  function openFilter(kind) {
    if (!FILTER_KINDS[kind]) return;
    if (filterKind) closeFilter();
    filterKind = kind;
    const box = filterContainer(kind);
    box.innerHTML = filterSheetHtml(kind);
    const slider = document.getElementById('gr-slider');
    slider.addEventListener('pointerdown', grPointerDown);
    slider.addEventListener('pointermove', grPointerMove);
    slider.addEventListener('pointerup', grPointerUp);
    slider.addEventListener('pointercancel', grPointerUp);
    slider.addEventListener('lostpointercapture', grPointerUp);
    ['gr-lo', 'gr-hi'].forEach(id => document.getElementById(id).addEventListener('keydown', grKey));
    document.getElementById('gr-ticks').addEventListener('click', grTickTap);
    grInit();
    if (WALL) document.querySelector(`#wall .wall-page[data-page="${kind}"]`).classList.add('filtering');
    else document.getElementById('filter-modal').classList.add('show');
    updateFilterControls();             // the toggles, the buttons, the Holds section (and the wall's board: the picker)
    if (WALL) wallFilterShown(kind);
  }

  function closeFilter() {
    if (!filterKind) return;
    closeHoldPicker();
    const kind = filterKind;
    filterKind = null;
    grDrag = null;
    filterContainer(kind).innerHTML = '';
    if (WALL) document.querySelector(`#wall .wall-page[data-page="${kind}"]`).classList.remove('filtering');
    else document.getElementById('filter-modal').classList.remove('show');
    if (holdsDirty) filtersChanged(kind);   // the list catches up with the picks
    if (WALL) wallFilterShown(kind);        // the board back to the chosen problem or circuit
  }

  function filterPickSort(key) {
    const k = FILTER_KINDS[filterKind];
    if (!k || !k.sorts().some(s => s[0] === key)) return;
    k.setSort(key);
    filtersChanged(filterKind);
  }

  function filterReset() {
    const kind = filterKind;
    if (!kind) return;
    FILTER_KINDS[kind].reset();
    grInit();
    filtersChanged(kind);
  }

  // The open sheet's own display: the sort lit, Show N (live), Reset.
  function fsRender() {
    if (!filterKind) return;
    const k = FILTER_KINDS[filterKind];
    const box = filterContainer(filterKind);
    const sort = k.getSort();
    box.querySelectorAll('.f-sort-opt').forEach(b => {
      const on = b.dataset.fsort === sort;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const n = k.count();
    const done = box.querySelector('[data-f="done"]');
    done.textContent = n ? `Show ${n} ${k.noun}${n === 1 ? '' : 's'}` : `No ${k.noun}s match`;
    done.disabled = !n;
    box.querySelector('[data-f="reset"]').disabled = k.nOn() === 0;
    renderFilterHolds();
    holdPickRefresh();
  }

  // ── The Grade section: a two-handle range slider over the kind's steps ──
  // The handles are indices into grSteps; the filter (the kind's lo / hi) follows
  // them at once, the count follows as they move, and the list re-renders when a
  // handle is let go (a 280-row re-render per step is heavy on the wall's Pi). A
  // handle at either end means no limit on that side; a narrowed range hides
  // unknown grades.
  let grSteps = [];
  let grLo = 0, grHi = 0;
  let grDrag = null;                    // 'lo' | 'hi' while a handle is held

  // The handles from the kind's range (on open, and after Reset / Clear filters).
  function grInit() {
    const k = FILTER_KINDS[filterKind];
    if (!k) return;
    grSteps = k.steps();
    const n = grSteps.length;
    const [lo, hi] = k.getRange();
    grLo = lo === null ? 0 : Math.max(0, grSteps.findIndex(g => k.rank(g) >= k.rank(lo)));
    grHi = n - 1;
    if (hi !== null) {
      for (let i = n - 1; i >= 0; i--) if (k.rank(grSteps[i]) <= k.rank(hi)) { grHi = i; break; }
    }
    if (grHi < grLo) grHi = grLo;
    document.getElementById('gr-ticks').innerHTML = grSteps.map((g, i) =>
      `<button class="gr-tick" type="button" data-i="${i}" style="left:${grPct(i)}%">${escHtml(k.fmt(g))}</button>`).join('');
    document.getElementById('gr-slider').hidden = n < 2;
    document.getElementById('gr-ticks').hidden = n < 2;
    document.getElementById('gr-none').hidden = n >= 2;
    grRender();
  }
  const grPct = i => (grSteps.length < 2 ? 0 : (i / (grSteps.length - 1)) * 100);

  // Handles -> the filter state, then the sheet's display (the count, not the list).
  function grApply() {
    const n = grSteps.length;
    FILTER_KINDS[filterKind].setRange(grLo <= 0 ? null : grSteps[grLo], grHi >= n - 1 ? null : grSteps[grHi]);
    grRender();
    fsRender();
  }
  function grRender() {
    const k = FILTER_KINDS[filterKind];
    const lo = document.getElementById('gr-lo'), hi = document.getElementById('gr-hi');
    if (!k || !lo) return;
    lo.style.left = grPct(grLo) + '%';
    hi.style.left = grPct(grHi) + '%';
    const fill = document.getElementById('gr-fill');
    fill.style.left = grPct(grLo) + '%';
    fill.style.width = (grPct(grHi) - grPct(grLo)) + '%';
    [[lo, grLo], [hi, grHi]].forEach(([el, i]) => {
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(Math.max(0, grSteps.length - 1)));
      el.setAttribute('aria-valuenow', String(i));
      el.setAttribute('aria-valuetext', grSteps[i] ? k.fmt(grSteps[i]) : '');
    });
    // The upper handle on top when both sit at the far left, so it can still be dragged off.
    lo.classList.toggle('under', grLo === grHi && grLo === 0);
    document.querySelectorAll('#gr-ticks .gr-tick').forEach(t => {
      const i = +t.dataset.i;
      t.classList.toggle('in', i >= grLo && i <= grHi);
    });
  }

  // The step nearest a pointer's x on the track.
  function grStepAt(clientX) {
    const r = document.getElementById('gr-track').getBoundingClientRect();
    const f = r.width ? (clientX - r.left) / r.width : 0;
    return Math.round(Math.min(1, Math.max(0, f)) * (grSteps.length - 1));
  }
  function grMoveTo(which, i) {
    if (which === 'lo') grLo = Math.min(i, grHi);
    else grHi = Math.max(i, grLo);
    grApply();
  }
  // Which handle a touch at step i should move: the nearer one; on a tie (both
  // handles on one step) the side the finger is on.
  function grPick(i) {
    if (grLo === grHi) return i < grLo ? 'lo' : i > grHi ? 'hi' : (grLo === 0 ? 'hi' : 'lo');
    return Math.abs(i - grLo) <= Math.abs(i - grHi) ? 'lo' : 'hi';
  }
  function grPointerDown(e) {
    if (grSteps.length < 2 || (e.button !== undefined && e.button > 0)) return;
    const i = grStepAt(e.clientX);
    const thumb = e.target.closest('.gr-thumb');
    grDrag = thumb ? (thumb.id === 'gr-lo' ? 'lo' : 'hi') : grPick(i);
    if (grDrag === 'lo' && grLo === grHi && i > grHi) grDrag = 'hi';   // both on one step: drag apart either way
    if (grDrag === 'hi' && grLo === grHi && i < grLo) grDrag = 'lo';
    e.currentTarget.setPointerCapture?.(e.pointerId);
    grMoveTo(grDrag, i);
    e.preventDefault();
  }
  function grPointerMove(e) {
    if (!grDrag) return;
    const i = grStepAt(e.clientX);
    const cur = grDrag === 'lo' ? grLo : grHi;
    if (i !== cur) grMoveTo(grDrag, i);
  }
  function grPointerUp() {
    if (!grDrag) return;
    grDrag = null;
    filtersChanged(filterKind);
  }
  function grKey(e) {
    const which = e.currentTarget.id === 'gr-lo' ? 'lo' : 'hi';
    const cur = which === 'lo' ? grLo : grHi;
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    let i = null;
    if (step) i = cur + step;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = grSteps.length - 1;
    if (i === null) return;
    e.preventDefault();
    grMoveTo(which, Math.max(0, Math.min(grSteps.length - 1, i)));
    filtersChanged(filterKind);
  }
  // A grade label under the track: the nearer handle jumps there.
  function grTickTap(e) {
    const t = e.target.closest('.gr-tick');
    if (!t) return;
    const i = +t.dataset.i;
    grMoveTo(grPick(i), i);
    filtersChanged(filterKind);
  }

  function cardHtml(p) {
    const faved = isFaved(p.id);
    return `
      <div class="problem-card" data-id="${escAttr(p.id)}">
        <div class="problem-info">
          <div class="problem-name">${escHtml(displayName(p))}</div>
          <div class="problem-meta">
            <span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span>
            ${p.is_benchmark ? benchMarkSvg() : ''}
            ${newBadgeHtml(p)}
            <span class="meta-setter">${escHtml(setterName(p))}</span>
            ${isTicked(p.id) ? '<span class="tick-flag" title="Sent">✓</span>' : ''}
          </div>
        </div>
        <button class="card-fave${faved ? ' faved' : ''}" data-fave="${escAttr(p.id)}" aria-pressed="${faved}" aria-label="${faved ? 'Remove from favourites' : 'Add to favourites'}">${HEART_SVG}</button>
      </div>`;
  }

  function renderList() {
    updateFilterControls();
    if (WALL) wallRenderList();           // the wall screen's list follows every render of this one
    const container = document.getElementById('list-container');
    const list = visibleProblems();
    document.getElementById('count').textContent = `${list.length} problem${list.length !== 1 ? 's' : ''}`;

    if (list.length === 0) {
      // The favourites onboarding hint only when favourites is the *only* thing
      // narrowing the list; otherwise the filters may be the cause.
      const otherFilters = searchQuery || problemFilterCount() > 1;
      container.innerHTML = (favesOnly && !otherFilters)
        ? `<div class="state-msg f-empty"><div class="icon">♡</div>No favourites yet. Tap the heart on a problem to save it here.`
          + `<button class="btn-block btn-ghost f-empty-btn" type="button" data-act="clear-filters" data-kind="problems">Clear filters</button></div>`
        : filterEmptyHtml('problems');
      return;
    }
    container.innerHTML = `<div class="problem-list">${list.map(cardHtml).join('')}</div>`;
  }

  // Shared grade-tab markup (the create pickers, problems and circuits). `isActive(g)`
  // decides the highlight. `fmt` (optional) formats the LABEL only — data-grade
  // keeps the raw value for matching. Problem grades pass fontGrade (capitalised);
  // circuit grades don't.
  function gradeTabButtons(grades, isActive, fmt) {
    return grades.map(g =>
      `<button class="grade-tab${isActive(g) ? ' active' : ''}" data-grade="${escAttr(g)}" type="button">${g === 'all' ? 'All' : escHtml(fmt ? fmt(g) : g)}</button>`
    ).join('');
  }

  // ── Detail ───────────────────────────────────────────────────────────────────
  // The Cast button is one element for the life of the page (its click listener
  // and its casting/sent state survive re-renders). Each render moves it into the
  // new title row; with no problem to show it's parked, hidden, after the content.
  let detailCastEl = null;
  function detailCastBtn() {
    return detailCastEl || (detailCastEl = document.getElementById('detail-cast'));
  }
  function parkDetailCast(wrap) {
    const btn = detailCastBtn();
    btn.hidden = true;
    wrap.after(btn);
  }

  function renderDetail(id) {
    const wrap = document.getElementById('detail-content');

    if (!loaded) {
      currentProblem = null;
      updateTickButton();
      updateFaveButton();
      parkDetailCast(wrap);
      wrap.innerHTML = `<div class="spinner"></div>`;
      return;
    }

    const p = allProblems.find(x => String(x.id) === String(id));
    if (!p) {
      currentProblem = null;
      updateTickButton();
      updateFaveButton();
      parkDetailCast(wrap);
      wrap.innerHTML = `<div class="state-msg"><div class="icon">🤷</div>That problem couldn't be found.<br><a class="link" href="#list">Back to problems</a></div>`;
      return;
    }

    // Moving to a different problem resets the mirror toggle to normal orientation.
    if (!currentProblem || String(currentProblem.id) !== String(p.id)) detailMirror = false;
    currentProblem = p;
    // A cast in progress for something else (the problem before a swipe, or the
    // other orientation) lets go of the shared Cast button; castByName then
    // drops it when its location check returns.
    if (castTarget && (castTarget.name !== p.name || castTarget.mirror !== detailMirror)) {
      castTarget = null;
      resetCastButton(detailCastBtn());
    }
    updateTickButton();
    updateFaveButton();
    updateMirrorButton();

    const castBtn = detailCastBtn();
    wrap.innerHTML = `
      <div class="detail-head-info">
        <div class="detail-title-row">
          <h1 class="detail-name">${escHtml(displayName(p))}</h1>
        </div>
        <div class="detail-meta">
          <span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span>
          ${feetBadgeHtml(p)}
          ${newBadgeHtml(p)}
          <span class="meta-setter">by ${escHtml(setterName(p))}</span>
          ${p.is_benchmark ? `<span class="bench-badge">${benchMarkSvg()}Benchmark</span>` : ''}
          ${(myTicksNormal.has(String(p.id)) && myTicksMirrored.has(String(p.id))) ? `<span class="both-badge">✓ both sides</span>` : ''}
        </div>
      </div>

      <div class="board-wrap">
        <img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />
        ${boardShapeOverlayHtml(p, { mirror: detailMirror, dim: true }) || boardOverlayHtml(p, detailMirror)}
        ${boardExpandBtn()}
      </div>
    `;
    wrap.querySelector('.detail-title-row').append(castBtn);
    castBtn.hidden = false;
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
  }

  // ── Swipe between problems (detail view) ──────────────────────────────────────
  // The "deck" is the same filtered + sorted list the cards came from, so swiping
  // honours the active grade tab and search. dir = +1 (next) / -1 (previous).
  function swipeToAdjacent(dir) {
    if (currentView !== 'detail' || !currentProblem) return;
    const deck = visibleProblems();
    let next;
    if (shuffleOn) {
      next = shuffleStep(deck, dir);
      if (!next) return;
    } else {
      const idx = deck.findIndex(p => String(p.id) === String(currentProblem.id));
      if (idx === -1) return;                       // current isn't in the filtered deck
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= deck.length) return;   // stop at the ends
      next = deck[nextIdx];
    }
    // Replace the hash (don't push history) so Back still returns to the list,
    // then render in place — the view stays put, only its content swaps.
    detailTrail.push(currentProblem.id);   // deleting `next` comes back here
    history.replaceState(history.state, '', '#detail/' + encodeURIComponent(next.id));
    closeInfo();
    renderDetail(next.id);
  }

  // ── Shuffle (detail view) ─────────────────────────────────────────────────────
  // With shuffle on, swiping forward goes to a random problem from the same deck,
  // one not yet seen on this run while any are left. Swiping back retraces the
  // path, and forward again replays it before picking new ones. The path starts
  // afresh on each visit to the detail view and whenever shuffle is toggled.
  function shuffleStep(deck, dir) {
    const cur = currentProblem.id;
    const inDeck = id => deck.find(p => String(p.id) === String(id));
    const from = dir > 0 ? shuffleFwd : shuffleBack;
    const to = dir > 0 ? shuffleBack : shuffleFwd;
    while (from.length) {                         // skip any deleted or filtered out
      const p = inDeck(from.pop());
      if (p) { to.push(cur); return p; }
    }
    if (dir < 0) return null;                     // back where the run started
    const seen = new Set([...shuffleBack, cur].map(String));
    let pool = deck.filter(p => !seen.has(String(p.id)));
    if (!pool.length) pool = deck.filter(p => String(p.id) !== String(cur));   // seen them all: go round again
    if (!pool.length) return null;
    to.push(cur);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function toggleShuffle() {
    shuffleOn = !shuffleOn;
    shuffleBack = [];
    shuffleFwd = [];
    updateShuffleButton();
  }
  function updateShuffleButton() {
    const btn = document.getElementById('detail-shuffle');
    if (!btn) return;
    btn.classList.toggle('active', shuffleOn);
    btn.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
    btn.setAttribute('aria-label', shuffleOn ? 'Shuffle on — tap to turn off' : 'Shuffle — swipe to a random problem');
  }

  // ── Info modal ─────────────────────────────────────────────────────────────────
  function openInfo() {
    const p = currentProblem;
    if (!p) return;
    // No comments section: comments are switched off (db/30, plan.md D4).
    document.getElementById('info-title').textContent = 'Problem info';   // the circuit sheet shares this modal

    document.getElementById('info-body').innerHTML = `
      <div class="info-row">
        <div class="info-label">Consensus grade</div>
        <div class="info-value"><span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span></div>
      </div>
      <div class="info-row">
        <div class="info-label">Feet</div>
        <div class="info-value">${feetLabel(feetRule(p))}</div>
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
  // The circuit cast uses it too (startCircuitCast in circuits.js).
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
  // adminBypass false: the live preview while setting (authoring.js) checks
  // admins too, so editing holds at home doesn't light the gym's board.
  async function ensureCastLocation({ adminBypass = true } = {}) {
    if (adminBypass && profile && profile.is_admin) return { ok: true };
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
  // The cast the cast button is showing (Locating / Sending / Sent), as
  // { name, mirror }, or null. A newer tap replaces it, and renderDetail clears it
  // when the problem or orientation on screen changes, which is how a cast still
  // waiting on the location check learns it has been left behind.
  let castTarget = null;

  function resetCastButton(btn) {
    btn.classList.remove('casting', 'sent');
    btn.disabled = false;
  }

  // A signed-in member's cast, recorded privately for PB Console's Activity
  // (db/34: insert-only, nobody can read it through the API). The broadcast
  // itself never says who: the channel is public. Fire and forget: a cast that
  // reached the board isn't failed by its log.
  function logCast(kind, name, mirror = false, run = null) {
    if (!session) return;
    sb.from('cast_log').insert({ user_id: session.user.id, kind, name, mirror: !!mirror,
                                 source: WALL ? 'wall' : 'phone', run })
      .then(({ error }) => { if (error) console.warn('cast log not saved', error); });
  }

  // stillShowing (optional): checked after the location wait, which can take
  // seconds; if it says the thing tapped is no longer on screen (a swipe, the
  // mirror flipped, the view left) nothing is sent. Otherwise the wall would
  // light the problem you swiped away from.
  // quiet: no "Cast cancelled" toast (the wall screen, whose next tap casts again).
  // Resolves true once Realtime accepted the cast, false otherwise.
  async function castByName(name, btn, mirror = false, stillShowing = null, { quiet = false } = {}) {
    if (!name) return false;
    // Icon-only cast buttons keep their icon; text buttons swap to status text.
    const isIcon = btn.classList.contains('cast-icon-btn');
    const prev = btn.innerHTML;
    const target = { name, mirror };
    castTarget = target;
    const mine = () => castTarget === target;
    const restore = () => {
      if (!mine()) return;          // a newer cast owns the button now
      castTarget = null;
      resetCastButton(btn);
      if (!isIcon) btn.innerHTML = prev;
    };
    btn.classList.remove('sent');
    btn.classList.add('casting');
    btn.disabled = true;
    if (!isIcon) btn.innerHTML = 'Locating';

    // Geofence gate — only blocks on a fix that's confidently away from the gym
    // (admins bypass; missing/uncertain fixes are allowed). May briefly wait for GPS.
    const fence = await ensureCastLocation();
    if (!mine() || (stillShowing && !stillShowing())) {
      const superseded = castTarget !== null && !mine();
      restore();
      if (!superseded && !quiet) showToast('Cast cancelled — the problem changed', 'error');
      return false;
    }
    if (!fence.ok) {
      restore();
      showToast('Casting only works at the gym', 'error');
      return false;
    }
    if (!isIcon) btn.innerHTML = 'Sending';

    const payload = { problem_name: name };
    if (mirror) payload.mirror = true;
    // Where it came from and whether someone was signed in (no user id, nothing
    // personal): PB Console's Activity shows it. The Pi ignores both for the LEDs.
    payload.source = WALL ? 'wall' : 'phone';
    payload.signed_in = !!session;

    try {
      // One REST POST (no socket, see state.js). Resolves once the Realtime server
      // has accepted the broadcast; rejects on an error status or a timeout.
      await channel.httpSend('cast_problem', payload, { timeout: 10000 });
      logCast('problem', name, mirror);
      showToast(`${mirror ? 'Mirror cast' : 'Cast'}: ${name}`, 'success');
      if (!mine()) return true;     // swiped on while sending: that button isn't ours
      btn.classList.remove('casting');
      btn.classList.add('sent');
      if (!isIcon) btn.innerHTML = 'Sent';
      setTimeout(restore, 2000);
      return true;
    } catch (err) {
      restore();
      showToast('Cast failed — check connection', 'error');
      console.error(err);
      return false;
    }
  }

  // Re-render whatever board-bearing view is showing once positions/image change.
  function refreshBoardViews() {
    if (WALL) wallRefreshBoard();
    if (currentView === 'detail') router();
    if (currentView === 'create') applyCreateRoles();
    if (currentView === 'outlines') initOutlines();
    if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
    if (currentView === 'circuit-create') applyCircuitCreate();
  }

  // Point every static board <img> (create + circuit create) at the
  // current BOARD_IMG. Their markup has no src, so nothing is fetched until
  // board_config has settled. The detail views' <img> is built per-render, so it
  // reads BOARD_IMG directly.
  function applyBoardImage() {
    document.querySelectorAll('#create-board .board-graphic, #cc-board .board-graphic').forEach(img => {
      if (img.getAttribute('src') !== BOARD_IMG) img.setAttribute('src', BOARD_IMG);
    });
    measureBoardAspect();
  }

  // Cache the board image's natural aspect (w/h). The shape overlay's svg is
  // stretched (viewBox 0..100 both axes), so it needs the aspect to draw a dot
  // that is round on screen. Re-render once it's known / changes.
  function measureBoardAspect() {
    const im = new Image();
    im.onload = () => {
      const a = im.naturalWidth / im.naturalHeight;
      if (a > 0 && Math.abs(a - boardAspect) > 0.001) { boardAspect = a; refreshBoardViews(); }
    };
    im.src = BOARD_IMG;
  }

  // ── Load hold position map (bundled fallback for the board overlay) ──────────
  // board_config (loadBoardConfig) is the source of truth; this bundled file is the
  // offline fallback, a snapshot of the live map (tools/snapshot_board.py). Don't
  // clobber a map that already came from board_config. Its __meta records the board
  // version it was taken from; it comes out here, before anything iterates the holds.
  async function loadHoldMap() {
    if (configHasMap) return;
    try {
      const res = await fetch('hold_map.json', { cache: 'no-cache' });
      if (res.ok && !configHasMap) {
        const map = await res.json();
        bundledMapVersion = (map.__meta && map.__meta.board_updated_at) || null;
        delete map.__meta;
        HOLD_MAP = map;
      }
    } catch (err) {
      console.warn('hold_map.json load failed — board overlay disabled', err);
    }
    refreshBoardViews();
  }

  // ── Load hold outline shapes (hold id -> [[x,y],…] % polygon) ───────────────
  // Their % coords are traced against the LIVE board image + map (board_config),
  // which is what the detail/create views render, so outlines and board have to
  // move together: board_config.hold_shapes (db/28) is the source of truth once
  // an admin has published from the #outlines editor, and this bundled file is
  // the first-paint / offline fallback. Don't clobber outlines that already came
  // from board_config. The board version they were traced against is recorded in
  // __meta.board_updated_at; shapesUsable() refuses to draw over any other board,
  // so a stale or missing copy just falls back to the dot overlay.
  async function loadHoldShapes() {
    if (configHasShapes) return;
    try {
      const res = await fetch('hold_shapes.json', { cache: 'no-cache' });
      if (res.ok && !configHasShapes) HOLD_SHAPES = await res.json();
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
        // `*` rather than a column list: naming a column PostgREST doesn't know
        // 400s the whole request, which would take the board image and hold map
        // down with it — exactly what would happen on a deploy that lands before
        // its migration. It's one small row, and the columns are all wanted here.
        .from('board_config').select('*')
        .eq('wall', 'HangoutPortland').maybeSingle();
      if (error || !data) return;
      boardConfigVersion = data.updated_at || null;   // the board version hold_shapes.json must match
      if (data.image_path) {
        const ver = data.updated_at ? `?v=${encodeURIComponent(data.updated_at)}` : '';
        BOARD_IMG = `${SUPA_URL}/storage/v1/object/public/${BOARD_BUCKET}/${data.image_path}${ver}`;   // applied by the boot chain (app.js)
      }
      if (data.hold_map && typeof data.hold_map === 'object' && Object.keys(data.hold_map).length) {
        HOLD_MAP = data.hold_map;
        configHasMap = true;
      }
      if (!holdsHaveMirror && data.mirror_map && typeof data.mirror_map === 'object' && Object.keys(data.mirror_map).length) {
        MIRROR_MAP = data.mirror_map;
        configHasMirror = true;
      }
      // Published outlines (db/28). shapesUsable() still gates them on
      // __meta.board_updated_at matching this row's updated_at, so a set
      // published against an older board is ignored exactly like a stale file.
      if (data.hold_shapes && typeof data.hold_shapes === 'object' && Object.keys(data.hold_shapes).length > 1) {
        HOLD_SHAPES = data.hold_shapes;
        configHasShapes = true;
      }
      refreshBoardViews();
    } catch (err) {
      console.warn('board_config load failed — using bundled board', err);
    }
  }

  // ── Load the holds table (db/41): each hold's name, kind and mirror partner ──
  // Names label the hold chips and the outline editor; the mirror partners replace
  // board_config.mirror_map (a trigger keeps the two the same until the setup flow,
  // session 2). Positions and outlines still come from board_config. The saved copy
  // is used at once, so a phone offline keeps the names. Read-only, public.
  function useHolds(rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    const info = {}, mirror = {};
    rows.forEach(r => {
      if (!r || typeof r.id !== 'string') return;
      info[r.id] = { name: r.name, kind: r.kind, mirror: r.mirror || null };
      if (r.kind === 'hand' && r.mirror) mirror[r.id] = r.mirror;
    });
    HOLD_INFO = info;
    if (Object.keys(mirror).length) {
      MIRROR_MAP = mirror;
      holdsHaveMirror = configHasMirror = true;
    }
    return true;
  }
  async function loadHolds() {
    if (!HOLD_INFO) {
      const saved = savedList('holds');
      if (saved) useHolds(saved.rows);
    }
    try {
      const { data, error } = await sb.from('holds').select('id,name,kind,mirror')
        .eq('wall', 'HangoutPortland').order('id').limit(2000);
      if (error) { console.warn('holds load failed', error); return; }
      if (useHolds(data)) saveList('holds', data);
    } catch (err) {
      console.warn('holds load failed', err);
    }
    if (currentView === 'detail' && detailMirror) router();
  }

  // ── Load the id -> nickname map (so setters show the live nickname) ───────────
  // The saved copy is applied first, synchronously, so setters already show their
  // names when the saved lists render (boot calls this before loadProblems).
  // profiles isn't readable by others any more (db/30): setter_names() returns the
  // nicknames of accounts that set a problem or circuit, and nobody else's.
  async function loadProfileNames() {
    if (!Object.keys(profileNames).length) {
      const saved = savedList('names');
      if (saved) profileNames = saved.rows;
    }
    const { data, error } = await sb.rpc('setter_names');
    if (error) { console.warn('profile names load failed', error); return; }
    profileNames = Object.fromEntries((data || []).map(r => [r.id, r.username]));
    saveList('names', profileNames);
    if (loaded) renderList();                       // refresh setters once names arrive
    if (currentView === 'detail') renderDetail(parseHash().param);
    if (currentView === 'circuits') renderCircuits();
    else if (currentView === 'circuit-detail') renderCircuitDetail(parseHash().param);
  }

  // ── Load problems ─────────────────────────────────────────────────────────────
  function showProblems(rows) {
    allProblems = rows;
    loaded = true;
    if (listSort === 'popular') loadTickCounts();
    renderList();
  }

  // The saved list (if there is one) shows at once; the fresh one replaces it when
  // it arrives. If the fetch fails, the saved list stays, with the offline note.
  async function loadProblems() {
    const saved = !loaded && savedList('problems');
    if (saved) {
      showProblems(saved.rows);
      router();                  // a cold #detail/<id> can open from the saved list
    }
    const { data, error } = await sb.from('problems').select('*');

    if (error) {
      console.warn('problems load failed', error);
      if (WALL) wallSetNet(true);
      if (saved) { setOfflineNote('list-offline', saved.t); return; }
      document.getElementById('list-container').innerHTML =
        `<div class="state-msg"><div class="icon">⚠️</div>Failed to load problems.<br><small style="opacity:.6">${escHtml(error.message)}</small></div>`;
      document.getElementById('count').textContent = '';
      return;
    }

    saveList('problems', data || []);
    setOfflineNote('list-offline', 0);
    if (WALL) wallSetNet(false);
    showProblems(data || []);
    // Re-run the router in case we booted straight into #detail/<id>. If the saved
    // list already routed, just re-render the detail in place: router() has side
    // effects (it closes the info sheet, exits fullscreen) the user would notice.
    if (!saved) router();
    else if (currentView === 'detail') renderDetail(parseHash().param);
  }

  // Pull-to-refresh on the list (wired in app.js). Unlike loadProblems it doesn't
  // re-run the router, which would restore a stale saved scroll position, and a
  // failed fetch keeps the list that's already showing. Ticks and favourites come
  // too, so the pills reflect sends made on another device.
  async function refreshProblems() {
    const [res] = await Promise.all([
      sb.from('problems').select('*'),
      session ? loadTicks() : null,
      session ? loadFaves() : null,
    ]);
    if (res.error) { showToast('Couldn’t refresh problems', 'error'); return; }
    saveList('problems', res.data || []);
    setOfflineNote('list-offline', 0);
    showProblems(res.data || []);
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

  // Every .admin-only control appears only for admins, on a real problem. Edit
  // and Delete also appear for the problem's owner, unless it's a benchmark or
  // someone else has ticked it (db/39, db/25; canEditProblem above). Until that
  // check is back Edit stays hidden and Delete shows (openDeleteConfirm checks
  // again). The benchmark item reads "Mark" or "Remove", and isn't offered for an
  // ungraded problem (e.g. "Project"): a benchmark is accurate at its grade, and
  // an ungraded one would score nothing.
  function updateAdminUI() {
    const p = currentProblem;
    const show = !!(profile && profile.is_admin && p);
    document.querySelectorAll('.admin-only').forEach(btn => { btn.hidden = !show; });
    const owner = !!(p && !isAdmin() && isOwnProblem(p) && !p.is_benchmark);
    if (owner && othersUsed('p', p.id) === undefined) {
      askOthersUsed('p', p.id, () => { if (currentProblem === p) updateAdminUI(); });
    }
    const edit = document.getElementById('menu-edit');
    if (edit) edit.hidden = !canEditProblem(p);
    const del = document.getElementById('menu-delete');
    if (del) del.hidden = !(p && (isAdmin() || (owner && othersUsed('p', p.id) !== true)));
    // Move to Circuits: admins only, never a benchmark (unmark it first; db/40).
    const move = document.getElementById('menu-move');
    if (move) move.hidden = !(show && !p.is_benchmark);
    const bench = document.getElementById('menu-bench');
    if (bench && show) {
      const on = !!currentProblem.is_benchmark;
      bench.hidden = !on && !isGraded(currentProblem);
      document.getElementById('menu-bench-label').textContent = on ? 'Remove benchmark' : 'Mark as benchmark';
    }
  }

  const isOwnProblem = p => !!(session && p && p.setter_id && p.setter_id === session.user.id);
  const isGraded = p => gradeRank(p.grade) < GRADE_ORDER.length;

  // ── Benchmark a problem (admins only) ────────────────────────────────────────
  // A benchmark is a high-quality problem that's accurate at its grade, and only
  // benchmarks score points: leaderboard() (db/27) is the single source of truth.
  // The DB enforces who can set it: the db/25 trigger pins is_benchmark for
  // non-admins, and db/27 locks a benchmark's row (edit, delete) to admins.
  let benchBusy = false;
  async function toggleBenchmark() {
    const p = currentProblem;
    if (!p || !isAdmin() || benchBusy) return;
    const make = !p.is_benchmark;
    if (make && !isGraded(p)) { showToast('Give it a grade before making it a benchmark', 'error'); return; }
    benchBusy = true;
    // .select() so a write the DB quietly refused (RLS hides the row, or the
    // trigger pins the flag for a user who's no longer an admin) isn't reported
    // as a success.
    const { data, error } = await sb.from('problems')
      .update({ is_benchmark: make }).eq('id', p.id).select('id, is_benchmark');
    benchBusy = false;
    if (error) { showToast('Couldn’t change the benchmark — try again', 'error'); console.error(error); return; }
    if (!data || !data.length || data[0].is_benchmark !== make) {
      showToast('Only admins can change benchmarks', 'error');
      return;
    }
    p.is_benchmark = make;               // same object lives in allProblems
    leaderboardLoaded = false;           // points depend on it — refetch the board next view
    renderList();
    if (currentView === 'detail' && currentProblem === p) renderDetail(p.id);
    showToast(make ? `${displayName(p)} is now a benchmark` : `${displayName(p)} is no longer a benchmark`, 'success');
  }

  // ── Delete a problem ─────────────────────────────────────────────────────────
  // Admins can delete any problem. An owner can delete their own only while nobody
  // else has ticked it (their own ticks don't count), and never once it's a
  // benchmark — db/25 and db/27 enforce this in RLS, so these checks are just so
  // the owner gets a clear message instead of a dead end.
  async function openDeleteConfirm() {
    const p = currentProblem;
    if (!p || !(isAdmin() || isOwnProblem(p))) return;
    if (!isAdmin() && p.is_benchmark) { showToast('This is a benchmark, so only an admin can delete it', 'error'); return; }
    if (!isAdmin()) {
      const { data, error } = await sb.rpc('problem_has_other_ticks', { pid: p.id });
      if (error) { showToast('Couldn’t check that — try again', 'error'); return; }
      if (data) { showToast('Someone else has ticked this, so only an admin can delete it', 'error'); return; }
      if (currentProblem !== p) return;   // swiped away while checking
    }
    document.getElementById('delete-name').textContent = displayName(p);
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

    // .select() so we can tell a real delete from one RLS silently filtered out
    // (a blocked delete returns no error, just zero rows).
    const { data, error } = await sb.from('problems').delete().eq('id', p.id).select('id');
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      errEl.textContent = error.code === '42501'
        ? 'You don’t have permission to delete this problem.'
        : error.message;
      return;
    }
    if (!data || !data.length) {
      errEl.textContent = isAdmin()
        ? 'Couldn’t delete it — it may already have been removed.'
        : 'Only an admin can delete this now: someone else has ticked it, or it’s become a benchmark.';
      return;
    }

    // The deck (and this problem's place in it) as it stood before the delete —
    // that's what names the neighbour we fall back to below.
    const deck = visibleProblems();
    const deckIdx = deck.findIndex(x => String(x.id) === String(p.id));

    allProblems = allProblems.filter(x => String(x.id) !== String(p.id));
    myTicks.delete(String(p.id));
    myTicksNormal.delete(String(p.id));
    myTicksMirrored.delete(String(p.id));
    myFaves.delete(String(p.id));
    leaderboardLoaded = false;           // its ticks cascade away — refetch the board next view
    closeDeleteConfirm();
    renderList();
    showToast('Problem deleted', 'success');

    // Where to land — stay in viewing mode wherever we can:
    //   1. swiped here → the last problem they were looking at (skipping any that
    //      have since gone too), so working through a deck isn't interrupted;
    //   2. otherwise → the problem before this one in the deck, or the one after
    //      it if they've just deleted the first;
    //   3. nothing either side (that was the only problem left, or it wasn't in
    //      the deck at all) → the list, where replaceRoute keeps their scroll
    //      position and leaves no Back that returns to the problem that's gone.
    let backTo = '';
    while (detailTrail.length && !backTo) {
      const id = detailTrail.pop();
      if (allProblems.some(x => String(x.id) === String(id))) backTo = id;
    }
    if (!backTo && deckIdx !== -1) {
      const neighbour = deckIdx > 0 ? deck[deckIdx - 1] : deck[deckIdx + 1];
      if (neighbour) backTo = neighbour.id;
    }
    replaceRoute(backTo ? '#detail/' + encodeURIComponent(backTo) : '#list');
  }

  // ── Who may edit (db/39) ─────────────────────────────────────────────────────
  // One Edit for problems and circuits opens the Create screen pre-filled
  // (#create/<id>, #circuit-create/<id>). Admins may edit anything. The owner may
  // edit their own problem while it isn't a benchmark and nobody else has ticked
  // it (problem_has_other_ticks, db/25), and their own circuit while no challenge
  // uses it and nobody else has logged a run of it (circuit_has_other_logs,
  // db/39). The Hangout's problems have no owner, so they're admin-only. RLS and
  // db/39's guards enforce all of it (an owner can't touch the setter, the
  // benchmark flag or anything else); this is only so Edit shows to the people it
  // will work for. "Someone else used it" is asked once per item and kept for a
  // minute, per signed-in account (the answer leaves the caller's own out).
  const OTHERS_TTL_MS = 60000;
  const othersKnown = new Map();     // '<uid>|p|<id>' or '<uid>|c|<id>' -> { v, t }
  const othersAsking = new Set();
  const othersKey = (kind, id) => `${session ? session.user.id : ''}|${kind}|${id}`;

  // true / false, or undefined while it isn't known (or is over a minute old).
  function othersUsed(kind, id) {
    const k = othersKnown.get(othersKey(kind, id));
    return k && Date.now() - k.t < OTHERS_TTL_MS ? k.v : undefined;
  }
  // Ask the database; then(v) gets true/false, or undefined when the ask failed.
  async function askOthersUsed(kind, id, then) {
    const key = othersKey(kind, id);
    if (othersAsking.has(key)) return;
    othersAsking.add(key);
    const { data, error } = kind === 'p'
      ? await sb.rpc('problem_has_other_ticks', { pid: id })
      : await sb.rpc('circuit_has_other_logs', { cid: id });
    othersAsking.delete(key);
    if (error) { console.warn('edit check failed', error); if (then) then(undefined); return; }
    othersKnown.set(key, { v: !!data, t: Date.now() });
    if (then) then(!!data);
  }

  // Edit shows only when it will work. An owner's check runs in the background
  // the first time (Edit appears when it says yes).
  function canEditProblem(p) {
    if (!p) return false;
    if (isAdmin()) return true;
    return isOwnProblem(p) && !p.is_benchmark && othersUsed('p', p.id) === false;
  }
  // The route guard: let an owner through while it isn't known yet (the Edit
  // screen asks again and sends them back if someone else has ticked it).
  const mayOpenProblemEdit = p =>
    !!p && (isAdmin() || (isOwnProblem(p) && !p.is_benchmark && othersUsed('p', p.id) !== true));

  // Move to Circuits (admins, db/40): the circuit Create screen, pre-filled.
  function openProblemMove() {
    const p = currentProblem;
    if (p && isAdmin() && !p.is_benchmark) location.hash = '#move/' + encodeURIComponent(p.id);
  }

  function openProblemEdit() {
    const p = currentProblem;
    if (p && canEditProblem(p)) location.hash = '#create/' + encodeURIComponent(p.id);
  }

