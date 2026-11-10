#!/usr/bin/env node
// Scores the app's camera LED mapping (app/ledmap.js, the same code board setup runs on the
// phone) on synthetic camera frames, against the LEDs the holds table already has.
//
//   node tools/ledmap_score.js            # the full run (about a minute)
//   node tools/ledmap_score.js --quick    # every 4th LED
//
// The camera: app/board-fallback.jpg seen at a slant (a perspective warp onto a 1280 x 960
// frame), darkened, with noise and mains-flicker bands that change every frame. Each LED
// that sits on a hand hold (from the table: Supabase, public read; the formula if offline)
// shows as a bright spot somewhere inside that hold's outline; every other LED shows
// nothing. The corners are "marked" a few pixels off, as a thumb would. Then:
//   - every hand hold must get its own LED back, and nothing else a hold;
//   - the planted faults must be flagged: a missing spot, a double spot, a spot far from
//     any hold, two LEDs on one hold, someone walking through the picture.
// Needs Python with Pillow to decode the JPEG. Exits 1 if anything is wrong.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const quick = process.argv.includes('--quick');
['trace.js', 'ledmap.js', 'setup.js'].forEach(f =>
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app', f), 'utf8'), { filename: f }));

// ── the board picture and the holds ──────────────────────────────────────────
const py = 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\n'
  + 'sys.stdout.write("%d %d\\n"%im.size); sys.stdout.flush(); sys.stdout.buffer.write(im.tobytes())';
const raw = execFileSync('python', ['-c', py, path.join(ROOT, 'app', 'board-fallback.jpg')], { maxBuffer: 1 << 28 });
const nl = raw.indexOf(10);
const [TW, TH] = raw.slice(0, nl).toString().split(' ').map(Number);
const img = new Uint8Array(raw.buffer, raw.byteOffset + nl + 1, TW * TH * 3);

const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_map.json'), 'utf8'));
const shapes = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_shapes.json'), 'utf8'));
const px = p => [p[0] / 100 * TW, p[1] / 100 * TH];
const holds = Object.keys(map).filter(k => k !== '__meta').map(id => ({
  id, c: px([map[id].x, map[id].y]), pts: (shapes[id] || []).map(px),
}));

function formula(n) {
  const x = (n - 1) % 19, y = Math.floor((n - 1) / 19);
  return x % 2 === 0 ? x * 13 + y + 1 : x * 13 + (13 - y);
}
async function tableLeds() {
  const st = fs.readFileSync(path.join(ROOT, 'app', 'state.js'), 'utf8');
  const url = /SUPA_URL = '([^']+)'/.exec(st)[1], key = /SUPA_KEY = '([^']+)'/.exec(st) || /eyJ[\w-]+\.[\w-]+\.[\w-]+/.exec(st);
  const k = key[1] || key[0];
  try {
    const r = await fetch(`${url}/rest/v1/holds?select=id,kind,led&wall=eq.HangoutPortland`, { headers: { apikey: k, Authorization: 'Bearer ' + k } });
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    return { src: 'the holds table', leds: Object.fromEntries(rows.filter(r2 => r2.led != null).map(r2 => [r2.id, r2.led])),
             locked: rows.filter(r2 => r2.kind === 'feet_sign').map(r2 => r2.led) };
  } catch (e) {
    const leds = {};
    holds.forEach(h => { leds[h.id] = formula(+h.id.slice(4)); });
    return { src: 'the formula (offline: ' + e.message + ')', leds, locked: [25, 26] };
  }
}

// ── the synthetic camera ─────────────────────────────────────────────────────
const CW = 1280, CH = 960;
const tgtQuad = [[0.01 * TW, 0.01 * TH], [0.99 * TW, 0.01 * TH], [0.99 * TW, 0.99 * TH], [0.01 * TW, 0.99 * TH]];
const camQuad = [[118, 96], [1176, 62], [1149, 902], [84, 874]];        // the board, slanted
const camToTgt = lmQuadMap(camQuad, tgtQuad), tgtToCam = lmQuadMap(tgtQuad, camQuad);
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += rnd(); return (u - 2) * 1.732; };

