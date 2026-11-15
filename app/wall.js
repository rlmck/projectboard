// ProjectBoard - the pieces load as ordered classic <script>s sharing ONE global scope
// (no ES modules, no build step). Order: state, core, problems, admin, account,
// authoring, circuits, challenge, leaderboard, wall, app. This file: the wall-screen
// mode (?wall) for the touchscreen next to the board.
//
// The Pi's kiosk (pi/systemd/kiosk.service) opens /?wall on a 1280×720 landscape
// touchscreen. Browse and cast only:
//   - Problems: the phone's filter row over the list (problems.js; the same state
//     and Filter panel): the filter icon, Benchmarks, a search field (typed on the
//     on-screen keyboard, docked over the board so the list stays in view; the
//     phone's searchQuery and matching) and Clear, then the list (sorted Easy or Hard: a
//     header per grade and a rail of grades down the left edge, a tap jumps the
//     list to that grade), and on the right the chosen problem's name, Mirror and
//     how its cast went, over the board (its outlines over the dimmed wall).
//     Since 2 Nov 2026 there's no cast button: a clean tap on a card (not a
//     scroll) picks the problem and lights it, a tap on Mirror flips it and
//     lights that side, and the wall's pick takes over whatever is on the board.
//     It casts through castByName() exactly as the phone does (guests can cast;
//     with no location fix the geofence lets it through); rapid taps send only
//     the latest.
//   - Circuits: the same row (Looping, search, Clear), the list, and the chosen circuit (its numbered holds) over the
//     board, dimmed when none is chosen. Opening the page lights nothing. Since
//     2 Nov 2026 a clean tap on a circuit picks it and lights all its holds at once
//     (show_circuit, contract 8.7: starts green, the last hold red, the rest blue;
//     no animation), with the same tap rules and sending as Problems.
//     Start circuit opens the phone's Cast sheet (circuits.js): speed and loop,
//     then the countdown, the move count and Stop. The wall doesn't go idle while
//     a run is going.
//   - Create (db/35), when the wall key works: anyone at the wall sets a problem
//     with no sign-in: the board to tap holds on (the phone's rules, cycleHold),
//     the name on an on-screen keyboard, grade, feet rule, Undo, Clear, Cancel,
//     Save. Every tap lights the board (authoring.js, contract §9). Saved through
//     wall_create_problem() with the wall key, as The Hangout; then the new
//     problem is chosen on Problems and lit on the board. No idle slides while it's
//     open; 5 minutes untouched asks, then discards it.
//   - Ranks, read-only: Points and each challenge's board side by side.
//   - Get the app: the /scan QR, in place of Profile. No sign-in anywhere.
// After WALL_IDLE_MS without a touch it goes back to the list (the filters, the
// search and the sort back to the defaults, the keyboard closed, the choice
// cleared, the list at the top) and plays
// slides: the QR and the benchmark of the day. A touch ends them (on the
// benchmark slide it picks that problem and lights it); a reload while they're up
// (an app update) comes back to them, not to 20 minutes of the list. There's no
// night screen here: outside the opening hours the Pi stops the kiosk and powers
// the screen down (pi/ops/pb-mode, since 7 Nov 2026). With no connection the
// saved list stays up with a note, casting is off, and it keeps trying.
//
// Kiosk hardening (12 Nov 2026, review WALL-01/02/03/11): no context menu, drag or
// selection anywhere on the wall (a long-press or right-click opens nothing, so the
// screen can't be sent to another page and Inspect can't show the wall key; the Pi
// also turns DevTools off by policy, pi/conf/chromium-kiosk.json). A forgotten
// "Discard this problem?" sheet becomes the idle ask after 5 minutes untouched, and
// an endless circuit run ends on the screen at the Pi's 30-minute limit
// (circuits.js). While the page is on screen it writes a heartbeat into IndexedDB
// every 2 minutes (wallAlive); pb-health restarts the kiosk when it stops (a
// crashed or frozen page, or the screen left on some other page).
//
// Everything the wall sends to the board (a problem, show_circuit, cast_circuit,
// stop, the live LEDs while setting) goes through one queue (boardSend, core.js;
// review WALL-08): one message at a time, in the order they were made.
//
// Kept light for the Pi 4 (review session 12, 15 Nov 2026: WALL-04, WALL-05): the
// keyboard's keys are built once and only relabelled; a search key re-renders only
// its list; a pick or Mirror redraws only what's over the board image; the poll
// re-renders only rows that changed, and never under a finger or a moving list
// (wallHandsOn: the render waits until they're off). An app update goes in after
// 2 minutes untouched and comes back to the same page, choice and scroll.
//
// The phone views stay underneath, hidden (body.wall): the loaders and the router
// run as usual, and the few hooks into them (renderList, refreshBoardViews,
// loadProblems, showChallenges) only call in here when WALL is set; the phone's
// lists themselves aren't built on the wall.

  const WALL_IDLE_MS = 20 * 60 * 1000;  // no touch for this long: back to the list, then the slides
  const WALL_SLIDE_MS = 12 * 1000;       // each idle slide
  const WALL_POLL_MS = 5 * 60 * 1000;    // fresh problems, names and challenges while online
  const WALL_RETRY_MS = 30 * 1000;       // ...and how often to try while the connection is down
  const WALL_BOARD_ROWS = 10;            // rows on each Ranks board
  const WALL_IDLE_KEY = 'pb-wall-idle';  // sessionStorage: the slides were up when the page unloaded
  const WALL_ALIVE_MS = 2 * 60 * 1000;   // the heartbeat for pb-health (wallAlive); it restarts the kiosk after 10 min without one
  const WALL_UPDATE_CHECK_MS = 5 * 60 * 1000;   // how often app.js asks for a new version (TODO 8; hourly before)
  const WALL_UPDATE_IDLE_MS = 2 * 60 * 1000;    // a waiting update goes in after this long untouched (wallUpdateOk)
  const WALL_RESUME_KEY = 'pb-wall-resume';     // sessionStorage: where the wall was when an update reloaded it
  const WALL_RESUME_MAX_MS = 10 * 60 * 1000;    // ...used only by the load straight after

  let wallPage = 'problems';     // 'problems' | 'circuits' | 'ranks' | 'app'
  let wallCircId = null;         // the chosen circuit's id
  let wallSelId = null;          // the chosen problem's id (looked up afresh, the list reloads)
  let wallMirror = false;        // the chosen problem is shown (and cast) mirrored
  let wallLastTouch = Date.now();
  let wallIdleOn = false;        // the idle slides are showing
  let wallSlide = 0;             // index into wallSlides()
  let wallSlideAt = 0;           // when the current slide went up
  let wallNetDown = false;       // the last fetch of the problems failed
  let wallLastPoll = Date.now(); // boot has just loaded everything
  let wallAliveAt = 0;           // the last heartbeat (0: one is due now)
  // How the last tap's cast went, per page (#wall-lit, #wall-clit). The sends
  // themselves queue in boardSend (core.js): a newer tap drops one still waiting.
  let wallCastState = null;      // Problems: { name, mirror, state: 'sending' | 'sent' | 'failed' }
  let wallCircCastState = null;  // Circuits (show_circuit): { name, state }
  // Fingers on the screen and the lists moving (wallHandsOn): renders that aren't
  // the answer to a tap wait until they're off, so a list is never rebuilt under a
  // finger (which would swallow its tap) or while it scrolls.
  const wallFingers = new Map(); // pointerId -> when it went down
  let wallTouches = 0;           // touch points down (a scroll cancels the pointer, not the touch)
  let wallScrollAt = 0;          // when a list last scrolled
  const wallDeferred = new Set();// 'list' | 'circuits': renders waiting for the hands to come off
  let wallSettleTimer = 0;
  let wallResumeTop = null;      // a scroll position to restore once the list is rendered (an update)
  let wallResumeCTop = null;
  // A clean tap: the finger went down while the list wasn't moving, and the list
  // didn't scroll and the finger didn't move more than WALL_TAP_SLOP px before it
  // came up. Anything else (a scroll, a drag, the touch that stops a fling) only
  // moves the list: it never picks or casts. Both lists (wallTapList).
  const WALL_TAP_SLOP = 10;      // px
  const WALL_FLING_MS = 150;     // the list scrolled this recently: a touch is stopping it
  let wallKeyOk = false;         // the wall key works (wall_key_ok, db/35): Create is offered
  let wallCreateOn = false;      // the Create page is open (the create state in state.js is the wall's)
  let wallCreateName = '';
  let wallKbShift = true;        // the next letter is a capital (at the start, and after a space; the name only)
  // What the on-screen keyboard types into: null (closed), 'name' (Create's name)
  // or a list's search, 'problems' | 'circuits' (WALL_KB_TARGETS).
  let wallKbFor = null;
  // The search text as typed, per list; searchQuery / circuitSearch (state.js) hold
  // it trimmed and lowercased, as the phone's fields do, and do the filtering.
  const wallSearch = { problems: '', circuits: '' };
  let wallAsk = null;            // the discard sheet: { kind: 'idle' | 'leave', then, until }

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

  // Sets an element's HTML only when it differs from what it was last set to, so a
  // re-render that changes nothing touches nothing (no restyle, no relayout).
  function wallSetHtml(el, html) {
    if (el._wallHtml === html) return;
    el._wallHtml = html;
    el.innerHTML = html;
  }

  // ── Hands on the screen (WALL-05) ─────────────────────────────────────────────
  // A finger down, or a list scrolling (a finger dragging it or a fling; only
  // within a few seconds of a touch, so the list's own re-render moving it doesn't count).
  function wallHandsOn() {
    const now = Date.now();
    for (const [id, t] of wallFingers) if (now - t > 15000) wallFingers.delete(id);   // a lost pointerup
    return wallFingers.size > 0 || wallTouches > 0
      || (now - wallScrollAt < WALL_FLING_MS && now - wallLastTouch < 5000);
  }
  // A render that would happen under a finger waits; it runs once they're off.
  function wallDefer(what) {
    if (!wallHandsOn()) return false;
    wallDeferred.add(what);
    wallSettleSoon();
    return true;
  }
  function wallSettleSoon() {
    if (wallSettleTimer || !wallDeferred.size) return;
    wallSettleTimer = setTimeout(() => {
      wallSettleTimer = 0;
      if (wallHandsOn()) { wallSettleSoon(); return; }
      const due = [...wallDeferred];
      wallDeferred.clear();
      if (due.includes('list')) wallRenderList();
      if (due.includes('circuits')) wallRenderCircuits();
    }, 100);
  }

  // The grade sections' keys and labels. Unknown grades sort last (gradeRank).
  const wallGradeKey = p => p.grade || '';
  const wallGradeLabel = g => (g ? fontGrade(g) : '—');

  const wallCardHtml = p => cardHtml(p, { wall: true });   // the one card renderer (problems.js)

  // The list: sorted Easy or Hard, a section per grade with a sticky header and
  // the rail of the grades in it; sorted New or Random, one flat list and no rail.
  // Called from renderList, so it follows every load, refresh and setter-name
  // update. The filters are the phone list's own (visibleProblems): the filter
  // icon (the Filter panel: sort, grade range, Benchmarks, holds), the Benchmarks
  // pill, the search (on the on-screen keyboard) and Clear are here; favourites and
  // done stay off without an account.
  function wallRenderList() {
    if (!WALL || wallDefer('list')) return;
    wallDeferred.delete('list');
    const box = wallEl('wall-list');
    let top = box.scrollTop;
    if (loaded && wallResumeTop !== null) { top = wallResumeTop; wallResumeTop = null; }
    const grouped = sortIsByGrade();
    document.querySelector('#wall .wall-problems').classList.toggle('wall-flat', !grouped);

    let grades = [];
    if (!loaded) {
      box.innerHTML = wallNetDown
        ? `<div class="state-msg"><div class="icon">⚠️</div>Can’t reach the server right now.<br>Trying again by itself.</div>`
        : `<div class="spinner"></div>`;
    } else {
      const list = visibleProblems();
      const sections = [];                 // [{ g, ps }] in list order (Easy / Hard sort by grade)
      if (grouped) list.forEach(p => {
        const g = wallGradeKey(p);
        if (!sections.length || sections[sections.length - 1].g !== g) sections.push({ g, ps: [] });
        sections[sections.length - 1].ps.push(p);
      });
      grades = sections.map(x => x.g);
      box.innerHTML = !list.length
        ? filterEmptyHtml('problems')
        : grouped
          ? sections.map(({ g, ps }) => `
              <section class="wall-grade" data-grade="${escAttr(g)}">
                <h2 class="wall-grade-head">${escHtml(wallGradeLabel(g))}<span>${ps.length} problem${ps.length === 1 ? '' : 's'}</span></h2>
                ${ps.map(wallCardHtml).join('')}
              </section>`).join('')
          : `<div class="wall-flat-list">${list.map(wallCardHtml).join('')}</div>`;
      box.scrollTop = top;
    }
    wallSetHtml(wallEl('wall-rail'), grades.map(g => {
      const label = wallGradeLabel(g);
      return `<button class="wall-rail-btn${label.length > 3 ? ' long' : ''}" type="button" data-grade="${escAttr(g)}">${escHtml(label)}</button>`;
    }).join(''));
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
    if (wallPicking('problems')) wallRenderPickBar('problems');
    else wallSetHtml(wallEl('wall-sel'), p
      ? `<h1 class="wall-name">${escHtml(displayName(p))}</h1>
         <div class="problem-meta wall-meta">${problemMetaHtml(p, { feet: true })}</div>`
      : `<h1 class="wall-name wall-name-empty">Pick a problem</h1>
         <p class="wall-hint">Tap one in the list to light it up on the wall.</p>`);
    const mirror = wallEl('wall-mirror');
    mirror.disabled = !p;
    mirror.classList.toggle('active', !!p && wallMirror);
    mirror.setAttribute('aria-pressed', p && wallMirror ? 'true' : 'false');
    wallRenderLit();
    wallRenderOffline();
    wallRenderCircSel();                 // its Start circuit and status follow the connection too
  }

  function wallBoardHtml(p, mirror) {
    // With nothing chosen the board is dimmed all over, as on the Circuits page.
    const overlay = p ? (boardShapeOverlayHtml(p, { mirror, dim: true }) || boardOverlayHtml(p, mirror))
      : `<div class="hold-layer">${wallDimOnlyHtml()}</div>`;
    return `<div class="board-wrap wall-board"><img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" draggable="false" />${overlay}</div>`;
  }

  // The board on a page's right (Problems, Circuits; the hold picker on either):
  // the <img> is built once, and again only for a new board photo; a pick, Mirror
  // or a picked hold replace only what's drawn over it (review WALL-05).
  function wallStageShow(stageId, overlay, hint = '', pick = false) {
    const stage = wallEl(stageId);
    let wrap = stage.querySelector('.wall-board');
    if (!wrap || wrap.querySelector('.board-graphic').getAttribute('src') !== BOARD_IMG) {
      stage.innerHTML = `<div class="board-wrap wall-board"><img class="board-graphic" src="${escAttr(BOARD_IMG)}" alt="The Hangout symmetry board" draggable="false" /></div>`
        + '<div class="wall-stage-hint" hidden></div>';
      wrap = stage.querySelector('.wall-board');
    }
    wrap.classList.toggle('wall-pick-board', pick);
    const img = wrap.querySelector('.board-graphic');
    while (img.nextSibling) img.nextSibling.remove();
    img.insertAdjacentHTML('afterend', overlay);
    const h = stage.querySelector('.wall-stage-hint');
    h.textContent = hint;
    h.hidden = !hint;
  }

  function wallRenderStage() {
    if (!WALL) return;
    if (wallPicking('problems')) { wallRenderPickBoard('problems'); return; }
    const p = wallSelected();
    const overlay = p ? (boardShapeOverlayHtml(p, { mirror: wallMirror, dim: true }) || boardOverlayHtml(p, wallMirror))
      : `<div class="hold-layer">${wallDimOnlyHtml()}</div>`;
    wallStageShow('wall-stage', overlay, p ? '' : 'Tap a problem on the left');
  }

  // Picks a problem (null: none), unmirrored. A cast for the one before that is
  // still waiting on the location check isn't sent: its stillShowing says no.
  function wallSelect(id) {
    wallSelId = id === null || id === undefined ? null : id;
    wallMirror = false;
    document.querySelectorAll('#wall-list .wall-card').forEach(c => {
      const on = String(c.dataset.id) === String(wallSelId);
      c.classList.toggle('selected', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    wallRenderSel();
    wallRenderStage();
  }

  // A clean tap on a card: pick it and light it. A tap on the card already
  // picked lights it again (to take the board back from a phone's cast).
  function wallPickAndCast(id) {
    if (String(id) !== String(wallSelId)) wallSelect(id);
    wallCast();
  }

  // Mirror flips the view and lights that side straight away; back again lights
  // the problem the right way round.
  function wallToggleMirror() {
    if (!wallSelected()) return;
    wallMirror = !wallMirror;
    wallRenderSel();
    wallRenderStage();
    wallCast();
  }

  // Lights what's on screen: the chosen problem, the way round it's shown. The
  // wall's pick always takes over the board (the Pi shows the latest cast). Not
  // idle or offline. The same path as the phone's cast button (castByName: name and
  // orientation fixed at the tap, sent only if they're still on screen), its send
  // in turn in the wall's queue: a tap while one is being sent waits, and a newer
  // tap replaces it, so rapid taps never queue up and the latest wins. castByName
  // gets a button of its own that isn't on the page; #wall-lit shows how it went.
  function wallCast() {
    const p = wallSelected();
    if (!p || wallPage !== 'problems' || wallOffline() || wallIsIdle() || wallPicking('problems') || wallKbSearching()) return;
    const { name } = p, mirror = wallMirror;
    const st = wallCastState = { name, mirror, state: 'sending' };
    wallRenderLit();
    castByName(name, document.createElement('button'), mirror, () => {
      const q = wallSelected();
      return wallPage === 'problems' && !wallIdleOn && !!q && q.name === name && wallMirror === mirror;
    }, { quiet: true }).then(ok => {
      if (wallCastState !== st) return;    // a newer tap owns the status
      st.state = ok ? 'sent' : 'failed';
      wallRenderLit();
    });
  }

  // How the chosen problem's cast went, beside Mirror. "Sent" means Realtime took
  // it, which isn't proof the board lit (contract §4), so it never says "lit".
  const WALL_LIT_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zM21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>';
  function wallRenderLit() {
    const p = wallSelected();
    const st = wallCastState;
    wallLitShow(wallEl('wall-lit'), !!p, !!p && !!st && st.name === p.name && st.mirror === wallMirror ? st.state : null);
  }
  // One status line, both pages: has = something is chosen; state = how its own
  // latest cast went ('sending' | 'sent' | 'failed'), or null for none.
  function wallLitShow(el, has, state) {
    let cls = '', text = '';
    if (!has) text = '';
    else if (wallOffline()) text = 'Offline: not lit';
    else if (state === 'sending') { cls = 'sending'; text = 'Lighting it up…'; }
    else if (state === 'sent') { cls = 'sent'; text = 'Sent to the board'; }
    else if (state === 'failed') { cls = 'failed'; text = 'Didn’t send: tap it again'; }
    else text = 'Tap it to light it up';
    el.className = 'wall-lit' + (cls ? ' ' + cls : '');
    wallSetHtml(el, text ? WALL_LIT_ICON + `<span>${escHtml(text)}</span>` : '');
  }

  // ── Circuits page ─────────────────────────────────────────────────────────────
  const wallCircSelected = () => (wallCircId === null ? null
    : allCircuits.find(c => String(c.id) === String(wallCircId)) || null);

  // The phone's list order and filters (visibleCircuits: the Filter panel, the
  // Looping pill and the search; no favourites here). Circuits are few, so no grade rail.
  function wallRenderCircuits() {
    if (!WALL || wallDefer('circuits')) return;
    wallDeferred.delete('circuits');
    const box = wallEl('wall-clist');
    let top = box.scrollTop;
    if (circuitsLoaded && wallResumeCTop !== null) { top = wallResumeCTop; wallResumeCTop = null; }
    if (!circuitsLoaded) {
      box.innerHTML = circuitsError || wallNetDown
        ? `<div class="state-msg"><div class="icon">⚠️</div>Can’t reach the server right now.<br>Trying again by itself.</div>`
        : `<div class="spinner"></div>`;
    } else {
      const list = visibleCircuits();
      box.innerHTML = list.length ? list.map(c => circuitCardHtml(c, { wall: true })).join('') : allCircuits.length
        ? filterEmptyHtml('circuits')
        : `<div class="state-msg"><div class="icon">🧗</div>No circuits yet.</div>`;
      box.scrollTop = top;
    }
    if (wallCircId !== null && circuitsLoaded && !wallCircSelected()) wallCircSelect(null);   // deleted since
    else { wallRenderCircSel(); wallRenderCircStage(); }
  }

  function wallRenderCircSel() {
    if (!WALL) return;
    const c = wallCircSelected();
    if (wallPicking('circuits')) wallRenderPickBar('circuits');
    else wallSetHtml(wallEl('wall-csel'), c
      ? `<h1 class="wall-name">${escHtml(circuitName(c))}</h1>
         <div class="problem-meta wall-meta">${circuitMetaHtml(c)}</div>`
      : `<h1 class="wall-name wall-name-empty">Pick a circuit</h1>
         <p class="wall-hint">Tap one to light its holds. Start circuit runs it a move at a time.</p>`);
    wallEl('wall-ccast').disabled = !c || wallOffline();
    wallRenderCircLit();
  }

  // With no problem or circuit chosen the board is dimmed all over, as the problem
  // views dim around their holds (holdShapeLayerHtml's mask, here with no holds cut
  // out). Used by both the Problems and the Circuits page.
  function wallDimOnlyHtml() {
    return holdShapeLayerHtml({}, { dim: true })
      || '<svg class="hold-shape-layer hs-dim" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="#000" opacity="0.62"/></svg>';
  }

  function wallRenderCircStage() {
    if (!WALL) return;
    if (wallPicking('circuits')) { wallRenderPickBoard('circuits'); return; }
    const c = wallCircSelected();
    wallStageShow('wall-cstage', `<div class="hold-layer">${c ? circuitStaticOverlay(c) : wallDimOnlyHtml()}</div>`,
      c ? '' : 'Tap a circuit on the left');
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

  // A clean tap on a circuit: pick it and light all its holds. A tap on the one
  // already picked lights it again (to take the board back from a phone).
  function wallCircPickAndShow(id) {
    if (String(id) !== String(wallCircId)) wallCircSelect(id);
    wallCircShow();
  }

  // Lights the chosen circuit's holds, all at once (show_circuit): the board shows
  // the latest cast, so this replaces a problem or a run, and a later cast replaces
  // it. Not idle or offline. Sent in turn in the wall's queue, the latest tap next, as wallCast.
  function wallCircShow() {
    const c = wallCircSelected();
    if (!c || wallPage !== 'circuits' || wallOffline() || wallIsIdle() || wallPicking('circuits') || wallKbSearching()) return;
    const name = circuitName(c);
    const st = wallCircCastState = { name, state: 'sending' };
    wallRenderCircLit();
    showCircuitByName(name, () => {
      const q = wallCircSelected();
      return wallPage === 'circuits' && !wallIdleOn && !!q && circuitName(q) === name;
    }).then(ok => {
      if (wallCircCastState !== st) return;
      st.state = ok ? 'sent' : 'failed';
      wallRenderCircLit();
    });
  }

  // How the chosen circuit's view went, beside Start circuit (as #wall-lit).
  function wallRenderCircLit() {
    const c = wallCircSelected();
    const st = wallCircCastState;
    wallLitShow(wallEl('wall-clit'), !!c, !!c && !!st && st.name === circuitName(c) ? st.state : null);
  }

  // Start circuit: the Cast sheet (speed, loop, the countdown and Stop).
  function wallCircStart() {
    const c = wallCircSelected();
    if (!c || wallOffline()) return;
    openCircuitCast(c);
  }

  // ── Picking holds (the hold filter, problems.js HOLDS) ────────────────────────
  // While a page's Filter panel is open the board beside it is the hold picker:
  // the bar reads "Pick holds" with the live count, Mirror (or Start circuit) and
  // the cast status hide (styles.css, .filtering), and a clean tap on the board
  // picks or drops a hold. Taps there never cast or send show_circuit. Closing
  // the panel puts the chosen problem or circuit (or the dimmed board) back.
  const wallPicking = kind => WALL && filterKind === kind;
  const wallStageId = kind => (kind === 'circuits' ? 'wall-cstage' : 'wall-stage');

  function wallRenderPickBar(kind) {
    wallSetHtml(wallEl(kind === 'circuits' ? 'wall-csel' : 'wall-sel'),
      `<h1 class="wall-name">Pick holds</h1><p class="wall-hint">${escHtml(holdPickLine(kind))}</p>`);
  }
  // The same board image as the page's (wallStageShow); a tap redraws only its layer.
  function wallRenderPickBoard(kind) {
    wallStageShow(wallStageId(kind), `<div class="hold-layer">${holdPickLayerFor(kind)}</div>`, '', true);
  }
  function wallRenderPick(kind) {
    if (!wallPicking(kind)) return;
    wallRenderPickBar(kind);
    wallRenderPickBoard(kind);
  }
  // The panel opened or closed: the bar and the board follow (problems.js). The
  // search keyboard closes (the row it types into is under the panel).
  function wallFilterShown(kind) {
    wallKbCloseSearch();
    if (kind === 'circuits') { wallRenderCircSel(); wallRenderCircStage(); }
    else { wallRenderSel(); wallRenderStage(); }
  }

  // A clean tap on the picking board (wallCleanTap, as the lists): the hold nearest it.
  function wallTapBoard(kind) {
    wallCleanTap(wallEl(wallStageId(kind)), e => {
      if (!wallPicking(kind) || wallIsIdle()) return;
      const wrap = e.target.closest('.wall-pick-board');
      if (!wrap) return;
      const h = hitHold(wrap, e.clientX, e.clientY);
      if (h) holdPickToggle(h.id);
    });
  }

  // ── Create a problem (db/35) ──────────────────────────────────────────────────
  const WALL_CREATE_IDLE_MS = 5 * 60 * 1000;  // untouched this long: ask, then discard
  const WALL_CREATE_ASK_S = 30;               // the countdown on that sheet
  const WALL_NAME_MAX = 60;                   // as the phone's field and the problems CHECK
  // The keyboard for the name: the characters wall_create_problem() accepts.
  // Letters show as capitals while shift is on (it is at the start and after a space).
  const WALL_KB_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
    ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '-', 'back'],
    ['!', '?', '&', 'space', '.', ',']
  ];
  // ...and for a search: lowercase (the search ignores case), + for grades like
  // 6a+ (searchNorm, core.js, matches on letters and digits only, as the phone
  // does), and a key that empties it.
  const WALL_KB_SEARCH_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'"],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '+', '-', 'back'],
    ['clear', 'space']
  ];
  const WALL_SEARCH_MAX = 40;
  // wall_create_problem's refusals (SQLSTATE P0001, the code as the message).
  const WALL_SAVE_ERRORS = {
    key: 'This screen can’t save problems right now.',
    rate: 'Lots of new problems just now: try again in a few minutes.',
    name: 'Use letters or numbers in the name.',
    name_taken: 'That name is already used — pick another.',
    offensive: 'Please pick a different name.',
    grade: 'Pick a grade.',
    holds: 'Those holds don’t make a problem yet: check the start, holds and finish.',
    feet: 'The feet didn’t save: pick the feet rule or the footholds again.'
  };

  // Create is offered only once the database says the wall key works.
  // A failed ask (the network not up yet when the kiosk starts at 08:00) is asked
  // again in a minute on its own, not only after the next good problems poll.
  let wallKeyRetry = 0;
  function wallCheckKey() {
    if (!WALL_KEY || wallKeyOk) return;
    clearTimeout(wallKeyRetry);
    sb.rpc('wall_key_ok', { p_key: WALL_KEY }).then(({ data, error }) => {
      if (error) { wallKeyRetry = setTimeout(wallCheckKey, 60 * 1000); return; }
      wallKeyOk = data === true;
      wallEl('wall-tab-create').hidden = !wallKeyOk;
    }, () => { wallKeyRetry = setTimeout(wallCheckKey, 60 * 1000); });
  }

  function wallCreateOpen() {
    resetCreate();                     // the shared create state (authoring.js), fresh
    wallCreateName = '';
    wallKbShift = true;
    wallCreateOn = true;
    const img = wallEl('wall-c-board').querySelector('.board-graphic');
    if (img.getAttribute('src') !== BOARD_IMG) img.src = BOARD_IMG;
    previewRenderNote();
    wallCreateRender();
  }

  // Save, Cancel, a discard or idle: the live LEDs end, the state is cleared.
  function wallCreateClose() {
    if (!wallCreateOn) return;
    wallCreateOn = false;
    previewEnd();
    wallKbClose();
    wallAskClose();
    resetCreate();
    wallCreateName = '';
    previewRenderNote();
  }

  // The board, the name, the grades, the steps (applyCreateRoles calls it too).
  function wallCreateRender() {
    if (!WALL || !wallCreateOn) return;
    wallEl('wall-c-layer').innerHTML = createLayerHtml();
    const nameBtn = wallEl('wall-c-name');
    nameBtn.textContent = wallCreateName || 'Tap to name it';
    nameBtn.classList.toggle('unset', !wallCreateName);
    wallEl('wall-c-grades').innerHTML = gradeTabButtons(GRADE_ORDER, g => g === createGrade, fontGrade);
    const st = createStatus(wallCreateName.trim(), 'Tap the name to type it');
    wallEl('wall-c-steps').innerHTML = st.steps;
    const next = wallEl('wall-c-next');
    next.textContent = st.next || 'Ready: tap Save';
    next.classList.toggle('ready', st.ready);
    wallEl('wall-c-undo').disabled = !createUndo.length;
    updateCreateFeet();
    wallCreateNet();
  }

  function wallCreateNet() {
    const save = wallEl('wall-c-save');
    if (!save.classList.contains('casting')) save.disabled = wallOffline();
  }

  function wallCreateTap(e) {
    // A hand hold cycles (cycleHold redraws and lights the board); a foothold is
    // picked or dropped (Specific feet, never lit): createTap in authoring.js.
    createTap(e.clientX, e.clientY, wallEl('wall-c-board'));
  }

  function wallPickGrade(g) {
    createGrade = createGrade === g ? '' : g;
    wallCreateRender();
  }

  // ── The on-screen keyboard: Create's name, or a list's search ──
  // One keyboard (#wall-kb) for both. For the name it sits full width over the
  // bottom; for a search it docks over the board (.search), so the whole list
  // stays in view and follows each key. Done, or a tap anywhere else (startWall),
  // closes it; a tap that closes it does nothing else, so it never casts.
  const WALL_KB_TARGETS = {
    name: {
      get: () => wallCreateName, set: v => { wallCreateName = v; },
      rows: WALL_KB_ROWS, max: WALL_NAME_MAX, caps: true, ph: 'Name your problem',
    },
    problems: {
      get: () => wallSearch.problems, set: v => wallSearchSet('problems', v),
      rows: WALL_KB_SEARCH_ROWS, max: WALL_SEARCH_MAX, caps: false, ph: 'Search name, setter, grade',
    },
    circuits: {
      get: () => wallSearch.circuits, set: v => wallSearchSet('circuits', v),
      rows: WALL_KB_SEARCH_ROWS, max: WALL_SEARCH_MAX, caps: false, ph: 'Search name, setter, grade',
    },
  };
  const wallKbSearching = () => wallKbFor === 'problems' || wallKbFor === 'circuits';

  // The keys are built once per layout (the name's, or a search's) and stay put:
  // a press changes only the text, and shift only the letters' labels (review
  // WALL-04: rebuilding every key per press could drop a fast second finger's key).
  let wallKbRows = null;         // the layout the keys were built for
  let wallKbCaps = false;        // the letters show as capitals

  function wallKbOpen(target = 'name') {
    if (!WALL_KB_TARGETS[target]) return;
    if (target !== 'name' && (wallIsIdle() || filterKind || wallPage !== target)) return;
    wallKbFor = target;
    const kb = wallEl('wall-kb');
    kb.classList.toggle('search', target !== 'name');
    kb.hidden = false;
    wallKbBuild();
    wallKbSync();
    wallRenderSearch();
  }
  function wallKbClose() {
    wallKbFor = null;
    wallEl('wall-kb').hidden = true;
    wallRenderSearch();
    if (wallCreateOn) wallCreateRender();
  }
  function wallKbCloseSearch() {
    if (wallKbSearching()) wallKbClose();
  }
  function wallKbBuild() {
    const t = WALL_KB_TARGETS[wallKbFor];
    if (!t || wallKbRows === t.rows) return;
    wallKbRows = t.rows;
    wallKbCaps = false;
    wallEl('wall-kb-keys').innerHTML = t.rows.map(row => row.map(k => {
      const label = k === 'shift' ? '⇧' : k === 'back' ? '⌫' : k === 'space' ? 'space' : k === 'clear' ? 'Clear' : k;
      const cls = k === 'shift' || k === 'back' ? ' fn' : k === 'space' ? ' space' : k === 'clear' ? ' fn wide' : '';
      const aria = k === 'shift' ? ' aria-label="Capital letter"' : k === 'back' ? ' aria-label="Delete"'
        : k === 'clear' ? ' aria-label="Clear the search"' : '';
      return `<button class="wall-key${cls}" type="button" data-k="${escAttr(k)}"${aria}>${escHtml(label)}</button>`;
    }).join('')).join('');
  }
  // The text as typed, and the letters' case with shift (the name only).
  function wallKbSync() {
    const t = WALL_KB_TARGETS[wallKbFor];
    if (!t) return;
    const text = t.get();
    wallSetHtml(wallEl('wall-kb-text'), (text ? escHtml(text)
      : `<span class="wall-kb-ph">${escHtml(t.ph)}</span>`) + '<i class="wall-kb-caret"></i>');
    const caps = t.caps && wallKbShift;
    if (caps === wallKbCaps) return;
    wallKbCaps = caps;
    wallEl('wall-kb-keys').querySelectorAll('.wall-key').forEach(b => {
      const k = b.dataset.k;
      if (k === 'shift') b.classList.toggle('on', caps);
      else if (/^[a-z]$/.test(k)) b.textContent = caps ? k.toUpperCase() : k;
    });
  }
  function wallKbPress(k) {
    const t = WALL_KB_TARGETS[wallKbFor];
    if (!t) return;
    let text = t.get();
    if (k === 'shift') {
      wallKbShift = !wallKbShift;
    } else if (k === 'back') {
      text = text.slice(0, -1);
      if (t.caps) wallKbShift = !text || text.endsWith(' ');
    } else if (k === 'clear') {
      text = '';
    } else if (text.length < t.max) {
      let c = k === 'space' ? ' ' : k;
      if (c === ' ' && (!text || text.endsWith(' '))) return;   // no leading or double space
      if (t.caps && wallKbShift && /[a-z]/.test(c)) c = c.toUpperCase();
      text += c;
      if (t.caps) wallKbShift = c === ' ';
    }
    if (text !== t.get()) t.set(text);
    wallKbSync();
  }

  // ── Search (a list's row): the phone's own state and matching ──
  // The text goes into searchQuery / circuitSearch, trimmed and lowercased as the
  // phone's input handler does, and the list re-renders (and goes back to the top)
  // at the next frame: keys typed faster than a frame share one render, and only
  // that list is rebuilt. `quiet`: state only, no render, and the keyboard closes
  // (clearFilters and the idle, which render themselves).
  const wallSearchDue = new Set();
  function wallSearchSet(kind, text, quiet = false) {
    if (!(kind in wallSearch)) return;
    wallSearch[kind] = text;
    const q = text.trim().toLowerCase();
    if (kind === 'problems') searchQuery = q; else circuitSearch = q;
    if (quiet) { wallKbCloseSearch(); wallSearchDue.delete(kind); }
    wallRenderSearch();
    if (quiet) return;
    if (!wallSearchDue.size) requestAnimationFrame(() => {
      const due = [...wallSearchDue];
      wallSearchDue.clear();
      due.forEach(k => filtersChanged(k));
    });
    wallSearchDue.add(kind);
  }
  // The search fields: the text (or the placeholder), a caret while the keyboard
  // types into it, and the × whenever there's text.
  function wallRenderSearch() {
    if (!WALL) return;
    document.querySelectorAll('#wall [data-wsearch]').forEach(f => {
      const kind = f.dataset.wsearch;
      const text = wallSearch[kind] || '';
      const on = wallKbFor === kind;
      f.classList.toggle('on', on);
      f.setAttribute('aria-expanded', on ? 'true' : 'false');
      wallSetHtml(f, (text ? escHtml(text) : `<span class="wall-search-ph">${escHtml(f.dataset.ph || 'Search')}</span>`)
        + (on ? '<i class="wall-kb-caret"></i>' : ''));
    });
    document.querySelectorAll('#wall [data-wsearch-clear]').forEach(b => { b.hidden = !wallSearch[b.dataset.wsearchClear]; });
  }

  // The discard sheet: leaving Create with something set, or 5 minutes untouched
  // (with a countdown; it discards by itself at the end).
  function wallAskDiscard(kind, then) {
    wallKbClose();
    wallAsk = { kind, then, until: kind === 'idle' ? Date.now() + WALL_CREATE_ASK_S * 1000 : 0 };
    wallEl('wall-c-confirm-title').textContent = kind === 'idle' ? 'Still setting?' : 'Discard this problem?';
    wallEl('wall-c-confirm').hidden = false;
    wallAskTick(Date.now());
  }
  function wallAskTick(now) {
    if (!wallAsk) return;
    if (wallAsk.kind !== 'idle') {
      wallEl('wall-c-confirm-text').textContent = 'The holds you’ve set aren’t saved yet.';
      return;
    }
    const left = Math.max(0, Math.ceil((wallAsk.until - now) / 1000));
    wallEl('wall-c-confirm-text').textContent =
      `Nobody’s touched the screen for 5 minutes. This problem goes in ${left} s unless you keep setting.`;
    if (left <= 0) wallAskAnswer(true);
  }
  function wallAskAnswer(discard) {
    const ask = wallAsk;
    wallAskClose();
    wallLastTouch = Date.now();
    if (discard && ask) ask.then();
  }
  function wallAskClose() {
    wallAsk = null;
    wallEl('wall-c-confirm').hidden = true;
  }

  function wallCreateCancel() {
    wallSetPage('problems');           // asks first if something's set
  }

  async function wallCreateSave() {
    const btn = wallEl('wall-c-save');
    if (btn.disabled || !wallCreateOn) return;
    const name = wallCreateName.trim();
    const miss = createProblemMissing(name, null);
    if (miss) {
      showToast(miss.msg, 'error');
      if (miss.field === 'name') wallKbOpen();
      return;
    }
    btn.disabled = true; btn.classList.add('casting'); btn.textContent = 'Saving…';
    const { data, error } = await sb.rpc('wall_create_problem', {
      p_key: WALL_KEY, p_name: name, p_grade: createGrade,
      p_starts: holdsWithRole('start'), p_ints: holdsWithRole('int'),
      p_finish: holdsWithRole('finish')[0], p_feet: createFeet, p_feet_holds: createFeetCol() });
    btn.classList.remove('casting'); btn.textContent = 'Save';
    wallCreateNet();
    if (error || !data || !data.id) {
      const code = error && error.message;
      showToast(WALL_SAVE_ERRORS[code] || 'Couldn’t save it — check the connection.', 'error');
      if (['name', 'name_taken', 'offensive'].includes(code)) wallKbOpen();
      if (code === 'key') { wallKeyOk = false; wallCheckKey(); }
      return;
    }
    allProblems.push(data);
    renderList();                      // -> wallRenderList
    if (!wallCreateOn) return;         // idle closed it while it saved: it's saved anyway
    wallSetPage('problems', true);     // closes Create (and its LEDs)
    wallSelect(data.id);
    const card = document.querySelector(`#wall-list .wall-card[data-id="${CSS.escape(String(data.id))}"]`);
    if (card) card.scrollIntoView({ block: 'center' });
    showToast(`Saved “${data.name}”`, 'success');
    wallCast();                        // and lit on the board, as a tap on its card would
  }

  // ── Offline ───────────────────────────────────────────────────────────────────
  const wallOffline = () => wallNetDown || !navigator.onLine;

  // The connection changed (a fetch failed or worked: loadProblems; the browser's
  // online and offline events): the cast statuses, the offline note, Start circuit
  // and Create's Save all follow, both ways (review WALL-07).
  function wallSetNet(down) {
    if (!WALL) return;
    wallNetDown = down;
    wallRenderNet();
    if (!loaded) wallRenderList();
  }
  function wallRenderNet() {
    wallRenderSel();
    wallCreateNet();
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
  // The phone's own loaders (one loading path, review 2.3): each renders only when
  // its rows changed, so a poll that finds nothing new rebuilds nothing.
  async function wallPoll() {
    wallLastPoll = Date.now();
    await loadProblems();                  // saved list, offline note, wallSetNet; renderList -> wallRenderList on a change
    if (wallNetDown) return;
    loadCircuits();                        // showCircuits -> wallRenderCircuits on a change
    loadProfileNames();
    loadChallenges();                      // showChallenges -> wallOnChallenges reloads Ranks if it's up
    refreshBoardIfChanged();               // a board publish: the new photo, map, outlines and holds
    if (!wallKeyOk) wallCheckKey();
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
  // Leaving Create with something set asks first, unless `discard` (Save, a
  // confirmed Cancel, idle).
  function wallSetPage(page, discard = false) {
    if (wallCreateOn && page !== 'create') {
      if (!discard && createDirty()) { wallAskDiscard('leave', () => wallSetPage(page, true)); return; }
      wallCreateClose();
    }
    wallKbCloseSearch();                     // the search keyboard belongs to its list
    if (page !== wallPage) closeFilter();   // the Filter panel belongs to its page
    wallPage = page;
    document.querySelectorAll('.wall-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
    document.querySelectorAll('.wall-page').forEach(s => s.classList.toggle('active', s.dataset.page === page));
    if (page === 'ranks') wallLoadRanks();
    if (page === 'circuits') wallRenderCircuits();
    if (page === 'create' && !wallCreateOn) wallCreateOpen();
  }

  // ── Idle slides ───────────────────────────────────────────────────────────────
  const wallIsIdle = () => wallIdleOn;

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
          <div class="problem-meta wall-meta">${problemMetaHtml(p)}</div>
          <p class="wall-slide-sub">Benchmarks score points on Ranks. Touch the screen to light it up.</p>
        </div>
      </div>`;
  }

  function wallFillQr(root) {
    const tpl = wallEl('wall-qr-tpl');
    root.querySelectorAll('.wall-qr:empty').forEach(slot => slot.appendChild(tpl.content.cloneNode(true)));
  }

  function wallRenderIdle() {
    const box = wallEl('wall-idle');
    box.hidden = !wallIdleOn;
    if (box.hidden) return;
    const slides = wallSlides();
    if (wallSlide >= slides.length) wallSlide = 0;
    const kind = slides[wallSlide];
    wallEl('wall-slide').innerHTML = wallSlideHtml(kind);
    wallEl('wall-slide').dataset.kind = kind;
    wallFillQr(box);
    wallEl('wall-dots').innerHTML = slides.map((_, i) => `<i class="${i === wallSlide ? 'on' : ''}"></i>`).join('');
  }

  // Back to the start: the Problems page, both lists' filters, searches and sorts
  // at their defaults (the Filter panel and the keyboard closed), nothing chosen,
  // the lists at the top.
  // Then the slides.
  function wallGoIdle() {
    abandonCircuitCast();
    wallSetPage('problems', true);     // Create closes (its LEDs end) without asking
    closeFilter();
    resetListFilters();
    resetCircuitFilters();
    wallSearchSet('problems', '', true);
    wallSearchSet('circuits', '', true);
    wallSelect(null);
    wallCircSelect(null);
    wallRenderCircuits();
    wallEl('wall-clist').scrollTop = 0;
    wallRenderList();
    updateFilterControls();            // the filter icons back to plain
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
  // benchmark slide it picks that problem and lights it.
  function wallWake() {
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
        wallCast();
      }
    }
  }

  function wallTick() {
    const now = Date.now();
    // Not while a circuit runs: the climber is on the wall, not touching the screen.
    if (circuitRunGoing()) wallLastTouch = now;
    if (wallCreateOn) {
      // No slides while someone's setting: 5 minutes untouched asks, then discards.
      // A "Discard this problem?" sheet left unanswered turns into that ask too
      // (WALL-02), so the board's lit holds, updates and Pi deploys aren't held all day.
      if ((!wallAsk || wallAsk.kind !== 'idle') && now - wallLastTouch > WALL_CREATE_IDLE_MS) {
        wallAskDiscard('idle', () => wallSetPage('problems', true));
      }
      if (wallAsk) wallAskTick(Date.now());
    } else if (!wallIdleOn && now - wallLastTouch > WALL_IDLE_MS) wallGoIdle();
    else if (wallIdleOn && now - wallSlideAt > WALL_SLIDE_MS) {
      wallSlide = (wallSlide + 1) % wallSlides().length;
      wallSlideAt = now;
      wallRenderIdle();
    }
    if (now - wallLastPoll > (wallOffline() ? WALL_RETRY_MS : WALL_POLL_MS)) wallPoll();
    wallAlive(now);
  }

  // The heartbeat pb-health watches (WALL-11, 12 Nov 2026): every WALL_ALIVE_MS while
  // this page is on screen, one small IndexedDB write (its own database, nothing
  // else in the app uses IndexedDB, so its files on the Pi change only for this).
  // A crashed or frozen renderer, or the screen left on another page (this one
  // hidden behind it), stops it, and the Pi restarts the kiosk. Relaxed durability:
  // no fsync, which is all the file's time stamp needs (the SD card).
  function wallAlive(now) {
    if (now - wallAliveAt < WALL_ALIVE_MS || document.visibilityState === 'hidden') return;
    wallAliveAt = now;
    try {
      const rq = indexedDB.open('pb-wall-alive', 1);
      rq.addEventListener('upgradeneeded', () => rq.result.createObjectStore('alive'));
      rq.addEventListener('success', () => {
        const db = rq.result;
        try {
          const tx = db.transaction('alive', 'readwrite', { durability: 'relaxed' });
          tx.objectStore('alive').put(now, 'at');
          tx.addEventListener('complete', () => db.close());
          tx.addEventListener('abort', () => db.close());
        } catch (e) { db.close(); }
      });
    } catch (e) { /* no IndexedDB: pb-health sees no heartbeat and leaves the kiosk alone */ }
  }

  // No context menu, drag or selection on the wall (WALL-01): a touch long-press or
  // a right-click in Chromium opens a menu with "Open image in new tab" (the kiosk
  // has no tabs or address bar to come back from) and "Inspect" (DevTools would
  // show the wall key in localStorage). Capture, so nothing on the page can let one
  // through. The Pi's Chromium policy turns DevTools and other sites off as well.
  function wallLockDown() {
    ['contextmenu', 'dragstart', 'selectstart', 'auxclick'].forEach(t =>
      document.addEventListener(t, e => e.preventDefault(), { capture: true }));
  }

  // Called by refreshBoardViews when the board image, map or outlines change.
  function wallRefreshBoard() {
    if (!WALL) return;
    if (wallCreateOn) {
      const img = wallEl('wall-c-board').querySelector('.board-graphic');
      if (img.getAttribute('src') !== BOARD_IMG) img.src = BOARD_IMG;
      wallCreateRender();
    }
    wallRenderStage();
    wallRenderCircStage();
    if (wallIdleOn && wallSlides()[wallSlide] === 'bench') wallRenderIdle();
  }

  // The one tap rule for the wall's lists and its hold-picking boards (review 2.3):
  // only a clean tap calls onTap(the click event): the finger moved no more than
  // WALL_TAP_SLOP and, on a list (scroller), the list didn't scroll under it and
  // wasn't moving when it went down (WALL_FLING_MS: the touch that stops a fling).
  // A scroll or a drag only moves the list. A keyboard's Enter (detail 0) is a tap.
  function wallCleanTap(el, onTap, { scroller = false } = {}) {
    let scrollAt = 0;                    // when the list last scrolled (a finger or a fling)
    let press = null;                    // { x, y, clean } for the finger on it
    if (scroller) el.addEventListener('scroll', () => {
      scrollAt = wallScrollAt = Date.now();
      if (press) press.clean = false;    // the list moved under the finger
    }, { passive: true });
    el.addEventListener('pointerdown', e => {
      press = { x: e.clientX, y: e.clientY, clean: Date.now() - scrollAt > WALL_FLING_MS };
    }, { passive: true });
    el.addEventListener('pointermove', e => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > WALL_TAP_SLOP) press.clean = false;
    }, { passive: true });
    el.addEventListener('pointercancel', () => { if (press) press.clean = false; }, { passive: true });
    el.addEventListener('click', e => {
      const p = press;
      press = null;
      if (e.detail !== 0) {
        if (!p || !p.clean) return;
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > WALL_TAP_SLOP) return;
      }
      onTap(e);
    });
  }
  // A clean tap on a card calls onTap(its id).
  function wallTapList(list, onTap) {
    wallCleanTap(list, e => {
      const card = e.target.closest('.wall-card');
      if (card) onTap(card.dataset.id);
    }, { scroller: true });
  }

  // ── App updates (TODO 8, 15 Nov 2026) ─────────────────────────────────────────
  // app.js checks for a new version every WALL_UPDATE_CHECK_MS and asks this before
  // reloading for one: only with nobody at the screen (2 minutes untouched, or the
  // slides up) and nothing a reload would lose: no circuit run or Cast sheet, no
  // Create (or its discard sheet), no live LEDs (hasUnsavedWork covers the rest).
  function wallUpdateOk() {
    if (hasUnsavedWork() || wallCreateOn || preview || wallAsk) return false;
    const sheet = document.getElementById('circuit-cast-modal');
    if (sheet && sheet.classList.contains('show')) return false;
    return wallIdleOn || Date.now() - wallLastTouch >= WALL_UPDATE_IDLE_MS;
  }

  // Just before that reload: where the wall is (the page, the chosen problem and
  // circuit, the way round, both lists' filters, searches and scroll), for the next
  // load to put back (wallResume). The slides have their own key (WALL_IDLE_KEY).
  function wallSaveResume() {
    if (wallIdleOn) return;
    ssSet(WALL_RESUME_KEY, JSON.stringify({
      at: Date.now(), page: wallPage, sel: wallSelId, mirror: wallMirror, circ: wallCircId,
      top: wallEl('wall-list').scrollTop, ctop: wallEl('wall-clist').scrollTop,
      search: { ...wallSearch },
      f: { listSort, gradeLo, gradeHi, benchOnly, holdPicks,
           circuitSort, circuitLoopOnly, circuitGradeLo, circuitGradeHi, circuitHoldPicks },
    }));
  }

  // On start: the state wallSaveResume left, if it's from the reload just now.
  // State only (nothing is cast); startWall renders it. Returns the page to open.
  function wallResume() {
    const raw = ssGet(WALL_RESUME_KEY);
    if (!raw) return null;
    ssSet(WALL_RESUME_KEY, null);
    let r;
    try { r = JSON.parse(raw); } catch (e) { return null; }
    if (!r || typeof r.at !== 'number' || Date.now() - r.at > WALL_RESUME_MAX_MS) return null;
    const f = r.f || {};
    const sortOf = (sorts, k) => (sorts.some(x => x[0] === k) ? k : 'new');
    listSort = sortOf(LIST_SORTS, f.listSort);
    circuitSort = sortOf(CIRCUIT_SORTS, f.circuitSort);
    gradeLo = f.gradeLo ?? null; gradeHi = f.gradeHi ?? null;
    circuitGradeLo = f.circuitGradeLo ?? null; circuitGradeHi = f.circuitGradeHi ?? null;
    benchOnly = !!f.benchOnly; circuitLoopOnly = !!f.circuitLoopOnly;
    holdPicks = Array.isArray(f.holdPicks) ? f.holdPicks : [];
    circuitHoldPicks = Array.isArray(f.circuitHoldPicks) ? f.circuitHoldPicks : [];
    const search = r.search || {};
    ['problems', 'circuits'].forEach(k => {
      const text = typeof search[k] === 'string' ? search[k].slice(0, WALL_SEARCH_MAX) : '';
      wallSearch[k] = text;
      if (k === 'problems') searchQuery = text.trim().toLowerCase(); else circuitSearch = text.trim().toLowerCase();
    });
    wallSelId = r.sel ?? null;
    wallMirror = !!r.mirror && wallSelId !== null;
    wallCircId = r.circ ?? null;
    wallResumeTop = +r.top || 0;
    wallResumeCTop = +r.ctop || 0;
    return ['problems', 'circuits', 'ranks', 'app'].includes(r.page) ? r.page : 'problems';
  }

  // ── Start (from app.js's boot) ────────────────────────────────────────────────
  function startWall() {
    wallLockDown();
    wallFillQr(wallEl('wall'));

    // Any touch counts as someone using the screen: a tap, or the start of a
    // scroll or drag (touchstart as well as pointerdown, which a scroll cancels).
    // Not 'scroll' itself: re-rendering the list moves it too.
    ['pointerdown', 'touchstart', 'keydown', 'wheel'].forEach(t =>
      document.addEventListener(t, () => { wallLastTouch = Date.now(); }, { capture: true, passive: true }));
    // Fingers down (wallHandsOn): renders wait for them to come off.
    document.addEventListener('pointerdown', e => { wallFingers.set(e.pointerId, Date.now()); }, { capture: true, passive: true });
    ['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, e => {
      wallFingers.delete(e.pointerId);
      wallSettleSoon();
    }, { capture: true, passive: true }));
    ['touchstart', 'touchend', 'touchcancel'].forEach(t => document.addEventListener(t, e => {
      wallTouches = e.touches.length;
      wallSettleSoon();
    }, { capture: true, passive: true }));

    document.querySelectorAll('.wall-tab').forEach(t => t.addEventListener('click', () => wallSetPage(t.dataset.page)));
    wallEl('wall-rail').addEventListener('click', e => {
      const b = e.target.closest('.wall-rail-btn');
      if (b) wallJumpTo(b.dataset.grade);
    });
    let markQueued = false;
    wallEl('wall-list').addEventListener('scroll', () => {
      if (markQueued) return;
      markQueued = true;
      requestAnimationFrame(() => { markQueued = false; wallMarkGrade(); });
    }, { passive: true });
    wallTapList(wallEl('wall-list'), wallPickAndCast);
    wallEl('wall-mirror').addEventListener('click', wallToggleMirror);
    wallTapList(wallEl('wall-clist'), wallCircPickAndShow);
    wallEl('wall-ccast').addEventListener('click', wallCircStart);
    wallTapBoard('problems');
    wallTapBoard('circuits');
    wallEl('wall-c-board').addEventListener('click', wallCreateTap);
    wallEl('wall-c-name').addEventListener('click', () => wallKbOpen('name'));
    wallEl('wall-c-grades').addEventListener('click', e => {
      const t = e.target.closest('.grade-tab');
      if (t) wallPickGrade(t.dataset.grade);
    });
    wallEl('wall-c-feet').addEventListener('click', e => {
      const b = e.target.closest('.feet-opt');
      if (b) setCreateFeet(b.dataset.feet);
    });
    wallEl('wall-c-undo').addEventListener('click', undoCreate);
    wallEl('wall-c-clear').addEventListener('click', onCreateReset);
    wallEl('wall-c-cancel').addEventListener('click', wallCreateCancel);
    wallEl('wall-c-save').addEventListener('click', wallCreateSave);
    // A key types when its finger lifts on it, not on the click: the browser makes
    // no click at all for a tap that overlaps another finger's, which is how fast
    // typing goes (WALL-04). Each finger is its own press. A keyboard's Enter or
    // Space on a focused key (a click with detail 0) types it too.
    const keys = wallEl('wall-kb-keys');
    const keyDown = new Map();           // pointerId -> the key it went down on
    keys.addEventListener('pointerdown', e => {
      const k = e.button === 0 && e.target.closest('.wall-key');
      if (k) keyDown.set(e.pointerId, k);
    });
    keys.addEventListener('pointerup', e => {
      const k = keyDown.get(e.pointerId);
      keyDown.delete(e.pointerId);
      if (!k || !k.isConnected) return;
      const over = document.elementFromPoint(e.clientX, e.clientY);
      if (over && over.closest('.wall-key') === k) wallKbPress(k.dataset.k);   // not if it slid off the key
    });
    keys.addEventListener('pointercancel', e => keyDown.delete(e.pointerId));
    keys.addEventListener('click', e => {
      const k = e.detail === 0 && e.target.closest('.wall-key');
      if (k) wallKbPress(k.dataset.k);
    });
    wallEl('wall-kb-done').addEventListener('click', wallKbClose);
    // The search fields: a tap opens the keyboard for that list; the × empties it.
    document.querySelectorAll('#wall [data-wsearch]').forEach(f =>
      f.addEventListener('click', () => wallKbOpen(f.dataset.wsearch)));
    document.querySelectorAll('#wall [data-wsearch-clear]').forEach(b =>
      b.addEventListener('click', () => wallSearchSet(b.dataset.wsearchClear, '')));
    // While a search keyboard is open, a tap anywhere but the keyboard and the
    // list's row closes it. On the list or the board (a card, Mirror, Start
    // circuit) that tap does nothing else: closing the keyboard never casts.
    // The tabs and the rail still work (a tab closes it anyway). Capture, so it
    // runs before the list's and the board's own handlers.
    document.addEventListener('click', e => {
      if (!wallKbSearching()) return;
      const t = e.target;
      if (!(t instanceof Element) || t.closest('#wall-kb, .wall-filters')) return;
      wallKbClose();
      if (t.closest('.wall-list, .wall-main')) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    wallEl('wall-c-keep').addEventListener('click', () => wallAskAnswer(false));
    wallEl('wall-c-discard').addEventListener('click', () => wallAskAnswer(true));
    wallEl('wall-c-confirm').addEventListener('click', e => { if (e.target.id === 'wall-c-confirm') wallAskAnswer(false); });
    wallEl('wall-idle').addEventListener('click', wallWake);
    // The connection, both ways (WALL-07); coming back fetches everything (wallPoll;
    // app.js's own online handler loads only the holds on the wall, WALL-12).
    window.addEventListener('online', () => { wallRenderNet(); wallPoll(); });
    window.addEventListener('offline', wallRenderNet);

    const resumePage = wallResume();     // an update's reload: back where it was
    wallRenderList();
    wallRenderStage();
    wallRenderCircuits();
    wallRenderSearch();
    updateFilterControls();
    if (ssGet(WALL_IDLE_KEY)) wallGoIdle();
    else if (resumePage) wallSetPage(resumePage);
    wallCheckKey();
    setInterval(wallTick, 1000);
  }
