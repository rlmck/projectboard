#!/usr/bin/env node
// Tests the hold editor's pure parts (app/holdedit.js, with app/trace.js and app/setup.js,
// the same code the app runs) in Node:
//   1 turning a hold's pixels: +θ then −θ (two real resamples) against the original,
//     for several angles and holds; a draft that nets to 0° gives back the original exactly;
//   2 the background fill: a fake hold cut out of plain background (pink, white, black and
//     across stripe edges) and filled, against what was there;
//   3 the mirror rule: a hold's partner turns the other way; a centre-line hand hold and
//     an unpaired foothold turn alone; a suggested partner is always a foothold;
//   4 hit-testing and the bounded Tap to trace: a foothold right beside a hand hold can be
//     traced and picked, and the trace never takes over the hand hold.
//
//   node tools/holdedit_score.js                      # app/board-fallback.jpg + app/hold_shapes.json
//   node tools/holdedit_score.js --image <jpg> --holds <json>   # a board + its holds rows
//        ({ holds: [{ id, name, kind, x, y, outline, mirror }], bc: { corners } }), e.g. the live board
//   node tools/holdedit_score.js ... --crops <dir>    # before/after crops (PNG) for a look
//   node tools/holdedit_score.js ... --feet "x,y;x,y" # footholds to tap-trace (px of the image)
// Needs Python with Pillow (decode/encode). Exits 1 if a check fails.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

// the app's scripts, with just enough of a browser for setup.js and holdedit.js to load
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { getElementById: () => null, querySelector: () => null };
global.showToast = () => {};
global.requestAnimationFrame = f => setTimeout(f, 0);
['trace.js', 'setup.js', 'holdedit.js'].forEach(f => vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'), { filename: f }));

const imgPath = opt('--image') || path.join(ROOT, 'app', 'board-fallback.jpg');
const py = 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\n'
  + 'sys.stdout.write("%d %d\\n"%im.size); sys.stdout.flush(); sys.stdout.buffer.write(im.tobytes())';
const raw = execFileSync('python', ['-c', py, imgPath], { maxBuffer: 1 << 28 });
const nl = raw.indexOf(10);
const [W, H] = raw.slice(0, nl).toString().split(' ').map(Number);
const data = new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset + nl + 1, raw.byteOffset + nl + 1 + W * H * 4));
const img = { data, width: W, height: H };

// the holds: rows as the app reads them (the holds table), or the bundled snapshot
let rows, corners = null;
if (opt('--holds')) {
  const j = JSON.parse(fs.readFileSync(opt('--holds'), 'utf8'));
  rows = j.holds; corners = j.bc && j.bc.corners;
} else {
  const shapes = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_shapes.json'), 'utf8'));
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_map.json'), 'utf8'));
  const mir = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'mirror_map.json'), 'utf8'));
  rows = Object.keys(shapes).filter(k => k !== '__meta').map(id => ({
    id, name: id, kind: 'hand', x: map[id] ? map[id].x : 0, y: map[id] ? map[id].y : 0, outline: shapes[id], mirror: mir[id] || id,
  }));
}
const smooth = 0.4;
const curvePx = pts => traceCurve(pts.map(p => [p[0] / 100 * W, p[1] / 100 * H]), smooth);
const usable = rows.filter(h => (h.kind === 'hand' || h.kind === 'foot') && Array.isArray(h.outline) && h.outline.length >= 3);
const polys = new Map(usable.map(h => [h.id, curvePx(h.outline)]));
const pal = hePalette(data, W, H);
console.log(`image ${path.basename(imgPath)} ${W}×${H}; ${usable.length} holds with outlines; palette ${pal.map(p => p.map(Math.round).join('/')).join(', ')}`);

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