const base = new Float32Array(CW * CH * 3);
for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
  const [u, v] = camToTgt([x + 0.5, y + 0.5]), o = (y * CW + x) * 3;
  if (u < 0 || v < 0 || u >= TW - 1 || v >= TH - 1) { base[o] = base[o + 1] = base[o + 2] = 18; continue; }
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  for (let c = 0; c < 3; c++) {
    const at = (xx, yy) => img[(yy * TW + xx) * 3 + c];
    const val = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    base[o + c] = val * 0.55 + 12;                                          // the gym's light, a bit dim
  }
}
// One averaged camera frame (3 frames' worth of noise), with spots [{x, y, amp, sigma}] (camera px).
function frame(spots, extra) {
  const f = new Float32Array(base), phase = rnd() * 6.28;
  for (let y = 0; y < CH; y++) {
    const band = Math.sin(y / 120 * 6.28 + phase) * 3;
    for (let x = 0; x < CW; x++) {
      const o = (y * CW + x) * 3, n = band + gauss() * 2;
      f[o] += n + gauss() * 0.8; f[o + 1] += n + gauss() * 0.8; f[o + 2] += n + gauss() * 0.8;
    }
  }
  spots.forEach(s => {
    const r = Math.ceil(s.sigma * 4);
    for (let y = Math.max(0, Math.floor(s.y - r)); y < Math.min(CH, s.y + r); y++) {
      for (let x = Math.max(0, Math.floor(s.x - r)); x < Math.min(CW, s.x + r); x++) {
        const d2 = (x + 0.5 - s.x) ** 2 + (y + 0.5 - s.y) ** 2;
        const v = s.amp * Math.exp(-d2 / (2 * s.sigma ** 2)) + s.amp * 0.2 * Math.exp(-d2 / (2 * (s.sigma * 3) ** 2));
        const o = (y * CW + x) * 3;
        f[o] = Math.min(255, f[o] + v); f[o + 1] = Math.min(255, f[o + 1] + v * 0.95); f[o + 2] = Math.min(255, f[o + 2] + v * 0.9);
      }
    }
  });
  if (extra) extra(f);
  for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(255, f[i]));
  return f;
}
// A spot somewhere inside a hold's outline (where its LED shines through), in camera px.
function spotIn(h) {
  for (let t = 0; t < 50; t++) {
    const p = [h.c[0] + (rnd() - 0.5) * 12, h.c[1] + (rnd() - 0.5) * 12];
    if (!h.pts.length || tracePointInPoly(p[0], p[1], h.pts)) { const c = tgtToCam(p); return { x: c[0], y: c[1], amp: 90 + rnd() * 120, sigma: 2 + rnd() * 2 }; }
  }
  const c = tgtToCam(h.c);
  return { x: c[0], y: c[1], amp: 150, sigma: 2.5 };
}

