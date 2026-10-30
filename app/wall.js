// ProjectBoard - the pieces load as ordered classic <script>s sharing ONE global scope
// (no ES modules, no build step). Order: state, core, problems, admin, account,
// authoring, circuits, challenge, leaderboard, wall, app. This file: the wall-screen
// mode (?wall) for the touchscreen next to the board.
//
// The Pi's kiosk (pi/systemd/kiosk.service) opens /?wall on a 1280×720 landscape
// touchscreen. Browse and cast only:
//   - Problems: a rail of grades down the left edge (a tap jumps the list to that
//     grade; the star filters to benchmarks), the whole list with a header per
//     grade, and on the right the chosen problem's name, Mirror and "Light it up"
//     over the board (its outlines over the dimmed wall). Light it up casts
//     through castByName() exactly as the phone does (guests can cast; with no
//     location fix the geofence lets it through).
//   - Circuits: the list, and the chosen circuit (its numbered holds) over the
//     board. Light it up opens the phone's Cast sheet (circuits.js): speed and
//     loop, then the countdown, the move count and Stop. The wall doesn't go idle
//     while a run is going; night closes the sheet (the Pi ends the run).
//   - Ranks, read-only: Points and each challenge's board side by side.
//   - Get the app: the /scan QR, in place of Profile. No sign-in anywhere.
// After WALL_IDLE_MS without a touch it goes back to the list (the filter and the
// choice cleared, the list at the top) and plays slides: the QR and the benchmark of the day. A touch ends
// them (on the benchmark slide it picks that problem); a reload while they're up
// (an app update) comes back to them, not to 20 minutes of the list. At
// night (the Pi's 23:00–08:00) it shows only a dimmed QR, and casting is off: the
// Pi ignores casts then anyway. With no connection the saved list stays up with a
// note, casting is off, and it keeps trying.
//
// The phone views stay underneath, hidden (body.wall): the loaders and the router
// run as usual, and the few hooks into them (renderList, refreshBoardViews,
// loadProblems, showChallenges) only call in here when WALL is set.

  const WALL_IDLE_MS = 20 * 60 * 1000;  // no touch for this long: back to the list, then the slides
  const WALL_SLIDE_MS = 12 * 1000;       // each idle slide
  const WALL_NIGHT_FROM = 23 * 60;       // minutes past midnight; the Pi's NIGHT_START / NIGHT_END
  const WALL_NIGHT_TO = 8 * 60;          // (pi/config.env.example), so the screen and the LEDs agree
  const WALL_POLL_MS = 5 * 60 * 1000;    // fresh problems, names and challenges while online
  const WALL_RETRY_MS = 30 * 1000;       // ...and how often to try while the connection is down
  const WALL_BOARD_ROWS = 10;            // rows on each Ranks board
  const WALL_IDLE_KEY = 'pb-wall-idle';  // sessionStorage: the slides were up when the page unloaded

  let wallPage = 'problems';     // 'problems' | 'circuits' | 'ranks' | 'app'
  let wallCircId = null;         // the chosen circuit's id
  let wallSelId = null;          // the chosen problem's id (looked up afresh, the list reloads)
  let wallMirror = false;        // the chosen problem is shown (and cast) mirrored
  let wallLastTouch = Date.now();
  let wallIdleOn = false;        // the idle slides are showing
  let wallNightOn = false;       // the night screen is showing
  let wallSlide = 0;             // index into wallSlides()
  let wallSlideAt = 0;           // when the current slide went up
  let wallNetDown = false;       // the last fetch of the problems failed
  let wallLastPoll = Date.now(); // boot has just loaded everything
  let wallCastHtml = '';         // the cast button's resting markup

  const wallEl = id => document.getElementById(id);
  // sessionStorage, guarded like lsGet/lsSet (core.js); null removes the key.
  function ssGet(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, value) {
    try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch (e) {}
  }

  if (WALL) {
    document.body.classList.add('wall');
    wallEl('wall').hidden = false;
  }

  // ── Problems page ─────────────────────────────────────────────────────────────
  const wallSelected = () => (wallSelId === null ? null : allProblems.find(p => String(p.id) === String(wallSelId)) || null);

  function wallMetaHtml(p) {
    return `
      <span class="grade-badge">${escHtml(fontGrade(p.grade) || '—')}</span>
      ${p.is_benchmark ? benchMarkSvg() : ''}
      ${newBadgeHtml(p)}
      <span class="meta-setter">${escHtml(setterName(p))}</span>`;
  }

  // The grade sections' keys and labels. Unknown grades sort last (gradeRank).
  const wallGradeKey = p => p.grade || '';
  const wallGradeLabel = g => (g ? fontGrade(g) : '—');

  function wallCardHtml(p) {
    const sel = String(p.id) === String(wallSelId);
    return `
      <button class="problem-card wall-card${sel ? ' selected' : ''}" type="button" data-id="${escAttr(p.id)}" aria-pressed="${sel}">
        <span class="problem-info">
          <span class="problem-name">${escHtml(displayName(p))}</span>
          <span class="problem-meta">${wallMetaHtml(p)}</span>
        </span>
      </button>`;
  }

  // The list, a section per grade with a sticky header, and the rail of the
  // grades in it. Called from renderList, so it follows every load, refresh and
  // setter-name update. The only filter is the phone list's own benchOnly (the
  // star); activeGrades stays empty on the wall, and search, favourites and done
  // stay off without a keyboard or account.
  function wallRenderList() {
    if (!WALL) return;
    const box = wallEl('wall-list');
    const top = box.scrollTop;
    const bench = wallEl('wall-bench');
    bench.classList.toggle('active', benchOnly);
    bench.setAttribute('aria-pressed', benchOnly ? 'true' : 'false');

    let grades = [];
    if (!loaded) {
      box.innerHTML = wallNetDown
        ? `<div class="state-msg"><div class="icon">⚠️</div>Can’t reach the server right now.<br>Trying again by itself.</div>`
        : `<div class="spinner"></div>`;
    } else {
      const sections = [];                 // [{ g, ps }] in list order (visibleProblems sorts by grade)
      visibleProblems().forEach(p => {
        const g = wallGradeKey(p);
        if (!sections.length || sections[sections.length - 1].g !== g) sections.push({ g, ps: [] });
        sections[sections.length - 1].ps.push(p);
      });
      grades = sections.map(x => x.g);
      box.innerHTML = sections.length
        ? sections.map(({ g, ps }) => `
            <section class="wall-grade" data-grade="${escAttr(g)}">
              <h2 class="wall-grade-head">${escHtml(wallGradeLabel(g))}<span>${ps.length} problem${ps.length === 1 ? '' : 's'}</span></h2>
              ${ps.map(wallCardHtml).join('')}
            </section>`).join('')
        : `<div class="state-msg"><div class="icon">🔎</div>No benchmarks yet.</div>`;
      box.scrollTop = top;
    }
    wallEl('wall-rail').innerHTML = grades.map(g => {
      const label = wallGradeLabel(g);
      return `<button class="wall-rail-btn${label.length > 3 ? ' long' : ''}" type="button" data-grade="${escAttr(g)}">${escHtml(label)}</button>`;
    }).join('');
    wallMarkGrade();
    if (wallSelId !== null && loaded && !wallSelected()) wallSelect(null);   // deleted since
    else wallRenderSel();
  }

  // The rail marks the grade at the top of the list.
  function wallMarkGrade() {
    const box = wallEl('wall-list');
    let here = null;
    for (const sec of box.querySelectorAll('.wall-grade')) {
      if (sec.offsetTop > box.scrollTop + 1) break;
      here = sec.dataset.grade;
    }
    document.querySelectorAll('#wall-rail .wall-rail-btn').forEach(b => b.classList.toggle('here', b.dataset.grade === here));
  }

  // A tap on the rail: that grade's header to the top of the list. No smooth
  // scrolling: a long glide is janky on the Pi, and it's a jump, not a browse.
  function wallJumpTo(g) {
    const sec = [...wallEl('wall-list').querySelectorAll('.wall-grade')].find(x => x.dataset.grade === g);
    if (sec) wallEl('wall-list').scrollTop = sec.offsetTop;
  }

  // The chosen problem's name and details, Mirror and the cast button.
  function wallRenderSel() {
    const p = wallSelected();
    wallEl('wall-sel').innerHTML = p
      ? `<h1 class="wall-name">${escHtml(displayName(p))}</h1>
         <div class="problem-meta wall-meta">${wallMetaHtml(p)}</div>`
      : `<h1 class="wall-name wall-name-empty">Pick a problem</h1>
         <p class="wall-hint">Choose one from the list, then light it up on the wall.</p>`;
    const mirror = wallEl('wall-mirror');
    mirror.disabled = !p;
    mirror.classList.toggle('active', !!p && wallMirror);
    mirror.setAttribute('aria-pressed', p && wallMirror ? 'true' : 'false');
    const cast = wallEl('wall-cast');
    if (!castTarget) cast.disabled = !p || wallOffline();   // a cast in progress owns the button
    wallRenderOffline();
    wallRenderCircSel();                 // its Light it up follows the connection and the night too
  }

  function wallBoardHtml(p, mirror) {
    const overlay = p ? (boardShapeOverlayHtml(p, { mirror, dim: true }) || boardOverlayHtml(p, mirror)) : '';
    return `<div class="board-wrap wall-board"><img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />${overlay}</div>`;
  }

  function wallRenderStage() {
    if (!WALL) return;
    const p = wallSelected();
    wallEl('wall-stage').innerHTML = wallBoardHtml(p, wallMirror)
      + (p ? '' : `<div class="wall-stage-hint">Tap a problem on the left</div>`);
  }

  function wallSelect(id) {
    wallSelId = id === null || id === undefined ? null : id;
    wallMirror = false;
    const p = wallSelected();
    // A cast still waiting on the location check for the problem before lets go
    // of the button; castByName drops it when the check returns (as renderDetail).
    if (castTarget && (!p || castTarget.name !== p.name || castTarget.mirror !== wallMirror)) {
      castTarget = null;
      wallResetCast();
    }
    document.querySelectorAll('#wall-list .wall-card').forEach(c => {
      const on = String(c.dataset.id) === String(wallSelId);
      c.classList.toggle('selected', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    wallRenderSel();
    wallRenderStage();
  }

  function wallResetCast() {
    const btn = wallEl('wall-cast');
    resetCastButton(btn);
    btn.innerHTML = wallCastHtml;
    const p = wallSelected();
    btn.disabled = !p || wallOffline();
  }

  function wallToggleMirror() {
    if (!wallSelected()) return;
    wallMirror = !wallMirror;
    if (castTarget) { castTarget = null; wallResetCast(); }
    wallRenderSel();
    wallRenderStage();
  }

  // Same path as the phone's cast button: name and orientation fixed at the tap,
  // and only sent if they're still on screen once the location check returns.
  function wallCast(e) {
    const p = wallSelected();
    if (!p || wallOffline() || wallNightOn) return;
    const name = p.name, mirror = wallMirror;
    castByName(name, e.currentTarget, mirror, () => {
      const q = wallSelected();
      return wallPage === 'problems' && !wallIdleOn && !wallNightOn && !!q && q.name === name && wallMirror === mirror;
    });
  }

  // ── Circuits page ─────────────────────────────────────────────────────────────
  const wallCircSelected = () => (wallCircId === null ? null
    : allCircuits.find(c => String(c.id) === String(wallCircId)) || null);

  function wallCircMetaHtml(c) {
    const n = circuitSeq(c).length;
    return `
      <span class="grade-badge">${escHtml(c.grade || '—')}</span>
      ${newBadgeHtml(c)}
      <span class="meta-setter">${escHtml(setterName(c))}</span>
      <span class="circuit-len">${n} move${n === 1 ? '' : 's'}</span>
      ${c.loops ? '<span class="loop-badge">↻ Loop</span>' : ''}`;
  }

  // Easiest first, as the phone's list; circuits are few, so no grade rail.
  function wallRenderCircuits() {
    if (!WALL) return;
    const box = wallEl('wall-clist');
    const top = box.scrollTop;
    if (!circuitsLoaded) {
      box.innerHTML = circuitsError || wallNetDown
        ? `<div class="state-msg"><div class="icon">⚠️</div>Can’t reach the server right now.<br>Trying again by itself.</div>`
        : `<div class="spinner"></div>`;
    } else {
      const list = allCircuits.slice().sort((a, b) =>
        sportRank(a.grade) - sportRank(b.grade) || circuitName(a).localeCompare(circuitName(b)));
      box.innerHTML = list.length ? list.map(c => {
        const sel = String(c.id) === String(wallCircId);
        return `
          <button class="problem-card wall-card${sel ? ' selected' : ''}" type="button" data-id="${escAttr(c.id)}" aria-pressed="${sel}">
            <span class="problem-info">
              <span class="problem-name">${escHtml(circuitName(c))}</span>
              <span class="problem-meta">${wallCircMetaHtml(c)}</span>
            </span>
          </button>`;
      }).join('') : `<div class="state-msg"><div class="icon">🧗</div>No circuits yet.</div>`;
      box.scrollTop = top;
    }
    if (wallCircId !== null && circuitsLoaded && !wallCircSelected()) wallCircSelect(null);   // deleted since
    else { wallRenderCircSel(); wallRenderCircStage(); }
  }

  function wallRenderCircSel() {
    if (!WALL) return;
    const c = wallCircSelected();
    wallEl('wall-csel').innerHTML = c
      ? `<h1 class="wall-name">${escHtml(circuitName(c))}</h1>
         <div class="problem-meta wall-meta">${wallCircMetaHtml(c)}</div>`
      : `<h1 class="wall-name wall-name-empty">Pick a circuit</h1>
         <p class="wall-hint">A long route, lit one move at a time at your speed.</p>`;
    wallEl('wall-ccast').disabled = !c || wallOffline() || wallNightOn;
  }

  function wallRenderCircStage() {
    if (!WALL) return;
    const c = wallCircSelected();
    wallEl('wall-cstage').innerHTML =
      `<div class="board-wrap wall-board"><img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" />`
      + (c ? `<div class="hold-layer">${circuitStaticOverlay(c)}</div>` : '') + '</div>'
      + (c ? '' : `<div class="wall-stage-hint">Tap a circuit on the left</div>`);
  }

  function wallCircSelect(id) {
    wallCircId = id === null || id === undefined ? null : id;
    document.querySelectorAll('#wall-clist .wall-card').forEach(c => {
      const on = String(c.dataset.id) === String(wallCircId);
      c.classList.toggle('selected', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    wallRenderCircSel();
    wallRenderCircStage();
  }

  function wallCircCast() {
    const c = wallCircSelected();
    if (!c || wallOffline() || wallNightOn) return;
    openCircuitCast(c);
  }

  // ── Offline ───────────────────────────────────────────────────────────────────
  const wallOffline = () => wallNetDown || !navigator.onLine;

  function wallSetNet(down) {
    if (!WALL) return;
    wallNetDown = down;
    wallRenderSel();
    if (!loaded) wallRenderList();
  }

  function wallRenderOffline() {
    const off = wallOffline();
    wallEl('wall-status').hidden = !off;
    const note = wallEl('wall-offline');
    note.hidden = !off;
    if (!off) return;
    const saved = savedList('problems');
    note.textContent = loaded && saved
      ? `No connection. Showing the problems saved ${savedWhen(saved.t)}. Lighting up the wall works again once it’s back.`
      : 'No connection. Lighting up the wall works again once it’s back.';
  }

  // Fresh problems (and setter names and challenges) every WALL_POLL_MS; the phone
  // gets them from pull-to-refresh, which the wall doesn't have. Every
  // WALL_RETRY_MS while the connection is down. Silent: no toasts on the wall.
  async function wallPoll() {
    wallLastPoll = Date.now();
    const { data, error } = await sb.from('problems').select('*');
    if (error) { wallSetNet(true); return; }
    saveList('problems', data || []);
    setOfflineNote('list-offline', 0);
    wallNetDown = false;
    showProblems(data || []);              // renderList -> wallRenderList
    loadCircuits();                        // showCircuits -> wallRenderCircuits
    loadProfileNames();
    loadChallenges();                      // showChallenges -> wallOnChallenges reloads Ranks if it's up
  }

  // ── Ranks (read-only) ────────────────────────────────────────────────────────
  function wallBoardRowsHtml(rows, stat, max) {
    return rows.filter(r => r.listed).slice(0, max).map(r => `
      <div class="leaderboard-row wall-row">
        <span class="lb-rank">${escHtml(rankLabel(r.rank))}</span>
        <span class="lb-name">${escHtml(r.username)}</span>
        <span class="lb-stat"><span class="lb-points">${escHtml(stat(r))}</span></span>
      </div>`).join('');
  }

  function wallBoardCardHtml(title, sub, state, rows, stat, max) {
    let body;
    if (state === 'loading') body = `<div class="spinner"></div>`;
    else if (state === 'error') body = `<div class="state-msg">Couldn’t load this board.</div>`;
    else body = wallBoardRowsHtml(rows, stat, max) || `<div class="state-msg">No one on this board yet.</div>`;
    return `
      <div class="wall-board-card">
        <h2>${escHtml(title)}</h2>
        <p class="wall-board-sub">${escHtml(sub)}</p>
        <div class="wall-rows">${body}</div>
      </div>`;
  }

  function wallRenderRanks() {
    if (!WALL) return;
    const pts = wallBoardCardHtml('Points', 'Benchmark sends',
      leaderboardError ? 'error' : leaderboardLoaded ? 'ok' : 'loading',
      leaderboard, r => `${r.points} pts`, WALL_BOARD_ROWS);
    const chs = allChallenges.map(c => {
      const b = challengeBoards[c.id];
      return wallBoardCardHtml(c.name, 'Best attempt, total time held',
        !b || !b.loaded ? 'loading' : b.error ? 'error' : 'ok',
        b ? b.rows : [], r => chClock(r.total_seconds), WALL_BOARD_ROWS);
    });
    wallEl('wall-boards').innerHTML = pts + chs.join('');
  }

  function wallLoadRanks() {
    wallRenderRanks();
    Promise.all([loadLeaderboard(true), ...allChallenges.map(c => loadChallengeBoard(c.id, true))])
      .then(wallRenderRanks, wallRenderRanks);
  }

  function wallOnChallenges() {
    if (!WALL) return;
    if (wallPage === 'ranks') wallLoadRanks();
  }

  // ── Pages ─────────────────────────────────────────────────────────────────────
  function wallSetPage(page) {
    wallPage = page;
    document.querySelectorAll('.wall-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
    document.querySelectorAll('.wall-page').forEach(s => s.classList.toggle('active', s.dataset.page === page));
    if (page === 'ranks') wallLoadRanks();
    if (page === 'circuits') wallRenderCircuits();
  }

  // ── Idle slides and night ─────────────────────────────────────────────────────
  function wallIsNight() {
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return WALL_NIGHT_FROM > WALL_NIGHT_TO
      ? (m >= WALL_NIGHT_FROM || m < WALL_NIGHT_TO)
      : (m >= WALL_NIGHT_FROM && m < WALL_NIGHT_TO);
  }
  const wallIsIdle = () => wallIdleOn || wallNightOn;

  // The benchmark of the day: the same one all day, the next one tomorrow.
  function wallFeatured() {
    const bench = allProblems.filter(p => p.is_benchmark)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!bench.length) return null;
    const d = new Date();
    const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    return bench[day % bench.length];
  }

  // The slides there's something to show for, in order. (Until 27 Oct 2026 each
  // challenge's top 5 had a slide after 'app'; it was taken out of the rotation.
  // The challenge boards are still on Ranks.)
  function wallSlides() {
    const s = ['app'];
    if (wallFeatured()) s.push('bench');
    return s;
  }

  const WALL_QR_SLOT = '<div class="wall-qr-card"><div class="wall-qr"></div></div>';

  function wallSlideHtml(kind) {
    if (kind === 'app') {
      return `
        <div class="wall-slide-app">
          ${WALL_QR_SLOT}
          <div class="wall-app-text">
            <h1>Light up the wall from your phone</h1>
            <ol class="wall-steps">
              <li>Scan the code with your phone’s camera</li>
              <li>Add Project Board to your home screen</li>
              <li>Tick your sends, save favourites and climb Ranks</li>
            </ol>
            <p class="wall-url">symmetryboard.co.uk</p>
          </div>
        </div>`;
    }
    // 'bench'
    const p = wallFeatured();
    return `
      <div class="wall-slide-bench">
        <div class="wall-slide-board">${wallBoardHtml(p, false)}</div>
        <div class="wall-slide-text">
          <p class="wall-kicker">Benchmark of the day</p>
          <h1>${escHtml(displayName(p))}</h1>
          <div class="problem-meta wall-meta">${wallMetaHtml(p)}</div>
          <p class="wall-slide-sub">Benchmarks score points on Ranks. Touch the screen to pick it, then light it up.</p>
        </div>
      </div>`;
  }

  function wallNightHtml() {
    return `
      <div class="wall-slide-night">
        ${WALL_QR_SLOT}
        <h1>The board’s asleep until 08:00</h1>
        <p>Scan to get the app</p>
      </div>`;
  }

  function wallFillQr(root) {
    const tpl = wallEl('wall-qr-tpl');
    root.querySelectorAll('.wall-qr:empty').forEach(slot => slot.appendChild(tpl.content.cloneNode(true)));
  }

  function wallRenderIdle() {
    const box = wallEl('wall-idle');
    box.hidden = !wallIsIdle();
    box.classList.toggle('night', wallNightOn);
    if (box.hidden) return;
    const slides = wallSlides();
    if (wallSlide >= slides.length) wallSlide = 0;
    const kind = slides[wallSlide];
    wallEl('wall-slide').innerHTML = wallNightOn ? wallNightHtml() : wallSlideHtml(kind);
    wallEl('wall-slide').dataset.kind = wallNightOn ? 'night' : kind;
    wallFillQr(box);
    wallEl('wall-dots').innerHTML = wallNightOn ? ''
      : slides.map((_, i) => `<i class="${i === wallSlide ? 'on' : ''}"></i>`).join('');
  }

  // Back to the start: the Problems page, no filter, nothing chosen, the list at
  // the top. Then the slides.
  function wallGoIdle() {
    abandonCircuitCast();
    wallSetPage('problems');
    benchOnly = false;
    wallSelect(null);
    wallCircSelect(null);
    wallEl('wall-clist').scrollTop = 0;
    wallRenderList();
    wallEl('wall-list').scrollTop = 0;
    wallMarkGrade();
    wallIdleOn = true;
    wallSlide = 0;
    wallSlideAt = Date.now();
    ssSet(WALL_IDLE_KEY, '1');
    wallRenderIdle();
    document.dispatchEvent(new Event('wall-idle'));   // app.js: a waiting update reloads now
  }

  // A touch on the slides ends them (the touch does nothing else). On the
  // benchmark slide it picks that problem. At night it stays put.
  function wallWake() {
    if (wallNightOn) return;
    const kind = wallSlides()[wallSlide];
    wallIdleOn = false;
    wallLastTouch = Date.now();
    ssSet(WALL_IDLE_KEY, null);
    wallRenderIdle();
    if (kind === 'bench') {
      const p = wallFeatured();
      if (p) {
        wallSelect(p.id);
        const card = document.querySelector(`#wall-list .wall-card[data-id="${CSS.escape(String(p.id))}"]`);
        if (card) card.scrollIntoView({ block: 'center' });
      }
    }
  }

  function wallTick() {
    const now = Date.now();
    const night = wallIsNight();
    if (night !== wallNightOn) {
      wallNightOn = night;
      if (night) wallGoIdle();             // casting off, the choice cleared
      wallRenderIdle();
      wallRenderSel();
    }
    if (!wallNightOn) {
      // Not while a circuit runs: the climber is on the wall, not touching the screen.
      if (circuitRunGoing()) wallLastTouch = now;
      if (!wallIdleOn && now - wallLastTouch > WALL_IDLE_MS) wallGoIdle();
      else if (wallIdleOn && now - wallSlideAt > WALL_SLIDE_MS) {
        wallSlide = (wallSlide + 1) % wallSlides().length;
        wallSlideAt = now;
        wallRenderIdle();
      }
      if (now - wallLastPoll > (wallOffline() ? WALL_RETRY_MS : WALL_POLL_MS)) wallPoll();
    }
  }

  // Called by refreshBoardViews when the board image, map or outlines change.
  function wallRefreshBoard() {
    if (!WALL) return;
    wallRenderStage();
    wallRenderCircStage();
    if (wallIdleOn && wallSlides()[wallSlide] === 'bench') wallRenderIdle();
  }

  // ── Start (from app.js's boot) ────────────────────────────────────────────────
  function startWall() {
    wallCastHtml = wallEl('wall-cast').innerHTML;
    wallFillQr(wallEl('wall'));

    // Any touch counts as someone using the screen: a tap, or the start of a
    // scroll or drag (touchstart as well as pointerdown, which a scroll cancels).
    // Not 'scroll' itself: re-rendering the list moves it too.
    ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(t =>
      document.addEventListener(t, () => { wallLastTouch = Date.now(); }, { capture: true, passive: true }));

    document.querySelectorAll('.wall-tab').forEach(t => t.addEventListener('click', () => wallSetPage(t.dataset.page)));
    wallEl('wall-rail').addEventListener('click', e => {
      const b = e.target.closest('.wall-rail-btn');
      if (b) wallJumpTo(b.dataset.grade);
    });
    wallEl('wall-bench').addEventListener('click', () => {
      benchOnly = !benchOnly;
      wallRenderList();
      wallEl('wall-list').scrollTop = 0;
      wallMarkGrade();
    });
    let markQueued = false;
    wallEl('wall-list').addEventListener('scroll', () => {
      if (markQueued) return;
      markQueued = true;
      requestAnimationFrame(() => { markQueued = false; wallMarkGrade(); });
    }, { passive: true });
    wallEl('wall-list').addEventListener('click', e => {
      const card = e.target.closest('.wall-card');
      if (card) wallSelect(card.dataset.id);
    });
    wallEl('wall-mirror').addEventListener('click', wallToggleMirror);
    wallEl('wall-cast').addEventListener('click', wallCast);
    wallEl('wall-clist').addEventListener('click', e => {
      const card = e.target.closest('.wall-card');
      if (card) wallCircSelect(card.dataset.id);
    });
    wallEl('wall-ccast').addEventListener('click', wallCircCast);
    wallEl('wall-idle').addEventListener('click', wallWake);
    window.addEventListener('online', () => { wallRenderSel(); wallPoll(); });
    window.addEventListener('offline', wallRenderSel);

    wallRenderList();
    wallRenderStage();
    wallRenderCircuits();
    wallNightOn = wallIsNight();
    if (wallNightOn || ssGet(WALL_IDLE_KEY)) wallGoIdle();
    setInterval(wallTick, 1000);
  }
