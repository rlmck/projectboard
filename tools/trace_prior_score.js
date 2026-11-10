#!/usr/bin/env node
// Scores the prior-guided trace of board setup (app/setup.js bsTraceData: trace.js's
// traceHolds, the match, then tracePriorFit for every hand hold) and the Review's
// Tap to trace (trace.js traceTap), headlessly: the very same code the phone runs.
//
//   node tools/trace_prior_score.js                 # the synthetic test (below); exits 1 if it fails
//   node tools/trace_prior_score.js --cartoon trace-input/cartoon.png \
//        --lineup "A11:7.7,12.2;S10:93.5,13.7;Q1:84.4,74.1;C1:17.6,74.5"
//                                                    # a real cartoon: four hand holds (name: x%, y% on the cartoon)
//   ... --json out.json    # the result shapes (% of the cartoon) for a look
//   ... --blind            # also report the blind trace + match alone (the flow before the prior)
//
// Today's board is the bundled snapshot (app/hold_map.json, hold_shapes.json: the live
// board until a publish). The synthetic test needs no private pictures: it makes a fake
// "new cartoon" from app/board-fallback.jpg: a mild global warp, each hold redrawn with
// a small jitter (shift, scale), two holds turned in place (18° and -22°); the truth is
// today's hand-traced outlines moved the same way. It passes if both turned holds are
// flagged or changed, at least 180 unchanged holds are accepted with a median IoU >= 0.91
// against the truth, and no shape is merged. Needs Python with Pillow (image decoding).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const NL = String.fromCharCode(10);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

global.document = undefined;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app', 'trace.js'), 'utf8'), { filename: 'trace.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app', 'setup.js'), 'utf8'), { filename: 'setup.js' });
const BSX = vm.runInThisContext('BS');

// ── images ────────────────────────────────────────────────────────────────────
function decode(file, max) {
  const py = 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\n'
    + 'k=float(sys.argv[2])/max(im.size)\nim=im.resize((round(im.width*k),round(im.height*k)),Image.BICUBIC) if k>0 else im\n'
    + 'sys.stdout.write("%d %d\\n"%im.size); sys.stdout.flush(); sys.stdout.buffer.write(im.tobytes())';
  const raw = execFileSync('python', ['-c', py, file, String(max || 0)], { maxBuffer: 1 << 28 });
  const nl = raw.indexOf(10);
  const [W, H] = raw.slice(0, nl).toString().split(' ').map(Number);
  return { data: new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset + nl + 1, raw.byteOffset + nl + 1 + W * H * 4)), width: W, height: H };
}
// RGBA pixels -> resized RGBA (through Python, as the app's canvas would)
function resize(img, max) {
  const py = 'import sys\nfrom PIL import Image\nw,h=int(sys.argv[1]),int(sys.argv[2])\nim=Image.frombytes("RGBA",(w,h),sys.stdin.buffer.read())\n'
    + 'k=float(sys.argv[3])/max(im.size)\nim=im.resize((round(w*k),round(h*k)),Image.BICUBIC)\n'
    + 'sys.stdout.write("%d %d\\n"%im.size); sys.stdout.flush(); sys.stdout.buffer.write(im.tobytes())';
  const raw = execFileSync('python', ['-c', py, String(img.width), String(img.height), String(max)], { input: Buffer.from(img.data.buffer), maxBuffer: 1 << 28 });
  const nl = raw.indexOf(10);
  const [W, H] = raw.slice(0, nl).toString().split(' ').map(Number);
  return { data: new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset + nl + 1, raw.byteOffset + nl + 1 + W * H * 4)), width: W, height: H };
}

// ── today's board (the bundled snapshot of the live one) ─────────────────────
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_map.json'), 'utf8'));
const SHAPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_shapes.json'), 'utf8'));
const SMOOTH = (SHAPES.__meta && SHAPES.__meta.smooth) || 0.7;
global.shapeSmooth = () => SMOOTH;
const gridName = id => { const n = +id.slice(4) - 1; return 'ABCDEFGHIJKLMNOPQRS'[n % 19] + (Math.floor(n / 19) + 1); };
const HOLDS = Object.keys(SHAPES).filter(k => k !== '__meta' && MAP[k]).map(id => ({
  id, name: gridName(id), kind: 'hand', led: 0, x: MAP[id].x, y: MAP[id].y, outline: SHAPES[id], mirror: null,
}));
const byName = n => HOLDS.find(h => h.name === n);