(async () => {
  const T = await tableLeds();
  const ledHold = {};
  Object.entries(T.leds).forEach(([id, led]) => { if (holds.some(h => h.id === id)) ledHold[led] = id; });
  const byId = new Map(holds.map(h => [h.id, h]));
  const COUNT = 248;
  let leds = [];
  for (let i = 1; i < COUNT; i++) if (!T.locked.includes(i)) leds.push(i);
  // the planted faults (each on a hand hold's LED)
  const onHold = leds.filter(l => ledHold[l]);
  const F = { missing: onHold[10], double: onHold[40], far: onHold[70], clashA: onHold[100], clashB: onHold[101], busy: onHold[130] };
  if (quick) leds = leds.filter((l, i) => i % 4 === 0 || Object.values(F).includes(l));
  // the gap furthest from every outline (for the far spot)
  let gap = null, gd = 0;
  for (let y = 0.1 * TH; y < 0.9 * TH; y += 6) for (let x = 0.1 * TW; x < 0.9 * TW; x += 6) {
    const d = lmNearest([x, y], holds).dist;
    if (d > gd) { gd = d; gap = [x, y]; }
  }
  // the corners as marked: a few px off
  const marked = camQuad.map(p => [p[0] + (rnd() - 0.5) * 12, p[1] + (rnd() - 0.5) * 12]);
  const toBoard = lmQuadMap(marked, tgtQuad);
  const bw = lmQuadWidth(tgtQuad);
  const off = frame([]);
  const results = {};
  const t0 = Date.now();
  leds.forEach(led => {
    const id = ledHold[led];
    let spots = [], extra = null;
    if (id && led !== F.missing) spots.push(spotIn(byId.get(id)));
    if (led === F.double) spots.push(spotIn(byId.get(ledHold[F.double + 20] || holds[5].id)));
    if (led === F.far) { const c = tgtToCam(gap); spots = [{ x: c[0], y: c[1], amp: 160, sigma: 2.5 }]; }
    if (led === F.clashB) spots = [spotIn(byId.get(ledHold[F.clashA]))];
    if (led === F.busy) extra = f => { for (let y = 300; y < 700; y++) for (let x = 500; x < 640; x++) { const o = (y * CW + x) * 3; f[o] += 60; f[o + 1] += 50; f[o + 2] += 40; } };
    const det = lmFindSpots(frame(spots, extra), off, CW, CH, marked);
    results[led] = lmClassify(det, toBoard, holds, bw);
  });
  const ms = Date.now() - t0;
  const refined = lmRefine(results, toBoard, holds, bw);
  lmRematch(results, refined, holds, bw);
  const tally = lmTally(results, holds.map(h => h.id));
  const got = {};
  tally.byHold.forEach((l, id) => { if (l.length === 1) got[id] = l[0]; });

  const bad = [];
  const expect = (cond, msg) => { if (!cond) bad.push(msg); };
  const st = led => results[led] && results[led].st;
  expect(st(F.missing) === 'none', `missing spot: LED ${F.missing} is ${st(F.missing)}, not none`);
  expect(tally.missing.includes(ledHold[F.missing]), `missing spot: ${ledHold[F.missing]} isn't listed as having no LED`);
  expect(st(F.double) === 'double', `double spot: LED ${F.double} is ${st(F.double)}`);
  expect(st(F.far) === 'far', `far spot: LED ${F.far} is ${st(F.far)}`);
  expect(tally.clash.includes(ledHold[F.clashA]), `two LEDs on ${ledHold[F.clashA]} not flagged`);
  expect(st(F.busy) === 'busy', `someone walking through: LED ${F.busy} is ${st(F.busy)}`);
  const faults = new Set([F.missing, F.double, F.far, F.clashA, F.clashB, F.busy].map(l => ledHold[l]));
  let right = 0, checked = 0;
  leds.forEach(led => {
    const id = ledHold[led];
    if (!id) { if (results[led].hold) bad.push(`LED ${led} (no hold) went to ${results[led].hold}`); return; }
    if (faults.has(id)) return;
    checked++;
    if (got[id] === led) right++;
    else bad.push(`${id}: expected LED ${led}, got ${(tally.byHold.get(id) || []).join('+') || 'none'} (LED ${led} is ${st(led)})`);
  });
  console.log(`LEDs from ${T.src}; ${leds.length} LEDs, ${Math.round(ms / leds.length)} ms each on this machine`);
  console.log(`hand holds back with their own LED: ${right} of ${checked} (the faults' holds aside)`);
  console.log(`flags: ${tally.flagged.length} LEDs (${tally.flagged.map(l => l + ' ' + st(l)).join(', ')}), ` +
              `${tally.missing.length} holds with no LED, ${tally.clash.length} with two; lit nothing: ${tally.none.length}`);
  if (bad.length) { console.log('PROBLEMS:\n  ' + bad.slice(0, 30).join('\n  ')); process.exit(1); }
  console.log('OK: every hand hold got its own LED back and every planted fault was flagged');
})();
