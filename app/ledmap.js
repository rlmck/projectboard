// ProjectBoard - ordered classic <script>s sharing ONE global scope (no ES modules, no
// build step). Order: state, core, problems, admin, account, authoring, circuits,
// challenge, leaderboard, wall, trace, ledmap, setup, app. This file: camera LED
// mapping, Board setup's step 4 (#setup, admins; session 2b of docs/board-setup-plan.md),
// and its Check mode.
//
// The pure part (lm* functions up to "the step"): no DOM, so tools/ledmap_score.js runs
// the same code in Node on synthetic camera frames and scores it.
//   lmAverage    several camera frames -> one (less noise, less mains flicker)
//   lmFindSpots  the lit LED's spot: the lift over an all-off frame, high-passed (slow
//                changes in the room's light cancel out), thresholded from the frame's own
//                noise, then blobs; flags a second spot and a scene that changed
//   lmQuadMap    camera -> board image through the two sets of four corners
//   lmHomFit     a homography fitted to matched points (the refinement)
//   lmClassify   a spot -> the hand hold under it (inside its outline, else the nearest
//                within reach), or a flag: none, double, far, between, busy
//   lmTally      results -> each hand hold's LEDs, the holds with none or two, the flags
// The step (further down): the camera, the Pi (map_leds / map_state, cast contract 11),
// the run, manual mode, review, Check mode. setup.js calls it.

// ── tuning ────────────────────────────────────────────────────────────────────
const LM_OPTS = {
  minLift: 22,        // a spot must lift the picture at least this much (0-255) over the off frame
  k: 7,               // ... and this many noise widths (MAD) above the frame's typical lift
  hpFrac: 0.035,      // the high-pass radius, as a share of the board's width on camera
  blobFrac: 0.4,      // a blob is what's over this share of the brightest lift (and the threshold)
  mergeFrac: 0.018,   // blobs closer than this (share of the board's width) are one spot (a glow)
  doubleFrac: 0.45,   // a second spot at least this bright (share of the first's peak) = two spots
  busyFrac: 0.004,    // more than this share of the board changed = something moved: retake
  farFrac: 0.02,      // a spot further than this from every hand hold's outline = far (share of width)
  betweenFrac: 0.006, // outside every outline and two holds within this of each other = between
};

// ── pure: frames and spots ────────────────────────────────────────────────────
// RGBA frames (ImageData.data, all the same size) -> Float32Array of RGB, averaged.
function lmAverage(frames) {
  const n = frames[0].length / 4, out = new Float32Array(n * 3), k = 1 / frames.length;
  frames.forEach(f => {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      out[i * 3] += f[j] * k; out[i * 3 + 1] += f[j + 1] * k; out[i * 3 + 2] += f[j + 2] * k;
    }
  });
  return out;
}

const lmDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lmQuadWidth = q => (lmDist(q[0], q[1]) + lmDist(q[3], q[2])) / 2;
function lmGrow(q, f) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(p => [cx + (p[0] - cx) * (1 + f), cy + (p[1] - cy) * (1 + f)]);
}

// The lit spot(s) in a camera frame. lit, off: RGB Float32Arrays (lmAverage) of a w x h
// frame; quad: the board's four corners on it, in px. Returns { spots: [{x, y, peak,
// area, weight}] brightest first, peak, thr, busy }.
function lmFindSpots(lit, off, w, h, quad, opts) {
  const o = Object.assign({}, LM_OPTS, opts || {});
  const roi = lmGrow(quad, 0.04), qw = lmQuadWidth(quad);
  const bx0 = Math.max(0, Math.floor(Math.min(...roi.map(p => p[0])))), bx1 = Math.min(w - 1, Math.ceil(Math.max(...roi.map(p => p[0]))));
  const by0 = Math.max(0, Math.floor(Math.min(...roi.map(p => p[1])))), by1 = Math.min(h - 1, Math.ceil(Math.max(...roi.map(p => p[1]))));
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  if (bw < 8 || bh < 8) return { spots: [], peak: 0, thr: 0, busy: false };
  // the board's mask (a convex quad: inside all four edges, either winding)
  const inside = new Uint8Array(bw * bh);
  const edges = roi.map((p, i) => [p, roi[(i + 1) % 4]]);
  const sgn = Math.sign(edges.reduce((a, [p, q]) => a + (q[0] - p[0]) * (q[1] + p[1]), 0)) || 1;
  let nIn = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const px = x + bx0 + 0.5, py = y + by0 + 0.5;
      let ok = true;
      for (const [p, q] of edges) {
        if (sgn * ((q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])) > 0) { ok = false; break; }
      }
      if (ok) { inside[y * bw + x] = 1; nIn++; }
    }
  }
  if (!nIn) return { spots: [], peak: 0, thr: 0, busy: false };
  // the lift: how much brighter each pixel got, in its brightest channel
  const d = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x;
      if (!inside[j]) continue;
      const i = ((y + by0) * w + x + bx0) * 3;
      const v = Math.max(lit[i] - off[i], lit[i + 1] - off[i + 1], lit[i + 2] - off[i + 2]);
      if (v > 0) d[j] = v;
    }
  }
  // box means from an integral image
  const integ = a => {
    const I = new Float64Array((bw + 1) * (bh + 1));
    for (let y = 0; y < bh; y++) {
      let row = 0;
      for (let x = 0; x < bw; x++) { row += a[y * bw + x]; I[(y + 1) * (bw + 1) + x + 1] = I[y * (bw + 1) + x + 1] + row; }
    }
    return I;
  };
  const boxMean = (I, x, y, r) => {
    const xa = Math.max(0, x - r), xb = Math.min(bw, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(bh, y + r + 1);
    return (I[yb * (bw + 1) + xb] - I[ya * (bw + 1) + xb] - I[yb * (bw + 1) + xa] + I[ya * (bw + 1) + xa]) / ((xb - xa) * (yb - ya));
  };
  // smoothed (3 x 3, against single-pixel noise), then high-passed (a slow change in the
  // room's light, or the flicker's bands, lifts a wide area evenly and cancels out)
  const I1 = integ(d), s = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (inside[y * bw + x]) s[y * bw + x] = boxMean(I1, x, y, 1);
  const R = Math.max(4, Math.round(qw * o.hpFrac));
  const I2 = integ(s), hp = new Float32Array(bw * bh);
  let peak = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x;
      if (!inside[j]) continue;
      const v = s[j] - boxMean(I2, x, y, R);
      if (v > 0) { hp[j] = v; if (v > peak) peak = v; }
    }
  }
  // the frame's own noise: median and MAD of the high-passed lift over the board
  const step = Math.max(1, Math.floor(Math.sqrt(nIn / 40000)));
  const samp = [];
  for (let y = 0; y < bh; y += step) for (let x = 0; x < bw; x += step) if (inside[y * bw + x]) samp.push(hp[y * bw + x]);
  samp.sort((a, b) => a - b);
  const med = samp[samp.length >> 1] || 0;
  const dev = samp.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = dev[dev.length >> 1] || 0;
  const thr = Math.max(o.minLift, med + o.k * 1.4826 * mad);
  let over = 0;
  for (let j = 0; j < hp.length; j++) if (hp[j] > thr) over++;
  const busy = over > o.busyFrac * nIn;
  if (peak < thr) return { spots: [], peak, thr, busy };
  // blobs over the cut (8-connected)
  const cut = Math.max(thr, peak * o.blobFrac), seen = new Uint8Array(bw * bh), blobs = [];
  for (let j0 = 0; j0 < hp.length; j0++) {
    if (seen[j0] || hp[j0] <= cut) continue;
    const st = [j0];
    seen[j0] = 1;
    let sw = 0, sx = 0, sy = 0, pk = 0, area = 0;
    while (st.length) {
      const j = st.pop(), x = j % bw, y = (j - x) / bw, v = hp[j];
      sw += v; sx += v * (x + 0.5); sy += v * (y + 0.5); area++;
      if (v > pk) pk = v;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= bw) continue;
          const k2 = yy * bw + xx;
          if (!seen[k2] && hp[k2] > cut) { seen[k2] = 1; st.push(k2); }
        }
      }
    }
    blobs.push({ x: sx / sw + bx0, y: sy / sw + by0, peak: pk, area, weight: sw });
  }
  // a glow can break into pieces: those close together are one spot
  blobs.sort((a, b) => b.weight - a.weight);
  const spots = [], near = qw * o.mergeFrac;
  blobs.forEach(b => {
    const m = spots.find(s2 => Math.hypot(s2.x - b.x, s2.y - b.y) <= near);
    if (!m) { spots.push(Object.assign({}, b)); return; }
    const t = m.weight + b.weight;
    m.x = (m.x * m.weight + b.x * b.weight) / t; m.y = (m.y * m.weight + b.y * b.weight) / t;
    m.weight = t; m.area += b.area; m.peak = Math.max(m.peak, b.peak);
  });
  spots.sort((a, b) => b.peak - a.peak || b.weight - a.weight);
  return { spots: spots.slice(0, 4), peak, thr, busy };
}

