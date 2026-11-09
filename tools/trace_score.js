#!/usr/bin/env node
// Scores the app's auto-trace (app/trace.js, the same code the setup flow runs) against
// the hand-traced outlines in app/hold_shapes.json, on app/board-fallback.jpg.
//
//   node tools/trace_score.js            # summary
//   node tools/trace_score.js --worst 15 # plus the worst holds
//   node tools/trace_score.js --json out.json   # also write the traced shapes (% of the image)
//   node tools/trace_score.js --native  # trace at the image's own size, not TRACE_WORK
//   node tools/trace_score.js --opts '{"bgTol":40}'   # try other settings (TRACE_DEFAULTS)
//
// Needs Python with Pillow to decode the JPEG (python -c ...). Prints the median IoU
// (overlap: intersection / union) of each hand-traced hold with its best traced shape,
// how many are >= 0.8, 0.6-0.8, below 0.6, missed (best < 0.3), merged (one shape is
// the best for two holds) and the extra shapes (best for no hold: footholds, mostly).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'app', 'trace.js'), 'utf8'), { filename: 'trace.js' });

const imgPath = opt('--image') || path.join(ROOT, 'app', 'board-fallback.jpg');
// scaled to the size the setup flow traces at (TRACE_WORK, longest side), as the app does
const py = 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGBA")\n'
  + 'k=float(sys.argv[2])/max(im.size)\nim=im.resize((round(im.width*k),round(im.height*k)),Image.BICUBIC) if k>0 else im\n'
  + 'sys.stdout.write("%d %d\\n"%im.size); sys.stdout.flush(); sys.stdout.buffer.write(im.tobytes())';
const raw = execFileSync('python', ['-c', py, imgPath, String(args.includes('--native') ? 0 : TRACE_WORK)], { maxBuffer: 1 << 28 });
const nl = raw.indexOf(10);
const [W, H] = raw.slice(0, nl).toString().split(' ').map(Number);
const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset + nl + 1, W * H * 4);

const res = traceHolds({ data, width: W, height: H }, JSON.parse(opt('--opts') || '{}'));
const shapes = res.shapes;

// The hand-traced outlines, drawn as the app draws them (closed Catmull-Rom, __meta.smooth).
const gtAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'hold_shapes.json'), 'utf8'));
const smooth = (gtAll.__meta && gtAll.__meta.smooth) || 0.7;
function curve(pts, s) {
  const n = pts.length, k = s / 6, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2 = [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    for (let t = 0; t < 1; t += 0.125) {
      const u = 1 - t;
      out.push([u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
                u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1]]);
    }
  }
  return out;
}
const gt = Object.keys(gtAll).filter(k => k !== '__meta').map(id => ({
  id, pts: curve(gtAll[id], smooth).map(p => [p[0] / 100 * W, p[1] / 100 * H]),
}));

function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
  return [x0, y0, x1, y1];
}
function iou(a, b) {
  const A = a.bb, B = b.bb;
  if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) return 0;
  const x0 = Math.floor(Math.min(A[0], B[0])), y0 = Math.floor(Math.min(A[1], B[1]));
  const x1 = Math.ceil(Math.max(A[2], B[2])), y1 = Math.ceil(Math.max(A[3], B[3]));
  let i = 0, u = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const pa = tracePointInPoly(x + 0.5, y + 0.5, a.pts), pb = tracePointInPoly(x + 0.5, y + 0.5, b.pts);
      if (pa && pb) i++;
      if (pa || pb) u++;
    }
  }
  return u ? i / u : 0;
}
gt.forEach(g => { g.bb = bbox(g.pts); });
shapes.forEach(s => { s.bb = bbox(s.pts); s.best = 0; s.holds = []; });

const scores = gt.map(g => {
  let best = 0, bs = null;
  shapes.forEach(s => { const v = iou(g, s); if (v > best) { best = v; bs = s; } });
  if (bs && best >= 0.3) bs.holds.push(g.id);
  return { id: g.id, iou: best, ratio: bs ? tracePolyArea(bs.pts) / tracePolyArea(g.pts) : 0 };
});
const v = scores.map(s => s.iou).sort((a, b) => a - b);
const median = v[Math.floor(v.length / 2)];
const n = f => scores.filter(f).length;
const merged = shapes.filter(s => s.holds.length > 1).length;
const extras = shapes.filter(s => !s.holds.length).length;
console.log('image %dx%d, %d hand-traced holds, %d traced shapes, %d ms', W, H, gt.length, shapes.length, res.ms);
console.log('palette: %s', res.palette.map(p => p.map(Math.round).join(',')).join(' | '));
console.log('median IoU %s; >=0.8: %d, 0.6-0.8: %d, 0.3-0.6: %d, missed (<0.3): %d; merged shapes: %d; extra shapes: %d',
  median.toFixed(3), n(s => s.iou >= 0.8), n(s => s.iou >= 0.6 && s.iou < 0.8), n(s => s.iou >= 0.3 && s.iou < 0.6),
  n(s => s.iou < 0.3), merged, extras);
const rs = scores.filter(s => s.iou >= 0.6).map(s => s.ratio).sort((a, b) => a - b);
console.log('traced area / hand-traced area (matched holds): median %s', rs[Math.floor(rs.length / 2)].toFixed(3));
const worst = +opt('--worst');
if (worst) {
  scores.slice().sort((a, b) => a.iou - b.iou).slice(0, worst).forEach(s => {
    const g = gt.find(x => x.id === s.id);
    console.log('  %s  %s  at %d,%d', s.id, s.iou.toFixed(2), Math.round((g.bb[0] + g.bb[2]) / 2), Math.round((g.bb[1] + g.bb[3]) / 2));
  });
}
const out = opt('--json');
if (out) {
  fs.writeFileSync(out, JSON.stringify(shapes.map(s => ({
    pts: s.pts.map(p => [+(p[0] / W * 100).toFixed(2), +(p[1] / H * 100).toFixed(2)]), holds: s.holds,
  }))));
}