// ── the flow, as the phone runs it ────────────────────────────────────────────
// img: the cartoon at its stored size; lineup: [{ id, x, y }] (cartoon %).
function runFlow(img, lineup, prior) {
  const work = resize(img, TRACE_WORK);
  Object.assign(BSX, {
    live: { holds: prior ? HOLDS : HOLDS.map(h => Object.assign({}, h, { outline: null })), corners: null, versions: [] },
    img: { cartoon: { w: img.width, h: img.height } },
    corners: { cartoon: [[0.3, 0.3], [99.7, 0.3], [99.7, 99.7], [0.3, 99.7]] },
    lineup: { cur: lineup.map(l => l.id), cart: lineup.map(l => [l.x, l.y]) },
  });
  const t0 = Date.now();
  const res = vm.runInThisContext('bsTraceData')(work.data ? { data: work.data, width: work.width, height: work.height } : work, work.width, work.height);
  return { res, work, ms: Date.now() - t0 };
}

// ── scoring ───────────────────────────────────────────────────────────────────
const pct2px = (pts, w, h) => pts.map(p => [p[0] / 100 * w, p[1] / 100 * h]);
const med = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const q = (a, f) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) * f)] : NaN; };

// Each hold's reference outline (px of the work image): the truth, or today's mapped.
function refOf(truth, W, H) {
  const cache = {};
  return id => cache[id] || (cache[id] = truth ? truth[id]
    : traceCurve(SHAPES[id], SMOOTH).map(p => { const c = bsXfApply(BSX.xf, p[0], p[1]); return [c[0] / 100 * W, c[1] / 100 * H]; }));
}
// truth: { id -> pts (px of the work image) } or null (a real cartoon: today's mapped)
function report(label, out, truth, opts = {}) {
  const { work } = out, W = work.width, H = work.height;
  const shapes = BSX.shapes, st = BSX.stats || {};
  const hand = shapes.filter(s => s.kind === 'hand');
  const ref = refOf(truth, W, H);
  const rows = hand.map(s => ({ s, iou: tracePolyIoU(pct2px(s.pts, W, H), ref(s.id)) }));
  const accepted = rows.filter(r => !r.s.chk), flagged = rows.filter(r => r.s.chk === 'flag'), changed = rows.filter(r => r.s.chk === 'changed');
  const feet = shapes.filter(s => s.kind === 'foot'), extras = shapes.filter(s => s.kind === 'extra');
  const missing = HOLDS.length - new Set(hand.map(s => s.id)).size;
  // merged: one shape over two holds' reference outlines
  let merged = 0;
  const mergedNames = [];
  shapes.forEach(s => {
    const p = pct2px(s.pts, W, H), bb = traceBBox(p);
    const over = HOLDS.filter(h => { const b = traceBBox(ref(h.id)); return !(b[2] < bb[0] || b[0] > bb[2] || b[3] < bb[1] || b[1] > bb[3]) && tracePolyCover(ref(h.id), p) > 0.5; });
    if (over.length > 1) { merged++; mergedNames.push(over.map(h => h.name).join('+') + ' (' + (s.kind === 'hand' ? gridName(s.id) : s.kind) + ')'); }
  });
  const est = flagged.length * 2 + changed.length * 1 + (feet.some(s => s.chk === 'cand') ? 1 : 0);
  console.log(`\n${label}`);
  console.log('  trace %d ms, prior %d ms, total %d ms (laptop, Node)', out.res.ms, st.ms || 0, out.ms);
  console.log('  hand holds %d: auto-accepted %d (traced %d, fitted %d), to check %d (flagged %d, changed %d), missing %d; merged shapes %d',
    HOLDS.length, accepted.length, st.traced, st.fitted, flagged.length + changed.length, flagged.length, changed.length, missing, merged);
  console.log('  footholds %d (candidates %d), extras %d, dropped %d; Review actions about %d',
    feet.length, feet.filter(s => s.chk === 'cand').length, extras.length, st.dropped, est);
  console.log('  IoU vs %s: accepted median %s (p10 %s), < 0.8: %d; all hand median %s',
    truth ? 'truth' : 'today\'s mapped outline', med(accepted.map(r => r.iou)).toFixed(3), q(accepted.map(r => r.iou), 0.1).toFixed(3),
    accepted.filter(r => r.iou < 0.8).length, med(rows.map(r => r.iou)).toFixed(3));
  const show = r => `${gridName(r.s.id)} (${r.s.chk || r.s.src}, turn ${r.s.fit.turn}°, scale ${r.s.fit.grow}, fit ${r.s.fit.score}, traced IoU ${r.s.fit.iou}, IoU ${r.iou.toFixed(2)})`;
  if (mergedNames.length) console.log('  merged: ' + mergedNames.join(', '));
  if (flagged.length) console.log('  flagged: ' + flagged.map(show).join('; '));
  if (changed.length) console.log('  changed: ' + changed.map(show).join('; '));
  if (opt('--drift')) fs.writeFileSync(opt('--drift'), 'hold,src,chk,turn,scale,score,tracedIoU,turnGain,turnShape,iouRef' + NL + rows.map(r =>
    [gridName(r.s.id), r.s.src, r.s.chk || '', r.s.fit.turn, r.s.fit.grow, r.s.fit.score, r.s.fit.iou, r.s.fit.gain, r.s.fit.shape, r.iou.toFixed(3)].join(',')).join(NL));
  if (opts.worst) rows.filter(r => !r.s.chk).sort((a, b) => a.iou - b.iou).slice(0, opts.worst).forEach(r => console.log('    worst ' + show(r)));
  return { rows, accepted, flagged, changed, merged, missing, feet, extras, est };
}