// the local background classes round a hold (which colours its region borders on)
function ringClasses(poly) {
  const bb = traceBBox(poly), cls = new Map();
  for (let k = 0; k < 64; k++) {
    const a = k / 64 * Math.PI * 2, c = tracePolyCentre(poly);
    const r = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 10;
    const x = Math.round(c[0] + Math.cos(a) * r), y = Math.round(c[1] + Math.sin(a) * r);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const j = (y * W + x) * 4, cl = heBgClass(data[j], data[j + 1], data[j + 2], pal);
    if (cl >= 0) cls.set(cl, (cls.get(cl) || 0) + 1);
  }
  return cls;
}
const others = id => usable.filter(h => h.id !== id).map(h => polys.get(h.id));
function diffIn(a, b, poly, grow) {
  const bb = traceBBox(poly), x0 = Math.max(0, Math.floor(bb[0]) - grow), y0 = Math.max(0, Math.floor(bb[1]) - grow);
  const x1 = Math.min(W, Math.ceil(bb[2]) + grow), y1 = Math.min(H, Math.ceil(bb[3]) + grow);
  let s = 0, n = 0, big = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = (y * W + x) * 4;
    const d = (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2])) / 3;
    s += d; n++; if (d > 40) big++;
  }
  return { mad: s / n, big: big / n };
}

// pick test holds: by background (one class pink-ish, one white-ish, one dark, and edges)
const lum = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const palKind = pal.map(p => (lum(p) > 200 ? 'white' : lum(p) < 70 ? 'black' : 'colour'));
const byBg = { white: [], black: [], colour: [], edge: [] };
usable.filter(h => h.kind === 'hand').forEach(h => {
  const rc = ringClasses(polys.get(h.id));
  const total = [...rc.values()].reduce((a, b) => a + b, 0);
  const major = [...rc.entries()].sort((a, b) => b[1] - a[1]);
  if (major.length >= 2 && major[1][1] >= total * 0.2) byBg.edge.push(h);
  else if (major.length && major[0][1] >= total * 0.8) byBg[palKind[major[0][0]]].push(h);
});
const pick = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
const tests = [].concat(pick(byBg.colour, 3), pick(byBg.white, 3), pick(byBg.black, 2), pick(byBg.edge, 4));
console.log(`test holds: colour ${pick(byBg.colour, 3).map(h => h.name)}, white ${pick(byBg.white, 3).map(h => h.name)}, black ${pick(byBg.black, 2).map(h => h.name)}, stripe edge ${pick(byBg.edge, 4).map(h => h.name)}`);

// ── 1 +θ then −θ ───────────────────────────────────────────────────────────────
console.log('\n1  turning a hold +θ then −θ (two resamples), mean abs difference in its box (0–255)');
const angles = [5, 15, 30, 45, 90];
const worst = { mad: 0 }, rtAll = [];
tests.forEach(h => {
  const poly = polys.get(h.id), c = tracePolyCentre(poly), line = [];
  angles.forEach(t => {
    const once = heRotateImage(img, [{ poly, deg: t }], others(h.id), pal);
    const turned = heTurnPx(poly, c, t);
    const back = heRotateImage({ data: once, width: W, height: H }, [{ poly: turned, deg: -t }], others(h.id), pal);
    const d = diffIn(data, back, poly, 4);
    // a turn that runs into a neighbour (the neighbour wins) or off the picture can't come back whole
    const tb = traceBBox(turned);
    const clash = tb[0] < 8 || tb[1] < 8 || tb[2] > W - 8 || tb[3] > H - 8
      || others(h.id).some(o => tracePolyCover(o, turned) > 0.005 || tracePolyCover(turned, o) > 0.005);
    line.push(`${t}°: ${d.mad.toFixed(2)}${clash ? '*' : ''}`);
    if (!clash) rtAll.push(d.mad);
    if (!clash && d.mad > worst.mad) Object.assign(worst, { mad: d.mad, big: d.big, name: h.name, t });
  });
  console.log(`   ${h.name.padEnd(5)} ${line.join('  ')}`);
});
console.log('   (* the turned hold runs into a neighbour or off the picture: the editor warns, and it can\'t come back whole)');
const allMad = rtAll.slice().sort((x, y) => x - y);
console.log(`   median ${allMad[Math.floor(allMad.length / 2)].toFixed(2)} over ${allMad.length} turns without a clash (bicubic resampling twice; the dark outline's soft edge is where most of it is)`);
check(worst.mad < 15, `worst mean abs difference without a clash ${worst.mad.toFixed(2)} (${worst.name}, ${worst.t}°; ${(worst.big * 100).toFixed(1)}% of pixels off by > 40) < 15`);
{
  const h = tests[0], poly = polys.get(h.id);
  const region = heRegion(img, poly, others(h.id), pal);
  const same = heComposite(data, W, H, []);
  let eq = same.length === data.length;
  for (let i = 0; eq && i < data.length; i++) if (same[i] !== data[i]) eq = false;
  check(eq && region.mask.some(Boolean), 'a draft that nets to 0° (no turned holds) gives back the original exactly');
}

