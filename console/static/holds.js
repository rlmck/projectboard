// PB Console: Holds. The outlines, footholds and foothold mirror pairs of the live board,
// edited on the laptop and published exactly as the app's Edit holds publishes them
// (admin_publish_board(), the super admin; console/holds.py does the write). Pick any hold
// or foothold from the list (search, arrows) or on the board; Clear and draw a fresh outline
// point by point (Undo while drawing), drag, add or remove single points, Simplify, Revert;
// new footholds are drawn, named FTn (left to right, bottom row up) and paired by the board's
// reflection, foot <-> foot only, as in the app. The point counts make the over-traced ones
// stand out. The geometry is the app's own: /app/trace.js and /app/setup.js are loaded before
// this file (traceCurve, traceSimplify, bsFootNameList, bsMirrorFit…). No inline scripts or
// styles (the console's CSP); the canvas colours come from app/tokens.css.
'use strict';
(function () {
  const PB = window.PB;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;
  const DRAFT_KEY = 'pb-console-holds';
  const MID = 30, HI = 60;               // point counts that stand out (amber, red)
  const UNDO_MAX = 100;
  const COLS = 'ABCDEFGHIJKLMNOPQRS';

  let data = null;                       // /api/holds
  let bmp = null, W = 0, H = 0;          // the board image (ImageBitmap) and its size
  let draft = blank();                   // {outlines: {id: pts%}, added: [{id, pts}], removed: [id], pairs: {id: id|null}}
  let undoS = [], redoS = [];
  let sel = null;                        // a hold id
  let mode = null;                       // null | 'draw' | 'pair'
  let drawFor = null, drawPts = [];      // the hold being drawn ('new' = a new foothold), its points (image px)
  let cursor = null;                     // the pointer on the board (image px)
  let view = { s: 1, ox: 0, oy: 0 };    // screen = image * s + o (CSS px)
  let filter = 'all', sortBy = 'board', query = '';
  let simplifyBase = null;
  let model = null, modelGen = -1, gen = 0;
  let loaded = false, loading = false;
  let colors = {};

  const cv = $('hl-board');
  const ctx = cv.getContext('2d');

  function blank() { return { outlines: {}, added: [], removed: [], pairs: {} }; }
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const r2 = (v) => Math.round(v * 100) / 100;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const toPx = (pts) => pts.map((p) => [p[0] / 100 * W, p[1] / 100 * H]);
  const toPct = (pts) => pts.map((p) => [r2(clamp(p[0] / W * 100, -5, 105)), r2(clamp(p[1] / H * 100, -5, 105))]);
  const quad = () => {
    const q = data && data.board.corners && data.board.corners.image;
    return Array.isArray(q) && q.length === 4 ? q : [[0, 0], [100, 0], [100, 100], [0, 100]];
  };
  const level = (n) => (n >= HI ? 'hi' : n >= MID ? 'mid' : '');
  const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // -- the model: the live rows with the draft laid over them -----------------------------
  function getModel() {
    if (model && modelGen === gen) return model;
    const list = [];
    data.holds.forEach((h) => {
      if (h.kind === 'foot' && draft.removed.includes(h.id)) return;
      const pts = draft.outlines[h.id] || (Array.isArray(h.outline) ? h.outline : []);
      list.push({ id: h.id, kind: h.kind, name: h.name, liveName: h.name, led: h.led, mirror: h.mirror || null,
        liveMirror: h.mirror || null, pts, live: Array.isArray(h.outline) ? h.outline : [], isNew: false, redrawn: has(draft.outlines, h.id) });
    });
    draft.added.forEach((a) => list.push({ id: a.id, kind: 'foot', name: '', liveName: null, led: null, mirror: null,
      liveMirror: null, pts: a.pts, live: [], isNew: true, redrawn: true }));
    list.forEach((h) => { if (h.kind === 'foot' && has(draft.pairs, h.id)) h.mirror = draft.pairs[h.id]; });
    const feet = list.filter((h) => h.kind === 'foot' && h.pts.length >= 3);
    const names = bsFootNameList(feet.map((h) => h.pts), quad(), W, H);
    feet.forEach((h, i) => { h.name = names[i]; });
    const smooth = $('hl-smooth').checked ? data.board.smooth : 0;
    list.forEach((h) => {
      h.px = toPx(h.pts);
      h.curve = h.px.length >= 3 ? traceCurve(h.px, smooth) : h.px;
      h.bb = h.curve.length ? traceBBox(h.curve) : [0, 0, 0, 0];
      h.area = h.curve.length >= 3 ? tracePolyArea(h.curve) : 0;
      h.renamed = !h.isNew && h.kind === 'foot' && h.name !== h.liveName;
      h.repaired = h.kind === 'foot' && has(draft.pairs, h.id);
      h.changed = h.redrawn || h.isNew || h.renamed || h.repaired;
    });
    model = { list, byId: new Map(list.map((h) => [h.id, h])) };
    modelGen = gen;
    return model;
  }
  const hold = (id) => (id ? getModel().byId.get(id) || null : null);
  const partner = (h) => (h && h.mirror && h.mirror !== h.id ? hold(h.mirror) : null);
  const label = (h) => (h ? h.name || (h.kind === 'foot' ? 'New foothold' : h.id) : '');

  // -- the draft, undo, the browser copy ---------------------------------------------------
  const snapState = () => JSON.stringify(draft);
  function snap() {
    undoS.push(snapState());
    if (undoS.length > UNDO_MAX) undoS.shift();
    redoS = [];
  }
  function changed() {
    gen++;
    try {
      if (dirty()) localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: data.board.version, draft }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* private window: the draft just isn't kept */ }
    render();
  }
  const dirty = () => Object.keys(draft.outlines).length || draft.added.length || draft.removed.length || Object.keys(draft.pairs).length;
  function undo() {
    if (!undoS.length) return;
    redoS.push(snapState());
    draft = JSON.parse(undoS.pop());
    if (sel && !hold(sel)) sel = null;
    changed();
  }
  function redo() {
    if (!redoS.length) return;
    undoS.push(snapState());
    draft = JSON.parse(redoS.pop());
    changed();
  }
  // A hold's outline in the draft (pts in %). Equal to live: no draft entry.
  function setPts(id, pts) {
    const a = draft.added.find((x) => x.id === id);
    if (a) { a.pts = pts; return; }
    const live = (data.holds.find((h) => h.id === id) || {}).outline;
    if (JSON.stringify(live) === JSON.stringify(pts)) delete draft.outlines[id];
    else draft.outlines[id] = pts;
  }
  function setPair(a, b) {
    const M = getModel();
    [a, b].forEach((id) => { const h = id && M.byId.get(id); if (h && h.mirror && h.mirror !== id) draft.pairs[h.mirror] = null; });
    if (a) draft.pairs[a] = b || null;
    if (b) draft.pairs[b] = a || null;
    const live = new Map(data.holds.filter((h) => h.kind === 'foot').map((h) => [h.id, h.mirror || null]));
    Object.keys(draft.pairs).forEach((id) => { if ((live.has(id) ? live.get(id) : null) === draft.pairs[id]) delete draft.pairs[id]; });
    gen++;
  }
  function nextFootId() {
    let n = (data.board && data.board.foot_id_max) || 0;     // never an id an earlier foothold had (db/45)
    const seen = (id) => { const m = /^foot(\d+)$/.exec(id || ''); if (m) n = Math.max(n, +m[1]); };
    data.holds.forEach((h) => seen(h.id));
    draft.added.forEach((a) => seen(a.id));
    return 'foot' + (n + 1);
  }
  // The foothold the board's reflection puts opposite this one (unpaired, foot only), as the app.
  function suggestPartner(id) {
    const M = getModel(), h = M.byId.get(id);
    if (!h) return null;
    const q = quad(), Hi = bsHomInv(bsHom(q)), bp = bsQuadPx(q, W, H);
    const pos = (x) => { const c = tracePolyCentre(x.pts), uv = bsHomApply(Hi, c[0], c[1]); return [uv[0] * bp.w, uv[1] * bp.h]; };
    const reflect = bsMirrorFit(M.list.filter((x) => x.kind === 'hand' && x.pts.length >= 3).map(pos), bp);
    const [rx, ry] = reflect(pos(h));
    let best = null, bd = Infinity;
    M.list.forEach((o) => {
      if (o.kind !== 'foot' || o.pts.length < 3) return;
      const p = pos(o), d = Math.hypot(p[0] - rx, p[1] - ry);
      if (d < bd) { bd = d; best = o; }
    });
    if (!best || best.id === id || bd > bp.w * BS_PAIR || best.mirror) return null;
    return best.id;
  }
  function edits() {
    const names = {};
    getModel().list.forEach((h) => { if (h.kind === 'foot' && h.name) names[h.id] = h.name; });
    return { outlines: draft.outlines, added: draft.added, removed: draft.removed, pairs: draft.pairs, names };
  }

  // -- loading -------------------------------------------------------------------------------
  async function load() {
    if (loading) return;
    loading = true;
    $('hl-hint').textContent = 'Loading the live board…';
    try {
      const { status, data: d } = await PB.apiJson('/api/holds');
      if (status !== 200) throw new Error(d.error || 'HTTP ' + status);
      if (!bmp || !data || data.board.image_path !== d.board.image_path) {
        const res = await PB.api('/api/holds-image?path=' + encodeURIComponent(d.board.image_path));
        if (!res.ok) throw new Error('the board image: HTTP ' + res.status);
        bmp = await createImageBitmap(await res.blob());
        W = bmp.width; H = bmp.height;
      }
      data = d;
      colors = { hand: tok('--int'), foot: tok('--feet'), sel: tok('--white'), changed: tok('--gold'), accent: tok('--accent'),
        start: tok('--start'), bad: tok('--finish'), ink: tok('--black') };
      restoreDraft();
      if (sel && !hold(sel)) sel = null;
      loaded = true;
      gen++;
      resize();
      fit();
      render();
    } catch (e) {
      $('hl-hint').textContent = 'Couldn’t load the board: ' + e.message;
    } finally {
      loading = false;
    }
  }
  function restoreDraft() {
    const msg = $('hl-msg');
    msg.hidden = true;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.draft) { draft = blank(); return; }
    draft = Object.assign(blank(), saved.draft);
    // drop what no longer fits the board (a foothold deleted from the phone, say)
    const ids = new Set(data.holds.map((h) => h.id));
    Object.keys(draft.outlines).forEach((k) => { if (!ids.has(k)) delete draft.outlines[k]; });
    draft.removed = draft.removed.filter((k) => ids.has(k));
    draft.added = draft.added.filter((a) => !ids.has(a.id));
    if (saved.version !== data.board.version) {
      msg.hidden = false;
      msg.innerHTML = 'Your draft was made on an earlier board version (the board was published since, from the phone or here). It is laid over the board as it is now: check it before you publish. <button class="btn small" id="hl-msg-drop">Discard the draft</button>';
    }
  }

  // -- the view --------------------------------------------------------------------------------
  function resize() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    draw();
  }
  const cw = () => cv.width / (window.devicePixelRatio || 1);
  const ch = () => cv.height / (window.devicePixelRatio || 1);
  function fit() {
    if (!W) return;
    const s = Math.min(cw() / W, ch() / H);
    view = { s, ox: (cw() - W * s) / 2, oy: (ch() - H * s) / 2 };
    draw();
  }
  function zoomTo(h) {
    if (!h || !h.bb) return;
    const [x0, y0, x1, y1] = h.bb, bw = Math.max(x1 - x0, W * 0.07), bh = Math.max(y1 - y0, H * 0.07);
    const s = clamp(Math.min(cw() * 0.32 / bw, ch() * 0.32 / bh), Math.min(cw() / W, ch() / H), 12);
    view = { s, ox: cw() / 2 - (x0 + x1) / 2 * s, oy: ch() / 2 - (y0 + y1) / 2 * s };
    draw();
  }
  // Keep a hold on screen without changing the zoom unless it's off the screen.
  function bringIntoView(h) {
    if (!h || !h.bb) return;
    const [x0, y0, x1, y1] = h.bb, fitS = Math.min(cw() / W, ch() / H);
    if (view.s <= fitS * 1.05) { zoomTo(h); return; }
    const sx0 = x0 * view.s + view.ox, sx1 = x1 * view.s + view.ox, sy0 = y0 * view.s + view.oy, sy1 = y1 * view.s + view.oy;
    if (sx0 < 0 || sy0 < 0 || sx1 > cw() || sy1 > ch()) zoomTo(h);
  }
  const toImg = (ev) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left - view.ox) / view.s, (ev.clientY - r.top - view.oy) / view.s]; };

  // -- drawing the board -------------------------------------------------------------------------
  function pathOf(pts) {
    ctx.beginPath();
    pts.forEach((p, i) => { const x = p[0] * view.s + view.ox, y = p[1] * view.s + view.oy; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
  }
  function draw() {
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw(), ch());
    if (!bmp || !data) return;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, view.ox, view.oy, W * view.s, H * view.s);
    const M = getModel(), S = hold(sel), P = partner(S), all = $('hl-all').checked, names = $('hl-names').checked;
    ctx.lineJoin = 'round';
    M.list.forEach((h) => {
      if (h === S || h.curve.length < 3) return;
      const pairPick = mode === 'pair' && h.kind === 'foot';
      if (!all && !h.changed && h !== P && !pairPick) return;
      pathOf(h.curve);
      ctx.globalAlpha = h === P || pairPick ? 1 : 0.8;
      ctx.lineWidth = h === P ? 2.5 : pairPick ? 2.5 : 1.5;
      ctx.setLineDash(h === P ? [6, 4] : []);
      ctx.strokeStyle = h === P ? colors.accent : h.changed ? colors.changed : h.kind === 'foot' ? colors.foot : colors.hand;
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (S && S.curve.length >= 3) {
      if (S.redrawn && S.live.length >= 3 && mode !== 'draw') {         // the live outline, for comparison
        const smooth = $('hl-smooth').checked ? data.board.smooth : 0;
        pathOf(traceCurve(toPx(S.live), smooth));
        ctx.setLineDash([3, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = colors.bad; ctx.stroke(); ctx.setLineDash([]);
      }
      pathOf(S.curve);
      ctx.globalAlpha = mode === 'draw' ? 0.25 : 0.18; ctx.fillStyle = colors.sel; ctx.fill(); ctx.globalAlpha = mode === 'draw' ? 0.4 : 1;
      ctx.lineWidth = 2.5; ctx.strokeStyle = S.kind === 'foot' ? colors.foot : colors.hand; ctx.stroke();
      ctx.globalAlpha = 1;
      if (mode !== 'draw') {
        const r = S.px.length > 80 ? 2.5 : 4;
        S.px.forEach((p) => {
          ctx.beginPath(); ctx.rect(p[0] * view.s + view.ox - r, p[1] * view.s + view.oy - r, 2 * r, 2 * r);
          ctx.fillStyle = colors.sel; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = colors.ink; ctx.stroke();
        });
      }
    }
    if (mode === 'draw') drawInProgress();
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tag = (h) => {
      if (!h || h.curve.length < 3) return;
      const c = tracePolyCentre(h.px), x = c[0] * view.s + view.ox, y = h.bb[1] * view.s + view.oy - 10;
      ctx.lineWidth = 3; ctx.strokeStyle = colors.ink; ctx.strokeText(label(h), x, y); ctx.fillStyle = colors.sel; ctx.fillText(label(h), x, y);
    };
    if (names) M.list.forEach(tag); else { tag(S); tag(P); }
  }
  function drawInProgress() {
    const pts = drawPts.map((p) => [p[0] * view.s + view.ox, p[1] * view.s + view.oy]);
    if (!pts.length) return;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (cursor) ctx.lineTo(cursor[0] * view.s + view.ox, cursor[1] * view.s + view.oy);
    ctx.lineWidth = 2; ctx.strokeStyle = colors.start; ctx.stroke();
    if (pts.length >= 3) {
      ctx.beginPath(); ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); ctx.lineTo(pts[0][0], pts[0][1]);
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p[0], p[1], i === 0 ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? colors.start : colors.sel; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = colors.ink; ctx.stroke();
    });
  }

  // -- the list ------------------------------------------------------------------------------------
  function boardKey(h) {
    if (h.kind === 'hand') {
      const m = /^([A-S])(\d+)$/.exec(h.name || '');
      return m ? +m[2] * 100 + COLS.indexOf(m[1]) : 9999;
    }
    const m = /^FT(\d+)$/.exec(h.name || '');
    return 100000 + (m ? +m[1] : 9999);
  }
  function visible() {
    const q = query.trim().toUpperCase();
    let list = getModel().list.filter((h) => (filter === 'all' || (filter === 'hand' && h.kind === 'hand') || (filter === 'foot' && h.kind === 'foot')
      || (filter === 'changed' && h.changed)) && (!q || label(h).toUpperCase().startsWith(q)));
    list = list.slice().sort((a, b) => (sortBy === 'points' ? b.pts.length - a.pts.length || boardKey(a) - boardKey(b) : boardKey(a) - boardKey(b)));
    return list;
  }
  function renderList() {
    const list = visible(), M = getModel();
    $('hl-rows').innerHTML = list.map((h) => {
      const n = h.pts.length, tags = [h.isNew ? 'new' : h.redrawn ? 'redrawn' : '', h.renamed ? 'renamed' : '', h.repaired ? 'pair' : ''].filter(Boolean);
      return '<button class="hl-row" role="option" data-id="' + esc(h.id) + '" aria-selected="' + (h.id === sel) + '">' +
        '<span class="hl-kind' + (h.kind === 'foot' ? ' foot' : '') + '" aria-hidden="true"></span>' +
        '<span>' + esc(label(h)) + (tags.length ? '<span class="hl-tag">' + esc(tags.join(' · ')) + '</span>' : '') + '</span>' +
        '<span class="hl-n ' + level(n) + '">' + (n || 'none') + '</span></button>';
    }).join('') || '<p class="note">No hold matches.</p>';
    const hands = M.list.filter((h) => h.kind === 'hand'), feet = M.list.filter((h) => h.kind === 'foot');
    const over = M.list.filter((h) => h.pts.length >= HI).length, mid = M.list.filter((h) => h.pts.length >= MID && h.pts.length < HI).length;
    $('hl-counts').textContent = hands.length + ' hand · ' + feet.length + ' feet · ' + over + ' with ' + HI + '+ points, ' + mid + ' with ' + MID + '–' + (HI - 1);
    const row = $('hl-rows').querySelector('[aria-selected=true]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function step(d) {
    const list = visible();
    if (!list.length) return;
    let i = list.findIndex((h) => h.id === sel);
    i = i < 0 ? (d > 0 ? 0 : list.length - 1) : clamp(i + d, 0, list.length - 1);
    pick(list[i].id, true);
  }

  // -- the panel ------------------------------------------------------------------------------------
  function renderPanel() {
    const p = $('hl-panel'), h = hold(sel);
    if (mode === 'draw') {
      const n = drawPts.length;
      p.innerHTML = '<h2>' + esc(drawFor === 'new' ? 'New foothold' : 'Redraw ' + label(h)) + '</h2>' +
        '<p>Click round the hold, corner by corner: <span class="hl-big">' + n + '</span> point' + (n === 1 ? '' : 's') + '. A rectangle needs 4.</p>' +
        '<p class="note">Enter, or a click on the first (green) point, finishes; Backspace or Ctrl+Z takes the last point back; Esc stops without changing anything. Drag to move the view, wheel to zoom.</p>' +
        '<div class="btn-row"><button class="btn primary small" data-a="finish"' + (n >= 3 ? '' : ' disabled') + '>Finish</button>' +
        '<button class="btn small" data-a="back"' + (n ? '' : ' disabled') + '>Undo point</button><button class="btn small" data-a="cancel">Cancel</button></div>';
      return;
    }
    if (mode === 'pair' && h) {
      p.innerHTML = '<h2>Pair ' + esc(label(h)) + '</h2><p>Click the foothold that mirrors it (footholds are outlined). A hand hold can\'t be its partner.</p>' +
        '<div class="btn-row"><button class="btn small" data-a="cancel">Cancel</button></div>';
      return;
    }
    if (!h) {
      p.innerHTML = '<h2>No hold picked</h2><p class="note">Pick one in the list (or <kbd>/</kbd> and its name), or click it on the board. <kbd>↓</kbd> walks the list; "Most points first" puts the over-traced ones on top.</p>';
      return;
    }
    const n = h.pts.length, P = partner(h), used = (data.feet_used || {})[h.id] || 0;
    const mirrorText = h.kind === 'hand'
      ? (h.mirror && h.mirror !== h.id ? '<button class="hl-link" data-go="' + esc(h.mirror) + '">' + esc(label(hold(h.mirror)) || h.mirror) + '</button> (fixed here)' : 'itself (centre)')
      : (P ? '<button class="hl-link" data-go="' + esc(P.id) + '">' + esc(label(P)) + '</button>' : 'none');
    p.innerHTML = '<h2>' + esc(label(h)) + '</h2>' +
      '<dl class="hl-facts">' +
      '<dt>Kind</dt><dd>' + (h.kind === 'hand' ? 'hand hold' + (h.led != null ? ', LED ' + esc(h.led) : '') : 'foothold (no LED)' + (h.isNew ? ', new' : '')) + '</dd>' +
      '<dt>Points</dt><dd><span class="hl-big ' + level(n) + '">' + (n || 'none') + '</span>' + (h.redrawn && !h.isNew ? ' (live: ' + h.live.length + ')' : '') + '</dd>' +
      '<dt>Mirror</dt><dd>' + mirrorText + '</dd>' +
      (h.kind === 'foot' ? '<dt>Used</dt><dd>' + (used ? used + ' problem' + (used === 1 ? '' : 's') + '\' Specific feet' : 'by no problem') + '</dd>' : '') +
      (h.renamed ? '<dt>Name</dt><dd>was ' + esc(h.liveName) + '</dd>' : '') +
      '</dl>' +
      '<div class="btn-row"><button class="btn small primary" data-a="draw" title="C">' + (n ? 'Clear and draw' : 'Draw') + '</button>' +
      (h.redrawn && !h.isNew ? '<button class="btn small" data-a="revert" title="R">Revert to live</button>' : '') + '</div>' +
      (n >= 8 ? '<label class="hl-simplify">Simplify <input type="range" id="hl-simp" min="0" max="8" step="0.25" value="0"> <span id="hl-simp-n">' + n + '</span></label>' : '') +
      (h.kind === 'foot' ? '<div class="btn-row"><button class="btn small" data-a="pair" title="P">Pair with…</button>' +
        (h.mirror && h.mirror !== h.id ? '<button class="btn small" data-a="unpair">Unpair</button>' : '') +
        '<button class="btn small danger" data-a="delete"' + (used ? ' disabled title="A problem\'s Specific feet uses it"' : '') + '>Delete foothold</button></div>' : '') +
      (h.redrawn && !h.isNew ? '<p class="note">The dashed red line is the live outline.</p>' : '');
  }
  function renderChanges() {
    const M = getModel(), out = [], pairs = [], renamed = [];
    M.list.filter((h) => h.redrawn && !h.isNew).forEach((h) => out.push(label(h) + ': outline ' + h.live.length + ' → ' + h.pts.length + ' points'));
    M.list.filter((h) => h.isNew).forEach((h) => out.push(label(h) + ': new foothold (' + h.pts.length + ' points)'));
    draft.removed.forEach((id) => { const r = data.holds.find((x) => x.id === id); out.push((r ? r.name : id) + ': deleted'); });
    M.list.filter((h) => h.repaired).forEach((h) => {
      const k = [h.id, h.mirror || ''].sort().join('|');
      if (pairs.includes(k)) return;
      pairs.push(k);
      out.push(h.mirror ? label(h) + ' ↔ ' + label(hold(h.mirror)) : label(h) + ': unpaired');
    });
    M.list.filter((h) => h.renamed).forEach((h) => renamed.push(h));
    if (renamed.length) out.push(renamed.length + ' foothold' + (renamed.length === 1 ? '' : 's') + ' renumbered, to keep FT1, FT2… left to right, bottom row up (ids and Specific feet stay)');
    $('hl-changes').innerHTML = out.length ? out.length + ' change' + (out.length === 1 ? '' : 's') + ':<ul>' + out.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : 'No changes: the draft matches the live board.';
    $('hl-publish').disabled = !out.length || !data.can_publish;
    $('hl-publish').title = data.can_publish ? '' : 'No db/.env on this laptop: the console can\'t publish';
    $('hl-discard').disabled = !dirty();
    $('hl-undo').disabled = !undoS.length;
    $('hl-redo').disabled = !redoS.length;
    $('hl-undo-publish').disabled = !data.can_publish;
    const s = data.snapshot || {};
    $('hl-snap').textContent = s.behind
      ? 'Behind the live board: the app\'s offline copy (app/hold_map.json, the outlines, the image) is from ' + (s.version || 'an older board') + '. Ship it after publishing (it deploys the app, and the Pi\'s copy follows).'
      : 'The app\'s offline copy matches the live board.';
    $('hl-ship-snap').disabled = !s.behind;
  }
  function hint() {
    const h = hold(sel);
    $('hl-hint').textContent = mode === 'draw' ? 'Drawing: click to add a point · Enter or the green point finishes · Backspace takes one back · Esc stops'
      : mode === 'pair' ? 'Pairing: click a foothold · Esc stops'
        : h ? label(h) + ': drag a point to move it · Shift+click a point to remove it · double-click an edge to add one · C to clear and draw'
          : 'Click a hold to pick it · wheel to zoom · drag to move the view';
  }
  function render() {
    if (!data) return;
    cv.classList.toggle('drawing', mode === 'draw' || mode === 'pair');
    renderList(); renderPanel(); renderChanges(); hint(); draw();
  }

  // -- actions ---------------------------------------------------------------------------------------
  function pick(id, scroll) {
    if (mode) stopMode();
    sel = id;
    simplifyBase = null;
    render();
    if (scroll) bringIntoView(hold(id));
  }
  function startDraw(forId) {
    mode = 'draw'; drawFor = forId; drawPts = []; simplifyBase = null;
    if (forId !== 'new') sel = forId;
    render();
  }
  function stopMode() { mode = null; drawFor = null; drawPts = []; }
  function finishDraw() {
    if (drawPts.length < 3) { PB.toast('An outline needs at least 3 points'); return; }
    const pts = toPct(drawPts);
    snap();
    if (drawFor === 'new') {
      const id = nextFootId();
      draft.added.push({ id, pts });
      gen++;
      const p = suggestPartner(id);
      if (p) setPair(id, p);
      sel = id;
      stopMode();
      changed();
      PB.toast(label(hold(id)) + ' added' + (p ? ', paired with ' + label(hold(p)) : ''));
    } else {
      setPts(drawFor, pts);
      stopMode();
      changed();
    }
  }
  function revert(id) {
    if (!has(draft.outlines, id)) return;
    snap(); delete draft.outlines[id]; changed();
  }
  function deleteFoot(id) {
    const h = hold(id);
    if (!h || h.kind !== 'foot') return;
    if ((data.feet_used || {})[id]) { PB.toast(label(h) + ' is in a problem\'s Specific feet, so it can\'t be deleted'); return; }
    snap();
    const p = partner(h);
    if (p) draft.pairs[p.id] = null;
    if (h.isNew) draft.added = draft.added.filter((a) => a.id !== id);
    else draft.removed.push(id);
    delete draft.outlines[id];
    delete draft.pairs[id];
    gen++;
    setPair(null, null);                  // prune pair entries equal to live
    sel = null;
    changed();
  }
  function pairWith(otherId) {
    const h = hold(sel), o = hold(otherId);
    if (!h || !o || o.kind !== 'foot') { PB.toast('Pick a foothold: footholds only pair with footholds'); return; }
    if (o.id === h.id) return;
    snap(); setPair(h.id, o.id); stopMode(); changed();
    PB.toast(label(h) + ' ↔ ' + label(o));
  }
  async function publish() {
    if (mode) stopMode();
    const ok = await PB.runAction('holds-publish', { version: data.board.version, edits: edits() }, 'Publish the holds');
    if (ok) {
      draft = blank(); undoS = []; redoS = [];
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
      gen++;
      await load();
    }
  }
  function discard() {
    if (!dirty()) return;
    snap(); draft = blank(); if (sel && !hold(sel)) sel = null;
    $('hl-msg').hidden = true;
    changed();
    PB.toast('Draft discarded (Undo brings it back)');
  }

  // -- the board's pointer --------------------------------------------------------------------------
  function holdAt(x, y) {
    const M = getModel(), tol = 10 / view.s;
    let inside = null, near = null, nd = Infinity;
    M.list.forEach((h) => {
      if (h.curve.length < 3 || x < h.bb[0] - tol || x > h.bb[2] + tol || y < h.bb[1] - tol || y > h.bb[3] + tol) return;
      if (tracePointInPoly(x, y, h.curve)) { if (!inside || h.area < inside.area) inside = h; return; }
      h.curve.forEach((p) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < nd) { nd = d; near = h; } });
    });
    return inside || (nd <= tol ? near : null);
  }
  function vertexAt(h, x, y) {
    if (!h) return -1;
    const tol = 8 / view.s;
    let best = -1, bd = tol;
    h.px.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d <= bd) { bd = d; best = i; } });
    return best;
  }
  function edgeAt(h, x, y) {
    if (!h || h.px.length < 3) return -1;
    const tol = 8 / view.s;
    let best = -1, bd = tol;
    h.px.forEach((a, i) => {
      const b = h.px[(i + 1) % h.px.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
      const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / L, 0, 1), d = Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
      if (d <= bd) { bd = d; best = i; }
    });
    return best;
  }

  let g = null;                           // the gesture: {x, y, sx, sy, moved, type: 'pan' | 'vertex', i, ox, oy}
  cv.addEventListener('pointerdown', (ev) => {
    if (!data || ev.button > 1) return;
    cv.setPointerCapture(ev.pointerId);
    const [x, y] = toImg(ev);
    g = { sx: ev.clientX, sy: ev.clientY, ox: view.ox, oy: view.oy, moved: false, type: 'pan' };
    if (!mode && ev.button === 0 && !ev.shiftKey) {
      const i = vertexAt(hold(sel), x, y);
      if (i >= 0) Object.assign(g, { type: 'vertex', i, before: snapState() });
    }
  });
  cv.addEventListener('pointermove', (ev) => {
    if (!data) return;
    cursor = toImg(ev);
    if (!g) { if (mode === 'draw') draw(); return; }
    const dx = ev.clientX - g.sx, dy = ev.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    if (g.type === 'pan') {
      view.ox = g.ox + dx; view.oy = g.oy + dy;
      cv.classList.add('panning');
      draw();
    } else {
      const h = hold(sel), pts = h.pts.map((p) => p.slice());
      pts[g.i] = toPct([cursor])[0];
      setPts(sel, pts);
      gen++;
      draw();
    }
  });
  function endGesture(ev) {
    if (!g) return;
    const was = g;
    g = null;
    cv.classList.remove('panning');
    if (was.type === 'vertex' && was.moved) {
      if (was.before !== snapState()) { undoS.push(was.before); if (undoS.length > UNDO_MAX) undoS.shift(); redoS = []; }
      changed();
      return;
    }
    if (was.moved || !ev) return;
    click(ev);
  }
  cv.addEventListener('pointerup', endGesture);
  cv.addEventListener('pointercancel', () => endGesture(null));
  cv.addEventListener('pointerleave', () => { cursor = null; if (mode === 'draw') draw(); });
  function click(ev) {
    const [x, y] = toImg(ev);
    if (mode === 'draw') {
      if (drawPts.length >= 3 && Math.hypot(drawPts[0][0] - x, drawPts[0][1] - y) * view.s <= 10) { finishDraw(); return; }
      drawPts.push([x, y]);
      renderPanel(); draw();
      return;
    }
    if (mode === 'pair') {
      const h = holdAt(x, y);
      if (h) pairWith(h.id);
      return;
    }
    const S = hold(sel);
    if (ev.shiftKey && S) {
      const i = vertexAt(S, x, y);
      if (i >= 0) {
        if (S.pts.length <= 3) { PB.toast('An outline needs at least 3 points'); return; }
        snap(); setPts(sel, S.pts.filter((_, k) => k !== i)); changed();
        return;
      }
    }
    const h = holdAt(x, y);
    if (h && h.id !== sel) pick(h.id, false);
    else if (!h && sel) { sel = null; render(); }
  }
  cv.addEventListener('dblclick', (ev) => {
    if (mode || !sel) return;
    const [x, y] = toImg(ev), S = hold(sel), i = edgeAt(S, x, y);
    if (i < 0 || vertexAt(S, x, y) >= 0) return;
    if (S.pts.length >= 400) { PB.toast('400 points at most'); return; }
    const pts = S.pts.map((p) => p.slice());
    pts.splice(i + 1, 0, toPct([[x, y]])[0]);
    snap(); setPts(sel, pts); changed();
  });
  cv.addEventListener('wheel', (ev) => {
    if (!data) return;
    ev.preventDefault();
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const fitS = Math.min(cw() / W, ch() / H), s = clamp(view.s * Math.pow(1.0015, -ev.deltaY), fitS * 0.5, 12);
    view.ox = mx - (mx - view.ox) * s / view.s;
    view.oy = my - (my - view.oy) * s / view.s;
    view.s = s;
    draw();
  }, { passive: false });

  // -- the keyboard ----------------------------------------------------------------------------------
  // On this tab "/" jumps to a hold (it opens the palette elsewhere; Ctrl+K still does here).
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== '/' || $('tab-holds').hidden || !data || document.querySelector('dialog[open]')) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (mode) { stopMode(); render(); }
    $('hl-search').focus(); $('hl-search').select();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if ($('tab-holds').hidden || !data || document.querySelector('dialog[open]')) return;
    const t = ev.target, typing = t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (typing && t.id !== 'hl-search') return;
    const k = ev.key, ctrl = ev.ctrlKey || ev.metaKey;
    if (t && t.id === 'hl-search') {
      if (k === 'Enter') {                // pick the first match, then show the whole list again (arrows walk on from it)
        const v = visible();
        t.value = ''; query = ''; t.blur(); ev.preventDefault();
        if (v.length) pick(v[0].id, true); else renderList();
      }
      else if (k === 'Escape') { t.value = ''; query = ''; renderList(); t.blur(); }
      else if (k === 'ArrowDown' || k === 'ArrowUp') { t.blur(); step(k === 'ArrowDown' ? 1 : -1); ev.preventDefault(); }
      return;
    }
    if (mode === 'draw') {
      if (k === 'Enter') { finishDraw(); ev.preventDefault(); }
      else if (k === 'Backspace' || (ctrl && k.toLowerCase() === 'z')) { drawPts.pop(); renderPanel(); draw(); ev.preventDefault(); }
      else if (k === 'Escape') { stopMode(); render(); }
      return;
    }
    if (k === 'Escape' && mode) { stopMode(); render(); return; }
    if (ctrl && k.toLowerCase() === 'z') { ev.shiftKey ? redo() : undo(); ev.preventDefault(); return; }
    if (ctrl && k.toLowerCase() === 'y') { redo(); ev.preventDefault(); return; }
    if (ctrl || ev.altKey) return;
    const key = k.length === 1 ? k.toLowerCase() : k;
    if (key === 'ArrowDown' || key === 'j') { step(1); ev.preventDefault(); }
    else if (key === 'ArrowUp' || key === 'k') { step(-1); ev.preventDefault(); }
    else if (key === 'c' && sel) startDraw(sel);
    else if (key === 'n') startDraw('new');
    else if (key === 'r' && sel) revert(sel);
    else if (key === 'p' && hold(sel) && hold(sel).kind === 'foot') { mode = 'pair'; render(); }
    else if (key === 'f') fit();
    else if (key === 'z' && sel) zoomTo(hold(sel));
    else if (key === 'Escape' && sel) { sel = null; render(); }
  });

  // -- wiring -------------------------------------------------------------------------------------------
  $('hl-rows').addEventListener('click', (ev) => { const b = ev.target.closest('[data-id]'); if (b) pick(b.dataset.id, true); });
  $('hl-search').addEventListener('input', () => { query = $('hl-search').value; renderList(); });
  document.querySelectorAll('[data-hlf]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.hlf;
    document.querySelectorAll('[data-hlf]').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  }));
  $('hl-sort').addEventListener('change', () => { sortBy = $('hl-sort').value; renderList(); });
  ['hl-smooth', 'hl-names', 'hl-all'].forEach((id) => $(id).addEventListener('change', () => { gen++; draw(); }));
  $('hl-fit').addEventListener('click', fit);
  $('hl-zoom').addEventListener('click', () => zoomTo(hold(sel)));
  $('hl-panel').addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-go]');
    if (go) { pick(go.dataset.go, true); return; }
    const b = ev.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'draw') startDraw(sel);
    else if (a === 'finish') finishDraw();
    else if (a === 'back') { drawPts.pop(); renderPanel(); draw(); }
    else if (a === 'cancel') { stopMode(); render(); }
    else if (a === 'revert') revert(sel);
    else if (a === 'pair') { mode = 'pair'; render(); }
    else if (a === 'unpair') { snap(); setPair(sel, null); changed(); }
    else if (a === 'delete') deleteFoot(sel);
  });
  $('hl-panel').addEventListener('input', (ev) => {
    if (ev.target.id !== 'hl-simp' || !sel) return;
    const h = hold(sel);
    if (!simplifyBase) { simplifyBase = { id: sel, pts: h.pts, before: snapState() }; }
    const tol = +ev.target.value, base = toPx(simplifyBase.pts);
    const pts = tol > 0 ? toPct(traceSimplify(base, tol)) : simplifyBase.pts;
    if (pts.length >= 3) setPts(sel, pts);
    gen++;
    $('hl-simp-n').textContent = pts.length + (tol > 0 ? ' (tolerance ' + tol + ' px)' : '');
    draw(); renderList(); renderChanges();
  });
  $('hl-panel').addEventListener('change', (ev) => {
    if (ev.target.id !== 'hl-simp' || !simplifyBase) return;
    if (simplifyBase.before !== snapState()) { undoS.push(simplifyBase.before); if (undoS.length > UNDO_MAX) undoS.shift(); redoS = []; }
    simplifyBase = null;
    changed();
  });
  $('hl-msg').addEventListener('click', (ev) => { if (ev.target.id === 'hl-msg-drop') discard(); });
  $('hl-publish').addEventListener('click', publish);
  $('hl-undo').addEventListener('click', undo);
  $('hl-redo').addEventListener('click', redo);
  $('hl-discard').addEventListener('click', discard);
  $('hl-new-foot').addEventListener('click', () => startDraw('new'));
  $('hl-reload').addEventListener('click', load);
  $('hl-undo-publish').addEventListener('click', async () => { if (await PB.runAction('holds-undo-publish', {}, 'Undo the last board publish')) load(); });
  $('hl-ship-snap').addEventListener('click', async () => { if (await PB.runAction('holds-ship-snapshot', {}, 'Ship the snapshot')) load(); });
  if (window.ResizeObserver) new ResizeObserver(() => { if (!$('tab-holds').hidden) resize(); }).observe(cv);
  PB.tabHooks.holds = () => { if (!loaded) load(); else resize(); };
  // read-only, for checking the tab from the browser's console (and the headless check)
  PB.holds = { state: () => JSON.parse(JSON.stringify({ sel, mode, view, W, H, draft, drawPts, undo: undoS.length, edits: data ? edits() : null })) };
})();
