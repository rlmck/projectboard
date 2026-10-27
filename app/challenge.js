// ProjectBoard - the pieces load as ordered classic <script>s sharing ONE global scope
// (no ES modules, no build step). Order: state, core, problems, admin, account,
// authoring, circuits, challenge, leaderboard, wall, app. This file: challenges (db/31) -
// load, the challenge view (rules, your best + history, the timed attempt, summary,
// save with retry), the circuit-detail link, and the challenge boards on Ranks
// (compare, admin delete).
//
// A challenge is a timed competition on a circuit; the protocol is data
// (challenges.protocol). The first is the Pat Burner: 3 sets × 3 reps, each rep to
// failure (the clock counts up until you tap Fell), 30 s between reps, 5 min
// between sets. Score = total seconds held; the server adds it up (never trusted
// from the phone) and ranks each climber's best attempt, earlier first on a tie.
//
// Timing is worked out from timestamps, never by counting ticks, so a locked
// screen or a backgrounded app loses nothing: on return the attempt catches up
// (a rest that ended while the screen was off starts the next rep's clock at the
// moment it ended). The attempt in progress is kept on the device (CH_RUN_KEY), so
// even closing the app keeps it. A finished attempt goes into a pending list
// (CH_PENDING_KEY) before it's sent, and stays there until the database has it:
// no signal means a Retry, never a lost attempt. The phone makes the attempt's id,
// so a retry of a save that did land is refused as a duplicate (23505) = saved.
//
// Leaving the view doesn't stop the attempt: the clock and its beeps carry on in
// any view, and a strip on top of the bottom nav (#ch-return) shows the phase and
// leads straight back to it.

  const CH_RUN_KEY = 'pb-challenge-run';
  const CH_PENDING_KEY = 'pb-challenge-pending';
  const CH_REP_CAP = 1200;                       // seconds; the db/31 per-rep cap
  const CH_MAX_AGE = 14 * 24 * 3600 * 1000;      // db/31: an attempt must have started within 14 days
  const CH_COLOURS = ['var(--accent)', 'var(--int)', 'var(--start)'];   // tokens.css; set through style=, since SVG attributes don't take var()
  const CH_TROPHY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v5a5 5 0 0 1-10 0V4z"></path><path d="M17 5h3v2a3 3 0 0 1-3 3"></path><path d="M7 5H4v2a3 3 0 0 0 3 3"></path></svg>';
  const CH_TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

  let chTicker = null;       // the clock (setInterval), while an attempt runs, in any view
  let chAudio = null;        // AudioContext, made on the first tap (browsers need a gesture)
  let chWakeLock = null;     // screen wake lock while an attempt runs (separate from the viewer's)
  let chLastBeep = '';       // phase + second last beeped, so a countdown beeps once per second
  let chEndArmed = 0;        // End early needs a second tap within 3 s (timestamp of the first)
  let chFellAt = 0;          // last Fell tap, so a double tap can't land on what replaces the button
  let chDiscardArmed = 0;    // Discard (summary) needs a second tap too
  let chDelTarget = null;    // Ranks: the attempt an admin is about to delete

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const challengeById = id => allChallenges.find(c => String(c.id) === String(id)) || null;
  const challengeForCircuit = cid => allChallenges.find(c => String(c.circuit_id) === String(cid)) || null;

  // The protocol with safe defaults (the db/31 CHECK guarantees the keys anyway).
  function chProto(ch) {
    const p = (ch && ch.protocol) || {};
    const n = (v, d) => (Number.isInteger(+v) && +v >= 0 ? +v : d);
    return { sets: n(p.sets, 3) || 1, reps: n(p.reps, 3) || 1, rep_rest_s: n(p.rep_rest_s, 30),
             set_rest_s: n(p.set_rest_s, 300), get_ready_s: n(p.get_ready_s, 10) };
  }

  // 457 -> "7:37"; under a minute -> "0:45".
  function chClock(secs) {
    const s = Math.max(0, Math.floor(secs));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  // A rest length in words: 30 -> "30 seconds", 300 -> "5 minutes".
  function chSpan(s) {
    if (s % 60 === 0 && s >= 60) return `${s / 60} minute${s === 60 ? '' : 's'}`;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const chDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  function chUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // ── Loading ───────────────────────────────────────────────────────────────────
  // As the circuit list: the saved copy at once, then the fresh one. Before db/31
  // is applied the table doesn't exist; that's just "no challenges".
  async function loadChallenges() {
    const saved = !challengesLoaded && savedList('challenges');
    if (saved) showChallenges(saved.rows);
    const { data, error } = await sb.from('challenges').select('id, circuit_id, name, protocol, is_active').eq('is_active', true);
    if (error) { console.warn('challenges load failed', error); if (!saved) showChallenges([]); return; }
    saveList('challenges', data || []);
    showChallenges(data || []);
  }

  function showChallenges(rows) {
    allChallenges = rows;
    challengesLoaded = true;
    if (currentView === 'circuit-detail' && currentCircuit) {
      fillCircuitChallenge(currentCircuit);
      document.getElementById('circuit-menu-delete').hidden = !canEditCircuit(currentCircuit);   // the lock may have changed
    }
    else if (currentView === 'challenge') renderChallenge(parseHash().param);
    else if (currentView === 'leaderboard') renderLeaderboard();
    if (WALL) wallOnChallenges();
    if (currentView !== 'challenge') chSyncAway();   // the strip on the nav can name it now
  }

  async function loadChallengeBoard(cid, force) {
    const b = challengeBoards[cid];
    if (b && b.loaded && !force) return;
    const { data, error } = await sb.rpc('challenge_leaderboard', { cid });
    if (error) console.warn('challenge board load failed', error);
    challengeBoards[cid] = { rows: data || [], loaded: true, error: error || null };
  }

  async function loadChallengeMine(cid, force) {
    if (!session) { challengeMine[cid] = { rows: [], loaded: true, error: null }; return; }
    const m = challengeMine[cid];
    if (m && m.loaded && !force) return;
    const { data, error } = await sb.from('challenge_attempts')
      .select('id, started_at, completed_at, rep_seconds, total_seconds, ended_early')
      .eq('challenge_id', cid).eq('user_id', session.user.id)
      .order('completed_at', { ascending: false }).limit(50);
    if (error) console.warn('challenge attempts load failed', error);
    challengeMine[cid] = { rows: data || [], loaded: true, error: error || null };
  }

  // After a save, a delete, the Ranks switch or a change of who's signed in.
  function forgetChallengeData() { challengeBoards = {}; challengeMine = {}; compareSel = []; }

  // ── The circuit-detail link ───────────────────────────────────────────────────
  function fillCircuitChallenge(c) {
    const slot = document.getElementById('circuit-challenge-slot');
    if (!slot) return;
    const ch = c && challengeForCircuit(c.id);
    if (!ch) { slot.innerHTML = ''; return; }
    const run = chLoadRun();
    const going = run && String(run.challengeId) === String(ch.id);
    slot.innerHTML = `
      <a class="challenge-link" href="#challenge/${encodeURIComponent(ch.id)}">
        <span class="challenge-link-icon">${CH_TROPHY_SVG}</span>
        <span class="challenge-link-text"><b>${escHtml(ch.name)} challenge</b><small>${going ? 'Attempt in progress: tap to go back to it' : 'Timed, with a leaderboard'}</small></span>
        <span class="challenge-link-go" aria-hidden="true">›</span>
      </a>`;
  }

  // ── The attempt in progress (kept on the device) ──────────────────────────────
  // { id, challengeId, userId, proto, startedAt, phase, phaseStart, restLen, reps, completedAt }
  // phase: 'ready' (get-ready countdown) · 'rep' (counting up) · 'rest' (countdown) · 'done'
  function chLoadRun() {
    if (challengeRun) return challengeRun;
    try {
      const r = JSON.parse(lsGet(CH_RUN_KEY) || 'null');
      if (!r || !r.id || !Array.isArray(r.reps) || !r.proto) return null;
      if (Date.now() - r.startedAt > CH_MAX_AGE) { chClearRun(); return null; }
      challengeRun = r;
      return r;
    } catch (e) { return null; }
  }
  function chStoreRun() { if (challengeRun) lsSet(CH_RUN_KEY, JSON.stringify(challengeRun)); }
  function chClearRun() { challengeRun = null; lsSet(CH_RUN_KEY, ''); chSyncAway(); }

  const chTotalReps = r => r.proto.sets * r.proto.reps;
  // 0-based index of the rep being climbed (or next up) -> set and rep numbers.
  function chWhere(r, idx) {
    return { set: Math.floor(idx / r.proto.reps) + 1, rep: (idx % r.proto.reps) + 1 };
  }

  // Close a rep at `at` (ms): record whole seconds (capped), then rest or finish.
  function chEndRep(r, at) {
    const s = Math.min(CH_REP_CAP, Math.max(0, Math.floor((at - r.phaseStart) / 1000)));
    r.reps.push(s);
    if (r.reps.length >= chTotalReps(r)) { r.phase = 'done'; r.completedAt = at; return; }
    r.phase = 'rest';
    r.phaseStart = at;
    r.restLen = (r.reps.length % r.proto.reps === 0) ? r.proto.set_rest_s : r.proto.rep_rest_s;
  }

  // Bring the attempt up to `now` from its timestamps. A countdown that has run out
  // starts the next rep at the moment it ran out; a rep that reaches the 20-minute
  // cap ends at the cap. Returns true if the phase changed.
  function chAdvance(r, now) {
    let changed = false;
    for (let guard = 0; guard < 50; guard++) {
      if (r.phase === 'ready' || r.phase === 'rest') {
        const end = r.phaseStart + (r.phase === 'ready' ? r.proto.get_ready_s : r.restLen) * 1000;
        if (now < end) break;
        r.phase = 'rep'; r.phaseStart = end; changed = true;
      } else if (r.phase === 'rep') {
        const cap = r.phaseStart + CH_REP_CAP * 1000;
        if (now < cap) break;
        chEndRep(r, cap); changed = true;
      } else break;
    }
    return changed;
  }

  // ── Sound (Web Audio; no files) ───────────────────────────────────────────────
  function chEnsureAudio() {
    try {
      if (!chAudio) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        chAudio = new AC();
      }
      if (chAudio.state === 'suspended') chAudio.resume();
    } catch (e) { /* no audio: the clock still works */ }
  }
  function chBeep(freq, ms, vol = 0.3) {
    if (!chAudio || document.visibilityState !== 'visible') return;
    try {
      const t = chAudio.currentTime;
      const o = chAudio.createOscillator(), g = chAudio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      o.connect(g); g.connect(chAudio.destination);
      o.start(t); o.stop(t + ms / 1000 + 0.03);
    } catch (e) {}
  }
  const chSoundCount = () => chBeep(880, 120);                     // 3, 2, 1
  const chSoundGo    = () => { chBeep(1320, 380, 0.4); };           // climb!
  const chSoundRest  = () => { chBeep(520, 220); setTimeout(() => chBeep(392, 320), 230); };
  const chSoundDone  = () => { chBeep(660, 160); setTimeout(() => chBeep(880, 160), 170); setTimeout(() => chBeep(1320, 420, 0.4), 340); };

  // ── Wake lock ─────────────────────────────────────────────────────────────────
  async function chAcquireWake() {
    if (chWakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      chWakeLock = await navigator.wakeLock.request('screen');
      chWakeLock.addEventListener('release', () => { chWakeLock = null; });
    } catch (e) { /* refused or unsupported: non-fatal */ }
  }
  function chReleaseWake() {
    if (chWakeLock) { try { chWakeLock.release(); } catch (e) {} chWakeLock = null; }
  }

  // ── The clock ─────────────────────────────────────────────────────────────────
  function chRunning() { return !!(challengeRun && challengeRun.phase !== 'done'); }

  // The ticker and the wake lock run while an attempt does, whichever view is
  // showing; the bottom nav hides only on the challenge view itself.
  function chStartTicker() {
    if (!chTicker) chTicker = setInterval(chTick, 200);
    chAcquireWake();
    chSyncAway();
  }
  function chStopTicker() {
    if (chTicker) { clearInterval(chTicker); chTicker = null; }
    chReleaseWake();
    chSyncAway();
  }

  // Called by setView for any other view (before currentView changes): the
  // attempt carries on, so just give the nav back and show the way back to it.
  function leaveChallenge() { chSyncAway(false); }

  // The body classes and the strip on the nav. `here` = the challenge view is showing.
  function chSyncAway(here = currentView === 'challenge') {
    const r = chLoadRun();
    document.body.classList.toggle('ch-running', here && chRunning());
    document.body.classList.toggle('ch-away', !here && !!r);
    const el = document.getElementById('ch-return');
    if (!el) return;
    el.hidden = here || !r;
    if (el.hidden) return;
    const ch = challengeById(r.challengeId);
    el.href = '#challenge/' + encodeURIComponent(r.challengeId);
    document.getElementById('ch-return-text').textContent = ch ? `Back to the ${ch.name}` : 'Back to your challenge';
    chUpdateAway(r, Date.now());
  }

  function chTick() {
    const r = challengeRun;
    if (!r) { chStopTicker(); return; }
    const now = Date.now();
    const before = r.phase;
    const here = currentView === 'challenge';
    if (chAdvance(r, now)) {
      chStoreRun();
      // Only sound the change if it happened just now (not while the screen was off).
      if (r.phase === 'rep' && now - r.phaseStart < 1500) chSoundGo();
      if (r.phase === 'done' && before !== 'done') { chSoundDone(); if (!here) chStopTicker(); }
      if (here) renderChallengeBody(); else chUpdateAway(r, now);
      return;
    }
    chCountBeep(r, now);
    if (here) chUpdateClock(r, now); else chUpdateAway(r, now);
  }

  // Seconds left in a countdown (get ready, rest), or null during a rep.
  function chLeft(r, now) {
    if (r.phase !== 'ready' && r.phase !== 'rest') return null;
    const len = r.phase === 'ready' ? r.proto.get_ready_s : r.restLen;
    return Math.max(0, Math.ceil((r.phaseStart + len * 1000 - now) / 1000));
  }

  // 3, 2, 1 before every rep, once per second, in any view.
  function chCountBeep(r, now) {
    const left = chLeft(r, now);
    if (left === null) return;
    const key = r.phase + r.phaseStart + ':' + left;
    if (left >= 1 && left <= 3 && chLastBeep !== key) { chLastBeep = key; chSoundCount(); }
  }

  // The parts that change every second, without rebuilding the view.
  function chUpdateClock(r, now) {
    const el = document.getElementById('ch-clock');
    if (!el) return;
    const left = chLeft(r, now);
    if (r.phase === 'rep') el.textContent = chClock((now - r.phaseStart) / 1000);
    else if (left !== null) el.textContent = chClock(left);
  }

  // The strip's phase and clock.
  function chUpdateAway(r, now) {
    const el = document.getElementById('ch-return-state');
    if (!el) return;
    const left = chLeft(r, now);
    const text = r.phase === 'done' ? 'Finished: save it'
      : r.phase === 'rep' ? `Climbing ${chClock((now - r.phaseStart) / 1000)}`
      : `${r.phase === 'ready' ? 'Get ready' : 'Rest'} ${chClock(left)}`;
    if (el.textContent !== text) el.textContent = text;
    document.getElementById('ch-return').dataset.phase = r.phase;
  }

  // Boot (app.js, after the first route): an attempt left running when the app
  // was closed carries on, whichever view the app opened on.
  function resumeChallenge() {
    const r = chLoadRun();
    if (!r) return;
    chAdvance(r, Date.now());
    chStoreRun();
    if (r.phase !== 'done') chStartTicker(); else chSyncAway();
  }

  // ── The challenge view ────────────────────────────────────────────────────────
  let chViewId = null;   // the challenge the view is showing

  function renderChallenge(id) {
    chViewId = id;
    const title = document.getElementById('challenge-title');
    const wrap = document.getElementById('challenge-content');
    const ch = challengeById(id);
    if (!ch) {
      title.textContent = 'Challenge';
      wrap.innerHTML = challengesLoaded
        ? `<div class="state-msg"><div class="icon">🤷</div>That challenge couldn’t be found.<br><a class="link" href="#circuits">Back to circuits</a></div>`
        : `<div class="spinner"></div>`;
      return;
    }
    title.textContent = ch.name;
    renderChallengeBody();
  }

  function renderChallengeBody() {
    const ch = challengeById(chViewId);
    const wrap = document.getElementById('challenge-content');
    if (!ch || !wrap) return;
    const run = chLoadRun();
    if (run && String(run.challengeId) === String(ch.id)) {
      chAdvance(run, Date.now());
      chStoreRun();
      if (run.phase === 'done') { chStopTicker(); wrap.innerHTML = chSummaryHtml(run, ch); }
      else { wrap.innerHTML = chRunHtml(run); chUpdateClock(run, Date.now()); chStartTicker(); }
      return;
    }
    if (chRunning()) chSyncAway(); else chStopTicker();   // another challenge's attempt keeps going
    wrap.innerHTML = chIntroHtml(ch, run);
    // Fill "your best" and the history once they're in.
    const need = [];
    if (!(challengeBoards[ch.id] && challengeBoards[ch.id].loaded)) need.push(loadChallengeBoard(ch.id));
    if (session && !(challengeMine[ch.id] && challengeMine[ch.id].loaded)) need.push(loadChallengeMine(ch.id));
    if (need.length) Promise.all(need).then(() => {
      if (currentView === 'challenge' && String(chViewId) === String(ch.id) && !chRunning() && !(challengeRun && challengeRun.phase === 'done')) {
        wrap.innerHTML = chIntroHtml(ch, chLoadRun());
      }
    });
  }

  function chIntroHtml(ch, otherRun) {
    const p = chProto(ch);
    const circuit = allCircuits.find(c => String(c.id) === String(ch.circuit_id));
    const total = p.sets * p.reps;
    const rules = `
      <div class="ch-card">
        <div class="ch-kicker">A timed challenge on the ${circuit
          ? `<a class="link" href="#circuit/${encodeURIComponent(circuit.id)}">${escHtml(circuitName(circuit))}</a>`
          : escHtml(ch.name)} circuit</div>
        <ol class="ch-rules">
          <li><b>${p.sets} sets of ${p.reps} reps</b>: ${total} reps in all.</li>
          <li>On each rep, climb laps of the circuit <b>until you come off</b>. The clock counts up. Tap <b>Fell</b> as soon as you’re off.</li>
          <li>Rest <b>${chSpan(p.rep_rest_s)}</b> between reps and <b>${chSpan(p.set_rest_s)}</b> between sets. Beeps count you back in.</li>
          <li>Your score is the <b>total time you held on</b>, added up over every rep. Stopping early still counts what you did.</li>
          <li>Prop your phone up where you can reach it. The screen stays on.</li>
        </ol>
        ${otherRun && otherRun.phase !== 'done' && String(otherRun.challengeId) !== String(ch.id)
          ? `<p class="shell-sub" style="margin:0">You have another challenge running. <a class="link" href="#challenge/${encodeURIComponent(otherRun.challengeId)}">Go back to it</a>.</p>`
          : session
            ? `<button class="btn-block btn-primary" id="ch-start" type="button">Start</button>`
            : `<p class="shell-sub" style="margin:0 0 12px">Sign in to take part. No email needed: just a nickname.</p>
               <button class="btn-block btn-primary" id="ch-signin" type="button">Sign in</button>`}
      </div>`;
    return rules + chMineHtml(ch);
  }

  // "Your best", unsaved attempts and the history (signed in only).
  function chMineHtml(ch) {
    if (!session) return `<a class="btn-block btn-ghost ch-board-link" href="#leaderboard" data-ranks="${escAttr(ch.id)}">See the leaderboard</a>`;
    const pending = chPending().filter(a => a.challengeId === String(ch.id) && a.userId === session.user.id);
    const pendingHtml = pending.length ? `
      <div class="ch-section">Not saved yet</div>
      ${pending.map(a => `
        <div class="ch-attempt pending">
          <div class="ch-attempt-main"><span class="ch-attempt-total">${chClock(a.reps.reduce((s, x) => s + x, 0))}</span>
            <span class="ch-attempt-date">${escHtml(chDate(a.completedAt))}</span></div>
          <div class="ch-attempt-reps">${a.reps.map(x => `<span>${x}s</span>`).join('')}</div>
        </div>`).join('')}
      <button class="btn-block btn-primary" id="ch-retry" type="button">Try saving again</button>` : '';

    const b = challengeBoards[ch.id];
    const m = challengeMine[ch.id];
    const mine = b && b.loaded ? b.rows.find(r => String(r.user_id) === String(session.user.id)) : null;
    const rows = m && m.loaded ? m.rows : null;
    let best = '…', rank = '…';
    if (b && b.loaded && m && m.loaded) {
      best = mine ? chClock(mine.total_seconds) : (rows.length ? chClock(Math.max(...rows.map(r => r.total_seconds))) : '—');
      rank = mine ? (mine.listed ? `${mine.rank}` : 'Hidden') : '—';
    }
    const hiddenNote = mine && !mine.listed
      ? `<p class="lb-private">Only you can see your score. Turn on <b>Show me on Ranks</b> in your Profile to appear on the leaderboard.</p>` : '';
    const history = rows === null ? `<div class="spinner"></div>`
      : m.error ? `<p class="shell-sub">Couldn’t load your attempts. Check your connection.</p>`
      : !rows.length ? `<p class="shell-sub">No attempts yet.</p>`
      : rows.map(a => `
        <details class="ch-attempt">
          <summary class="ch-attempt-main"><span class="ch-attempt-total">${chClock(a.total_seconds)}</span>
            <span class="ch-attempt-date">${escHtml(chDate(a.completed_at))}${a.ended_early ? ' · stopped early' : ''}</span></summary>
          <div class="ch-attempt-reps">${(a.rep_seconds || []).map((x, i) => `<span title="Rep ${i + 1}">${x}s</span>`).join('')}</div>
        </details>`).join('');
    return `
      ${pendingHtml}
      <div class="ch-section">Your best</div>
      <div class="profile-row"><span class="k">Best score</span><span class="v">${escHtml(best)}</span></div>
      <div class="profile-row"><span class="k">Rank</span><span class="v">${escHtml(rank)}</span></div>
      ${hiddenNote}
      <a class="btn-block btn-ghost ch-board-link" href="#leaderboard" data-ranks="${escAttr(ch.id)}">See the leaderboard</a>
      <div class="ch-section">Your attempts</div>
      ${history}`;
  }

  function chRunHtml(r) {
    const idx = r.reps.length;                        // the rep being climbed, or next up
    const { set, rep } = chWhere(r, idx);
    const label = r.phase === 'ready' ? 'Get ready'
      : r.phase === 'rep' ? 'Climb!'
      : (idx % r.proto.reps === 0 ? 'Set rest' : 'Rest');
    const where = r.phase === 'rep'
      ? `Set ${set} of ${r.proto.sets} · Rep ${rep} of ${r.proto.reps}`
      : `Next: set ${set}, rep ${rep}`;
    const chips = r.reps.map((x, i) => `<span title="Rep ${i + 1}">${x}s</span>`).join('');
    const held = r.reps.reduce((s, x) => s + x, 0);
    return `
      <div class="ch-run ch-phase-${r.phase}">
        <div class="ch-run-top">
          <span class="ch-held">Held so far <b>${chClock(held)}</b></span>
          <button class="ch-end" id="ch-end" type="button">End early</button>
        </div>
        <div class="ch-phase" id="ch-phase">${label}</div>
        <div class="ch-clock" id="ch-clock">0:00</div>
        <div class="ch-where">${where}</div>
        <div class="ch-chips">${chips}</div>
        ${r.phase === 'rep'
          ? `<button class="ch-fell" id="ch-fell" type="button">Fell</button>`
          : `<div class="ch-fell-space">${r.phase === 'ready' ? 'Get on the wall. The clock starts on the long beep.' : 'The clock starts again on the long beep.'}</div>`}
      </div>`;
  }

  function chSummaryHtml(r, ch) {
    const total = r.reps.reduce((s, x) => s + x, 0);
    const early = r.reps.length < chTotalReps(r);
    const who = session && session.user.id === r.userId;
    return `
      <div class="ch-card ch-summary">
        <div class="ch-kicker">${escHtml(ch.name)}${early ? ' · stopped early' : ' · all done'}</div>
        <div class="ch-total">${chClock(total)}</div>
        <div class="ch-total-sub">held in ${r.reps.length} rep${r.reps.length === 1 ? '' : 's'}</div>
        <div class="ch-chips">${r.reps.map((x, i) => `<span title="Rep ${i + 1}">${x}s</span>`).join('')}</div>
        ${who
          ? `<button class="btn-block btn-primary" id="ch-save" type="button">Save</button>`
          : `<p class="shell-sub" style="margin:0 0 12px">Sign in as the climber who started this attempt to save it.</p>
             <button class="btn-block btn-primary" id="ch-signin" type="button">Sign in</button>`}
        <button class="btn-block btn-ghost" id="ch-discard" type="button">Discard</button>
      </div>`;
  }

  // ── Actions (one delegated listener, wired in app.js) ─────────────────────────
  function onChallengeClick(e) {
    chEnsureAudio();                      // any tap unlocks sound (needed again after a reload)
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.classList.contains('ch-board-link')) { ranksTab = t.dataset.ranks || 'points'; return; }   // the link navigates
    switch (t.id) {
      case 'ch-start':   chStart(); break;
      case 'ch-signin':  location.hash = '#auth'; break;
      case 'ch-fell':    chFell(); break;
      case 'ch-end':     chEndEarly(t); break;
      case 'ch-save':    chSave(); break;
      case 'ch-discard': chDiscard(t); break;
      case 'ch-retry':   retryChallengeSaves(false); break;
    }
  }

  function chStart() {
    const ch = challengeById(chViewId);
    if (!ch || !session || chRunning()) return;
    const now = Date.now();
    challengeRun = { id: chUuid(), challengeId: String(ch.id), userId: session.user.id, proto: chProto(ch),
                     startedAt: now, phase: 'ready', phaseStart: now, restLen: 0, reps: [], completedAt: null };
    chStoreRun();
    chLastBeep = '';
    renderChallengeBody();
  }

  function chFell() {
    const r = challengeRun;
    if (!r) return;
    const now = Date.now();
    chAdvance(r, now);
    if (r.phase !== 'rep') { renderChallengeBody(); return; }
    chFellAt = now;
    chEndRep(r, now);
    chStoreRun();
    if (r.phase === 'done') chSoundDone(); else chSoundRest();
    renderChallengeBody();
  }

  function chEndEarly(btn) {
    const r = challengeRun;
    if (!r) return;
    const now = Date.now();
    if (now - chFellAt < 800) return;                        // the tail of a Fell double tap
    if (now - chEndArmed > 3000) {                           // first tap: ask for a second
      chEndArmed = now;
      btn.textContent = 'Tap again to end';
      btn.classList.add('armed');
      setTimeout(() => { if (btn.isConnected && Date.now() - chEndArmed >= 3000) { btn.textContent = 'End early'; btn.classList.remove('armed'); } }, 3100);
      return;
    }
    chEndArmed = 0;
    chAdvance(r, now);
    if (r.phase === 'rep') chEndRep(r, now);                 // the rep so far counts, as if you'd fallen
    if (r.phase !== 'done') {
      if (!r.reps.length) { chClearRun(); renderChallengeBody(); showToast('Stopped. Nothing to save.', 'success'); return; }
      r.phase = 'done'; r.completedAt = now;
    }
    chStoreRun();
    chSoundDone();
    renderChallengeBody();
  }

  function chDiscard(btn) {
    const now = Date.now();
    if (now - chDiscardArmed > 3000) {
      chDiscardArmed = now;
      btn.textContent = 'Tap again to throw it away';
      btn.classList.add('armed');
      return;
    }
    chDiscardArmed = 0;
    chClearRun();
    renderChallengeBody();
  }

  // ── Saving (pending list + retry) ─────────────────────────────────────────────
  function chPending() {
    try { const v = JSON.parse(lsGet(CH_PENDING_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function chSetPending(list) { lsSet(CH_PENDING_KEY, JSON.stringify(list)); }

  // One insert. 'saved' (or already saved: 23505), 'refused' (the database won't
  // ever take it: a broken rule or a retired challenge), or 'kept' (try again later).
  async function chSend(a) {
    const { error } = await sb.from('challenge_attempts').insert({
      id: a.id,
      challenge_id: a.challengeId,
      started_at: new Date(a.startedAt).toISOString(),
      completed_at: new Date(a.completedAt).toISOString(),
      rep_seconds: a.reps,
    });
    if (!error || error.code === '23505') return { result: 'saved' };
    console.warn('challenge save failed', error);
    if (error.code === '23514' || error.code === '23503') return { result: 'refused', error };
    return { result: 'kept', error };
  }

  async function chSave() {
    const r = challengeRun;
    if (!r || r.phase !== 'done' || !session || session.user.id !== r.userId) return;
    const btn = document.getElementById('ch-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    // Into the pending list first, so nothing is lost if the page dies mid-save.
    const a = { id: r.id, challengeId: r.challengeId, userId: r.userId, startedAt: r.startedAt, completedAt: r.completedAt, reps: r.reps.slice() };
    chSetPending([...chPending().filter(x => x.id !== a.id), a]);
    chClearRun();
    await retryChallengeSaves(false, a.id);
  }

  // Send this user's pending attempts, oldest first. Quiet when run in the
  // background (start-up, back online); otherwise says what happened.
  let chRetrying = false;
  async function retryChallengeSaves(quiet = true, justSaved = null) {
    if (chRetrying || !session) return;
    const mine = chPending().filter(a => a.userId === session.user.id);
    if (!mine.length) return;
    chRetrying = true;
    let saved = 0, kept = 0, refused = 0;
    for (const a of mine) {
      const { result, error } = await chSend(a);
      if (result === 'kept') { kept++; continue; }
      chSetPending(chPending().filter(x => x.id !== a.id));
      if (result === 'saved') saved++;
      else { refused++; console.warn('challenge attempt refused', error && error.message); }
    }
    chRetrying = false;
    if (saved || refused) {
      for (const cid of new Set(mine.map(a => a.challengeId))) { delete challengeBoards[cid]; delete challengeMine[cid]; }
    }
    if (!quiet || saved) {
      if (kept) showToast(justSaved ? 'No signal: it’s kept on this phone. Try again later.' : 'Still couldn’t save: it’s kept on this phone.', 'error');
      else if (refused) showToast('That attempt couldn’t be saved (it broke a rule).', 'error');
      else if (saved) showToast(saved === 1 ? 'Saved' : `${saved} attempts saved`, 'success');
    }
    if (currentView === 'challenge') renderChallengeBody();
    else if (currentView === 'leaderboard') renderLeaderboard();
  }

  // ── Ranks: a challenge board ──────────────────────────────────────────────────
  // The tab row (Points + one per active challenge), drawn by renderLeaderboard.
  function renderRanksTabs() {
    const el = document.getElementById('ranks-tabs');
    if (!el) return;
    if (!allChallenges.length) { el.hidden = true; ranksTab = 'points'; return; }
    if (ranksTab !== 'points' && !challengeById(ranksTab)) ranksTab = 'points';
    el.hidden = false;
    const tab = (id, name) => `<button class="filter-pill${ranksTab === id ? ' active' : ''}" type="button" data-tab="${escAttr(id)}" aria-pressed="${ranksTab === id}">${escHtml(name)}</button>`;
    el.innerHTML = tab('points', 'Points') + allChallenges.map(c => tab(String(c.id), c.name)).join('');
  }

  function renderChallengeBoard(cid) {
    const el = document.getElementById('leaderboard-content');
    if (!el) return;
    const b = challengeBoards[cid];
    if (!b || !b.loaded) {
      el.innerHTML = `<div class="spinner"></div>`;
      loadChallengeBoard(cid).then(() => { if (currentView === 'leaderboard' && ranksTab === cid) renderChallengeBoard(cid); });
      return;
    }
    if (b.error) { el.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div>Couldn’t load the leaderboard.</div>`; return; }
    const ch = challengeById(cid);
    const listed = b.rows.filter(r => r.listed);
    const me = session ? b.rows.find(r => String(r.user_id) === String(session.user.id)) : null;
    const note = me && !me.listed
      ? `<p class="lb-private">Your best is <b>${chClock(me.total_seconds)}</b>. Only you can see this. Turn on <b>Show me on Ranks</b> in your Profile to appear here.</p>` : '';
    const intro = `<p class="ch-board-intro">Each climber’s best attempt. Tap up to 3 climbers to compare their reps. <a class="link" href="#challenge/${encodeURIComponent(cid)}">Take the challenge</a></p>`;
    if (!listed.length) {
      el.innerHTML = note + `<div class="state-msg"><div class="icon">🏆</div>No one on this board yet.<br><a class="link" href="#challenge/${encodeURIComponent(cid)}">Take the ${escHtml(ch ? ch.name : '')} challenge</a></div>`;
      return;
    }
    compareSel = compareSel.filter(id => listed.some(r => String(r.user_id) === id));
    const admin = isAdmin();
    const rows = listed.map(r => {
      const mine = !!(session && String(r.user_id) === String(session.user.id));
      const sel = compareSel.includes(String(r.user_id));
      return `
        <div class="leaderboard-row ch-row${mine ? ' me' : ''}${sel ? ' selected' : ''}" data-uid="${escAttr(r.user_id)}" role="button" tabindex="0" aria-pressed="${sel}">
          <span class="lb-rank">${escHtml(rankLabel(r.rank))}</span>
          <span class="lb-name">${escHtml(r.username)}${mine ? ' <span class="lb-you">you</span>' : ''}</span>
          <span class="lb-stat">
            <span class="lb-points">${chClock(r.total_seconds)}</span>
            <span class="lb-sends">${escHtml(chDate(r.achieved_at))}</span>
          </span>
          ${admin ? `<button class="icon-btn ch-del" type="button" data-attempt="${escAttr(r.attempt_id)}" aria-label="Delete this attempt">${CH_TRASH_SVG}</button>` : ''}
        </div>`;
    }).join('');
    el.innerHTML = note + intro + `<div class="problem-list">${rows}</div>` + (compareSel.length ? `
      <div class="ch-compare-bar">
        <button class="btn-block btn-ghost" id="ch-compare-clear" type="button">Clear</button>
        <button class="btn-block btn-primary" id="ch-compare-go" type="button">Compare ${compareSel.length}</button>
      </div>` : '');
  }

  // Taps on a challenge board (delegated from #leaderboard-content, wired in app.js).
  function onChallengeBoardClick(e) {
    if (ranksTab === 'points') return;
    const del = e.target.closest('.ch-del');
    if (del) { e.stopPropagation(); openAttemptDelete(del.dataset.attempt); return; }
    if (e.target.closest('#ch-compare-clear')) { compareSel = []; renderChallengeBoard(ranksTab); return; }
    if (e.target.closest('#ch-compare-go')) { openCompare(); return; }
    const row = e.target.closest('.ch-row');
    if (!row) return;
    const uid = row.dataset.uid;
    if (compareSel.includes(uid)) compareSel = compareSel.filter(x => x !== uid);
    else if (compareSel.length >= 3) { showToast('Compare up to 3 climbers', 'error'); return; }
    else compareSel = [...compareSel, uid];
    renderChallengeBoard(ranksTab);
  }

  // ── Compare (a hand-drawn SVG chart; no chart library) ────────────────────────
  async function openCompare() {
    const cid = ranksTab;
    const body = document.getElementById('compare-body');
    body.innerHTML = `<div class="spinner"></div>`;
    document.getElementById('compare-modal').classList.add('show');
    const { data, error } = await sb.rpc('challenge_compare', { cid, uids: compareSel });
    if (error) { body.innerHTML = `<p class="shell-sub">Couldn’t load the comparison.</p>`; console.warn('compare failed', error); return; }
    // Keep the order they were picked in.
    const series = compareSel.map(id => (data || []).find(d => String(d.user_id) === id)).filter(Boolean);
    body.innerHTML = series.length ? chCompareHtml(series, chProto(challengeById(cid))) : `<p class="shell-sub">Nothing to compare.</p>`;
  }
  function closeCompare() { document.getElementById('compare-modal').classList.remove('show'); }

  function chCompareHtml(series, p) {
    const n = Math.max(p.sets * p.reps, ...series.map(s => s.rep_seconds.length));
    const top = Math.max(10, ...series.flatMap(s => s.rep_seconds));
    const step = top <= 60 ? 10 : top <= 180 ? 30 : top <= 600 ? 60 : 300;
    const yMax = Math.ceil(top / step) * step;
    const W = 320, H = 190, L = 36, R = 10, T = 10, B = 26;
    const x = i => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
    const y = v => T + (H - T - B) * (1 - v / yMax);
    let grid = '';
    for (let v = 0; v <= yMax; v += step) {
      grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="ch-grid"/>`
            + `<text x="${L - 6}" y="${y(v) + 4}" class="ch-axis" text-anchor="end">${v >= 60 && v % 60 === 0 ? v / 60 + 'm' : v + 's'}</text>`;
    }
    for (let i = 0; i < n; i++) grid += `<text x="${x(i)}" y="${H - 8}" class="ch-axis" text-anchor="middle">${i + 1}</text>`;
    const lines = series.map((s, k) => {
      const c = CH_COLOURS[k % CH_COLOURS.length];
      const pts = s.rep_seconds.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const dots = s.rep_seconds.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2" style="fill:${c}"/>`).join('');
      return `<polyline points="${pts}" fill="none" style="stroke:${c}" stroke-width="2.2" stroke-linejoin="round"/>${dots}`;
    }).join('');
    const legend = series.map((s, k) => `
      <div class="ch-legend-row">
        <i style="background:${CH_COLOURS[k % CH_COLOURS.length]}"></i>
        <span class="ch-legend-name">${escHtml(s.username)}</span>
        <span class="ch-legend-total">${chClock(s.total_seconds)}</span>
      </div>
      <div class="ch-attempt-reps">${s.rep_seconds.map((v, i) => `<span title="Rep ${i + 1}">${v}s</span>`).join('')}</div>`).join('');
    return `
      <svg class="ch-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Seconds held on each rep">${grid}${lines}</svg>
      <div class="ch-chart-caption">Seconds held on each rep (rep number along the bottom). Each climber’s best attempt.</div>
      <div class="ch-legend">${legend}</div>`;
  }

  // ── Admin: delete an attempt (logged server-side) ─────────────────────────────
  function openAttemptDelete(aid) {
    const b = challengeBoards[ranksTab];
    const r = b && b.rows.find(x => String(x.attempt_id) === String(aid));
    if (!r || !isAdmin()) return;
    chDelTarget = r;
    document.getElementById('attempt-delete-text').textContent =
      `${r.username}’s best attempt: ${chClock(r.total_seconds)} on ${chDate(r.achieved_at)}. Their next-best attempt (if any) takes its place. This is logged.`;
    document.getElementById('attempt-delete-error').textContent = '';
    document.getElementById('attempt-delete-modal').classList.add('show');
  }
  function closeAttemptDelete() { document.getElementById('attempt-delete-modal').classList.remove('show'); chDelTarget = null; }

  async function doAttemptDelete() {
    const r = chDelTarget;
    if (!r) return;
    const btn = document.getElementById('attempt-delete-confirm');
    const errEl = document.getElementById('attempt-delete-error');
    btn.disabled = true;
    const { error } = await sb.rpc('admin_delete_attempt', { aid: r.attempt_id });
    btn.disabled = false;
    if (error) {
      errEl.textContent = error.code === '42501' ? 'Only admins can delete attempts.' : 'Couldn’t delete it: ' + error.message;
      return;
    }
    const cid = ranksTab;
    closeAttemptDelete();
    delete challengeBoards[cid]; delete challengeMine[cid];
    compareSel = compareSel.filter(id => id !== String(r.user_id));
    showToast('Attempt deleted', 'success');
    renderLeaderboard();
  }

  // Back in the foreground: catch the attempt up, take the wake lock again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !challengeRun) return;
    if (currentView === 'challenge') renderChallengeBody();
    else if (chRunning()) chTick();
    if (chRunning()) chAcquireWake();
  });

  // Browsers only allow sound after a tap. After a reload the attempt may carry on
  // in another view, so any tap anywhere unlocks it while one is running.
  document.addEventListener('pointerdown', () => { if (chRunning()) chEnsureAudio(); }, true);