// ── pure: geometry ────────────────────────────────────────────────────────────
// Through the board's four corners on each picture (TL, TR, BR, BL): a point on one
// picture -> the same point of the board on the other. Units are whatever the quads use.
function lmQuadMap(src, dst) {
  const A = bsHomInv(bsHom(src)), B = bsHom(dst);
  if (!A || !B) return null;
  return p => { const uv = bsHomApply(A, p[0], p[1]); return bsHomApply(B, uv[0], uv[1]); };
}

// A homography fitted (least squares, normalised) to [[from], [to]] pairs; null if it can't.
function lmHomFit(pairs) {
  if (pairs.length < 6) return null;
  const norm = pts => {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const s = Math.SQRT2 / (pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1);
    return { f: p => [(p[0] - cx) * s, (p[1] - cy) * s], cx, cy, s };
  };
  const ns = norm(pairs.map(p => p[0])), nd = norm(pairs.map(p => p[1]));
  const M = Array.from({ length: 8 }, () => new Array(8).fill(0)), v = new Array(8).fill(0);
  pairs.forEach(([a, b]) => {
    const [u, w] = ns.f(a), [x, y] = nd.f(b);
    [[[u, w, 1, 0, 0, 0, -u * x, -w * x], x], [[0, 0, 0, u, w, 1, -u * y, -w * y], y]].forEach(([r, t]) => {
      for (let i = 0; i < 8; i++) { v[i] += r[i] * t; for (let j = 0; j < 8; j++) M[i][j] += r[i] * r[j]; }
    });
  });
  const h = bsSolve(M, v);
  if (!h) return null;
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  return p => {
    const q = bsHomApply(H, ...ns.f(p));
    return [q[0] / nd.s + nd.cx, q[1] / nd.s + nd.cy];
  };
}