// ── 2 the background fill against plain background ────────────────────────────
console.log('\n2  the fill: a fake hold cut from plain background, filled, against what was there');
function fakeAt(cx, cy, r) {
  const pts = [];
  for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; pts.push([cx + Math.cos(a) * r * (1 + 0.25 * Math.sin(3 * a)), cy + Math.sin(a) * r]); }
  return pts;
}
// candidate spots: background all round (no hold within reach), sorted by how many colours
const allPolys = usable.map(h => polys.get(h.id));
const spots = { one: [], edge: [] };
for (let y = 60; y < H - 60; y += 11) for (let x = 60; x < W - 60; x += 11) {
  const r = 12, f = fakeAt(x, y, r), bb = traceBBox(f);
  if (allPolys.some(p => { const b = traceBBox(p); return !(b[2] < bb[0] - 16 || b[0] > bb[2] + 16 || b[3] < bb[1] - 16 || b[1] > bb[3] + 16); })) continue;
  const cls = new Set();
  let bad = 0, n = 0;
  for (let yy = Math.floor(bb[1]) - 14; yy <= bb[3] + 14; yy += 2) for (let xx = Math.floor(bb[0]) - 14; xx <= bb[2] + 14; xx += 2) {
    const j = (yy * W + xx) * 4, cl = heBgClass(data[j], data[j + 1], data[j + 2], pal);
    n++;
    if (cl >= 0) cls.add(cl);
    else if (heBgDist(data[j], data[j + 1], data[j + 2], pal) > 30) bad++;   // not even a mix of two (an edge)
  }
  if (bad > n * 0.04) continue;                 // a hold, a shadow or a speck nearby (an edge's own antialiasing is allowed)
  (cls.size === 1 ? spots.one : spots.edge).push(f);
}
const fillErr = f => {
  const region = heRegion(img, f, [], pal);
  const out = heComposite(data, W, H, [{ region, deg: 0 }]);
  return diffIn(data, out, f, 2);
};
const edgeSpots = pick(spots.edge, 12);
const fs1 = pick(spots.one, 12).map(fillErr), fs2 = edgeSpots.map(fillErr);
const avg = l => l.reduce((a, b) => a + b.mad, 0) / Math.max(1, l.length);
console.log(`   ${fs1.length} spots on one colour: mean abs difference ${avg(fs1).toFixed(2)}; ${fs2.length} spots across a stripe edge: ${avg(fs2).toFixed(2)} (worst ${Math.max(0, ...fs2.map(x => x.mad)).toFixed(2)})`);
check(fs1.length > 0 && avg(fs1) < 4, `plain background filled within ${avg(fs1).toFixed(2)} < 4`);
check(!fs2.length || avg(fs2) < 8, `stripe edges filled within ${avg(fs2).toFixed(2)} < 8 (the edge carried straight through)`);

