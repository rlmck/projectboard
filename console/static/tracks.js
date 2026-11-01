// PB Console: Circuit tracks (cast contract 8.6, db/37). A port of the editor in
// tools/circuit-trace-demo.html ("Train track", "Edit the track"): pick a circuit,
// pick a move, tap LEDs on the board to add or remove them; the circuit's own
// holds jump to the move that starts there. Saved through the action table
// (circuit-track-save, with a confirm listing the moves that change), which checks
// it exactly as the Pi does (pi/listener/circuit.py check_track) and writes over
// direct Postgres. No inline scripts or styles (the console's CSP).
'use strict';
(function () {
  const PB = window.PB;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;
  const COLS = 'ABCDEFGHIJKLMNOPQRS';
  const LED = { green: [40, 235, 95], blue: [50, 120, 255], red: [255, 45, 45], white: [235, 240, 255], pink: [236, 72, 153] };
  const num = (h) => parseInt(String(h).slice(4), 10);
  const cellLabel = (n) => COLS[(n - 1) % 19] + (Math.floor((n - 1) / 19) + 1);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  let data = null;          // {circuits, cells, limits, trace}
  let CELLS = {};
  let circ = null;          // the circuit row being edited
  let edits = {};           // move -> [cell numbers] (every move of the circuit)
  let saved = {};           // move -> [cell numbers] as stored (for "changed")
  let stale = [];           // stored moves that no longer match the circuit
  let legIdx = 0;
  let previewing = false, previewT0 = 0;
  let loaded = false;

  const cv = $('trk-board');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, R = W * 0.034;
  const img = new Image();
  img.onload = () => draw();
  img.src = '/board.jpg';

  // -- moves (the demo's legs/suggested/along) --------------------------------------
  function legs() {
    if (!circ) return [];
    const seq = circ.hold_sequence, L = seq.length, out = [];
    for (let i = 0; i < L - 1; i++) out.push({ move: i + 1, from: seq[i], to: seq[i + 1] });
    if (circ.loops && L > 1) out.push({ move: L, from: seq[L - 1], to: seq[0] });
    return out.filter((l) => l.from !== l.to).map((l) => ({ ...l, a: num(l.from), b: num(l.to) }));
  }
  const gxy = (n) => [(n - 1) % 19, Math.floor((n - 1) / 19)];
  function suggested(l) {
    const inCirc = new Set(circ.hold_sequence.map(num)), [x0, y0] = gxy(l.a), [x1, y1] = gxy(l.b), out = [];
    const k = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 1; i < k; i++) {
      const c = Math.round(y0 + (y1 - y0) * i / k) * 19 + Math.round(x0 + (x1 - x0) * i / k) + 1;
      if (!inCirc.has(c) && !out.includes(c) && c !== 2 && c !== 21) out.push(c);
    }
    return along(l, out);
  }
  function along(l, cells) {
    if (!CELLS[l.a] || !CELLS[l.b]) return [...cells];
    const P = (n) => [CELLS[n][0] * W / 100, CELLS[n][1] * H / 100];
    const [ax, ay] = P(l.a), [bx, by] = P(l.b), dx = bx - ax, dy = by - ay;
    const key = (n) => (CELLS[n] ? (P(n)[0] - ax) * dx + (P(n)[1] - ay) * dy : 0);
    return [...cells].sort((m, n) => key(m) - key(n));
  }
  const same = (p, q) => p.length === q.length && p.every((v, i) => v === q[i]);
  const legCells = (l) => edits[l.move] || [];
  const isSuggested = (l) => same(along(l, legCells(l)), suggested(l));
  const isChanged = (l) => !saved[l.move] || !same(along(l, legCells(l)), saved[l.move]);

  function trackSummary() {
    const inCirc = new Set(circ.hold_sequence.map(num)), all = new Set();
    legs().forEach((l) => legCells(l).forEach((n) => { if (!inCirc.has(n)) all.add(n); }));
    const tr = [...all];
    return { track: tr, others: tr.filter((n) => CELLS[n] && CELLS[n][2]), empty: tr.filter((n) => CELLS[n] && !CELLS[n][2]) };
  }

  // The trace's path, as circuit.py _path(): each move's from-hold then its LEDs, the last hold
  // unless it loops, every LED once.
  function path() {
    const seq = circ.hold_sequence.map(num), inCirc = new Set(seq), out = [];
    legs().forEach((l) => { out.push(l.a); along(l, legCells(l)).forEach((n) => { if (!inCirc.has(n)) out.push(n); }); });
    if (!circ.loops || !out.length) out.push(seq[seq.length - 1]);
    return [...new Set(out)].filter((n) => CELLS[n] && n !== 2 && n !== 21);
  }

  // -- loading --------------------------------------------------------------------------
  async function load() {
    $('trk-msg').textContent = 'Reading the circuits from the database…';
    try {
      const { status, data: d } = await PB.apiJson('/api/tracks');
      if (status !== 200) throw new Error(d.error || status);
      data = d;
      CELLS = d.cells;
      const sel = $('trk-circuit'), keep = circ && circ.name;
      sel.innerHTML = d.circuits.map((c, i) => '<option value="' + i + '">' + esc(c.name) + ' (' + esc(c.grade || '?') + ', ' +
        c.hold_sequence.length + ' holds, ' + (c.loops ? 'loop' : 'once') + (c.led_track ? ', track' : '') + ')</option>').join('');
      let i = d.circuits.findIndex((c) => c.name === (keep || 'Pat Burner'));
      if (i < 0) i = 0;
      sel.value = String(i);
      pick(i);
      $('trk-msg').textContent = 'Read just now: ' + d.circuits.length + ' circuits, ' +
        d.circuits.filter((c) => c.led_track).length + ' with a track.';
      loaded = true;
    } catch (e) {
      $('trk-msg').textContent = "Couldn't read the circuits: " + e.message + ' (needs db/.env on this laptop).';
    }
  }

  function pick(i) {
    circ = data.circuits[i];
    edits = {}; saved = {}; stale = []; legIdx = 0;
    const L = legs(), byMove = {};
    const t = circ.led_track;
    if (t && Array.isArray(t.moves)) t.moves.forEach((m) => { if (m && typeof m.move === 'number') byMove[m.move] = m; });
    L.forEach((l) => {
      const m = byMove[l.move];
      if (m && m.from === l.from && m.to === l.to && Array.isArray(m.cells)) {
        edits[l.move] = m.cells.map(num).filter((n) => CELLS[n]);
        saved[l.move] = edits[l.move].slice();
        delete byMove[l.move];
      } else {
        if (m) stale.push(m);
        edits[l.move] = suggested(l);
      }
    });
    Object.values(byMove).forEach((m) => stale.push(m));
    stopPreview();
    drawLegs(); draw();
  }

  function startSuggested() {
    if (!circ) return;
    legs().forEach((l) => { edits[l.move] = suggested(l); });
    drawLegs(); draw();
  }

  // -- drawing --------------------------------------------------------------------------
  const XY = (n) => [CELLS[n][0] / 100 * W, CELLS[n][1] / 100 * H];
  function glow(n, rgb, a, r) {
    if (!CELLS[n] || a <= 0.005) return;
    r = r || R;
    const [x, y] = XY(n), [cr, cg, cb] = rgb;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + 0.95 * a + ')');
    gr.addColorStop(0.25, 'rgba(' + cr + ',' + cg + ',' + cb + ',' + 0.55 * a + ')');
    gr.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
  function colourOf(i) {
    const L = circ.hold_sequence.length, s = clamp(circ.start_count || 1, 1, Math.min(2, L));
    if (i < s) return LED.green;
    if (!circ.loops && i === L - 1) return LED.red;
    return LED.blue;
  }
  function backdrop(dark) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (img.complete && img.naturalWidth) { ctx.drawImage(img, 0, 0, W, H); ctx.fillStyle = 'rgba(0,0,0,' + dark + ')'; ctx.fillRect(0, 0, W, H); }
  }

  function draw() {
    if (!circ) { backdrop(0.72); return; }
    if (previewing) return;
    const L = legs(), cur = L[legIdx], inCirc = new Set(circ.hold_sequence.map(num));
    backdrop(0.72);
    for (let n = 1; n <= 247; n++) {               // every LED: a dot under a hold, a ring in an empty cell
      if (inCirc.has(n) || n === 2 || n === 21 || !CELLS[n]) continue;
      const [x, y] = XY(n);
      ctx.beginPath(); ctx.arc(x, y, W * 0.006, 0, 7);
      if (CELLS[n][2]) { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; ctx.stroke(); }
    }
    if (cur && CELLS[cur.a] && CELLS[cur.b]) {
      const [ax, ay] = XY(cur.a), [bx, by] = XY(cur.b);
      ctx.strokeStyle = 'rgba(236,72,153,0.55)'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalCompositeOperation = 'lighter';
    L.forEach((l, i) => { if (i !== legIdx) legCells(l).forEach((n) => glow(n, LED.pink, 0.3)); });
    circ.hold_sequence.forEach((h, i) => glow(num(h), colourOf(i), 0.55));
    if (cur) { legCells(cur).forEach((n) => glow(n, LED.pink, 1)); glow(cur.a, LED.white, 0.9); glow(cur.b, LED.white, 0.9); }
    ctx.globalCompositeOperation = 'source-over';
    if (cur) {
      [[cur.a, 'from'], [cur.b, 'to']].forEach(([n, txt]) => {
        if (!CELLS[n]) return;
        const [x, y] = XY(n);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, R * 0.6, 0, 7); ctx.stroke();
        ctx.font = '600 ' + Math.round(W * 0.016) + 'px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.strokeText(txt, x, y - R * 0.75); ctx.fillStyle = '#fff'; ctx.fillText(txt, x, y - R * 0.75);
      });
    }
    const tr = trackSummary();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3; ctx.setLineDash([7, 6]);
    tr.others.forEach((n) => { const [x, y] = XY(n); ctx.beginPath(); ctx.arc(x, y, R * 0.45, 0, 7); ctx.stroke(); });
    ctx.setLineDash([]);
    $('trk-now').textContent = cur
      ? 'Move ' + cur.move + ': ' + cellLabel(cur.a) + ' → ' + cellLabel(cur.b) + ', ' + legCells(cur).length + ' LEDs' +
        (isSuggested(cur) ? ' (the suggested line)' : ' (edited)') + (isChanged(cur) ? ', not saved' : '') + '.'
      : 'This circuit has no moves to edit.';
    const counts = $('trk-counts');
    counts.textContent = 'Whole track: ' + tr.track.length + ' LEDs, ' + tr.others.length + ' under other holds (ringed), ' +
      tr.empty.length + ' in empty cells. Trace: ' + path().length + ' LEDs a lap.';
    counts.classList.toggle('warn-text', tr.others.length > 0);
    const dirty = legs().filter(isChanged).length;
    $('trk-dirty').textContent = dirty ? dirty + ' move' + (dirty === 1 ? '' : 's') + ' not saved' + (circ.led_track ? '' : ' (no track stored yet)') : 'Saved.';
    $('trk-stale').hidden = !stale.length;
    $('trk-stale').innerHTML = stale.length ? '<strong>' + stale.length + ' stored move' + (stale.length === 1 ? '' : 's') +
      ' no longer match the circuit</strong> (it was edited since the track was saved). The Pi skips them; saving replaces them with the moves below.<ul>' +
      stale.map((m) => '<li>move ' + esc(m.move) + ': ' + esc(m.from) + ' → ' + esc(m.to) + '</li>').join('') + '</ul>' : '';
    $('trk-remove').disabled = !circ.led_track;
  }

  function drawLegs() {
    const L = legs();
    if (legIdx >= L.length) legIdx = 0;
    $('trk-legs').innerHTML = L.map((l, i) => '<button class="btn small trk-leg' + (i === legIdx ? ' on' : '') +
      (isChanged(l) ? ' trk-dirty' : '') + '" data-leg="' + i + '" title="' + (isSuggested(l) ? 'Suggested' : 'Edited') + '">' +
      l.move + ' ' + cellLabel(l.a) + '→' + cellLabel(l.b) + ' · ' + legCells(l).length + (isSuggested(l) ? '' : ' ✎') + '</button>').join('');
  }

  // -- the trace preview (as circuit.py trace_frame, 3 s, repeating) -------------------------
  function previewFrame() {
    if (!previewing) return;
    const tr = data.trace, p = path(), n = p.length;
    const t = ((performance.now() - previewT0) / 1000) % 3;
    const tt = Math.floor(t * 30) / 30;                    // the Pi's 30 fps
    const step = clamp(tr.lap / Math.max(1, n), tr.step_min, tr.step_max);
    backdrop(0.8);
    ctx.globalCompositeOperation = 'lighter';
    const fade = smooth(tt / tr.fade), lit = new Map();
    new Set(circ.hold_sequence.map(num)).forEach((h) => lit.set(h, [LED.white, Math.max(0.12, tr.dim) * fade]));
    trackSummary().track.forEach((c) => lit.set(c, [LED.pink, Math.max(0.2, tr.dim) * fade]));
    const k = Math.floor(tt / step);
    [[2, 0.15], [1, 0.45], [0, 1]].forEach(([b, a]) => { if (k - b >= 0 && n) lit.set(p[(k - b) % n], [LED.white, a]); });
    lit.forEach(([rgb, a], c) => glow(c, rgb, a));
    ctx.globalCompositeOperation = 'source-over';
    $('trk-now').textContent = 'Trace preview: ' + n + ' LEDs a lap, ' + step.toFixed(3) + ' s a step (' + (n * step).toFixed(1) + ' s a lap).';
    requestAnimationFrame(previewFrame);
  }
  function togglePreview() {
    if (!circ) return;
    previewing = !previewing;
    $('trk-preview').textContent = previewing ? 'Stop the preview' : 'Preview the trace';
    $('trk-preview').classList.toggle('on', previewing);
    if (previewing) { previewT0 = performance.now(); requestAnimationFrame(previewFrame); } else draw();
  }
  function stopPreview() { if (previewing) togglePreview(); }

  // -- tapping the board ---------------------------------------------------------------
  function cellAt(ev) {
    const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left) * W / r.width, y = (ev.clientY - r.top) * H / r.height;
    let best = null, bd = Infinity;
    for (let n = 1; n <= 247; n++) {
      if (n === 2 || n === 21 || !CELLS[n]) continue;     // the feet signs are never track LEDs
      const [cx, cy] = XY(n), d = Math.hypot(cx - x, cy - y);
      if (d < bd) { bd = d; best = n; }
    }
    return bd < R * 1.1 ? best : null;
  }
  cv.addEventListener('pointerdown', (ev) => {
    if (!circ || previewing) return;
    const n = cellAt(ev); if (!n) return;
    const L = legs();
    if (circ.hold_sequence.map(num).includes(n)) {        // a circuit hold: jump to the move that starts there
      const j = L.findIndex((l) => l.a === n); if (j >= 0) { legIdx = j; drawLegs(); draw(); }
      return;
    }
    const cur = L[legIdx]; if (!cur) return;
    const cells = legCells(cur).slice(), at = cells.indexOf(n);
    if (at >= 0) cells.splice(at, 1);
    else if (cells.length >= data.limits.cells) { PB.toast('At most ' + data.limits.cells + ' LEDs in a move'); return; }
    else cells.push(n);
    edits[cur.move] = along(cur, cells);
    drawLegs(); draw();
  });

  // -- save, remove, import, test cast -----------------------------------------------------
  function trackJson() {
    return { version: 1, moves: legs().map((l) => ({ move: l.move, from: l.from, to: l.to, cells: along(l, legCells(l)).map((n) => 'hold' + n) })) };
  }
  async function save() {
    if (!circ) return;
    stopPreview();
    if (await PB.runAction('circuit-track-save', { circuit: circ.name, track: trackJson() }, 'Save the track of ' + circ.name)) load();
  }
  async function remove() {
    if (!circ || !circ.led_track) return;
    if (await PB.runAction('circuit-track-remove', { circuit: circ.name }, 'Remove the track of ' + circ.name)) load();
  }
  async function importFile(ev) {
    const f = ev.target.files[0]; if (!f || !circ) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.format !== 'pb-circuit-tracks' || j.version !== 1) throw new Error('not a pb-circuit-tracks version 1 file');
      const c = (j.circuits || {})[circ.name];
      if (!c) throw new Error('it has no circuit called ' + circ.name + ' (it has: ' + Object.keys(j.circuits || {}).join(', ') + ')');
      let used = 0, skipped = 0;
      const L = legs();
      (c.moves || []).forEach((m) => {
        const l = L.find((x) => x.move === m.move && x.from === m.from && x.to === m.to);
        if (!l || !Array.isArray(m.cells)) { skipped++; return; }
        edits[l.move] = along(l, m.cells.map(num).filter((n) => CELLS[n] && n !== 2 && n !== 21)).slice(0, data.limits.cells);
        used++;
      });
      drawLegs(); draw();
      $('trk-msg').textContent = 'Imported ' + used + ' moves from ' + f.name + (skipped ? '; ' + skipped + " didn't match the circuit now and were left out" : '') + '. Not saved yet.';
    } catch (e) { $('trk-msg').textContent = 'Import failed: ' + e.message + '.'; }
    ev.target.value = '';
  }

  // -- wiring -------------------------------------------------------------------------------
  $('trk-circuit').addEventListener('change', () => pick(Number($('trk-circuit').value)));
  $('trk-reload').addEventListener('click', load);
  $('trk-legs').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-leg]'); if (!b) return;
    legIdx = Number(b.dataset.leg); stopPreview(); drawLegs(); draw();
  });
  $('trk-suggest').addEventListener('click', () => { const l = legs()[legIdx]; if (l) { edits[l.move] = suggested(l); drawLegs(); draw(); } });
  $('trk-clear').addEventListener('click', () => { const l = legs()[legIdx]; if (l) { edits[l.move] = []; drawLegs(); draw(); } });
  $('trk-all-suggested').addEventListener('click', startSuggested);
  $('trk-preview').addEventListener('click', togglePreview);
  $('trk-save').addEventListener('click', save);
  $('trk-remove').addEventListener('click', remove);
  $('trk-import').addEventListener('change', importFile);
  $('trk-cast').addEventListener('click', () => {
    if (!circ) return;
    PB.runAction('circuit-test-cast', { circuit: circ.name, loop: $('trk-loop').checked }, 'Test cast ' + circ.name);
  });
  $('trk-stop').addEventListener('click', () => PB.runAction('circuit-test-stop', {}, 'Stop the test run'));
  PB.tabHooks.tracks = () => { if (!loaded) load(); else draw(); };
})();
