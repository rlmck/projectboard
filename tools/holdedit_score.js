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
//     traced and picked, and the trace never takes over the hand hold;
//   5 laying a draft over a newer board (heRebase, db/45): turns, deletions and pairs kept;
//     a trim of a redrawn outline, a pair re-made elsewhere and edits on holds that are gone
//     dropped; new footholds renumbered above every id the board has used;
//   6 the edit list (bsEditOps / heOps, db/48), points edited (heSetBase), the 400-point cap
//     (bsCapPoints) and Board Setup's payload checks (validateBoardPayload, BRD-10);
//   (3) the editor's compose: only the turned holds' boxes, into one buffer (BRD-06), is the
//     whole-image compose, and nothing outside the boxes changes.
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
    const turned = traceTurn(poly, c, t);
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
  const items = heItems(), full = heComposite(HE.img.orig, W, H, items);
  const buf = new Uint8ClampedArray(HE.img.orig);
  heCompositeInto(buf, HE.img.orig, W, H, items);
  const boxes = items.map(it => heItemBox(it.region, W, H));
  let same = true, outside = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== full[i]) { same = false; break; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (boxes.some(b => x >= b[0] && x < b[2] && y >= b[1] && y < b[3])) continue;
    const j = (y * W + x) * 4;
    if (full[j] !== HE.img.orig[j] || full[j + 1] !== HE.img.orig[j + 1] || full[j + 2] !== HE.img.orig[j + 2]) outside++;
  }
  check(items.length === 2 && same && outside === 0,
    `the editor's compose (${left.name} and its partner, ${boxes.map(b => (b[2] - b[0]) + '×' + (b[3] - b[1])).join(' + ')} px of ${W}×${H}) into one buffer is the whole-image compose; ${outside} pixels outside the boxes change`);
  heRotateBy(left.id, -25); HE.gen++;
  check(!Object.keys(HE.rot).length && !heItems().length,
    `in the editor, ${left.name} +25° then −25° leaves no turn at all: nothing to compose, the image is the original`);
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
// --payload <file>: the edit list of these edits plus a turn (the first paired hand hold on
// the left +10°), for a rolled-back run through the real admin_edit_holds() (db/48)
if (opt('--payload') && left) {
  heRotateBy(left.id, 10); HE.gen++;
  const ops = heOps('setup/zz-test-edit.jpg');
  fs.writeFileSync(opt('--payload'), JSON.stringify({ edits: ops, turned: [left.id, left.mirror], added: HE.added.map(a => a.id), cut: Object.keys(HE.outlines) }));
  console.log(`   edit list (${ops.length} edits) written to ${opt('--payload')}`);
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

// ── 5 laying edits over a newer board ───────────────────────────────────────────
{
  const sq = (x, y) => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  const row = (id, kind, name, x, y, mirror) => ({ id, kind, name, x, y, outline: sq(x, y), mirror: mirror || null });
  const oldRows = [row('hold1', 'hand', 'A1', 10, 90, 'hold1'), row('hold3', 'hand', 'C1', 20, 90, 'hold3'),
    row('foot1', 'foot', 'FT1', 10, 95, 'foot2'), row('foot2', 'foot', 'FT2', 90, 95, 'foot1'),
    row('foot3', 'foot', 'FT3', 30, 95), row('foot4', 'foot', 'FT4', 70, 95), row('foot5', 'foot', 'FT5', 50, 95)];
  const keepLive = BS.live, keepHE = JSON.stringify({ rot: HE.rot, added: HE.added, removed: HE.removed, pairs: HE.pairs, outlines: HE.outlines, baseRef: HE.baseRef, sel: HE.sel });
  BS.live = { holds: oldRows, footMax: 5 };
  HE.baseRef = heRefAll();
  // the draft: turn hold1 and foot5, trim hold3, delete foot4, pair foot3 with a new
  // foothold foot6, and a new unpaired foot7
  Object.assign(HE, { rot: { hold1: 5, foot5: -3 }, outlines: { hold3: sq(20.2, 90) }, removed: ['foot4'],
    added: [{ id: 'foot6', pts: sq(60, 96) }, { id: 'foot7', pts: sq(40, 96) }], pairs: { foot3: 'foot6', foot6: 'foot3' }, undo: ['x'], redo: [] });
  const ref = heTouchedRef();
  // meanwhile, published elsewhere: hold3 redrawn, foot5 deleted, foot6 + foot7 added there
  // (foot_id_max now 7), foot1/foot2 untouched
  BS.live = { holds: oldRows.filter(h => h.id !== 'foot5').map(h => (h.id === 'hold3' ? Object.assign({}, h, { outline: sq(21, 90) }) : h))
    .concat([row('foot6', 'foot', 'FT6', 5, 97), row('foot7', 'foot', 'FT7', 95, 97)]), footMax: 7 };
  const lost = heRebase(ref);
  check(HE.rot.hold1 === 5 && !('foot5' in HE.rot), 'rebase: a turn kept, a turn of a foothold deleted elsewhere dropped');
  check(!HE.outlines.hold3, 'rebase: a trim of an outline redrawn elsewhere dropped');
  check(HE.removed.length === 1 && HE.removed[0] === 'foot4', 'rebase: a deletion kept');
  const ids = HE.added.map(a => a.id);
  check(ids.length === 2 && ids.every(id => +id.slice(4) > 7) && new Set(ids).size === 2, `rebase: new footholds renumbered above every id used (${ids.join(', ')})`);
  check(HE.pairs.foot3 === ids[0] && HE.pairs[ids[0]] === 'foot3', 'rebase: a pair with a renumbered new foothold follows it');
  check(lost === 2 && HE.undo.length === 0, `rebase: 2 clashes counted (${lost}), undo history cleared`);
  // a pair re-made elsewhere wins over the draft's
  BS.live = { holds: oldRows, footMax: 5 };
  HE.baseRef = heRefAll();
  Object.assign(HE, { rot: {}, outlines: {}, removed: [], added: [], pairs: { foot3: 'foot4', foot4: 'foot3' } });
  const ref2 = heTouchedRef();
  BS.live = { holds: oldRows.map(h => (h.id === 'foot3' ? Object.assign({}, h, { mirror: 'foot5' }) : h.id === 'foot5' ? Object.assign({}, h, { mirror: 'foot3' }) : h)), footMax: 5 };
  heRebase(ref2);
  check(!Object.keys(HE.pairs).length, 'rebase: a pair re-made elsewhere is kept, the draft\'s dropped at both ends');
  BS.live = keepLive;
  Object.assign(HE, JSON.parse(keepHE));
}

// ── 6 the edit list, points, the 400-point cap, Board Setup's payload checks ───
console.log('\n6  the edit list (db/48), edited points, the 400-point cap, the payload checks');
{
  const sq = (x, y) => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
  const row = (id, kind, name, x, y, mirror) => ({ id, kind, name, x: x + 0.5, y: y + 0.5, outline: sq(x, y), mirror: mirror || null });
  const live = [row('hold1', 'hand', 'A1', 10, 90, 'hold19'), row('hold19', 'hand', 'S1', 80, 90, 'hold1'),
    row('foot1', 'foot', 'FT1', 10, 95, 'foot2'), row('foot2', 'foot', 'FT2', 90, 95, 'foot1'), row('foot3', 'foot', 'FT3', 50, 95)];
  const ops = bsEditOps(live, { outlines: { hold1: sq(10.2, 90) }, turns: {}, added: [{ id: 'foot9', pts: sq(30, 96) }], removed: ['foot2'],
    pairs: { foot1: null, foot9: 'foot3', foot3: 'foot9' }, names: { foot1: 'FT1', foot3: 'FT2', foot9: 'FT3' }, image: null });
  const by = op => ops.filter(o => o.op === op);
  check(by('delete_foot').length === 1 && by('add_foot')[0].name === 'FT3' && by('outline')[0].id === 'hold1'
    && by('name').length === 1 && by('name')[0].id === 'foot3' && by('pair').length === 3 && !by('image').length,
    `bsEditOps: one delete, a named new foothold, an outline, one rename (only the changed name), the pairs (${ops.length} edits)`);
  const t = bsEditOps(live, { outlines: { hold1: sq(10, 90) }, turns: { hold1: 5 }, image: 'setup/x.jpg' });
  check(t[0].op === 'image' && t[1].op === 'turn' && t[1].deg === 5, 'a turn is sent with its image first');
  check(!bsEditOps(live, { pairs: { foot1: 'foot2' }, removed: ['foot2'] }).some(o => o.op === 'pair'), 'no pair with a foothold being deleted');
  // the 400-point cap
  const ring = Array.from({ length: 900 }, (_, i) => [50 + 5 * Math.cos(i / 900 * 2 * Math.PI), 50 + 5 * Math.sin(i / 900 * 2 * Math.PI)]);
  const capped = bsCapPoints(ring, W, H);
  check(capped.length <= 400 && capped.length >= 12 && bsCapPoints(sq(1, 1), W, H).length === 4,
    `bsCapPoints: a 900-point outline -> ${capped.length} points (≤ 400); a small one is left alone`);
  // points edited on the model, and the edit list from them
  const keepLive = BS.live, keepHE = JSON.stringify({ rot: HE.rot, added: HE.added, removed: HE.removed, pairs: HE.pairs, outlines: HE.outlines, sel: HE.sel });
  BS.live = { holds: live, footMax: 9, corners: null };
  Object.assign(HE, { rot: {}, added: [], removed: [], pairs: {}, outlines: {} }); HE.gen++;
  heSetBase('hold1', sq(10, 90));
  check(!Object.keys(HE.outlines).length, 'heSetBase: an outline back to the board\'s own is no edit');
  heSetBase('hold1', sq(10, 90).map((p, i) => (i === 2 ? [p[0] + 0.3, p[1] + 0.3] : p)));
  let o = heOps(null).filter(x => x.op !== 'name');      // (these test footholds get renumbered by the FTn rule too)
  check(o.length === 1 && o[0].op === 'outline' && o[0].id === 'hold1' && heHold('hold1').edited, 'a point moved: one outline edit');
  heSetBase('hold1', sq(40, 50)); o = heOps(null);
  check(o.some(x => x.op === 'position' && x.id === 'hold1' && Math.abs(x.x - 40.5) < 0.01), 'an outline moved off its hand hold\'s position: the position follows (its centre)');
  BS.live = keepLive;
  Object.assign(HE, JSON.parse(keepHE)); HE.gen++;
  // Board Setup's payload checks (as admin_publish_board's)
  const pay = live.filter(h => h.id !== 'foot2').map(h => Object.assign({ id: h.id, kind: h.kind, x: h.x, y: h.y, outline: h.outline, mirror: h.mirror }, h.kind === 'foot' ? { name: h.name } : {}));
  pay.find(h => h.id === 'foot1').mirror = null;
  check(!validateBoardPayload(pay, live, 3, {}).length, 'validateBoardPayload: a good board passes');
  const bad = (f, what, used) => { const p = JSON.parse(JSON.stringify(pay)); f(p); const v = validateBoardPayload(p, live, 3, used || {}); check(v.length > 0, `validateBoardPayload refuses ${what}: "${v[0]}"`); };
  bad(p => { p.find(h => h.id === 'hold1').outline = ring; }, 'over 400 points');
  bad(p => { p.splice(0, 1); }, 'a hand hold left out');
  bad(p => { p.find(h => h.id === 'foot1').mirror = 'hold1'; }, 'a hand ↔ foot pair');
  bad(p => { p.find(h => h.id === 'foot3').name = 'FT1'; }, 'two footholds with one name');
  bad(p => { p.push({ id: 'foot2', kind: 'foot', name: 'FT9', x: 5, y: 5, outline: sq(5, 5), mirror: null }); p.find(h => h.id === 'foot2').id = 'foot3'; }, 'an id twice');
  bad(p => { p.push({ id: 'foot3x', kind: 'foot', name: 'FT9', x: 5, y: 5, outline: sq(5, 5), mirror: null }); }, 'a bad foothold id');
  bad(p => { p.push({ id: 'foot3', kind: 'foot', name: 'FT9', x: 5, y: 5, outline: sq(5, 5), mirror: null }); p.find(h => h.id === 'foot3' && h.name === 'FT3').id = 'foot0'; }, 'an old foothold id (≤ foot_id_max, not on the board)');
  bad(() => {}, 'dropping a foothold a problem uses', { foot2: 1 });
  // Board Setup: a partner chosen by hand survives a Review edit that remakes the pairs (BRD-15)
  const keep = { shapes: BS.shapes, corners: BS.corners, img: BS.img, live: BS.live, mirror: BS.mirror, flags: BS.flags, pairPicks: BS.pairPicks };
  BS.img = { cartoon: { w: 1000, h: 1000 } }; BS.corners = { cartoon: [[0, 0], [100, 0], [100, 100], [0, 100]] };
  BS.live = { holds: [], footMax: 0 };
  const shp = (key, kind, id, x, y) => ({ key, kind, id, pts: sq(x, y) });
  BS.shapes = [shp('a', 'foot', 'foot1', 20, 90), shp('b', 'foot', 'foot2', 79, 90), shp('c', 'foot', 'foot3', 50, 95)];
  for (let i = 0; i < 14; i++) BS.shapes.push(shp('h' + i, 'hand', 'hold' + (i + 1), 10 + (i % 7) * 5, 10 + Math.floor(i / 7) * 20), shp('m' + i, 'hand', 'hold' + (i + 40), 89 - (i % 7) * 5, 10 + Math.floor(i / 7) * 20));
  BS.pairPicks = {}; BS.mirror = null; bsMakeMirror();
  const auto = BS.mirror.foot1;
  bsPickPair(bsShapeOf('foot1'), bsShapeOf('foot3'));
  BS.mirror = null; bsMakeMirror();                      // what a Review edit does
  check(auto === 'foot2' && BS.mirror.foot1 === 'foot3' && BS.mirror.foot3 === 'foot1' && BS.mirror.foot2 === null,
    `Mirror pairs: FT1's reflection pair (${auto}) changed by hand to foot3 is kept when Review remakes the pairs`);
  Object.assign(BS, keep);
}

console.log('\n7  PB Console: mirror-copy, the smoothing edit (db/49), the shared geometry');
{
  // every hand hold's outline mirrored onto its partner (bsMirrorOutline through the fitted
  // reflection), against the partner's own outline: a symmetry board's partners are mirror images
  const q = (corners && corners.image) || [[0, 0], [100, 0], [100, 100], [0, 100]];
  const Hi = bsHomInv(bsHom(q)), bp = bsQuadPx(q, W, H);
  const hands = usable.filter(h => h.kind === 'hand');
  const pos = h => { const c = tracePolyCentre(h.outline), uv = bsHomApply(Hi, c[0], c[1]); return [uv[0] * bp.w, uv[1] * bp.h]; };
  const reflect = bsMirrorFit(hands.map(pos), bp);
  const byId = new Map(usable.map(h => [h.id, h]));
  const pct2px = pts => pts.map(p => [p[0] / 100 * W, p[1] / 100 * H]);
  const ious = [];
  let back = 1;
  hands.forEach(h => {
    const P = h.mirror && h.mirror !== h.id && byId.get(h.mirror);
    if (!P || P.kind !== 'hand') return;
    const m = bsMirrorOutline(h.outline, P.outline, q, W, H, reflect);
    ious.push(tracePolyIoU(pct2px(m), pct2px(P.outline)));
    if (m.length !== h.outline.length) back = 0;
    const twice = bsMirrorOutline(m, h.outline, q, W, H, reflect);
    back = Math.min(back, tracePolyIoU(pct2px(twice), pct2px(h.outline)));
  });
  ious.sort((a, b) => a - b);
  const med = ious[Math.floor(ious.length / 2)] || 0;
  console.log(`   ${ious.length} hand holds mirrored onto their partners: IoU with the partner's own outline median ${med.toFixed(3)}, p10 ${(ious[Math.floor(ious.length / 10)] || 0).toFixed(3)}`);
  check(ious.length > 100 && med >= 0.7, `mirror-copy lands on the partner (median IoU ${med.toFixed(3)} >= 0.7)`);
  check(back >= 0.97, `mirrored there and back is the outline again (worst IoU ${back.toFixed(3)}), with the same number of points`);
  const sm = bsEditOps(usable, { smooth: 0.55 });
  check(sm.length === 1 && sm[0].op === 'smooth' && sm[0].value === 0.55 && !bsEditOps(usable, {}).length,
    'bsEditOps: the smoothing is one edit ({op: smooth, value}), and only when set');
  // the closed curve: the path and the samples are the same Béziers (one copy, traceCurveSegs)
  const o = usable[0].outline, segs = traceCurveSegs(o, 0.7), path = traceCurvePath(o, 0.7), samp = traceCurve(o, 0.7);
  const cs = path.match(/C/g).length;
  check(cs === o.length && samp.length === o.length * 8 && Math.hypot(samp[8][0] - segs[1][0][0], samp[8][1] - segs[1][0][1]) < 1e-9,
    `traceCurvePath and traceCurve share one curve (${cs} Béziers, ${samp.length} samples)`);
  const t = traceTurn([[1, 0]], [0, 0], 90);
  check(Math.abs(t[0][0]) < 1e-12 && Math.abs(t[0][1] - 1) < 1e-12, 'traceTurn: +90° turns (1, 0) to (0, 1) (clockwise on screen)');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