// The blind flow (2a): the trace + match only, as Review got it before the prior.
function reportBlind(img, lineup, truth) {
  const out = runFlow(img, lineup, false), W = out.work.width, H = out.work.height;
  const shapes = BSX.shapes, hand = shapes.filter(s => s.kind === 'hand');
  const ref = refOf(truth, W, H);
  const missing = HOLDS.filter(h => !hand.some(s => s.id === h.id));
  const ious = hand.map(s => ({ id: s.id, v: tracePolyIoU(pct2px(s.pts, W, H), ref(s.id)) }));
  let merged = 0;
  shapes.forEach(s => { const p = pct2px(s.pts, W, H); if (HOLDS.filter(h => tracePolyCover(ref(h.id), p) > 0.5).length > 1) merged++; });
  const extras = shapes.filter(s => s.kind === 'extra');
  // an extra: a foothold if it's as small as one and not over a hand hold, else a stray
  const strays = extras.filter(s => HOLDS.some(h => tracePolyCover(pct2px(s.pts, W, H), ref(h.id)) > 0.3));
  const low = ious.filter(r => r.v < 0.8);
  const est = missing.length * 3 + merged * 2 + strays.length * 2 + low.filter(r => r.v < 0.6).length * 3 + 1;
  console.log('\nBlind trace + match (the flow before this session)');
  console.log('  trace %d ms; shapes %d; hand holds with no shape %d; merged shapes %d; IoU < 0.8 against %s: %d (median %s)',
    out.res.ms, shapes.length, missing.length, merged, truth ? 'the truth' : 'today\'s outline mapped', low.length, med(ious.map(r => r.v)).toFixed(3));
  console.log('  extras %d: %d over a hand hold (strays/fragments), %d elsewhere (footholds, mostly); Review actions about %d',
    extras.length, strays.length, extras.length - strays.length, est);
  if (missing.length) console.log('  no shape: ' + missing.map(h => h.name).join(' '));
  return { missing: missing.length, merged, low: low.length, extras: extras.length, strays: strays.length, est, xf: BSX.xf };
}