// ── 3 the mirror rule (the editor's own model and functions) ──────────────────
console.log('\n3  the mirror rule');
BS.live = { holds: rows.map(h => Object.assign({}, h)), corners: corners || { image: [[0, 0], [100, 0], [100, 100], [0, 100]] }, image: 'test.jpg', version: 't' };
HE.img = { orig: data, w: W, h: H, path: 'test.jpg' };
HE.palette = pal;
const reset = () => { Object.assign(HE, { rot: {}, added: [], removed: [], pairs: {}, undo: [], redo: [], sel: null, tool: null }); HE.gen++; };
reset();
const M0 = heModel();
const hand = M0.list.filter(h => h.kind === 'hand');
const xOf = h => tracePolyCentre(h.pts)[0];
const left = hand.find(h => h.mirror && h.mirror !== h.id && xOf(h) < 40);
const centre = hand.find(h => !h.mirror || h.mirror === h.id);
if (left) {
  heRotateBy(left.id, 45); HE.gen++;
  check(HE.rot[left.id] === 45 && HE.rot[left.mirror] === -45, `${left.name} +45° gives its partner ${heHold(left.mirror).name} ${HE.rot[left.mirror]}°`);
  heRotateBy(left.mirror, 10); HE.gen++;
  check(HE.rot[left.id] === 35 && HE.rot[left.mirror] === -35, `then ${heHold(left.mirror).name} +10°: ${left.name} ${HE.rot[left.id]}°, ${heHold(left.mirror).name} ${HE.rot[left.mirror]}° (always opposite)`);
  const h1 = heHold(left.id), p1 = heHold(left.mirror);
  const c0 = tracePolyCentre(left.pts.map(p => [p[0] / 100 * W, p[1] / 100 * H])), c1 = tracePolyCentre(h1.pts.map(p => [p[0] / 100 * W, p[1] / 100 * H]));
  check(Math.hypot(c0[0] - c1[0], c0[1] - c1[1]) < 0.6 && h1.x === left.x && h1.y === left.y, `the turn is about the centroid: it moved ${Math.hypot(c0[0] - c1[0], c0[1] - c1[1]).toFixed(2)} px; the hold's position is unchanged`);
  check(p1.deg === -35, 'the partner\'s outline turns with it');
} else check(false, 'no paired hand hold on the left to test');
reset();
if (centre) {
  heRotateBy(centre.id, 30); HE.gen++;
  check(Object.keys(HE.rot).length === 1 && HE.rot[centre.id] === 30, `centre-line ${centre.name} +30° turns alone`);
} else console.log('   (no centre-line hand hold on this board)');
reset();
const feet0 = M0.list.filter(h => h.kind === 'foot');
const unpaired = feet0.find(h => !h.mirror);
if (unpaired) {
  heRotateBy(unpaired.id, -20); HE.gen++;
  check(Object.keys(HE.rot).length === 1 && HE.rot[unpaired.id] === -20, `unpaired foothold ${unpaired.name} −20° turns alone`);
}
const fp = feet0.find(h => h.mirror && h.mirror !== h.id);
if (fp) {
  reset();
  heRotateBy(fp.id, 12); HE.gen++;
  check(HE.rot[fp.mirror] === -12 && heHold(fp.mirror).kind === 'foot', `foothold ${fp.name} +12°: its partner ${heHold(fp.mirror).name} (a foothold) −12°`);
}
const pairKinds = M0.list.every(h => !h.mirror || h.mirror === h.id || (heHold(h.mirror) && heHold(h.mirror).kind === h.kind));
check(pairKinds, 'every pair on the board is hand ↔ hand or foot ↔ foot');
if (left) {
  reset();
  heRotateBy(left.id, 25); HE.gen++;
  const turned = heComposeNow();
  heRotateBy(left.id, -25); HE.gen++;
  check(turned !== HE.img.orig && !Object.keys(HE.rot).length && heComposeNow() === HE.img.orig,
    `in the editor, ${left.name} +25° then −25° leaves no turn at all: the image is the original, untouched`);
}
check(heNorm(190) === -170 && heNorm(-185) === 175 && heNorm(360) === 0, 'angles stay within ±180°');