// The distance from a point to a polygon's edge (0 inside it).
function lmPolyDist(p, pts) {
  if (pts.length >= 3 && tracePointInPoly(p[0], p[1], pts)) return 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

// holds: [{ id, c: [x, y], pts: [[x, y]…] }] in the board picture's px. The hold a point is
// on (inside its outline: the smallest such), else the nearest outline; with the runner-up.
function lmNearest(p, holds) {
  let best = null, bd = Infinity, second = null, sd = Infinity;
  holds.forEach(h => {
    const d = h.pts && h.pts.length >= 3 ? lmPolyDist(p, h.pts) : lmDist(p, h.c);
    const tie = d === 0 && bd === 0 && best && tracePolyArea(h.pts) < tracePolyArea(best.pts);
    if (d < bd || tie) { second = best; sd = bd; best = h; bd = d; }
    else if (d < sd) { second = h; sd = d; }
  });
  return { hold: best, dist: bd, second, sdist: sd };
}

// One LED's detection -> its result. toBoard: camera px -> board picture px; bw: the board's
// width on the picture, px. A result keeps the spots (camera px, for a later re-match).
//   ok: on a hand hold   none: no spot   double: two spots   far: a spot near no hand hold
//   between: a spot between two holds   busy: the picture kept changing (someone moved)
function lmClassify(det, toBoard, holds, bw, opts) {
  const o = Object.assign({}, LM_OPTS, opts || {});
  const r = { st: 'none', hold: null, guess: null, cam: det.spots.map(s => [Math.round(s.x * 10) / 10, Math.round(s.y * 10) / 10]),
              peak: Math.round(det.peak), how: 'camera' };
  if (det.busy) { r.st = 'busy'; return r; }
  if (!det.spots.length) return r;
  return lmMatch(r, toBoard, holds, bw, o, det.spots.length > 1 && det.spots[1].peak >= o.doubleFrac * det.spots[0].peak);
}
function lmMatch(r, toBoard, holds, bw, o, double) {
  const p = toBoard(r.cam[0]), n = lmNearest(p, holds);
  r.at = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
  r.guess = n.hold ? n.hold.id : null;
  r.hold = null;
  if (double === undefined) double = r.st === 'double';
  if (double) r.st = 'double';
  else if (!n.hold || n.dist > o.farFrac * bw) r.st = 'far';
  else if (n.dist > 0 && n.second && n.sdist - n.dist < o.betweenFrac * bw) r.st = 'between';
  else { r.st = 'ok'; r.hold = n.hold.id; }
  return r;
}

// Re-match every camera result through a new map (after the refinement).
function lmRematch(results, toBoard, holds, bw, opts) {
  const o = Object.assign({}, LM_OPTS, opts || {});
  Object.values(results).forEach(r => {
    if (r.how === 'camera' && r.cam && r.cam.length && ['ok', 'far', 'between', 'double'].includes(r.st)) {
      lmMatch(r, toBoard, holds, bw, o, r.st === 'double');
    }
  });
}

// The corners are marked by hand, so refine: fit the camera -> board map to the spots that
// landed inside an outline (to that hold's centre), and keep it if more spots land inside.
function lmRefine(results, toBoard, holds, bw, opts) {
  const byId = new Map(holds.map(h => [h.id, h]));
  const inside = map => Object.values(results).filter(r => r.how === 'camera' && r.cam && r.cam.length && r.st !== 'busy')
    .reduce((a, r) => { const n = lmNearest(map(r.cam[0]), holds); return a + (n.dist === 0 ? 1 : 0); }, 0);
  let best = toBoard, score = inside(toBoard);
  for (let it = 0; it < 3; it++) {
    const pairs = [];
    Object.values(results).forEach(r => {
      if (r.how !== 'camera' || r.st !== 'ok' || !r.cam || r.cam.length !== 1) return;
      const n = lmNearest(best(r.cam[0]), holds);
      if (n.dist === 0) pairs.push([r.cam[0], byId.get(n.hold.id).c]);
    });
    const fit = lmHomFit(pairs);
    if (!fit) break;
    const s = inside(fit);
    if (s <= score) break;
    best = fit; score = s;
  }
  return best;
}

// results: { led: {st, hold…} } -> each hand hold's LEDs and what needs a look.
function lmTally(results, holdIds) {
  const byHold = new Map(holdIds.map(id => [id, []]));
  const flagged = [], none = [], skipped = [];
  Object.keys(results).map(Number).sort((a, b) => a - b).forEach(led => {
    const r = results[led];
    if (r.hold && byHold.has(r.hold)) byHold.get(r.hold).push(led);
    else if (r.st === 'none') none.push(led);
    else if (r.st === 'skip') skipped.push(led);
    else if (!r.hold) flagged.push(led);
  });
  const missing = [], clash = [];
  byHold.forEach((leds, id) => { if (!leds.length) missing.push(id); else if (leds.length > 1) clash.push(id); });
  return { byHold, flagged, none, skipped, missing, clash, done: holdIds.length - missing.length - clash.length };
}

// Check mode: the mapped LEDs against the table's.
function lmCompare(byHold, table) {
  let same = 0;
  const diff = [];
  byHold.forEach((leds, id) => {
    if (leds.length === 1 && leds[0] === table[id]) same++;
    else diff.push({ id, table: table[id], got: leds.slice() });
  });
  return { same, diff };
}

// ── the step: state ───────────────────────────────────────────────────────────
// Step 4 of the setup flow (between Review and Mirror pairs), and Check mode (today's
// board, from the start page: maps every LED and compares with the table, publishes
// nothing). Phases: choose -> camera -> corners (the camera still) -> run -> review, or
// choose -> manual -> review; Check mode adds tcorners (today's board picture) when the
// board has no corners stored. The results and the camera corners are saved on this
// phone (the setup draft, or Check mode's own), so a run can stop and carry on.
const LM_CHECK_KEY = 'pb-board-ledcheck';
const LM_SETTLE_MS = 300;      // after the Pi says an LED is lit, before camera frames are used
const LM_ACK_MS = 5000;        // no map_state for this long = the board isn't answering
const LM_PING_MS = 20000;      // keep-alive while the step is open (the Pi lets go after 60 s)
const LM_OFF_EVERY = 25;       // a fresh all-off frame every this many LEDs (the room's light drifts)
const LM_WORK = 1280;          // camera frames are analysed at most this many px across

const LM = {
  check: false,        // Check mode
  phase: 'choose',
  mode: null,          // 'keep' | 'camera' | 'manual'
  results: {},         // LED -> { st, hold, guess, cam, at, peak, how }
  count: null,         // the strip's LED count (the Pi's map_state)
  cw: 0, ch: 0,        // the camera frame's working size (results' camera px are of this size)
  sel: null,           // { led } | { hold }
  tool: null,          // 'assign': tap the hold for the selected LED
  running: false, paused: null, busyNote: '',
  tgt: null, toBoard: null, off: null, camLocked: false, lockNote: '', camErr: '',
  stream: null, track: null, cv: null, ctx: null, wake: null,
  session: null, seq: 0, first: false, sub: null, waiters: new Map(), lit: [], ping: null, ackAt: 0,
  manualLed: null, last: null,
};

const lmWait = ms => new Promise(r => setTimeout(r, ms));
const lmLockedLeds = () => (BS.live ? BS.live.holds.filter(h => h.kind === 'feet_sign' && h.led != null).map(h => h.led) : []);
const lmEveryHandHasLed = () => bsLiveHand().length > 0 && bsLiveHand().every(h => h.led != null);
const lmMapped = () => LM.mode === 'camera' || LM.mode === 'manual';

// The board picture the mapping lands on: the new cartoon (the draft), or today's (Check).
function lmTgt() {
  const kind = LM.check ? 'current' : 'cartoon', m = BS.img[kind], q = BS.corners[kind];
  if (!m || !q) return null;
  const P = p => [p[0] / 100 * m.w, p[1] / 100 * m.h];
  const holds = LM.check
    ? bsLiveHand().filter(h => h.x != null).map(h => ({ id: h.id, c: P([+h.x, +h.y]), pts: (h.outline || []).map(P) }))
    : BS.shapes.filter(s => s.kind === 'hand').map(s => ({ id: s.id, c: P(bsCentre(s.pts)), pts: s.pts.map(P) }));
  const quad = q.map(P);
  return { kind, m, quad, holds, bw: lmQuadWidth(quad) };
}
const lmCamQuad = () => (BS.corners.camera || []).map(p => [p[0] / 100 * LM.cw, p[1] / 100 * LM.ch]);
const lmTally2 = () => lmTally(LM.results, (LM.tgt || lmTgt() || { holds: [] }).holds.map(h => h.id));
function lmOrder() {
  const locked = lmLockedLeds(), out = [];
  for (let i = 1; i < (LM.count || 248); i++) if (!locked.includes(i)) out.push(i);
  return out;
}

// ── saving (the setup draft, or Check mode's own) ─────────────────────────────
function lmDraftData() {
  return { phase: LM.phase, mode: LM.mode, results: LM.results, count: LM.count, cw: LM.cw, ch: LM.ch };
}
function lmRestore(d) {
  Object.assign(LM, { phase: 'choose', mode: null, results: {}, count: null, cw: 0, ch: 0, sel: null, tool: null, paused: null, tgt: null, toBoard: null, last: null });
  if (!d) return;
  Object.assign(LM, { mode: d.mode || null, results: d.results || {}, count: d.count || null, cw: d.cw || 0, ch: d.ch || 0 });
  if (Object.keys(LM.results).length) LM.phase = 'review';
}
function lmSaveCheck() {
  try {
    localStorage.setItem(LM_CHECK_KEY, JSON.stringify(Object.assign(lmDraftData(), {
      t: Date.now(), corners: { camera: BS.corners.camera || null, current: BS.corners.current || null } })));
  } catch (e) { /* full or blocked: it lives in memory */ }
}
function lmCheckDraft() {
  try { return JSON.parse(localStorage.getItem(LM_CHECK_KEY) || 'null'); } catch (e) { return null; }
}

// ── entry and leaving ─────────────────────────────────────────────────────────
// Check mode, from the start page: today's board, today's LEDs as the answer key.
async function lmStartCheck() {
  if (!BS.live) return;
  lmLeave();
  Object.assign(BS, { img: {}, corners: {}, shapes: [], mirror: null, flags: [], traced: false, pred: {}, undo: [] });
  LM.check = true;
  try {
    const bmp = await bsBitmapFromUrl(BOARD_IMG);
    BS.img.current = { bmp, w: bmp.width, h: bmp.height, path: null };
  } catch (e) {
    LM.check = false;
    showToast('Couldn’t load today’s board picture', 'error');
    return;
  }
  const d = lmCheckDraft();
  lmRestore(d);
  BS.corners.current = (d && d.corners && d.corners.current) || (BS.live.corners && BS.live.corners.image) || null;
  if (d && d.corners && d.corners.camera) BS.corners.camera = d.corners.camera;
  bsGo('leds');
}
// Leaving the step: the board goes back to idle, the camera stops.
function lmLeave() {
  LM.running = false;
  lmResolveAll('stopped');
  lmEndSession();
  lmCamStop();
  LM.manualLed = null; LM.tool = null;
}
function lmExitCheck() {
  lmLeave();
  LM.check = false;
  Object.assign(BS, { img: {}, corners: {} });
  bsGo('start');
}

// ── the Pi (cast contract 11: map_leds out, map_state back) ───────────────────
async function lmSubscribe() {
  if (LM.sub) return true;
  const ch = sb.channel('board:HangoutPortland');
  ch.on('broadcast', { event: 'map_state' }, msg => lmOnState(msg && msg.payload));
  const ok = await new Promise(res => {
    const t = setTimeout(() => res(false), 10000);
    ch.subscribe(s => {
      if (s === 'SUBSCRIBED') { clearTimeout(t); res(true); }
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(t); res(false); }
    });
  });
  if (!ok) { sb.removeChannel(ch).catch(() => {}); return false; }
  LM.sub = ch;
  return true;
}
function lmOnState(b) {
  if (!b || b.session !== LM.session) return;
  if (Number.isInteger(b.count) && b.count > 1) LM.count = b.count;
  const w = LM.waiters.get(b.seq);
  if (w) { LM.waiters.delete(b.seq); w(b.state); return; }
  // not a reply being waited for: a takeover, the night, the Pi letting go
  if (['taken', 'night', 'ended'].includes(b.state) && !LM.running && BS.step === 'leds') {
    LM.paused = b.state;
    lmRenderAll();
  }
}
function lmResolveAll(state) {
  LM.waiters.forEach(w => w(state));
  LM.waiters.clear();
}
function lmBody(extra) {
  return Object.assign({ session: LM.session }, extra, { source: 'phone', signed_in: !!session });
}
// Light these LEDs (white; [] = dark) and wait for the Pi to say what it did:
// lit | taken | night | ended | bad | timeout | error | stopped.
async function lmLight(leds, show) {
  if (!await lmSubscribe()) return 'error';
  if (!LM.session) {
    LM.session = castRunToken(); LM.seq = 0; LM.first = true;
    clearInterval(LM.ping);
    LM.ping = setInterval(lmPing, LM_PING_MS);
  }
  const seq = ++LM.seq, body = lmBody({ seq, leds });
  if (LM.first) body.first = true;
  if (show) body.show = true;
  LM.lit = leds.slice();
  let reply = new Promise(res => LM.waiters.set(seq, res));
  try {
    await channel.httpSend('map_leds', body, { timeout: 8000 });
    LM.first = false;
  } catch (e) {
    console.warn('map_leds not sent', e);
    LM.waiters.delete(seq);
    return 'error';
  }
  let st = await Promise.race([reply, lmWait(LM_ACK_MS).then(() => 'timeout')]);
  while (st === 'waiting') {                   // a circuit run: the Pi says 'lit' when it ends
    LM.paused = 'waiting'; bsRenderPanel();
    reply = new Promise(res => LM.waiters.set(seq, res));
    st = await Promise.race([reply, lmWait(35 * 60000).then(() => 'timeout')]);
    if (LM.paused === 'waiting') LM.paused = null;
  }
  LM.waiters.delete(seq);
  LM.ackAt = performance.now();
  return st;
}
function lmPing() {
  if (!LM.session || LM.running || BS.step !== 'leds' || document.visibilityState !== 'visible') return;
  channel.httpSend('map_leds', lmBody({ seq: ++LM.seq, leds: LM.lit, ping: true }), { timeout: 8000 }).catch(() => {});
}
function lmEndSession() {
  clearInterval(LM.ping); LM.ping = null;
  if (LM.session) {
    channel.httpSend('map_leds', lmBody({ end: true }), { timeout: 8000 }).catch(e => console.warn('map_leds end not sent', e));
  }
  LM.session = null; LM.lit = [];
  if (LM.sub) { sb.removeChannel(LM.sub).catch(() => {}); LM.sub = null; }
}
// After a publish or an undo: the Pi re-reads the holds now, not at its 10-minute refresh.
function lmHoldsChanged() {
  channel.httpSend('holds_changed', { wall: BS_WALL, source: 'phone', signed_in: !!session }, { timeout: 8000 })
    .catch(e => console.warn('holds_changed not sent', e));
}