// Tap to trace at each hand hold's centroid (truth or today's mapped).
function tapScore(label, out, truth) {
  const W = out.work.width, H = out.work.height, masks = BSX.masks, v = [], fails = [];
  const t0 = Date.now();
  HOLDS.forEach(h => {
    const ref = truth ? truth[h.id] : pct2px(BSX.fits[h.id], W, H);
    const c = tracePolyCentre(ref);
    const pts = traceTap(masks, c[0], c[1], { maxArea: tracePolyArea(ref) * 3 });
    const iou = pts ? tracePolyIoU(pts, ref) : 0;
    v.push(iou);
    if (iou < 0.7) fails.push(`${h.name} ${iou.toFixed(2)}`);
  });
  console.log(`\nTap to trace, ${label}: ${HOLDS.length} taps in ${Date.now() - t0} ms; IoU median ${med(v).toFixed(3)}, p10 ${q(v, 0.1).toFixed(3)}; >= 0.8: ${v.filter(x => x >= 0.8).length}, 0.7-0.8: ${v.filter(x => x >= 0.7 && x < 0.8).length}, < 0.7: ${fails.length}`);
  if (fails.length) console.log('  below 0.7: ' + fails.join(', '));
  return { median: med(v), fails: fails.length };
}

// ── the synthetic cartoon ─────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