// ── 4 hit-testing and the bounded tap trace ───────────────────────────────────
console.log('\n4  hit-testing and Tap to trace beside a hand hold');
reset();
const k = TRACE_WORK / Math.max(W, H), mw = Math.round(W * k), mh = Math.round(H * k);
const rs = execFileSync('python', ['-c', py.replace('.convert("RGBA")', `.convert("RGBA").resize((${mw},${mh}),Image.BICUBIC)`), imgPath], { maxBuffer: 1 << 28 });
const nl2 = rs.indexOf(10);
const big = { data: new Uint8ClampedArray(rs.buffer.slice(rs.byteOffset + nl2 + 1, rs.byteOffset + nl2 + 1 + mw * mh * 4)), width: mw, height: mh };
const masks = traceHolds(big, { keepMasks: true }).masks;
global.bsW = () => W;                                    // 1 stage px = 1 image px for the hit reach
const feetAt = (opt('--feet') || '').split(';').filter(Boolean).map(s => s.split(',').map(Number));
if (!feetAt.length) {
  // no footholds given: test on a spot beside a hand hold where a small blob that's no
  // hand hold sits (the traced shapes no outline covers), if the board has one
  const res = traceHolds(big, {});
  res.shapes.forEach(s => {
    const c = [s.cx / k, s.cy / k];
    // 200 px²: the smallest of the 53 real footholds on the 10 Nov 2026 board is about 300 px² on the
    // bundled image; a smaller blob is a speck (a bolt hole, a dark hold's tip), not a foothold
    if (s.area / k / k < 200 || s.area / k / k > 900) return;
    if (M0.list.some(h => tracePointInPoly(c[0], c[1], h.curve))) return;
    const nearHand = M0.list.some(h => h.kind === 'hand' && Math.min(...h.curve.map(p => Math.hypot(p[0] - c[0], p[1] - c[1]))) < 18);
    if (nearHand) feetAt.push(c);
  });
}
console.log(`   ${feetAt.length} spot(s): ${feetAt.slice(0, 8).map(p => p.map(Math.round).join(',')).join('  ')}`);
let tapped = 0;
feetAt.forEach(([px, py0]) => {
  const x = px / W * 100, y = py0 / H * 100;
  const r = heTapPts(masks, x, y);
  if (r.error) { check(false, `tap at ${Math.round(px)},${Math.round(py0)}: ${r.error}`); return; }
  heAddFoot(r.pts);
  let h = heHold(HE.sel);
  const targets = heCutTargets(h);
  if (targets.length) {
    // a hand hold's outline swallowed it: the foothold is traced on its own, then cut out of that outline
    const before = tracePolyCover(h.curve, targets[0].curve);
    heCut();
    h = heHold(HE.sel);
    const t2 = heHold(targets[0].id), after = tracePolyCover(h.curve, t2.curve);
    check(before > 0.3 && after < 0.05 && tracePolyArea(t2.curve) > tracePolyArea(targets[0].curve) * 0.7,
      `inside ${targets[0].name}'s outline: Cut takes it out (${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(1)}% of the foothold inside; ${targets[0].name} keeps ${(tracePolyArea(t2.curve) / tracePolyArea(targets[0].curve) * 100).toFixed(0)}% of its area)`);
  }
  const neighbours = heModel().list.filter(o => o.kind === 'hand' && o.id !== h.id);
  const worstCover = Math.max(...neighbours.map(o => tracePolyCover(o.curve, h.curve)));
  const area = tracePolyArea(h.curve);
  const hit = heHit(x, y), hitBeside = heHit(x + (Math.sqrt(area) * 0.45 + 1) / W * 100, y);
  const round = bsPerim(h.curve) ** 2 / area;              // 4π for a circle; a ring round a neighbour is far more
  check(worstCover < 0.05 && area < 2500 && round < 30, `tap at ${Math.round(px)},${Math.round(py0)} -> ${h.name} (${Math.round(area)} px², compact ${round.toFixed(1)}), takes ${(worstCover * 100).toFixed(1)}% of any hand hold`);
  check(hit && hit.id === h.id, `a tap on it picks ${hit ? hit.name : 'nothing'}`);
  check(hitBeside && (hitBeside.id === h.id || hitBeside.kind === 'foot'), `a tap at its edge still picks the foothold (${hitBeside ? hitBeside.name : 'nothing'})`);
  tapped++;
});
if (tapped) {
  const named = heModel().list.filter(h => h.kind === 'foot');
  check(new Set(named.map(h => h.name)).size === named.length, `foothold names are unique after adding (${named.length} footholds)`);
  const sugg = heModel().list.filter(h => h.isNew && h.mirror);
  check(sugg.every(h => heHold(h.mirror).kind === 'foot'), `suggested partners are footholds only (${sugg.length} of ${tapped} new footholds paired)`);
}
// --payload <file>: the publish payload of these edits plus a turn (the first paired
// hand hold on the left +10°), for a rolled-back run through the real admin_publish_board()
if (opt('--payload') && left) {
  heRotateBy(left.id, 10); HE.gen++;
  fs.writeFileSync(opt('--payload'), JSON.stringify({ holds: hePayload(), turned: [left.id, left.mirror], added: HE.added.map(a => a.id), cut: Object.keys(HE.outlines) }));
  console.log(`   payload (${hePayload().length} holds) written to ${opt('--payload')}`);
}
// the same names as today's for an unedited board
reset();
const today = rows.filter(h => h.kind === 'foot');
if (today.length) {
  const m = heModel(), diff = today.filter(h => m.byId.get(h.id) && m.byId.get(h.id).name !== h.name);
  check(!diff.length, `with no edits, the FTn rule gives today's ${today.length} foothold names back (${diff.length} differ)`);
}