// ── the camera ────────────────────────────────────────────────────────────────
async function lmCamStart() {
  if (LM.track && LM.track.readyState === 'live') return true;
  LM.camErr = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    LM.camErr = 'This browser can’t use the camera. Map by tapping instead.';
    return false;
  }
  try {
    LM.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    LM.camErr = e && e.name === 'NotAllowedError' ? 'The camera wasn’t allowed. Allow it for this site, or map by tapping.'
      : 'No camera: ' + ((e && e.message) || 'unknown');
    return false;
  }
  LM.track = LM.stream.getVideoTracks()[0];
  LM.camLocked = false; LM.lockNote = '';
  const v = bsEl('bs-video');
  v.muted = true; v.playsInline = true; v.srcObject = LM.stream;
  try { await v.play(); } catch (e) { /* a muted stream normally plays */ }
  for (let i = 0; i < 50 && !v.videoWidth; i++) await lmWait(100);
  if (!v.videoWidth) { LM.camErr = 'The camera didn’t start.'; lmCamStop(); return false; }
  const k = Math.min(1, LM_WORK / Math.max(v.videoWidth, v.videoHeight));
  const cw = Math.round(v.videoWidth * k), ch = Math.round(v.videoHeight * k);
  if (LM.cw && Math.abs(LM.cw / LM.ch - cw / ch) > 0.01) {
    // a different shape of picture: the corners and camera spots from before don't fit it
    delete BS.corners.camera;
    Object.keys(LM.results).forEach(l => { if (LM.results[l].how === 'camera') delete LM.results[l]; });
  } else if (LM.cw && LM.cw !== cw) {
    const f = cw / LM.cw;
    Object.values(LM.results).forEach(r => { if (r.cam) r.cam = r.cam.map(p => [p[0] * f, p[1] * f]); });
  }
  LM.cw = cw; LM.ch = ch;
  LM.cv = document.createElement('canvas');
  LM.cv.width = cw; LM.cv.height = ch;
  LM.ctx = LM.cv.getContext('2d', { willReadFrequently: true });
  lmWakeOn();
  return true;
}
function lmCamStop() {
  if (LM.stream) LM.stream.getTracks().forEach(t => t.stop());
  LM.stream = null; LM.track = null; LM.off = null;
  const v = bsEl('bs-video');
  if (v) { v.srcObject = null; v.hidden = true; }
  lmWakeOff();
}
// Exposure, white balance and focus held where they are (with the board dark), where the
// browser allows: a spot is then the only thing that changes between frames.
async function lmLockCamera() {
  LM.camLocked = true;
  const t = LM.track;
  if (!t || !t.getCapabilities) { LM.lockNote = 'This browser can’t hold the exposure: fine if the light is steady.'; return; }
  const caps = t.getCapabilities(), set = t.getSettings ? t.getSettings() : {}, adv = [], held = [];
  const can = (k, v) => Array.isArray(caps[k]) && caps[k].includes(v);
  if (can('exposureMode', 'manual')) { const c = { exposureMode: 'manual' }; if (set.exposureTime) c.exposureTime = set.exposureTime; adv.push(c); held.push('exposure'); }
  if (can('whiteBalanceMode', 'manual')) { const c = { whiteBalanceMode: 'manual' }; if (set.colorTemperature) c.colorTemperature = set.colorTemperature; adv.push(c); held.push('white balance'); }
  if (can('focusMode', 'manual')) { const c = { focusMode: 'manual' }; if (set.focusDistance) c.focusDistance = set.focusDistance; adv.push(c); held.push('focus'); }
  if (!adv.length) { LM.lockNote = 'This phone can’t hold the exposure from a web page: fine if the light is steady.'; return; }
  try { await t.applyConstraints({ advanced: adv }); LM.lockNote = 'Held: ' + held.join(', ') + '.'; }
  catch (e) { LM.lockNote = 'Couldn’t hold the exposure: fine if the light is steady.'; }
}
async function lmWakeOn() {
  if (LM.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { LM.wake = await navigator.wakeLock.request('screen'); LM.wake.addEventListener('release', () => { LM.wake = null; }); }
  catch (e) { /* refused: it still works while the screen stays on */ }
}
function lmWakeOff() { if (LM.wake) { LM.wake.release().catch(() => {}); LM.wake = null; } }

// The next camera frame (its metadata where the browser gives it), or 150 ms at most: some
// browsers hold the callback back for up to a second after a frame is read.
function lmNextFrame(v) {
  return new Promise(res => {
    const t = setTimeout(() => res(null), v.requestVideoFrameCallback ? 150 : 70);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback((now, md) => { clearTimeout(t); res(md); });
  });
}
// n camera frames captured after `after` (performance.now() time, where the browser says), averaged.
async function lmGrab(n, after) {
  const v = bsEl('bs-video'), frames = [], deadline = performance.now() + 3000;
  while (frames.length < n) {
    const md = await lmNextFrame(v);
    if (md && md.captureTime && after && md.captureTime < after && performance.now() < deadline) continue;
    LM.ctx.drawImage(v, 0, 0, LM.cw, LM.ch);
    frames.push(LM.ctx.getImageData(0, 0, LM.cw, LM.ch).data);
  }
  return lmAverage(frames);
}
async function lmTakeOff() {
  const st = await lmLight([]);
  if (st !== 'lit') return st;
  await lmWait(LM_SETTLE_MS);
  LM.off = await lmGrab(4, LM.ackAt);
  return 'lit';
}
// One LED: light it, find its spot, match it. Someone walking through: a fresh off frame
// and again (three tries), then it's flagged 'busy'.
async function lmMeasure(led) {
  for (let a = 0; a < 3; a++) {
    if (!LM.off) { const s = await lmTakeOff(); if (s !== 'lit') return s; }
    const st = await lmLight([led]);
    if (st !== 'lit') return st;
    await lmWait(LM_SETTLE_MS);
    const det = lmFindSpots(await lmGrab(3, LM.ackAt), LM.off, LM.cw, LM.ch, lmCamQuad());
    LM.last = led;
    if (det.busy && a < 2) { LM.off = null; continue; }
    LM.results[led] = lmClassify(det, LM.toBoard, LM.tgt.holds, LM.tgt.bw);
    return 'lit';
  }
  return 'lit';
}

// ── the run (camera) ──────────────────────────────────────────────────────────
async function lmRun() {
  if (LM.running) return;
  LM.tgt = lmTgt();
  if (!LM.tgt || !BS.corners.camera) return;
  if (!await lmCamStart()) { lmRenderAll(); return; }
  LM.toBoard = lmQuadMap(lmCamQuad(), LM.tgt.quad);
  LM.running = true; LM.paused = null; LM.phase = 'run'; LM.off = null; LM.sel = null;
  bsRender();
  let st = await lmTakeOff();
  if (st === 'lit' && !LM.camLocked) {
    await lmWait(800);                        // auto exposure settles on the dark board first
    await lmLockCamera();
    st = await lmTakeOff();
  }
  let n = 0;
  while (st === 'lit' && LM.running) {
    const led = lmOrder().find(l => !LM.results[l]);
    if (led == null) break;
    st = await lmMeasure(led);
    n++;
    if (st === 'lit' && n % LM_OFF_EVERY === 0) LM.off = null;
    if (n % 5 === 0) bsSave();
    lmRenderAll();
  }
  const stopped = !LM.running;
  LM.running = false;
  if (st !== 'lit') { lmPause(st); return; }
  if (!stopped && lmOrder().every(l => LM.results[l])) { await lmLight([]); lmFinish(); }
  else lmPause('stopped');
}
function lmPause(st) {
  LM.running = false;
  LM.paused = st;
  bsSave();
  lmRenderAll();
}
// The run's done (or stopped to look): refine the camera map, re-match, review.
function lmFinish() {
  LM.tgt = lmTgt();
  if (LM.cw && BS.corners.camera && LM.tgt) {
    const base = lmQuadMap(lmCamQuad(), LM.tgt.quad);
    LM.toBoard = lmRefine(LM.results, base, LM.tgt.holds, LM.tgt.bw);
    lmRematch(LM.results, LM.toBoard, LM.tgt.holds, LM.tgt.bw);
  }
  LM.phase = 'review'; LM.paused = null; LM.sel = null; LM.tool = null; LM.manualLed = null;
  bsSave();
  bsRender();
}
// Review: run one LED again with the camera (the corners from before).
async function lmRerun(led) {
  if (LM.running) return;
  LM.tgt = lmTgt();
  if (!await lmCamStart()) { showToast(LM.camErr, 'error'); return; }
  if (!LM.toBoard) LM.toBoard = lmQuadMap(lmCamQuad(), LM.tgt.quad);
  LM.running = true; LM.busyNote = `Running LED ${led} again…`; bsRenderPanel();
  const prev = LM.results[led];
  delete LM.results[led];
  LM.off = null;
  const st = await lmMeasure(led);
  LM.running = false; LM.busyNote = '';
  if (st !== 'lit') { if (prev && !LM.results[led]) LM.results[led] = prev; lmPause(st); return; }
  await lmLight([led]);
  bsSave();
  lmRenderAll();
}

// ── manual mode (no camera): the Pi lights an LED, tap its hold ───────────────
async function lmManualNext(back) {
  const order = lmOrder();
  if (back) {
    const done = order.filter(l => LM.results[l] && LM.results[l].how === 'tap');
    const prev = LM.manualLed != null ? done.filter(l => l < LM.manualLed).pop() : done.pop();
    if (prev == null) return;
    delete LM.results[prev];
  }
  const led = order.find(l => !LM.results[l]);
  if (led == null) { await lmLight([]); lmFinish(); return; }
  LM.manualLed = led; LM.phase = 'manual';
  lmRenderAll();
  const st = await lmLight([led]);
  if (st !== 'lit') { lmPause(st); return; }
  LM.paused = null;
  lmRenderAll();
}
function lmManualSet(st, hold) {
  const led = LM.manualLed;
  if (led == null) return;
  LM.results[led] = { st, hold: hold || null, how: 'tap' };
  bsSave();
  lmManualNext(false);
}

// ── review edits ──────────────────────────────────────────────────────────────
// The LED goes to this hold (or to none: not a hand hold), whatever the camera said.
function lmGive(led, hold) {
  LM.results[led] = Object.assign({}, LM.results[led] || { how: 'tap' }, { st: hold ? 'tap' : 'skip', hold: hold || null });
  LM.tool = null;
  LM.sel = hold ? { hold } : null;
  bsSave();
  lmRenderAll();
}
// A hold with two LEDs keeps one; the others are set aside (not a hand hold).
function lmKeep(hold, led) {
  (lmTally2().byHold.get(hold) || []).forEach(l => { if (l !== led) LM.results[l] = Object.assign({}, LM.results[l], { st: 'skip', hold: null }); });
  bsSave();
  lmRenderAll();
}
async function lmShow(leds) {
  const st = await lmLight(leds, ['taken', 'ended'].includes(LM.paused));
  if (st !== 'lit') { lmPause(st); return; }
  LM.paused = null;
  lmRenderAll();
}
// The hold a tap is on (picture %), within reach.
function lmHoldAt(x, y) {
  const t = LM.tgt || (LM.tgt = lmTgt());
  if (!t) return null;
  const n = lmNearest([x / 100 * t.m.w, y / 100 * t.m.h], t.holds);
  return n.hold && n.dist <= t.bw * 0.02 ? n.hold.id : null;
}
function lmTap(g) {
  if (LM.phase === 'manual') {
    if (LM.manualLed == null || LM.paused) return;
    const id = lmHoldAt(g.x, g.y);
    if (id) lmManualSet('tap', id);
    return;
  }
  if (LM.phase !== 'review') return;
  const id = lmHoldAt(g.x, g.y);
  if (LM.tool === 'assign' && LM.sel && LM.sel.led != null) {
    if (id) lmGive(LM.sel.led, id);
    return;
  }
  LM.sel = id ? { hold: id } : null;
  LM.tool = null;
  lmRenderAll();
}
// The hand holds' LEDs to publish ({ id: led }), or null unless every hand hold has exactly one.
function lmPublishLeds() {
  if (LM.check || !lmMapped()) return null;
  const t = lmTally2();
  if (t.missing.length || t.clash.length || !t.byHold.size) return null;
  const out = {};
  t.byHold.forEach((l, id) => { out[id] = l[0]; });
  return out;
}
function lmReady() {
  if (!lmMapped()) return LM.mode === 'keep' && lmEveryHandHasLed();
  return !!lmPublishLeds();
}

// ── drawing ───────────────────────────────────────────────────────────────────
function lmRenderAll() { if (BS.step !== 'leds') return; bsDrawImage(); bsRenderBoard(); bsRenderPanel(); lmVideo(); }
function lmVideo() {
  const v = bsEl('bs-video');
  if (!v) return;
  const on = BS.step === 'leds' && !!LM.stream && (LM.phase === 'camera' || LM.phase === 'run');
  v.hidden = !on;
  v.classList.toggle('thumb', LM.phase === 'run');
}
function lmTable() {
  const t = {};
  bsLiveHand().forEach(h => { t[h.id] = h.led; });
  return t;
}
function lmSvg() {
  const t = LM.tgt || (LM.tgt = lmTgt());
  if (!t) return '';
  const tally = lmTally2(), table = LM.check ? lmTable() : null, pct = p => [p[0] / t.m.w * 100, p[1] / t.m.h * 100];
  const lastHold = LM.last != null && LM.results[LM.last] ? LM.results[LM.last].hold : null;
  const selLed = LM.sel && LM.sel.led != null ? LM.results[LM.sel.led] : null;
  let out = '';
  t.holds.forEach(h => {
    if (!h.pts.length) return;
    const leds = tally.byHold.get(h.id) || [];
    let cls = 'bs-s lm-h';
    if (leds.length > 1) cls += ' lm-clash';
    else if (leds.length === 1) cls += table && table[h.id] !== leds[0] ? ' lm-diff' : ' lm-ok';
    else cls += LM.phase === 'review' ? ' lm-none' : ' lm-wait';
    if ((LM.sel && LM.sel.hold === h.id) || (selLed && (selLed.hold === h.id || selLed.guess === h.id))) cls += ' sel';
    if ((LM.phase === 'run' || LM.phase === 'manual') && h.id === lastHold) cls += ' lm-now';
    out += `<path class="${cls}" d="${bsPath(h.pts.map(pct))}"/>`;
  });
  return out;
}
function lmOver() {
  const t = LM.tgt;
  if (!t || !['run', 'review', 'manual'].includes(LM.phase)) return '';
  let html = '';
  const ring = (r, cls) => {
    if (!r || !r.at) return;
    const [x, y] = bsScreen(r.at[0] / t.m.w * 100, r.at[1] / t.m.h * 100);
    html += `<div class="lm-spot ${cls}" style="left:${x}px;top:${y}px"></div>`;
  };
  if (LM.sel && LM.sel.led != null) ring(LM.results[LM.sel.led], 'sel');
  else if (LM.phase === 'run' && LM.last != null) ring(LM.results[LM.last], '');
  if (LM.sel && LM.sel.hold) {
    const h = t.holds.find(x => x.id === LM.sel.hold);
    if (h) {
      const top = h.pts.length ? Math.min(...h.pts.map(p => p[1])) : h.c[1];
      const [x, y] = bsScreen(h.c[0] / t.m.w * 100, top / t.m.h * 100);
      const leds = lmTally2().byHold.get(h.id) || [];
      html += `<div class="bs-label" style="left:${x}px;top:${y}px">${escHtml(bsName(h.id))}${leds.length ? ' · LED ' + leds.join(' + ') : ''}</div>`;
    }
  }
  return html;
}

// ── the panel ─────────────────────────────────────────────────────────────────
const LM_PAUSE_TEXT = {
  taken: 'Someone lit the board (a cast, or someone setting a problem). Take it back when they’re done.',
  ended: 'The board went back to its idle pattern.',
  night: 'The board is off: it’s outside the opening hours. Turn it on with PB Console → Board → Stay on until, then carry on.',
  timeout: 'The board isn’t answering. Is the Pi online and up to date?',
  error: 'Couldn’t reach the board: check the phone’s connection.',
  bad: 'The board refused that LED.',
  waiting: 'A circuit is running on the board: this carries on by itself when it ends.',
  stopped: 'Paused. Carry on where it stopped, or look at what’s done so far.',
};
const LM_ST_TEXT = { ok: 'on a hold', none: 'lit nothing', double: 'two spots', far: 'far from every hold',
                     between: 'between two holds', busy: 'the picture kept changing', tap: 'set by hand', skip: 'not a hand hold' };
const lmTakeBackBtn = act => `<button class="ol-btn ol-publish" data-act="${act}">Take the board back</button>`;

function lmPanel() {
  const order = lmOrder(), doneN = order.filter(l => LM.results[l]).length, has = Object.keys(LM.results).length > 0;
  const pause = LM.paused ? `<div class="lm-note ${LM.paused === 'stopped' ? '' : 'warn'}">${escHtml(LM_PAUSE_TEXT[LM.paused] || LM.paused)}</div>` : '';
  const prog = `<div class="lm-prog"><span style="width:${Math.round(doneN / Math.max(1, order.length) * 100)}%"></span></div>`;
  if (LM.phase === 'choose') {
    if (LM.check) {
      return `<p class="bs-hint"><b>Check mode</b> maps every LED on today’s board and compares it with the LED each hold has now. Nothing is published.</p>
        <p class="bs-hint">Phone on the tripod facing the board, the whole board in the picture. Do it when nobody’s casting: outside the opening hours with PB Console’s Stay on until.</p>
        <div class="ol-row"><button class="ol-btn ol-publish" data-act="lm-mode" data-mode="camera">${has ? 'Carry on with the camera' : 'Use the camera'}</button>
          <button class="ol-btn" data-act="lm-mode" data-mode="manual">Tap each hold</button></div>
        ${has ? '<div class="ol-row"><button class="ol-btn" data-act="lm-review">See the last check</button><button class="ol-btn bs-danger" data-act="lm-clear">Start afresh</button></div>' : ''}
        <div class="ol-row"><button class="ol-btn" data-act="lm-back">Done</button></div>`;
    }
    const all = lmEveryHandHasLed();
    if (!LM.mode && all) LM.mode = 'keep';
    const opt = (mode, title, sub, dis) => `<button class="lm-opt ${LM.mode === mode ? 'on' : ''}" data-act="lm-pick" data-mode="${mode}" ${dis ? 'disabled' : ''}><b>${title}</b><span>${sub}</span></button>`;
    return `${opt('keep', 'Keep today’s LEDs', all ? 'Every hand hold keeps the LED it has. The usual choice.' : 'Not every hand hold has an LED yet.', !all)}
      ${opt('camera', 'Map with the camera', 'Phone on a tripod: the board lights each LED in turn and the camera finds it.')}
      ${opt('manual', 'Map by tapping', 'No camera: the board lights each LED, you tap its hold.')}
      ${lmMapped() && has ? '<div class="ol-row"><button class="ol-btn" data-act="lm-review">See the mapping so far</button></div>' : ''}
      <div class="ol-row"><button class="ol-btn" data-act="prev">Back</button>
        <button class="ol-btn ol-publish" data-act="lm-go" ${LM.mode ? '' : 'disabled'}>${LM.mode === 'keep' ? 'Next' : has ? 'Carry on' : 'Start'}</button></div>`;
  }
  if (LM.phase === 'tcorners') {
    return `<p class="bs-hint">Today’s board picture: drag the four numbered corners onto the board’s corners (1 top left, then clockwise). You’ll mark the same four on the camera’s picture.</p>
      <div class="ol-row"><button class="ol-btn" data-act="lm-choose">Back</button><button class="ol-btn ol-publish" data-act="lm-tdone">Next</button></div>`;
  }
  if (LM.phase === 'camera') {
    return `${LM.camErr ? `<div class="lm-note warn">${escHtml(LM.camErr)}</div>` : ''}
      <p class="bs-hint">Phone on the tripod, the whole board in the picture, nothing in front of it. The board goes dark while this runs.</p>
      <div class="ol-row"><button class="ol-btn" data-act="lm-choose">Back</button>
        ${LM.camErr ? '<button class="ol-btn" data-act="lm-mode" data-mode="manual">Map by tapping</button>' : ''}
        <button class="ol-btn ol-publish" data-act="lm-still" ${LM.stream ? '' : 'disabled'}>Take a still, mark the corners</button></div>`;
  }
  if (LM.phase === 'corners') {
    const photo = !LM.check && BS.corners.photo;
    return `<p class="bs-hint">Drag the four numbered corners onto the board’s corners in the camera’s picture (1 top left, then clockwise): the same corners as on the board picture. Pinch to zoom. Don’t move the phone after this.</p>
      <div class="ol-row">${photo ? '<button class="ol-btn" data-act="lm-photocorners">Use the photo’s corners</button>' : ''}<button class="ol-btn" data-act="lm-camera">Retake the still</button></div>
      <div class="ol-row"><button class="ol-btn" data-act="lm-choose">Back</button><button class="ol-btn ol-publish" data-act="lm-run">${doneN ? 'Carry on mapping' : 'Start mapping'}</button></div>`;
  }
  if (LM.phase === 'run') {
    const t = lmTally2(), cur = LM.last, r = cur != null ? LM.results[cur] : null;
    return `${pause}${prog}
      <div class="bs-status"><span>${doneN} of ${order.length} LEDs</span><span class="ok">${t.done} holds</span>
        <span>${t.none.length} lit nothing</span><span class="${t.flagged.length ? 'bad' : ''}">${t.flagged.length} to check</span></div>
      <p class="bs-hint">${LM.running ? (r ? `LED ${cur}: ${escHtml(LM_ST_TEXT[r.st] || '')}${r.hold ? ', ' + escHtml(bsName(r.hold)) : ''}.` : 'Starting…') : ''}
        ${LM.lockNote ? escHtml(LM.lockNote) : ''}</p>
      <div class="ol-row">${LM.running ? '<button class="ol-btn" data-act="lm-stop">Pause</button>'
        : `${['taken', 'ended'].includes(LM.paused) ? lmTakeBackBtn('lm-takeback') : '<button class="ol-btn ol-publish" data-act="lm-run">Carry on</button>'}
           <button class="ol-btn" data-act="lm-finish">Look at what’s done</button>`}</div>`;
  }
  if (LM.phase === 'manual') {
    const led = LM.manualLed;
    return `${pause}${prog}
      <p class="bs-hint">${led != null ? `<b>LED ${led}</b> is lit, white. Tap its hold on the picture.` : 'Starting…'} ${doneN} of ${order.length} done.</p>
      <div class="ol-row"><button class="ol-btn" data-act="lm-mnone">Nothing lit</button><button class="ol-btn" data-act="lm-mskip">Not a hand hold</button></div>
      <div class="ol-row"><button class="ol-btn" data-act="lm-mback">Back one</button>
        ${['taken', 'ended', 'stopped'].includes(LM.paused) ? lmTakeBackBtn('lm-mretry') : '<button class="ol-btn" data-act="lm-mretry">Light it again</button>'}
        <button class="ol-btn" data-act="lm-finish">Stop and review</button></div>`;
  }
  return pause + lmReviewPanel();
}

function lmReviewPanel() {
  const t = lmTally2(), table = LM.check ? lmTable() : null, total = t.byHold.size;
  let html = `<div class="bs-status"><span class="${t.done === total ? 'ok' : 'bad'}">${t.done}/${total} hand holds have one LED</span>
    <span class="${t.flagged.length ? 'bad' : ''}">${t.flagged.length} LEDs to check</span><span>${t.none.length + t.skipped.length} on no hold</span></div>`;
  if (LM.busyNote) return html + `<p class="bs-hint">${escHtml(LM.busyNote)}</p>`;
  if (table) {
    const c = lmCompare(t.byHold, table);
    html += `<div class="lm-score"><b>${c.same} of ${total}</b> hand holds got the same LED as the table${c.diff.length ? '. Different:' : '.'}</div>`;
    if (c.diff.length) {
      html += `<div class="lm-list">` + c.diff.map(d => `<button class="lm-item" data-act="lm-selhold" data-id="${escAttr(d.id)}">
        <b>${escHtml(bsName(d.id))}</b><span>table ${d.table != null ? d.table : '–'}, mapped ${d.got.length ? d.got.join(' + ') : 'none'}</span></button>`).join('') + `</div>`;
    }
  }
  if (LM.sel && LM.sel.led != null) {
    const led = LM.sel.led, r = LM.results[led] || {};
    html += `<div class="lm-sel"><b>LED ${led}</b>: ${escHtml(LM_ST_TEXT[r.st] || 'not run')}${r.hold ? ', ' + escHtml(bsName(r.hold)) : r.guess ? ', nearest ' + escHtml(bsName(r.guess)) : ''}</div>`;
    html += LM.tool === 'assign'
      ? `<p class="bs-hint">Tap the hold LED ${led} lights.</p><div class="ol-row"><button class="ol-btn" data-act="lm-toolsoff">Cancel</button></div>`
      : `<div class="ol-row"><button class="ol-btn" data-act="lm-light" data-led="${led}">Light it</button>
          ${BS.corners.camera && LM.cw ? `<button class="ol-btn" data-act="lm-rerun" data-led="${led}">Run it again</button>` : ''}
          <button class="ol-btn" data-act="lm-assign">Tap its hold</button>
          ${r.guess && !r.hold ? `<button class="ol-btn" data-act="lm-give" data-led="${led}" data-id="${escAttr(r.guess)}">It’s ${escHtml(bsName(r.guess))}</button>` : ''}
          <button class="ol-btn" data-act="lm-give" data-led="${led}" data-id="">Not a hand hold</button>
          <button class="ol-btn" data-act="lm-desel">Close</button></div>`;
  } else if (LM.sel && LM.sel.hold) {
    const id = LM.sel.hold, leds = t.byHold.get(id) || [];
    html += `<div class="lm-sel"><b>${escHtml(bsName(id))}</b>: ${leds.length ? 'LED ' + leds.join(' + ') : 'no LED'}${table ? `, table ${table[id] != null ? table[id] : '–'}` : ''}</div>
      <div class="ol-row">${leds.length > 1 ? leds.map(l => `<button class="ol-btn" data-act="lm-keep" data-id="${escAttr(id)}" data-led="${l}">Keep ${l}</button>`).join('')
          : leds.map(l => `<button class="ol-btn" data-act="lm-sel" data-led="${l}">LED ${l}…</button>`).join('')}
        ${leds.length ? `<button class="ol-btn" data-act="lm-light" data-led="${leds.join(',')}">Light ${leds.length > 1 ? 'them' : 'it'}</button>` : ''}
        ${table && table[id] != null ? `<button class="ol-btn" data-act="lm-light" data-led="${table[id]}">Light the table’s</button>` : ''}
        <button class="ol-btn" data-act="lm-desel">Close</button></div>
      ${!leds.length ? `<p class="bs-hint">Its LED is probably one that lit nothing or was flagged: open one below, Light it, and if ${escHtml(bsName(id))} lights, Tap its hold.</p>` : ''}`;
  }
  const items = [];
  t.missing.forEach(id => items.push(`<button class="lm-item bad" data-act="lm-selhold" data-id="${escAttr(id)}"><b>${escHtml(bsName(id))}</b><span>no LED</span></button>`));
  t.clash.forEach(id => items.push(`<button class="lm-item bad" data-act="lm-selhold" data-id="${escAttr(id)}"><b>${escHtml(bsName(id))}</b><span>LEDs ${(t.byHold.get(id) || []).join(' + ')}</span></button>`));
  t.flagged.forEach(l => items.push(`<button class="lm-item warn" data-act="lm-sel" data-led="${l}"><b>LED ${l}</b><span>${escHtml(LM_ST_TEXT[LM.results[l].st] || '')}</span></button>`));
  if (items.length) html += `<div class="lm-list">${items.join('')}</div>`;
  const spare = t.none.concat(t.skipped).sort((a, b) => a - b);
  if (spare.length) {
    html += `<details class="lm-more"><summary>${spare.length} LEDs on no hand hold (spares, behind the board, or misses)</summary>
      <div class="lm-chips">${spare.map(l => `<button class="bs-mini" data-act="lm-sel" data-led="${l}">${l}</button>`).join('')}</div></details>`;
  }
  const locked = lmLockedLeds();
  if (locked.length) html += `<p class="bs-hint">The feet signs’ LEDs (${locked.join(', ')}) are never mapped or moved.</p>`;
  const again = `<button class="ol-btn" data-act="lm-again">Map again</button>`;
  if (LM.check) return html + `<div class="ol-row">${again}<button class="ol-btn" data-act="lm-back">Done</button></div>`;
  const ready = lmReady();
  return html + `<div class="ol-row">${again}<button class="ol-btn" data-act="lm-keepall">Keep today’s instead</button></div>
    <div class="ol-row"><button class="ol-btn" data-act="prev">Back</button><button class="ol-btn ol-publish" data-act="next" ${ready ? '' : 'disabled'}>${ready ? 'Next' : 'Fix the red ones first'}</button></div>`;
}

// ── actions (setup.js's panel handler passes lm-* here) ───────────────────────
async function lmAct(act, b) {
  const d = b.dataset || {}, led = d.led != null && d.led !== '' && !String(d.led).includes(',') ? +d.led : null;
  switch (act) {
    case 'lm-back': if (LM.check) lmExitCheck(); else bsGo('review'); return;
    case 'lm-pick': LM.mode = d.mode; bsRenderPanel(); return;
    case 'lm-go': if (LM.mode === 'keep') { bsNext(); return; } return lmAct('lm-mode', { dataset: { mode: LM.mode } });
    case 'lm-mode':
      LM.mode = d.mode;
      if (LM.check && !BS.corners.current) { BS.corners.current = [[4, 4], [96, 4], [96, 96], [4, 96]]; LM.phase = 'tcorners'; bsRender(); return; }
      if (LM.mode === 'camera') return lmAct('lm-camera', {});
      LM.phase = 'manual'; LM.tgt = lmTgt(); LM.paused = null; bsRender(); lmWakeOn(); lmManualNext(false); return;
    case 'lm-tdone': LM.tgt = null; bsSave(); return lmAct('lm-mode', { dataset: { mode: LM.mode || 'camera' } });
    case 'lm-choose': lmLeave(); LM.phase = 'choose'; LM.paused = null; bsRender(); return;
    case 'lm-keepall': lmLeave(); LM.mode = 'keep'; LM.phase = 'choose'; bsSave(); bsRender(); return;
    case 'lm-review': lmFinish(); return;
    case 'lm-clear': LM.results = {}; bsSave(); bsRenderPanel(); return;
    case 'lm-camera':
      LM.phase = 'camera'; bsRender();
      await lmCamStart();
      lmRenderAll();
      if (LM.stream) lmLight([]);              // the board dark while the phone is set up
      return;
    case 'lm-still': {
      if (!LM.ctx) return;
      LM.ctx.drawImage(bsEl('bs-video'), 0, 0, LM.cw, LM.ch);
      const bmp = await createImageBitmap(LM.cv);
      BS.img.camera = { bmp, w: LM.cw, h: LM.ch, path: null, id: 'cam' + Date.now() };
      if (!BS.corners.camera) BS.corners.camera = [[6, 6], [94, 6], [94, 94], [6, 94]];
      LM.phase = 'corners';
      bsRender(); lmVideo();
      requestAnimationFrame(() => bsLayout(false));
      return;
    }
    case 'lm-photocorners': BS.corners.camera = BS.corners.photo.map(p => p.slice()); bsSave(); bsRenderBoard(); return;
    case 'lm-run': bsSave(); LM.paused = null; return lmRun();
    case 'lm-stop': LM.running = false; lmResolveAll('stopped'); return;
    case 'lm-takeback': {
      const st = await lmLight(LM.lit, true);
      if (st !== 'lit') { lmPause(st); return; }
      LM.paused = null; LM.off = null;
      return lmRun();
    }
    case 'lm-finish': LM.running = false; lmResolveAll('stopped'); LM.manualLed = null; await lmLight([]); lmFinish(); return;
    case 'lm-again': LM.results = {}; LM.sel = null; bsSave(); return lmAct('lm-mode', { dataset: { mode: LM.mode === 'manual' ? 'manual' : 'camera' } });
    case 'lm-mnone': return lmManualSet('none');
    case 'lm-mskip': return lmManualSet('skip');
    case 'lm-mback': return lmManualNext(true);
    case 'lm-mretry': {
      if (LM.manualLed == null) return lmManualNext(false);
      const st = await lmLight([LM.manualLed], true);
      if (st !== 'lit') { lmPause(st); return; }
      LM.paused = null; lmRenderAll(); return;
    }
    case 'lm-sel': LM.sel = { led }; LM.tool = null; lmRenderAll(); return;
    case 'lm-selhold': {
      LM.sel = { hold: d.id }; LM.tool = null;
      const t = LM.tgt || (LM.tgt = lmTgt()), h = t && t.holds.find(x => x.id === d.id);
      if (h) bsZoomTo(h.c[0] / t.m.w * 100, h.c[1] / t.m.h * 100, 3);
      lmRenderAll(); return;
    }
    case 'lm-desel': LM.sel = null; LM.tool = null; lmRenderAll(); return;
    case 'lm-toolsoff': LM.tool = null; bsRenderPanel(); return;
    case 'lm-light': return lmShow(String(d.led).split(',').map(Number));
    case 'lm-rerun': return lmRerun(led);
    case 'lm-assign': LM.tool = 'assign'; bsRenderPanel(); return;
    case 'lm-give': lmGive(led, d.id || null); return;
    case 'lm-keep': lmKeep(d.id, led); return;
  }
}

// Wiring (bsWire calls it): leaving the view, or the app going to the background, lets the
// board go and stops the camera; coming back offers to carry on.
function lmWire() {
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#setup')) return;
    lmLeave();
    if (LM.check) { LM.check = false; Object.assign(BS, { img: {}, corners: {} }); BS.step = 'start'; }
  });
  document.addEventListener('visibilitychange', () => {
    if (BS.step !== 'leds') return;
    if (document.visibilityState === 'hidden') {
      const was = LM.phase;
      lmLeave();
      if (was === 'run' || was === 'manual') { LM.paused = 'stopped'; bsSave(); }
    } else {
      if (LM.phase === 'camera' || LM.phase === 'run') lmCamStart().then(() => { lmRenderAll(); if (LM.phase === 'camera' && LM.stream) lmLight([]); });
      else lmRenderAll();
    }
  });
}