function synthetic() {
  const src = decode(path.join(ROOT, 'app', 'board-fallback.jpg'), 0);
  const W = src.width, H = src.height, S = src.data, r = rng(13);
  // the global warp, output -> source (mild: a skew, a bow, a little scale)
  const Ginv = (x, y) => { const u = x / W, v = y / H;
    return [W * (0.012 + 0.975 * u + 0.012 * v + 0.012 * u * v - 0.01 * v * v), H * (0.01 + 0.98 * v - 0.012 * u + 0.015 * u * u)]; };
  const G = (x, y) => {           // source -> output, by Newton on Ginv
    let p = [x, y];
    for (let k = 0; k < 20; k++) {
      const g = Ginv(p[0], p[1]), e = 0.5;
      const gx = Ginv(p[0] + e, p[1]), gy = Ginv(p[0], p[1] + e);
      const J = [(gx[0] - g[0]) / e, (gy[0] - g[0]) / e, (gx[1] - g[1]) / e, (gy[1] - g[1]) / e];
      const det = J[0] * J[3] - J[1] * J[2], fx = g[0] - x, fy = g[1] - y;
      p = [p[0] - (J[3] * fx - J[1] * fy) / det, p[1] - (-J[2] * fx + J[0] * fy) / det];
    }
    return p;
  };
  // the holds (source px), their masks grown a few px (outline and shadow), and how each moves
  const holds = HOLDS.map(h => {
    const pts = pct2px(traceCurve(SHAPES[h.id], SMOOTH), W, H), bb = traceBBox(pts);
    const x0 = Math.floor(bb[0]) - 6, y0 = Math.floor(bb[1]) - 6, w = Math.ceil(bb[2]) - x0 + 7, hh = Math.ceil(bb[3]) - y0 + 7;
    let m = traceRaster(pts, x0, y0, w, hh);
    for (let k = 0; k < 4; k++) m = traceDilate(m, w, hh);
    const elong = (bb[2] - bb[0]) / (bb[3] - bb[1]);
    return { h, pts, c: tracePolyCentre(pts), x0, y0, w, hh, m, elong: Math.max(elong, 1 / elong),
             dx: gauss(r) * 0.0035 * W, dy: gauss(r) * 0.0035 * W, s: 1 + gauss(r) * 0.025, rot: 0 };
  });
  // two holds turned in place: elongated ones, well inside the board
  const pick = holds.filter(o => o.elong > 1.8 && o.c[0] > W * 0.15 && o.c[0] < W * 0.85 && o.c[1] > H * 0.15 && o.c[1] < H * 0.85)
    .sort((a, b) => a.h.id.localeCompare(b.h.id, 'en', { numeric: true }));
  const turned = [pick[3], pick[Math.floor(pick.length * 0.6)]];
  turned[0].rot = 18; turned[1].rot = -22;
  turned.forEach(o => { o.dx = 0; o.dy = 0; o.s = 1; });
  // the background with the holds taken out (filled in from round about, onion-peel)
  const bg = new Float32Array(W * H * 3), hole = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { bg[i * 3] = S[i * 4]; bg[i * 3 + 1] = S[i * 4 + 1]; bg[i * 3 + 2] = S[i * 4 + 2]; }
  holds.forEach(o => { for (let y = 0; y < o.hh; y++) for (let x = 0; x < o.w; x++) {
    const X = o.x0 + x, Y = o.y0 + y; if (X >= 0 && Y >= 0 && X < W && Y < H && o.m[y * o.w + x]) hole[Y * W + X] = 1; } });
  let todo = [];
  for (let i = 0; i < W * H; i++) if (hole[i]) todo.push(i);
  while (todo.length) {
    const next = [], fill = [];
    todo.forEach(i => {
      const x = i % W; let n = 0, a = 0, b = 0, c = 0;
      [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W].forEach(j => { if (j >= 0 && j < W * H && !hole[j]) { n++; a += bg[j * 3]; b += bg[j * 3 + 1]; c += bg[j * 3 + 2]; } });
      if (n) fill.push([i, a / n, b / n, c / n]); else next.push(i);
    });
    if (!fill.length) break;
    fill.forEach(([i, a, b, c]) => { bg[i * 3] = a; bg[i * 3 + 1] = b; bg[i * 3 + 2] = c; hole[i] = 0; });
    todo = next;
  }
  // render: the background through the warp, then each hold moved (jitter, turn) and warped
  const out = new Uint8ClampedArray(W * H * 4);
  const sample = (arr, stride, x, y, ch) => {           // bilinear
    x = Math.max(0, Math.min(W - 1.001, x)); y = Math.max(0, Math.min(H - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = (y0 * W + x0) * stride + ch;
    return arr[i] * (1 - fx) * (1 - fy) + arr[i + stride] * fx * (1 - fy) + arr[i + W * stride] * (1 - fx) * fy + arr[i + W * stride + stride] * fx * fy;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sx, sy] = Ginv(x + 0.5, y + 0.5), i = (y * W + x) * 4;
    for (let ch = 0; ch < 3; ch++) out[i + ch] = sample(bg, 3, sx - 0.5, sy - 0.5, ch);
    out[i + 3] = 255;
  }
  const truth = {};
  const local = (o, p) => { const cs = Math.cos(o.rot * Math.PI / 180) * o.s, sn = Math.sin(o.rot * Math.PI / 180) * o.s;
    const ux = p[0] - o.c[0], uy = p[1] - o.c[1]; return [o.c[0] + o.dx + cs * ux - sn * uy, o.c[1] + o.dy + sn * ux + cs * uy]; };
  const localInv = (o, p) => { const cs = Math.cos(-o.rot * Math.PI / 180) / o.s, sn = Math.sin(-o.rot * Math.PI / 180) / o.s;
    const ux = p[0] - o.c[0] - o.dx, uy = p[1] - o.c[1] - o.dy; return [o.c[0] + cs * ux - sn * uy, o.c[1] + sn * ux + cs * uy]; };
  holds.forEach(o => {
    const corners = [[o.x0, o.y0], [o.x0 + o.w, o.y0], [o.x0 + o.w, o.y0 + o.hh], [o.x0, o.y0 + o.hh]].map(p => G(...local(o, p)));
    const bb = traceBBox(corners);
    for (let y = Math.max(0, Math.floor(bb[1]) - 2); y < Math.min(H, Math.ceil(bb[3]) + 2); y++) {
      for (let x = Math.max(0, Math.floor(bb[0]) - 2); x < Math.min(W, Math.ceil(bb[2]) + 2); x++) {
        const [sx, sy] = localInv(o, Ginv(x + 0.5, y + 0.5));
        const mx = Math.floor(sx) - o.x0, my = Math.floor(sy) - o.y0;
        if (mx < 0 || my < 0 || mx >= o.w || my >= o.hh || !o.m[my * o.w + mx]) continue;
        const i = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) out[i + ch] = sample(S, 4, sx - 0.5, sy - 0.5, ch);
      }
    }
    truth[o.h.id] = o.pts.map(p => G(...local(o, p)));
  });
  return { img: { data: out, width: W, height: H }, truth, turned: turned.map(o => o.h.id), G };
}

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const json = opt('--json');
  if (opt('--cartoon')) {
    const img = decode(opt('--cartoon'), BS_CARTOON_MAX);
    const lineup = (opt('--lineup') || '').split(';').filter(Boolean).map(t => {
      const [n, xy] = t.split(':'), [x, y] = xy.split(',').map(Number), h = byName(n.trim());
      if (!h) throw new Error('no hold ' + n);
      return { id: h.id, x, y };
    });
    if (lineup.length !== 4) throw new Error('--lineup needs four holds');
    console.log('cartoon %s, %d × %d (stored size); line-up %s', opt('--cartoon'), img.width, img.height, lineup.map(l => gridName(l.id)).join(' '));
    if (args.includes('--blind')) reportBlind(img, lineup, null);
    const out = runFlow(img, lineup, true);
    report('Prior-guided trace', out, null, { worst: +opt('--worst') || 0 });
    tapScore('at each hold\'s fitted centroid', out, null);
    if (json) fs.writeFileSync(json, JSON.stringify({ w: img.width, h: img.height, shapes: BSX.shapes, fits: BSX.fits }));
    return;
  }
  const syn = synthetic();
  if (opt('--save')) {
    execFileSync('python', ['-c', 'import sys\nfrom PIL import Image\nw,h=int(sys.argv[1]),int(sys.argv[2])\nImage.frombytes("RGBA",(w,h),sys.stdin.buffer.read()).convert("RGB").save(sys.argv[3])',
      String(syn.img.width), String(syn.img.height), opt('--save')], { input: Buffer.from(syn.img.data.buffer) });
  }
  console.log('synthetic cartoon from board-fallback.jpg (%d × %d): turned %s', syn.img.width, syn.img.height,
    syn.turned.map((id, i) => `${gridName(id)} ${i ? -22 : 18}°`).join(', '));
  // the line-up: four holds near the corners, tapped up to ±0.3% off their true centres
  const r = rng(7);
  const four = ['A11', 'S10', 'Q1', 'C1'].map(n => byName(n)).map(h => {
    const c = tracePolyCentre(syn.truth[h.id]);
    return { id: h.id, x: c[0] / syn.img.width * 100 + (r() - 0.5) * 0.6, y: c[1] / syn.img.height * 100 + (r() - 0.5) * 0.6 };
  });
  const out = runFlow(syn.img, four, true);
  const k = out.work.width / syn.img.width, truth = {};
  Object.keys(syn.truth).forEach(id => { truth[id] = syn.truth[id].map(p => [p[0] * k, p[1] * k]); });
  const rep = report('Prior-guided trace', out, truth, { worst: +opt('--worst') || 0 });
  const tap = tapScore('at each true centroid', out, truth);
  const turnedOk = syn.turned.every(id => rep.rows.some(x => x.s.id === id && x.s.chk));
  const unchanged = rep.accepted.filter(x => !syn.turned.includes(x.s.id));
  const pass = turnedOk && unchanged.length >= 180 && med(unchanged.map(x => x.iou)) >= 0.91 && rep.merged === 0 && rep.missing === 0;
  console.log('\nturned holds flagged or changed: %s; unchanged auto-accepted %d (>= 180), median IoU %s (>= 0.91); merged %d (0); Review actions about %d',
    turnedOk ? 'yes' : 'NO', unchanged.length, med(unchanged.map(x => x.iou)).toFixed(3), rep.merged, rep.est);
  if (args.includes('--blind')) reportBlind(syn.img, four, truth);
  if (json) fs.writeFileSync(json, JSON.stringify({ w: syn.img.width, h: syn.img.height, shapes: BSX.shapes, fits: BSX.fits }));
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
}
if (require.main === module) main();
else module.exports = { runFlow, decode, HOLDS, byName, pct2px, BSX };