// ── crops for a look ──────────────────────────────────────────────────────────
const cropDir = opt('--crops');
if (cropDir) {
  fs.mkdirSync(cropDir, { recursive: true });
  const enc = 'import sys\nfrom PIL import Image\nw,h=int(sys.argv[2]),int(sys.argv[3])\nim=Image.frombytes("RGBA",(w,h),sys.stdin.buffer.read())\nim.save(sys.argv[1])';
  tests.forEach(h => {
    const poly = polys.get(h.id), c = tracePolyCentre(poly), bb = traceBBox(poly);
    const r = Math.ceil(Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 24);
    const x0 = Math.max(0, Math.round(c[0] - r)), y0 = Math.max(0, Math.round(c[1] - r));
    const cw = Math.min(W - x0, 2 * r), ch = Math.min(H - y0, 2 * r);
    const panels = [data, heRotateImage(img, [{ poly, deg: 30 }], others(h.id), pal), heRotateImage(img, [{ poly, deg: -60 }], others(h.id), pal)];
    const S = 3, ow = cw * panels.length * S + (panels.length - 1) * 6, oh = ch * S, buf = Buffer.alloc(ow * oh * 4, 255);
    panels.forEach((src, pi) => {
      for (let y = 0; y < oh; y++) for (let x = 0; x < cw * S; x++) {
        const s = ((y0 + Math.floor(y / S)) * W + x0 + Math.floor(x / S)) * 4, d = (y * ow + pi * (cw * S + 6) + x) * 4;
        buf[d] = src[s]; buf[d + 1] = src[s + 1]; buf[d + 2] = src[s + 2]; buf[d + 3] = 255;
      }
    });
    execFileSync('python', ['-c', enc, path.join(cropDir, `turn-${h.name}.png`), String(ow), String(oh)], { input: buf });
  });
  edgeSpots.forEach((f, i) => {
    const c = tracePolyCentre(f), r = 30, x0 = Math.max(0, Math.round(c[0] - r)), y0 = Math.max(0, Math.round(c[1] - r));
    const region = heRegion(img, f, [], pal), filled = heComposite(data, W, H, [{ region, deg: 0 }]);
    const cut = new Uint8ClampedArray(data);
    for (let ly = 0; ly < region.h; ly++) for (let lx = 0; lx < region.w; lx++) {
      if (!region.mask[ly * region.w + lx]) continue;
      const j = ((region.y0 + ly) * W + region.x0 + lx) * 4;
      cut[j] = 0; cut[j + 1] = 200; cut[j + 2] = 255;
    }
    const panels = [data, cut, filled], S = 4, cw = 2 * r, ow = cw * 3 * S + 12, oh = cw * S, buf = Buffer.alloc(ow * oh * 4, 255);
    panels.forEach((src, pi) => {
      for (let y = 0; y < oh; y++) for (let x = 0; x < cw * S; x++) {
        const s2 = ((y0 + Math.floor(y / S)) * W + x0 + Math.floor(x / S)) * 4, d = (y * ow + pi * (cw * S + 6) + x) * 4;
        buf[d] = src[s2]; buf[d + 1] = src[s2 + 1]; buf[d + 2] = src[s2 + 2]; buf[d + 3] = 255;
      }
    });
    execFileSync('python', ['-c', enc, path.join(cropDir, `fill-edge-${i + 1}.png`), String(ow), String(oh)], { input: buf });
  });
  console.log(`\ncrops (before | +30° | −60°, ×3; fill-edge-N: before | cut out | filled, ×4) in ${cropDir}`);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
