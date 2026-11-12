// ProjectBoard - ordered classic <script>s sharing ONE global scope (no ES modules, no
// build step). Order: state, core, problems, admin, account, authoring, circuits,
// challenge, leaderboard, wall, trace, setup, holdedit, app. This file: the admin hold
// editor (Admin → Board Setup → Edit holds, the super admin only (db/44); docs/board-setup-plan.md, "The hold editor").
//
// It works on the live board directly (no photo, cartoon or line-up), on setup.js's
// stage (pan, pinch, the loupe) as the step 'edit':
//   select    tap a hold: inside an outline first (the smallest), else the nearest
//             outline, so a small foothold right beside a hand hold can be picked
//   add       a foothold by Tap to trace (bounded: other holds' outlines are taken out
//             of the trace's masks, so it never takes over a neighbour) or Draw; named by
//             the FTn rule (left to right, bottom row up); a mirror partner suggested by
//             the board's reflection (foot <-> foot only)
//   delete    a foothold, unless a problem's Specific feet uses it
//   rotate    a hold about its centroid (drag the ↻ handle, or −5° −1° +1° +5°); its
//             mirror partner turns the same amount the other way. The hold's pixels in
//             the board image (cut by its outline, grown to take in the dark outline
//             line) turn with it, and the area it uncovers is filled from the background
//             around it (heRegion: rays to the region's edge; opposite rays that land on
//             the same background colour decide, so a straight stripe edge stays straight)
//   publish   every edit is kept in a draft on this device (Undo/Redo); Publish changes
//             shows a summary, uploads the new board image (only when a hold turned) and
//             publishes through admin_publish_board(), so Undo the last publish works.
//             The edits are kept by hold id (turns, new and deleted footholds, pairs,
//             trims), so when the board is published from somewhere else meanwhile they
//             are laid over the board as it is now (heRebase), keeping whatever was
//             published there; an edit that clashes with it is dropped and said so. The
//             publish names the version it was built on and the server refuses any other
//             (db/45), so nothing published elsewhere is ever overwritten.
// The image work (heRegion, heComposite, heRotateImage) is pure, no DOM:
// tools/holdedit_score.js runs it in Node.

const HE_DRAFT = 'pb-hold-edit';
const HE_DRAFT_V = 1;
const HE_JPEG_Q = 0.95;          // the edited board image: same size, JPEG, no visible recompression
const HE_GROW_MAX = 0.009;       // a hold's region grows at most this share of the image's width past its outline
const HE_BG_TOL = 52;            // RGB distance to a background (palette) colour
const HE_UNDO_MAX = 40;
const HE_DIRS = Array.from({ length: 16 }, (_, k) => [Math.cos(k * Math.PI / 8), Math.sin(k * Math.PI / 8)]);

const HE = {
  img: null,           // { orig: Uint8ClampedArray RGBA, w, h, path }
  canvas: null,        // the board image with the edits (drawn on the stage)
  palette: null,       // the background colours (trace.js)
  rot: {},             // hold id -> degrees (+ = clockwise on screen)
  added: [],           // [{ id, pts: [[x%, y%]…] }] new footholds
  removed: [],         // ids of today's footholds to delete
  pairs: {},           // foothold id -> partner id | null (overrides today's)
  outlines: {},        // hand hold id -> its outline with a foothold cut out of it (%)
  undo: [], redo: [],
  sel: null,           // a hold id
  tool: null,          // 'tap' | 'draw' | 'pair' | 'summary' | null
  gen: 0,              // bumps on every edit (the model's cache key)
  model: null, modelGen: -1,
  regions: new Map(), regionsKey: '',
  imgGen: 0, masks: null, masksGen: -1,
  busy: false, raf: 0, version: null,
  baseRef: {},         // hold id -> { o: hash of its outline, m: its mirror } on the board the edits were made on
};

// ── the pure image work (Node-testable) ───────────────────────────────────────
// The nearest background colour of (r, g, b), or -1. A darker shade of a coloured
// background (a soft shadow) counts as that colour.
function heBgClass(r, g, b, pal) {
  let best = -1, bd = HE_BG_TOL * HE_BG_TOL;
  for (let i = 0; i < pal.length; i++) {
    const p = pal[i], dr = r - p[0], dg = g - p[1], db = b - p[2], d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
// How far (RGB) a colour is from the background colours pal: from any one of them, or from
// a mix of two (an antialiased stripe edge), except two greys (white and black mix to
// grey, which is what dark holds are).
function heBgDist(r, g, b, pal) {
  let bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const p = pal[i];
    bd = Math.min(bd, Math.hypot(r - p[0], g - p[1], b - p[2]));
    for (let k = i + 1; k < pal.length; k++) {
      const q = pal[k];
      if (traceSaturation(p) < 0.25 && traceSaturation(q) < 0.25) continue;
      const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], dd = dx * dx + dy * dy + dz * dz;
      const t = ((r - p[0]) * dx + (g - p[1]) * dy + (b - p[2]) * dz) / (dd || 1);
      if (t <= 0 || t >= 1) continue;
      bd = Math.min(bd, Math.hypot(r - p[0] - t * dx, g - p[1] - t * dy, b - p[2] - t * dz));
    }
  }
  return bd;
}
// The background palette of an RGBA image (trace.js's: the colours of the flat pixels).
function hePalette(data, W, H) {
  const N = W * H;
  let r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) { r[i] = data[j]; g[i] = data[j + 1]; b[i] = data[j + 2]; }
  r = traceBox3(r, W, H); g = traceBox3(g, W, H); b = traceBox3(b, W, H);
  const flat = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
      const lx = (0.299 * (r[i + 1] - r[i - 1]) + 0.587 * (g[i + 1] - g[i - 1]) + 0.114 * (b[i + 1] - b[i - 1]));
      const ly = (0.299 * (r[i + W] - r[i - W]) + 0.587 * (g[i + W] - g[i - W]) + 0.114 * (b[i + W] - b[i - W]));
      if (lx * lx + ly * ly < 36) flat[i] = 1;
    }
  }
  return tracePalette(r, g, b, flat, N);
}

// A hold's region on the image: its outline (poly, px) grown until the ring round it is
// background (so the dark outline line and any edge shading come with it), minus the
// other holds' outlines (others: [poly px]). With the background fill for every pixel
// of the region. -> { x0, y0, w, h, mask, fill (RGB), c: [cx, cy], reach, g }
function heRegion(img, poly, others, pal) {
  const W = img.width, H = img.height, d = img.data;
  const gMax = Math.max(3, Math.round(W * HE_GROW_MAX)), pad = gMax + 18;   // room outside the region to find stripe edges
  const bb = traceBBox(poly);
  const x0 = Math.max(0, Math.floor(bb[0]) - pad), y0 = Math.max(0, Math.floor(bb[1]) - pad);
  const x1 = Math.min(W, Math.ceil(bb[2]) + pad + 1), y1 = Math.min(H, Math.ceil(bb[3]) + pad + 1);
  const w = x1 - x0, h = y1 - y0;
  const other = new Uint8Array(w * h);
  others.forEach(o => {
    const ob = traceBBox(o);
    if (ob[2] < x0 || ob[0] > x1 || ob[3] < y0 || ob[1] > y1) return;
    const m = traceRaster(o, x0, y0, w, h);
    for (let i = 0; i < m.length; i++) if (m[i]) other[i] = 1;
  });
  const bgClassAt = (lx, ly) => {
    const j = ((y0 + ly) * W + x0 + lx) * 4;
    return heBgClass(d[j], d[j + 1], d[j + 2], pal);
  };
  let cur = traceRaster(poly, x0, y0, w, h), g = 0;
  for (let k = 1; k <= gMax; k++) {
    const nxt = traceDilate(cur, w, h);
    let ring = 0, bg = 0;
    for (let i = 0; i < nxt.length; i++) {
      if (!nxt[i] || cur[i] || other[i]) continue;
      ring++;
      if (bgClassAt(i % w, (i - i % w) / w) >= 0) bg++;
    }
    cur = nxt; g = k;
    if (k >= 2 && (!ring || bg >= ring * 0.9)) break;
  }
  cur = traceDilate(cur, w, h); g++;                       // one more: the antialiased edge
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = cur[i] && !other[i] ? 1 : 0;

  // the fill: from each pixel, 16 rays to the region's edge; the background colour just
  // past it is what each sees. Two opposite rays that see the same colour put the pixel
  // in it (a straight edge between two colours can't be crossed by a line that ends on
  // the same side twice), coloured by the two ends interpolated along the line.
  const inM = (fx, fy) => {
    const ix = Math.floor(fx), iy = Math.floor(fy);
    return ix >= 0 && iy >= 0 && ix < w && iy < h && mask[iy * w + ix];
  };
  const ends = new Array(16);
  const sampleAt = (fx, fy) => {
    const ends2 = ends;
    for (let k = 0; k < 16; k++) {
      const [dx, dy] = HE_DIRS[k];
      let t = 0;
      while (t < w + h && inM(fx + dx * t, fy + dy * t)) t += 1;
      const ex = fx + dx * (t + 2), ey = fy + dy * (t + 2);
      const gx = Math.floor(x0 + ex), gy = Math.floor(y0 + ey);
      const lx = Math.floor(ex), ly = Math.floor(ey);
      if (gx < 0 || gy < 0 || gx >= W || gy >= H || (lx >= 0 && ly >= 0 && lx < w && ly < h && other[ly * w + lx])) { ends2[k] = null; continue; }
      const j = (gy * W + gx) * 4, cl = heBgClass(d[j], d[j + 1], d[j + 2], pal);
      ends2[k] = cl < 0 ? null : { cl, t: t + 2, c: [d[j], d[j + 1], d[j + 2]] };
    }
    const wsum = [], csum = [];
    for (let k = 0; k < 8; k++) {
      const a = ends[k], b = ends[k + 8];
      if (!a || !b || a.cl !== b.cl) continue;
      const L = a.t + b.t, wt = 1 / (L * L);
      if (!wsum[a.cl]) { wsum[a.cl] = 0; csum[a.cl] = [0, 0, 0]; }
      wsum[a.cl] += wt;
      for (let c = 0; c < 3; c++) csum[a.cl][c] += wt * (a.c[c] * b.t + b.c[c] * a.t) / L;
    }
    let bc = -1, bw = 0;
    wsum.forEach((v, cl) => { if (v > bw) { bw = v; bc = cl; } });
    if (bc >= 0) return { cl: bc, c: csum[bc].map(v => v / bw) };
    let near = null;
    ends.forEach(e => { if (e && (!near || e.t < near.t)) near = e; });
    return near ? { cl: near.cl, c: near.c.slice() } : null;
  };
  const fill = new Uint8ClampedArray(w * h * 3), cls = new Int16Array(w * h).fill(-2);
  let any = null;
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const i = ly * w + lx;
      if (!mask[i]) continue;
      const s = sampleAt(lx + 0.5, ly + 0.5);
      if (!s) { cls[i] = -1; continue; }
      cls[i] = s.cl; any = any || s;
      fill[i * 3] = s.c[0]; fill[i * 3 + 1] = s.c[1]; fill[i * 3 + 2] = s.c[2];
    }
  }
  // where the colour changes (a stripe edge), 3 × 3 samples a pixel: an antialiased edge
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const i = ly * w + lx;
      if (!mask[i]) continue;
      const nb = [lx > 0 ? cls[i - 1] : -2, lx < w - 1 ? cls[i + 1] : -2, ly > 0 ? cls[i - w] : -2, ly < h - 1 ? cls[i + w] : -2];
      if (cls[i] >= 0 && nb.every(v => v === -2 || v === cls[i])) continue;
      const acc = [0, 0, 0];
      let n = 0;
      for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
        const s = sampleAt(lx + 0.5 + sx / 3, ly + 0.5 + sy / 3);
        if (s) { acc[0] += s.c[0]; acc[1] += s.c[1]; acc[2] += s.c[2]; n++; }
      }
      const c = n ? acc.map(v => v / n) : any ? any.c : [d[((y0 + ly) * W + x0 + lx) * 4], d[((y0 + ly) * W + x0 + lx) * 4 + 1], d[((y0 + ly) * W + x0 + lx) * 4 + 2]];
      fill[i * 3] = c[0]; fill[i * 3 + 1] = c[1]; fill[i * 3 + 2] = c[2];
    }
  }
  heStripeFill(d, W, x0, y0, w, h, mask, other, pal, fill);
  // what turns with the hold: everything inside its outline, and in the band grown past
  // it only what isn't background (the dark outline line, edge shading), fading out by how
  // close a pixel is to a background colour. So a stripe edge beside the hold stays put.
  // Right by the outline (2 px) that's the line's own soft edge, so only a pixel close to
  // one background colour is left behind; further out, a mix of two background colours (a
  // stripe's antialiased edge) is left behind too.
  const inside = traceRaster(poly, x0, y0, w, h), paste = new Float32Array(w * h);
  const near = traceDilate(traceDilate(inside, w, h), w, h);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (inside[i]) { paste[i] = 1; continue; }
    const lx = i % w, ly = (i - lx) / w, j = ((y0 + ly) * W + x0 + lx) * 4;
    let bd = Infinity;
    if (near[i]) pal.forEach(p => { bd = Math.min(bd, Math.hypot(d[j] - p[0], d[j + 1] - p[1], d[j + 2] - p[2])); });
    else bd = heBgDist(d[j], d[j + 1], d[j + 2], pal);
    paste[i] = Math.max(0, Math.min(1, (bd - 16) / 14));
  }
  const c = tracePolyCentre(poly);
  let reach = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const lx = i % w, ly = (i - lx) / w;
    reach = Math.max(reach, Math.hypot(x0 + lx + 0.5 - c[0], y0 + ly + 0.5 - c[1]));
  }
  return { x0, y0, w, h, mask, paste, fill, c, reach: reach + 2, g };
}

// Where a stripe edge crosses the region, the rays alone leave it ragged (and the edge's
// thin dark border line is no background colour), so the edges are found outside the
// region and carried straight through it: each edge's pixels (between two background
// colours) are fitted with a line; each fill pixel takes the background colour of the ring
// samples on its side of every line, and near a line the edge's own profile (its colour
// against the distance across it, measured outside the region: antialiasing and border
// line included). Changes fill in place; does nothing where no edge crosses.
function heStripeFill(d, W, x0, y0, w, h, mask, other, pal, fill) {
  const N = w * h;
  let oth = other;
  for (let k = 0; k < 3; k++) oth = traceDilate(oth, w, h);
  let far = mask;
  for (let k = 0; k < 14; k++) far = traceDilate(far, w, h);
  const cls = new Int16Array(N), col = i => { const lx = i % w, ly = (i - lx) / w, j = ((y0 + ly) * W + x0 + lx) * 4; return [d[j], d[j + 1], d[j + 2]]; };
  for (let i = 0; i < N; i++) { const c = col(i); cls[i] = heBgClass(c[0], c[1], c[2], pal); }
  // edge pixels: outside the region, no hold, not one background colour, two colours close by
  const edge = new Uint8Array(N);
  for (let ly = 2; ly < h - 2; ly++) {
    for (let lx = 2; lx < w - 2; lx++) {
      const i = ly * w + lx;
      if (!far[i] || mask[i] || oth[i]) continue;
      const c = col(i);
      let near = Infinity;
      pal.forEach(p => { near = Math.min(near, Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2])); });
      if (near < 24) continue;
      const seen = new Set();
      for (let yy = -3; yy <= 3; yy++) for (let xx = -3; xx <= 3; xx++) {
        const q = (ly + yy) * w + lx + xx;
        if (q >= 0 && q < N && cls[q] >= 0 && !oth[q]) seen.add(cls[q]);
      }
      if (seen.size >= 2) edge[i] = 1;
    }
  }
  const lab = traceLabel(edge, w, h, 8);
  let lines = [];
  const fit = pts => {
    let mx = 0, my = 0;
    pts.forEach(p => { mx += p[0]; my += p[1]; });
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    pts.forEach(p => { const a = p[0] - mx, b = p[1] - my; sxx += a * a; sxy += a * b; syy += b * b; });
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr - l1;
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { mx, my, dx: Math.cos(ang), dy: Math.sin(ang), l1, l2, pts };
  };
  for (let l = 1; l <= lab.count; l++) {
    if (lab.area[l] < 6) continue;
    const pts = [];
    for (let i = 0; i < N; i++) if (lab.lab[i] === l) pts.push([i % w + 0.5, (i - i % w) / w + 0.5]);
    const f = fit(pts);
    if (f.l1 < 5 * Math.max(f.l2, 0.05) || f.l1 / pts.length < 2) continue;     // a thin, long piece only
    lines.push(f);
  }
  // the same edge entering and leaving the region: one line
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const A = lines[a], B = lines[b], cos = Math.abs(A.dx * B.dx + A.dy * B.dy);
      const off = Math.abs(-A.dy * (B.mx - A.mx) + A.dx * (B.my - A.my));
      if (cos > Math.cos(8 * Math.PI / 180) && off < 3) { lines[a] = fit(A.pts.concat(B.pts)); lines.splice(b, 1); b = a; }
    }
  }
  const sd = (L, x, y) => -L.dy * (x - L.mx) + L.dx * (y - L.my);   // signed distance across the line
  // refit each line on every edge pixel within 2 px of it (both sides of the region)
  const edgePts = [];
  for (let i = 0; i < N; i++) if (edge[i]) edgePts.push([i % w + 0.5, (i - i % w) / w + 0.5]);
  for (let it = 0; it < 2; it++) {
    lines = lines.map(L => { const pts = edgePts.filter(p => Math.abs(sd(L, p[0], p[1])) < 2); return pts.length >= 6 ? fit(pts) : L; });
  }
  lines = lines.filter(L => { for (let i = 0; i < N; i++) if (mask[i] && Math.abs(sd(L, i % w + 0.5, (i - i % w) / w + 0.5)) < 1) return true; return false; });
  if (!lines.length) return;
  const sig = (x, y) => lines.reduce((s, L, k) => s | (sd(L, x, y) > 0 ? 1 << k : 0), 0);
  // ring samples a few pixels outside the region, by side
  let r1 = traceDilate(mask, w, h), r4 = r1;
  for (let k = 0; k < 4; k++) r4 = traceDilate(r4, w, h);
  const ring = new Map();
  for (let i = 0; i < N; i++) {
    if (!r4[i] || r1[i] || oth[i] || cls[i] < 0) continue;
    const x = i % w + 0.5, y = (i - i % w) / w + 0.5;
    if (lines.some(L => Math.abs(sd(L, x, y)) < 3)) continue;
    const s = sig(x, y);
    if (!ring.has(s)) ring.set(s, []);
    ring.get(s).push({ x, y, c: col(i), cl: cls[i] });
  }
  // each edge's profile: colour against the distance across it (0.5 px bins, ±4 px)
  const prof = lines.map(L => {
    const sum = Array.from({ length: 17 }, () => [0, 0, 0, 0]);
    for (let i = 0; i < N; i++) {
      if (!far[i] || mask[i] || oth[i]) continue;
      const x = i % w + 0.5, y = (i - i % w) / w + 0.5, s = sd(L, x, y);
      if (Math.abs(s) > 4 || lines.some(M => M !== L && Math.abs(sd(M, x, y)) < 5)) continue;
      const b = Math.round(s * 2) + 8, c = col(i);
      sum[b][0] += c[0]; sum[b][1] += c[1]; sum[b][2] += c[2]; sum[b][3]++;
    }
    return sum.map(v => (v[3] ? [v[0] / v[3], v[1] / v[3], v[2] / v[3]] : null));
  });
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const x = i % w + 0.5, y = (i - i % w) / w + 0.5;
    const close = lines.map((L, k) => ({ k, s: sd(L, x, y) })).filter(o => Math.abs(o.s) < 3.5).sort((a, b) => Math.abs(a.s) - Math.abs(b.s));
    if (close.length) {
      const p = prof[close[0].k], t = close[0].s * 2 + 8, b0 = Math.floor(t), f = t - b0;
      const a = p[b0], b = p[Math.min(16, b0 + 1)];
      if (a && b) { for (let c = 0; c < 3; c++) fill[i * 3 + c] = a[c] * (1 - f) + b[c] * f; continue; }
    }
    const list = ring.get(sig(x, y));
    if (!list || !list.length) continue;
    const votes = new Map();
    list.forEach(r => votes.set(r.cl, (votes.get(r.cl) || 0) + 1));
    let best = -1, bv = 0;
    votes.forEach((v, cl) => { if (v > bv) { bv = v; best = cl; } });
    let ws = 0;
    const acc = [0, 0, 0];
    list.forEach(r => {
      if (r.cl !== best) return;
      const wt = 1 / ((r.x - x) ** 2 + (r.y - y) ** 2 + 1);
      ws += wt; acc[0] += wt * r.c[0]; acc[1] += wt * r.c[1]; acc[2] += wt * r.c[2];
    });
    if (ws) for (let c = 0; c < 3; c++) fill[i * 3 + c] = acc[c] / ws;
  }
}

// The image with every item turned: items [{ region, deg, keep }] where keep is the list
// of the other holds' outlines as they now are (px; never painted over). Each turned
// hold's region is filled with its background first, then its pixels, turned about its
// centroid (bilinear), are laid over the result. -> a new RGBA array.
function heComposite(orig, W, H, items) {
  const out = new Uint8ClampedArray(orig);
  items.forEach(({ region: R }) => {
    for (let ly = 0; ly < R.h; ly++) {
      for (let lx = 0; lx < R.w; lx++) {
        const i = ly * R.w + lx;
        if (!R.mask[i]) continue;
        const j = ((R.y0 + ly) * W + R.x0 + lx) * 4;
        out[j] = R.fill[i * 3]; out[j + 1] = R.fill[i * 3 + 1]; out[j + 2] = R.fill[i * 3 + 2];
      }
    }
  });
  const px = (x, y, c) => orig[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + c];
  const wx = new Float64Array(4), wy = new Float64Array(4);   // bicubic weights: sharper than bilinear, so a turn and back loses little
  items.forEach(({ region: R, deg, keep }) => {
    if (!deg) return;
    const a = -deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    const [cx, cy] = R.c;
    const qx0 = Math.max(0, Math.floor(cx - R.reach)), qy0 = Math.max(0, Math.floor(cy - R.reach));
    const qx1 = Math.min(W, Math.ceil(cx + R.reach) + 1), qy1 = Math.min(H, Math.ceil(cy + R.reach) + 1);
    const qw = qx1 - qx0, qh = qy1 - qy0;
    const block = new Uint8Array(qw * qh);
    (keep || []).forEach(o => {
      const ob = traceBBox(o);
      if (ob[2] < qx0 || ob[0] > qx1 || ob[3] < qy0 || ob[1] > qy1) return;
      const m = traceRaster(o, qx0, qy0, qw, qh);
      for (let i = 0; i < m.length; i++) if (m[i]) block[i] = 1;
    });
    const mk = (lx, ly) => (lx >= 0 && ly >= 0 && lx < R.w && ly < R.h ? R.paste[ly * R.w + lx] : 0);
    for (let qy = qy0; qy < qy1; qy++) {
      for (let qx = qx0; qx < qx1; qx++) {
        if (block[(qy - qy0) * qw + qx - qx0]) continue;
        const ux = qx + 0.5 - cx, uy = qy + 0.5 - cy;
        const sx = cx + cs * ux - sn * uy - 0.5, sy = cy + sn * ux + cs * uy - 0.5;   // source pixel centre coords
        const fx = Math.floor(sx), fy = Math.floor(sy), tx = sx - fx, ty = sy - fy;
        const lx = fx - R.x0, ly = fy - R.y0;
        const alpha = mk(lx, ly) * (1 - tx) * (1 - ty) + mk(lx + 1, ly) * tx * (1 - ty) + mk(lx, ly + 1) * (1 - tx) * ty + mk(lx + 1, ly + 1) * tx * ty;
        if (alpha <= 0) continue;
        const j = (qy * W + qx) * 4;
        heCubicW(tx, wx); heCubicW(ty, wy);
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let m = 0; m < 4; m++) {
            let row = 0;
            for (let n = 0; n < 4; n++) row += wx[n] * px(fx - 1 + n, fy - 1 + m, c);
            v += wy[m] * row;
          }
          out[j + c] = alpha * v + (1 - alpha) * out[j + c];
        }
      }
    }
  });
  return out;
}

// The four bicubic (Keys, a = −0.5) weights for a sample t (0..1) past the second of four pixels.
function heCubicW(t, w) {
  const a = -0.5, k = x => { x = Math.abs(x); return x <= 1 ? (a + 2) * x * x * x - (a + 3) * x * x + 1 : x < 2 ? a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a : 0; };
  w[0] = k(1 + t); w[1] = k(t); w[2] = k(1 - t); w[3] = k(2 - t);
}

// Turn points (px) by deg about c.
function heTurnPx(pts, c, deg) {
  const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  return pts.map(p => { const ux = p[0] - c[0], uy = p[1] - c[1]; return [c[0] + cs * ux - sn * uy, c[1] + sn * ux + cs * uy]; });
}
// One-shot: the image with holds turned. holds: [{ poly (px), deg }], others: [poly px]
// (holds that don't move). Used by tools/holdedit_score.js.
function heRotateImage(img, holds, others, pal) {
  const W = img.width, H = img.height;
  pal = pal || hePalette(img.data, W, H);
  const all = holds.map(h => h.poly).concat(others);
  const items = holds.map((h, i) => {
    const region = heRegion(img, h.poly, all.filter((_, k) => k !== i), pal);
    const keep = holds.filter((_, k) => k !== i).map(o => heTurnPx(o.poly, tracePolyCentre(o.poly), o.deg)).concat(others);
    return { region, deg: h.deg, keep };
  });
  return heComposite(img.data, W, H, items);
}

// ── the model: today's holds with the draft's edits ───────────────────────────
const heSmooth = () => (typeof shapeSmooth === 'function' ? shapeSmooth() : 0.4);
const heNorm = v => { let a = ((v + 180) % 360 + 360) % 360 - 180; if (a === -180) a = 180; return Math.round(a * 10) / 10; };
function heQuad() {
  const q = BS.live && BS.live.corners && BS.live.corners.image;
  return Array.isArray(q) && q.length === 4 ? q : [[0, 0], [100, 0], [100, 100], [0, 100]];
}
// pts in % turned by deg about their centroid (in pixels, so nothing skews)
function heTurnPct(pts, deg) {
  const W = HE.img.w, H = HE.img.h, px = pts.map(p => [p[0] / 100 * W, p[1] / 100 * H]);
  return heTurnPx(px, tracePolyCentre(px), deg).map(p => [bsR2(p[0] / W * 100), bsR2(p[1] / H * 100)]);
}
const heCurve = pts => traceCurve(pts.map(p => [p[0] / 100 * HE.img.w, p[1] / 100 * HE.img.h]), heSmooth());

function heModel() {
  if (HE.model && HE.modelGen === HE.gen) return HE.model;
  const list = [];
  (BS.live ? BS.live.holds : []).forEach(h => {
    if (h.kind !== 'hand' && h.kind !== 'foot') return;
    if (h.kind === 'foot' && HE.removed.includes(h.id)) return;
    if (!Array.isArray(h.outline) || h.outline.length < 3) return;
    list.push({ id: h.id, kind: h.kind, name: h.name, x: +h.x, y: +h.y, base: HE.outlines[h.id] || h.outline, mirror: h.mirror || null, isNew: false, liveName: h.name, cut: !!HE.outlines[h.id] });
  });
  HE.added.forEach(a => list.push({ id: a.id, kind: 'foot', name: '', x: null, y: null, base: a.pts, mirror: null, isNew: true }));
  list.forEach(h => {
    if (h.kind === 'foot' && Object.prototype.hasOwnProperty.call(HE.pairs, h.id)) h.mirror = HE.pairs[h.id];
    h.deg = HE.rot[h.id] || 0;
    h.pts = h.deg ? heTurnPct(h.base, h.deg) : h.base;
    h.curve = heCurve(h.pts);
    h.bb = traceBBox(h.curve);
  });
  const feet = list.filter(h => h.kind === 'foot');
  const names = bsFootNameList(feet.map(h => h.pts), heQuad(), HE.img.w, HE.img.h);
  feet.forEach((h, i) => { h.name = names[i]; });
  const byId = new Map(list.map(h => [h.id, h]));
  HE.model = { list, byId };
  HE.modelGen = HE.gen;
  return HE.model;
}
const heHold = id => (id ? heModel().byId.get(id) || null : null);
function hePartner(h) {
  if (!h || !h.mirror || h.mirror === h.id) return null;
  return heHold(h.mirror);
}
const heLabel = h => (h ? (h.kind === 'foot' ? h.name || 'Foothold' : h.name) : '');

// Holds whose outline overlaps another's (a turned or new hold, or the selected one's
// pair): [[a, b]…]. A warning only; nothing is blocked.
function heOverlaps() {
  const M = heModel(), out = [], seen = new Set();
  const edited = M.list.filter(h => h.deg || h.isNew);
  edited.forEach(a => {
    M.list.forEach(b => {
      if (a === b) return;
      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) return;
      if (a.bb[2] < b.bb[0] || b.bb[2] < a.bb[0] || a.bb[3] < b.bb[1] || b.bb[3] < a.bb[1]) return;
      const ov = Math.max(tracePolyCover(a.curve, b.curve), tracePolyCover(b.curve, a.curve));
      if (ov > 0.03) { seen.add(key); out.push([a, b]); }
    });
  });
  return out;
}

// ── the draft (this device) and undo ──────────────────────────────────────────
const heState = () => JSON.stringify({ rot: HE.rot, added: HE.added, removed: HE.removed, pairs: HE.pairs, outlines: HE.outlines });
function heLoadState(s) {
  const o = JSON.parse(s);
  HE.rot = o.rot || {}; HE.added = o.added || []; HE.removed = o.removed || []; HE.pairs = o.pairs || {}; HE.outlines = o.outlines || {};
}
function heSave() {
  try {
    if (!heDirty()) { localStorage.removeItem(HE_DRAFT); return; }
    localStorage.setItem(HE_DRAFT, JSON.stringify({
      v: HE_DRAFT_V, t: Date.now(), version: HE.version, image: HE.img && HE.img.path, ref: heTouchedRef(),
      state: JSON.parse(heState()), undo: HE.undo.slice(-HE_UNDO_MAX), redo: HE.redo.slice(-HE_UNDO_MAX),
    }));
  } catch (e) { /* full or blocked: the draft lives in memory */ }
}
function heDraft() {
  try { const d = JSON.parse(localStorage.getItem(HE_DRAFT) || 'null'); return d && d.v === HE_DRAFT_V ? d : null; }
  catch (e) { return null; }
}
function heDropDraft() { try { localStorage.removeItem(HE_DRAFT); } catch (e) {} }
const heDirty = () => Object.keys(HE.rot).length > 0 || HE.added.length > 0 || HE.removed.length > 0 || Object.keys(HE.pairs).length > 0 || Object.keys(HE.outlines).length > 0;
function heSnap() {
  HE.undo.push(heState());
  if (HE.undo.length > HE_UNDO_MAX) HE.undo.shift();
  HE.redo = [];
}
function heChanged(imageToo) {
  HE.gen++;
  if (imageToo) heScheduleImage();
  heSave();
  bsRenderBoard(); bsRenderPanel();
}
function heUndo() {
  if (!HE.undo.length) return;
  HE.redo.push(heState());
  heLoadState(HE.undo.pop());
  if (HE.sel && !heHold(HE.sel)) HE.sel = null;
  HE.regions.clear(); HE.regionsKey = '';
  heChanged(true);
}
function heRedo() {
  if (!HE.redo.length) return;
  HE.undo.push(heState());
  heLoadState(HE.redo.pop());
  if (HE.sel && !heHold(HE.sel)) HE.sel = null;
  HE.regions.clear(); HE.regionsKey = '';
  heChanged(true);
}

// ── the board the edits were made on, and laying them over a newer one ───────
function heHash(v) {
  const s = JSON.stringify(v == null ? null : v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}
// Every hand hold and foothold of BS.live, as the edits' baseline.
function heRefAll() {
  const ref = {};
  (BS.live ? BS.live.holds : []).forEach(h => {
    if (h.kind === 'hand' || h.kind === 'foot') ref[h.id] = { o: heHash(h.outline), m: h.mirror || null };
  });
  return ref;
}
// Only the holds the edits touch (kept in the draft).
function heTouchedRef() {
  const ids = new Set([...Object.keys(HE.rot), ...Object.keys(HE.outlines), ...HE.removed, ...Object.keys(HE.pairs)]);
  Object.values(HE.pairs).forEach(v => { if (v) ids.add(v); });
  const ref = {};
  ids.forEach(id => { if (HE.baseRef[id]) ref[id] = HE.baseRef[id]; });
  return ref;
}
// Lay the edits over BS.live, a newer board than the one they were made on (`ref` says
// how the touched holds were then). Kept: turns, deletions, new footholds (renumbered
// above every id the board has used), trims and pairs whose holds haven't changed.
// Dropped: anything on a hold that's gone, a trim of an outline redrawn since, a pair
// whose foothold was re-paired since. Undo history starts again. -> how many were dropped.
function heRebase(ref) {
  const live = new Map((BS.live ? BS.live.holds : []).filter(h => h.kind === 'hand' || h.kind === 'foot').map(h => [h.id, h]));
  let lost = 0;
  const outlineMoved = id => !ref[id] || !live.has(id) || ref[id].o !== heHash(live.get(id).outline);
  const pairMoved = id => !ref[id] || !live.has(id) || ref[id].m !== (live.get(id).mirror || null);
  const num = id => { const m = /^foot(\d+)$/.exec(id || ''); return m ? +m[1] : 0; };
  HE.removed = HE.removed.filter(id => live.has(id) && live.get(id).kind === 'foot');
  Object.keys(HE.rot).forEach(id => { if (!live.has(id) && !HE.added.some(a => a.id === id)) { delete HE.rot[id]; lost++; } });
  Object.keys(HE.outlines).forEach(id => { if (outlineMoved(id)) { delete HE.outlines[id]; lost++; } });
  // new footholds: a fresh number when theirs is taken now or was used before
  let n = BS.live ? BS.live.footMax || 0 : 0;
  live.forEach((h, id) => { n = Math.max(n, num(id)); });
  const floor = n, rename = {};
  HE.added.forEach(a => { if (num(a.id) <= floor) rename[a.id] = true; else n = Math.max(n, num(a.id)); });
  HE.added.forEach(a => { if (rename[a.id] === true) { rename[a.id] = 'foot' + (++n); a.id = rename[a.id]; } });
  const re = id => (id && typeof rename[id] === 'string' ? rename[id] : id);
  const rot = {};
  Object.keys(HE.rot).forEach(id => { rot[re(id)] = HE.rot[id]; });
  HE.rot = rot;
  const pairs = {};
  Object.keys(HE.pairs).forEach(id => { pairs[re(id)] = re(HE.pairs[id]); });
  // pairs: both ends still there, and a live foothold's own pair unchanged since
  const isNew = id => HE.added.some(a => a.id === id);
  const there = id => isNew(id) || (live.has(id) && live.get(id).kind === 'foot' && !HE.removed.includes(id));
  Object.keys(pairs).forEach(id => {
    const v = pairs[id];
    if (!there(id) || (v && !there(v)) || (!isNew(id) && pairMoved(id))) { delete pairs[id]; lost++; }
  });
  // a pair kept at one end only would never pair back: drop it
  const partner = id => (id in pairs ? pairs[id] : live.has(id) ? live.get(id).mirror || null : null);
  Object.keys(pairs).forEach(id => {
    const v = pairs[id];
    if (v && v !== id && partner(v) !== id) { delete pairs[id]; lost++; }
  });
  // entries equal to the board's own pair go
  Object.keys(pairs).forEach(id => { if (live.has(id) && (live.get(id).mirror || null) === pairs[id]) delete pairs[id]; });
  HE.pairs = pairs;
  if (HE.sel) HE.sel = re(HE.sel);
  HE.undo = []; HE.redo = [];
  HE.regions.clear(); HE.regionsKey = '';
  HE.masks = null; HE.masksGen = -1;
  HE.gen++;
  return lost;
}

// A summary of the draft for the start page: "2 holds turned, 1 foothold added".
function heDraftSummary(d) {
  const s = d.state || {};
  const parts = [];
  const nr = Object.keys(s.rot || {}).length, na = (s.added || []).length, nd = (s.removed || []).length;
  if (nr) parts.push(`${nr} hold${nr === 1 ? '' : 's'} turned`);
  if (na) parts.push(`${na} foothold${na === 1 ? '' : 's'} added`);
  if (nd) parts.push(`${nd} foothold${nd === 1 ? '' : 's'} deleted`);
  if (Object.keys(s.outlines || {}).length) parts.push('outlines trimmed');
  if (!parts.length && Object.keys(s.pairs || {}).length) parts.push('foothold pairs changed');
  return parts.join(', ');
}
// The start page's card (setup.js's start step).
function heStartCard() {
  const d = heDraft();
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const stale = d && BS.live && d.image !== BS.live.image;                // a new image: the edits can't be kept
  const moved = d && BS.live && !stale && d.version !== BS.live.version;  // published since: laid over it
  return `
    <div class="bs-card">
      <div class="bs-card-title">Edit holds</div>
      <p class="bs-muted">Change today’s board directly: add or delete footholds, and turn a hold to match the wall (its mirror partner turns the other way). Nothing changes for climbers until you publish.</p>
      ${d && !stale ? `<p class="bs-muted"><b>Unpublished edits</b> (${escHtml(when(d.t))}): ${escHtml(heDraftSummary(d))}.</p>` : ''}
      ${moved ? `<p class="bs-muted">The board has been published since, so your edits will be laid over it as it is now (anything that clashes is dropped, and you’re told).</p>` : ''}
      ${stale ? `<p class="bs-muted"><b>Your unpublished edits were made on an earlier board image</b> (a new photo or a turn has been published since), so they’ll be dropped when you open the editor.</p>` : ''}
      <button class="ol-btn ${d && !stale ? 'ol-publish' : ''} bs-wide" data-act="he-open">${d && !stale ? 'Carry on editing' : 'Edit holds'}</button>
    </div>`;
}

// ── open the editor ───────────────────────────────────────────────────────────
async function heOpen() {
  if (HE.busy) return;
  HE.busy = true;
  bsEl('bs-page').innerHTML = '<div class="spinner"></div>';
  await bsLoadLive();                        // always the board as it is now (BRD-01)
  HE.busy = false;
  if (!BS.live || !BS.live.image) { showToast('Couldn’t load the board', 'error'); bsRender(); return; }
  HE.busy = true;
  try {
    if (HE.img && HE.img.path === BS.live.image && HE.version !== BS.live.version) {
      // edits still in memory, made on an earlier version of this same image
      const lost = heRebase(HE.baseRef);
      HE.version = BS.live.version;
      HE.baseRef = heRefAll();
      heSave();
      if (heDirty()) heRebasedToast(lost);
    }
    if (!HE.img || HE.img.path !== BS.live.image || HE.version !== BS.live.version) {
      const res = await fetch(bsUrl(BS.live.image), { cache: 'no-cache' });
      if (!res.ok) throw new Error('image ' + res.status);
      const blob = await res.blob();
      let bmp;
      try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
      catch (e) { bmp = await createImageBitmap(blob); }
      const W = bmp.width, H = bmp.height, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const orig = ctx.getImageData(0, 0, W, H).data;
      HE.img = { orig, w: W, h: H, path: BS.live.image };
      HE.canvas = c;
      HE.palette = hePalette(orig, W, H);
      HE.version = BS.live.version;
      HE.baseRef = heRefAll();
      HE.masks = null; HE.masksGen = -1;
      Object.assign(HE, { rot: {}, added: [], removed: [], pairs: {}, outlines: {}, undo: [], redo: [] });
      const d = heDraft();
      if (d && d.version === HE.version && d.image === HE.img.path) {
        heLoadState(JSON.stringify(d.state || {}));
        HE.undo = d.undo || []; HE.redo = d.redo || [];
      } else if (d && d.image === HE.img.path) {
        heLoadState(JSON.stringify(d.state || {}));
        const lost = heRebase(d.ref || {});
        heSave();
        heRebasedToast(lost);
      } else if (d) {
        heDropDraft();
        showToast('A new board image was published since your edits, so they were dropped', 'error');
      }
    }
    HE.sel = null; HE.tool = null;
    HE.regions.clear(); HE.regionsKey = '';
    HE.gen++;
    heRenderImage();
    BS.img.edit = { bmp: HE.canvas, w: HE.img.w, h: HE.img.h, path: HE.img.path };
    HE.busy = false;
    bsGo('edit');
  } catch (e) {
    console.warn('hold editor: open', e);
    HE.busy = false;
    showToast('Couldn’t load the board image', 'error');
    bsRender();
  }
}
function heRebasedToast(lost) {
  showToast(`The board was published from somewhere else since your edits: they’re laid over it as it is now${lost ? ` (${lost} that clashed with it ${lost === 1 ? 'was' : 'were'} dropped)` : ''}. Check them before you publish.`, lost ? 'error' : 'success');
}
function heClose() {
  HE.sel = null; HE.tool = null;
  bsGo('start');
}

// ── the image ─────────────────────────────────────────────────────────────────
function heRegionFor(h) {
  const key = JSON.stringify([HE.added.map(a => a.id), HE.removed, HE.outlines]);
  if (HE.regionsKey !== key) { HE.regions.clear(); HE.regionsKey = key; }
  let r = HE.regions.get(h.id);
  if (!r) {
    const M = heModel(), poly = heCurve(h.base);
    const pb = traceBBox(poly), m = HE.img.w * 0.05;
    const others = M.list.filter(o => o.id !== h.id).map(o => heCurve(o.base))
      .filter(o => { const b = traceBBox(o); return !(b[2] < pb[0] - m || b[0] > pb[2] + m || b[3] < pb[1] - m || b[1] > pb[3] + m); });
    r = heRegion({ data: HE.img.orig, width: HE.img.w, height: HE.img.h }, poly, others, HE.palette);
    HE.regions.set(h.id, r);
  }
  return r;
}
function heComposeNow() {
  const M = heModel();
  const items = M.list.filter(h => h.deg).map(h => {
    const r = heRegionFor(h), m = r.reach + 4;
    const keep = M.list.filter(o => o !== h && !(o.bb[2] < r.c[0] - m || o.bb[0] > r.c[0] + m || o.bb[3] < r.c[1] - m || o.bb[1] > r.c[1] + m)).map(o => o.curve);
    return { region: r, deg: h.deg, keep };
  });
  return items.length ? heComposite(HE.img.orig, HE.img.w, HE.img.h, items) : HE.img.orig;
}
function heRenderImage() {
  const data = heComposeNow();
  HE.canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), HE.img.w, HE.img.h), 0, 0);
  HE.imgGen++;
  const c = bsEl('bs-img');
  if (c && BS.step === 'edit') {
    if (c.width !== HE.img.w || c.height !== HE.img.h) { c.width = HE.img.w; c.height = HE.img.h; }
    c.getContext('2d').drawImage(HE.canvas, 0, 0);
    c.dataset.src = 'edit';
  }
}
function heScheduleImage() {
  if (HE.raf) return;
  HE.raf = requestAnimationFrame(() => { HE.raf = 0; heRenderImage(); });
}
// setup.js's bsDrawImage, in the editor
function heDrawImage() {
  const c = bsEl('bs-img');
  if (!HE.canvas) return;
  if (c.dataset.src !== 'edit' || c.width !== HE.img.w) {
    c.width = HE.img.w; c.height = HE.img.h;
    c.getContext('2d').drawImage(HE.canvas, 0, 0);
    c.dataset.src = 'edit';
    bsLayout(false);
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────
function heRenderBoard() {
  const svg = bsEl('bs-svg');
  if (!svg || !HE.img) return;
  const M = heModel(), sel = heHold(HE.sel), part = hePartner(sel);
  const warn = new Set();
  heOverlaps().forEach(([a, b]) => { warn.add(a.id); warn.add(b.id); });
  let out = '';
  M.list.forEach(h => {
    let cls = 'bs-s ' + h.kind;
    if (h.deg) cls += ' he-rot';
    if (h.isNew) cls += ' he-new';
    if (warn.has(h.id)) cls += ' he-warn';
    if (part && h.id === part.id) cls += ' partner';
    if (sel && h.id === sel.id) cls += ' sel';
    out += `<path class="${cls}" d="${smoothShapePath(h.pts, heSmooth())}"/>`;
  });
  if (sel && part) {
    const a = tracePolyCentre(sel.pts), b = tracePolyCentre(part.pts);
    out += `<line class="bs-link" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }
  if (BS.g && BS.g.type === 'lasso' && BS.g.pts.length > 1) {
    out += `<polyline class="bs-lasso" points="${BS.g.pts.map(p => p.join(',')).join(' ')}"/>`;
  }
  svg.innerHTML = out;
  bsRenderOver();
}
function heOverHtml() {
  const h = heHold(HE.sel);
  if (!h) return '';
  let html = '';
  const top = Math.min(...h.pts.map(p => p[1])), c = tracePolyCentre(h.pts);
  const [x, y] = bsScreen(c[0], top);
  html += `<div class="bs-label" style="left:${x}px;top:${y}px">${escHtml(heLabel(h))}</div>`;
  const rh = heRotHandle();
  if (rh) html += `<div class="bs-rot" style="left:${rh[0]}px;top:${rh[1]}px">↻</div>`;
  const p = hePartner(h);
  if (p) {
    const pt = Math.min(...p.pts.map(q => q[1])), pc = tracePolyCentre(p.pts), [px, py] = bsScreen(pc[0], pt);
    html += `<div class="bs-label he-plabel" style="left:${px}px;top:${py}px">${escHtml(heLabel(p))}</div>`;
  }
  return html;
}
// Where the turn handle is (stage px): above the selected hold, out of the label's way.
function heRotHandle() {
  const h = BS.step === 'edit' && !HE.tool && heHold(HE.sel);
  if (!h) return null;
  const c = tracePolyCentre(h.pts), [sx, sy] = bsScreen(c[0], c[1]);
  const bottom = Math.max(...h.pts.map(p => p[1])), [, by] = bsScreen(c[0], bottom);
  return [sx, by + 30];
}
const heDegText = d => (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(Math.abs(d) % 1 ? 1 : 0) + '°';

function hePanel() {
  const M = heModel(), h = heHold(HE.sel);
  const nr = M.list.filter(x => x.deg).length, na = HE.added.length, nd = HE.removed.length;
  const dirty = heDirty();
  const ov = heOverlaps();
  const status = `<div class="bs-status"><span>${M.list.filter(x => x.kind === 'hand').length} hand holds · ${M.list.filter(x => x.kind === 'foot').length} footholds</span>
      ${nr ? `<span class="ok">${nr} turned</span>` : ''}${na ? `<span class="ok">${na} added</span>` : ''}${nd ? `<span class="bad">${nd} to delete</span>` : ''}
      ${ov.length ? `<span class="bad">${ov.length} overlap${ov.length === 1 ? '' : 's'}</span>` : ''}</div>`;
  const undoRow = `<button class="ol-btn" data-act="he-undo" ${HE.undo.length ? '' : 'disabled'}>Undo</button><button class="ol-btn" data-act="he-redo" ${HE.redo.length ? '' : 'disabled'}>Redo</button>`;
  if (HE.tool === 'summary') return heSummaryPanel();
  if (HE.tool === 'tap') {
    return status + `<p class="bs-hint">${HE.busy ? 'Getting the board ready… (a few seconds, once)' : 'Tap inside the foothold to trace just that hold. Pinch to zoom first: it won’t spread into a hand hold beside it.'}</p>
      <div class="ol-row"><button class="ol-btn" data-act="he-tool-off">Cancel</button></div>`;
  }
  if (HE.tool === 'draw') {
    return status + `<p class="bs-hint">Draw round the foothold with one finger (two fingers zoom).</p>
      <div class="ol-row"><button class="ol-btn" data-act="he-tool-off">Cancel</button></div>`;
  }
  if (HE.tool === 'pair' && h) {
    return status + `<p class="bs-hint">Tap the foothold to pair with <b>${escHtml(heLabel(h))}</b> (footholds pair only with footholds).</p>
      <div class="ol-row"><button class="ol-btn" data-act="he-tool-off">Cancel</button></div>`;
  }
  if (h) {
    const p = hePartner(h);
    const pairText = h.kind === 'hand'
      ? (p ? `Mirror partner <b>${escHtml(heLabel(p))}</b> turns the other way.` : 'On the centre line: it turns alone.')
      : (p ? `Mirror partner <b>${escHtml(heLabel(p))}</b>${HE.suggested === h.id ? ' (suggested)' : ''} turns the other way.` : 'No mirror partner: it turns alone.');
    const warn = ov.filter(([a, b]) => a.id === h.id || b.id === h.id || (p && (a.id === p.id || b.id === p.id)))
      .map(([a, b]) => `${escHtml(heLabel(a))} overlaps ${escHtml(heLabel(b))}`);
    return status + `
      <div class="ol-row"><span class="bs-sel-text">${escHtml(heLabel(h))}</span><span class="he-kind">${h.kind === 'hand' ? 'hand hold' : h.isNew ? 'new foothold' : 'foothold'}</span>
        <span class="he-angle" aria-live="polite">${heDegText(h.deg)}</span></div>
      <p class="bs-hint">${pairText} Drag the ↻ handle or use the buttons (+ is clockwise).</p>
      ${warn.length ? `<p class="bs-hint bad">${warn.join('; ')}. Check it on the board (publishing is still allowed).</p>` : ''}
      <div class="ol-row he-turns">
        <button class="ol-btn" data-act="he-rot" data-d="-5">−5°</button><button class="ol-btn" data-act="he-rot" data-d="-1">−1°</button>
        <button class="ol-btn" data-act="he-rot" data-d="1">+1°</button><button class="ol-btn" data-act="he-rot" data-d="5">+5°</button>
        <button class="ol-btn" data-act="he-rot0" ${h.deg ? '' : 'disabled'}>Reset</button></div>
      ${heCutTargets(h).length ? `<p class="bs-hint">It sits inside <b>${heCutTargets(h).map(x => escHtml(heLabel(x))).join(', ')}</b>’s outline.</p>
        <div class="ol-row"><button class="ol-btn" data-act="he-cut">Cut it out of ${heCutTargets(h).map(x => escHtml(heLabel(x))).join(', ')}’s outline</button></div>` : ''}
      ${h.kind === 'foot' ? `<div class="ol-row"><button class="ol-btn" data-act="he-pair">${p ? 'Change partner' : 'Pair with…'}</button>
        <button class="ol-btn" data-act="he-unpair" ${p ? '' : 'disabled'}>Clear partner</button>
        <button class="ol-btn bs-danger" data-act="he-del">Delete</button></div>` : ''}
      <div class="ol-row">${undoRow}<button class="ol-btn" data-act="he-desel">Close</button></div>`;
  }
  return status + `
    <p class="bs-hint">Tap a hold to select it. Add a foothold with Tap to trace or Draw. A foothold a problem uses (Specific feet) can’t be deleted.</p>
    <div class="ol-row"><button class="ol-btn" data-act="he-tap">Tap to trace a foothold</button><button class="ol-btn" data-act="he-draw">Draw a foothold</button></div>
    <div class="ol-row">${undoRow}</div>
    <div class="ol-row"><button class="ol-btn" data-act="he-close">Back</button>
      <button class="ol-btn ol-publish" data-act="he-summary" ${dirty ? '' : 'disabled'}>Publish changes…</button></div>`;
}

// What Publish changes would do.
function heChanges() {
  const M = heModel(), live = BS.live.holds;
  const liveFoot = new Map(live.filter(h => h.kind === 'foot').map(h => [h.id, h]));
  const turned = M.list.filter(h => h.deg);
  const added = M.list.filter(h => h.isNew);
  const removed = HE.removed.map(id => liveFoot.get(id)).filter(Boolean);
  // footholds whose partner changed, one entry a pair (a hold left with none is listed alone)
  const pairs = [], seen = new Set();
  M.list.filter(h => h.kind === 'foot').forEach(h => {
    const was = h.isNew ? null : (liveFoot.get(h.id).mirror || null);
    if ((h.mirror || null) === was || seen.has(h.id)) return;
    seen.add(h.id);
    if (h.mirror) seen.add(h.mirror);
    pairs.push(h);
  });
  const renamed = M.list.filter(h => h.kind === 'foot' && !h.isNew && h.name !== h.liveName);
  const cut = M.list.filter(h => h.cut);
  return { turned, added, removed, pairs, renamed, cut };
}
function heSummaryPanel() {
  const ch = heChanges(), ov = heOverlaps();
  const li = (ok, txt) => `<li class="${ok ? 'ok' : 'bad'}">${txt}</li>`;
  const names = list => list.map(h => escHtml(heLabel(h))).join(', ');
  let items = '';
  if (ch.turned.length) items += li(true, `Turned: ${ch.turned.map(h => `${escHtml(heLabel(h))} ${heDegText(h.deg)}`).join(', ')}. The board picture changes with them.`);
  if (ch.added.length) items += li(true, `Footholds added: ${names(ch.added)}.`);
  if (ch.removed.length) items += li(true, `Footholds deleted: ${ch.removed.map(h => escHtml(h.name)).join(', ')}.`);
  if (ch.pairs.length) items += li(true, `Foothold pairs: ${ch.pairs.map(h => `${escHtml(heLabel(h))} ↔ ${h.mirror ? escHtml(heLabel(heHold(h.mirror))) : 'none'}`).join(', ')}.`);
  if (ch.cut.length) items += li(true, `Outline trimmed round a foothold: ${names(ch.cut)}.`);
  if (ch.renamed.length) items += li(true, `${ch.renamed.length} foothold${ch.renamed.length === 1 ? '' : 's'} renumbered to keep FT1, FT2… left to right, bottom row up (their ids, and any Specific feet, stay the same).`);
  if (ov.length) items += li(false, `Overlapping: ${ov.map(([a, b]) => `${escHtml(heLabel(a))} / ${escHtml(heLabel(b))}`).join(', ')}.`);
  items += li(true, 'Hand holds keep their names, LEDs and problems. Undo the last publish puts today’s board back.');
  return `<ul class="bs-checks">${items}</ul>
    <div class="ol-row"><button class="ol-btn" data-act="he-tool-off">Back</button>
      <button class="ol-btn ol-publish" data-act="he-publish" ${HE.busy ? 'disabled' : ''}>${HE.busy ? 'Publishing…' : 'Publish changes'}</button></div>`;
}

// ── edits ─────────────────────────────────────────────────────────────────────
// Turn the hold by delta degrees from the rotations `from` (its partner the other way).
function heRotateBy(id, delta, from) {
  const r = Object.assign({}, from || HE.rot), h = heHold(id);
  if (!h) return;
  r[id] = heNorm((r[id] || 0) + delta);
  const p = hePartner(h);
  if (p) r[p.id] = heNorm((r[p.id] || 0) - delta);
  Object.keys(r).forEach(k => { if (!r[k]) delete r[k]; });
  HE.rot = r;
}
function heRotButton(delta) {
  if (!HE.sel) return;
  heSnap();
  heRotateBy(HE.sel, delta);
  heChanged(true);
}
function heRotReset() {
  const h = heHold(HE.sel);
  if (!h || !h.deg) return;
  heSnap();
  heRotateBy(h.id, -h.deg);
  heChanged(true);
}
function heNextFootId() {
  let n = BS.live ? BS.live.footMax || 0 : 0;            // never an id an earlier foothold had (db/45)
  const seen = id => { const m = /^foot(\d+)$/.exec(id || ''); if (m) n = Math.max(n, +m[1]); };
  (BS.live ? BS.live.holds : []).forEach(h => seen(h.id));
  HE.added.forEach(a => seen(a.id));
  return 'foot' + (n + 1);
}
// The foothold the board's reflection puts opposite this one (unpaired, foot only), or null.
function heSuggestPartner(id) {
  const M = heModel(), h = heHold(id);
  if (!h) return null;
  const q = heQuad(), Hi = bsHomInv(bsHom(q)), bp = bsQuadPx(q, HE.img.w, HE.img.h);
  const pos = x => { const c = tracePolyCentre(x.pts), uv = bsHomApply(Hi, c[0], c[1]); return [uv[0] * bp.w, uv[1] * bp.h]; };
  const reflect = bsMirrorFit(M.list.filter(x => x.kind === 'hand').map(pos), bp);
  const [rx, ry] = reflect(pos(h));
  let best = null, bd = Infinity;
  M.list.forEach(o => {
    if (o.kind !== 'foot') return;
    const p = pos(o), d = Math.hypot(p[0] - rx, p[1] - ry);
    if (d < bd) { bd = d; best = o; }
  });
  if (!best || best.id === id || bd > bp.w * BS_PAIR || best.mirror) return null;
  return best.id;
}
function heSetPair(aId, bId) {
  const M = heModel();
  [aId, bId].forEach(id => {
    const h = id && M.byId.get(id);
    if (h && h.mirror && h.mirror !== id) HE.pairs[h.mirror] = null;
  });
  if (aId) HE.pairs[aId] = bId || null;
  if (bId) HE.pairs[bId] = aId || null;
  // keep only real changes (an entry equal to today's pair, or "none" for a new foothold, goes)
  const live = new Map((BS.live ? BS.live.holds : []).filter(h => h.kind === 'foot').map(h => [h.id, h.mirror || null]));
  Object.keys(HE.pairs).forEach(id => { if ((live.has(id) ? live.get(id) : null) === HE.pairs[id]) delete HE.pairs[id]; });
  HE.gen++;
}
function heAddFoot(pts) {
  heSnap();
  const id = heNextFootId();
  HE.added.push({ id, pts });
  HE.gen++;
  const p = heSuggestPartner(id);
  if (p) { heSetPair(id, p); HE.suggested = id; } else HE.suggested = null;
  HE.sel = id; HE.tool = null;
  heChanged(false);
  const h = heHold(id);
  showToast(`${heLabel(h)} added${p ? `, paired with ${heLabel(heHold(p))}` : ''}`, 'success');
}
async function heDelete() {
  const h = heHold(HE.sel);
  if (!h || h.kind !== 'foot') return;
  if (!h.isNew) {
    const { data, error } = await sb.from('problems').select('id').contains('feet_holds', [h.id]).limit(1);
    if (error) { showToast('Couldn’t check whether a problem uses it', 'error'); return; }
    if (data && data.length) { showToast(`${heLabel(h)} is in a problem’s Specific feet, so it can’t be deleted`, 'error'); return; }
  }
  heSnap();
  const p = hePartner(h);
  if (p) HE.pairs[p.id] = null;
  if (h.isNew) HE.added = HE.added.filter(a => a.id !== h.id);
  else HE.removed.push(h.id);
  delete HE.rot[h.id];
  delete HE.pairs[h.id];
  HE.sel = null;
  heChanged(true);
}

// The hand holds whose outline a foothold sits in (a hand hold's outline that swallowed it).
function heCutTargets(f) {
  if (!f || f.kind !== 'foot') return [];
  return heModel().list.filter(h => h.kind === 'hand' && !(h.bb[2] < f.bb[0] || f.bb[2] < h.bb[0] || h.bb[3] < f.bb[1] || f.bb[3] < h.bb[1])
    && tracePolyCover(f.curve, h.curve) > 0.3);
}
// A hand hold's outline (px, unturned) with a foothold's (px) cut out: the biggest piece
// left, traced as the trace traces. -> pts in %, or null.
function heCutOutline(handCurve, footCurve, W, H) {
  const b = traceBBox(handCurve), x0 = Math.max(0, Math.floor(b[0]) - 3), y0 = Math.max(0, Math.floor(b[1]) - 3);
  const w = Math.min(W, Math.ceil(b[2]) + 4) - x0, h = Math.min(H, Math.ceil(b[3]) + 4) - y0;
  const m = traceRaster(handCurve, x0, y0, w, h);
  let f = traceRaster(footCurve, x0, y0, w, h);
  f = traceDilate(traceDilate(f, w, h), w, h);                  // a small gap, as between two drawn holds
  for (let i = 0; i < m.length; i++) if (f[i]) m[i] = 0;
  const o = traceOpts(W, H, { inset: 0 });
  const pts = traceOutline({ mask: m, w, h, x0, y0 }, o);
  if (!pts || pts.length < 3 || pts.length > 400) return null;
  return pts.map(p => [bsR2(bsClamp(p[0] / W * 100, -5, 105)), bsR2(bsClamp(p[1] / H * 100, -5, 105))]);
}
function heCut() {
  const f = heHold(HE.sel), targets = heCutTargets(f);
  if (!targets.length) return;
  if (targets.some(h => h.deg)) { showToast('Reset that hold’s turn first, then cut', 'error'); return; }
  const out = {};
  for (const h of targets) {
    const pts = heCutOutline(heCurve(h.base), f.curve, HE.img.w, HE.img.h);
    if (!pts) { showToast(`Couldn’t trim ${heLabel(h)}’s outline`, 'error'); return; }
    out[h.id] = pts;
  }
  heSnap();
  Object.assign(HE.outlines, out);
  heChanged(true);
  showToast(`${targets.map(heLabel).join(', ')} trimmed round ${heLabel(f)}`, 'success');
}

// Tap to trace a foothold: the trace's masks (of the board as edited), with every
// other hold's outline taken out, so a tap beside a hand hold can't take it over.
async function heEnsureMasks() {
  if (HE.masks && HE.masksGen === HE.imgGen) return HE.masks;
  HE.busy = true; bsRenderPanel();
  await new Promise(r => setTimeout(r, 60));
  try {
    const k = TRACE_WORK / Math.max(HE.img.w, HE.img.h);
    const w = Math.round(HE.img.w * k), h = Math.round(HE.img.h * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(HE.canvas, 0, 0, w, h);
    HE.masks = traceHolds(ctx.getImageData(0, 0, w, h), { keepMasks: true }).masks;
    HE.masksGen = HE.imgGen;
  } catch (e) { console.error('hold editor: masks', e); HE.masks = null; }
  HE.busy = false;
  return HE.masks;
}
// The bounded tap trace (pure apart from the model): -> pts in %, or { error }.
function heTapPts(masks, x, y) {
  const M = heModel(), W = HE.img.w, H = HE.img.h, k = masks.W / W;
  const tx = x / 100 * W, ty = y / 100 * H, near = 0.12 * W;
  const fg = masks.fg.slice(), grow = Math.max(2, Math.round(2.5 * k));
  let inside = null;
  M.list.forEach(h => {
    if (h.bb[2] < tx - near || h.bb[0] > tx + near || h.bb[3] < ty - near || h.bb[1] > ty + near) return;
    if (tracePointInPoly(tx, ty, h.curve)) { if (!inside || tracePolyArea(h.curve) < tracePolyArea(inside.curve)) inside = h; return; }
  });
  M.list.forEach(h => {
    if (h === inside) return;
    if (h.bb[2] < tx - near || h.bb[0] > tx + near || h.bb[3] < ty - near || h.bb[1] > ty + near) return;
    const sp = h.curve.map(p => [p[0] * k, p[1] * k]), b = traceBBox(sp);
    // the hold and its dark outline line round it (a few px past the outline)
    const x0 = Math.max(0, Math.floor(b[0]) - grow - 1), y0 = Math.max(0, Math.floor(b[1]) - grow - 1);
    const w = Math.min(masks.W, Math.ceil(b[2]) + grow + 2) - x0, hh = Math.min(masks.H, Math.ceil(b[3]) + grow + 2) - y0;
    if (w <= 0 || hh <= 0) return;
    let m = traceRaster(sp, x0, y0, w, hh);
    for (let g = 0; g < grow; g++) m = traceDilate(m, w, hh);
    for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) if (m[yy * w + xx]) fg[(y0 + yy) * masks.W + x0 + xx] = 0;
  });
  if (inside && inside.kind === 'foot') return { error: `That’s ${heLabel(inside)} already` };
  const feet = M.list.filter(h => h.kind === 'foot').map(h => tracePolyArea(h.curve)).sort((a, b) => a - b);
  let maxArea = (feet.length ? feet[Math.floor(feet.length / 2)] * 3 : 0.002 * W * H) * k * k;
  if (inside) maxArea = Math.min(maxArea, tracePolyArea(inside.curve) * k * k * 0.5);
  const pts = traceTap({ fg, line: masks.line, W: masks.W, H: masks.H }, tx * k, ty * k, { maxArea });
  if (!pts) return { error: 'No foothold found there: try Draw' };
  const px = pts.map(p => [p[0] / k, p[1] / k]);
  if (bsPerim(px) ** 2 / Math.max(1, tracePolyArea(px)) > 60) return { error: 'That didn’t trace cleanly: try Draw' };   // a thin ring, not a hold
  if (inside && tracePolyIoU(px, inside.curve) > 0.5) return { error: `That’s ${heLabel(inside)}: tap the foothold itself, or Draw it` };
  return { pts: px.map(p => [bsR2(bsClamp(p[0] / W * 100, -5, 105)), bsR2(bsClamp(p[1] / H * 100, -5, 105))]) };
}
async function heTapTrace(x, y) {
  if (HE.busy) return;
  const masks = await heEnsureMasks();
  if (!masks) { showToast('Couldn’t read the board image', 'error'); bsRenderPanel(); return; }
  const r = heTapPts(masks, x, y);
  if (r.error) { showToast(r.error, 'error'); bsRenderPanel(); return; }
  heAddFoot(r.pts);
}

// ── taps and gestures on the stage (from setup.js's handlers) ─────────────────
// The hold under (x, y) %: inside an outline first (the smallest), else the nearest
// outline within reach (so a little foothold beside a hand hold can be picked).
function heHit(x, y) {
  const M = heModel(), W = HE.img.w, H = HE.img.h, px = x / 100 * W, py = y / 100 * H;
  let best = null, ba = Infinity;
  M.list.forEach(h => {
    if (px < h.bb[0] || px > h.bb[2] || py < h.bb[1] || py > h.bb[3]) return;
    if (tracePointInPoly(px, py, h.curve)) { const a = tracePolyArea(h.curve); if (a < ba) { ba = a; best = h; } }
  });
  if (best) return best;
  const reach = 22 * W / Math.max(1, bsW());          // 22 screen px
  let bd = reach;
  M.list.forEach(h => {
    if (px < h.bb[0] - reach || px > h.bb[2] + reach || py < h.bb[1] - reach || py > h.bb[3] + reach) return;
    const c = h.curve;
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length], dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / ((dx * dx + dy * dy) || 1)));
      const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
      if (d < bd) { bd = d; best = h; }
    }
  });
  return best;
}
function heTap(g) {
  if (HE.tool === 'tap') { heTapTrace(g.x, g.y); return; }
  if (HE.tool === 'summary') return;
  const h = heHit(g.x, g.y);
  if (HE.tool === 'pair') {
    const a = heHold(HE.sel);
    if (!a || !h) return;
    if (h.kind !== 'foot') { showToast('A foothold can only pair with a foothold', 'error'); return; }
    heSnap();
    heSetPair(a.id, h.id === a.id ? null : h.id);
    HE.tool = null; HE.suggested = null;
    heChanged(true);
    return;
  }
  HE.sel = h ? h.id : null;
  if (HE.suggested && HE.sel !== HE.suggested) HE.suggested = null;
  bsRenderBoard(); bsRenderPanel();
}
// pointerdown on the stage: the turn handle starts a turn. Returns true when it took the gesture.
function heDown(g, cx, cy) {
  if (HE.tool === 'draw') { Object.assign(g, { type: 'lasso', pts: [[bsR2(g.x), bsR2(g.y)]] }); return true; }
  const rh = heRotHandle();
  if (!rh) return false;
  const [sx, sy] = bsStageXY(cx, cy);
  if (Math.hypot(rh[0] - sx, rh[1] - sy) >= 26) return false;
  const h = heHold(HE.sel), c = tracePolyCentre(h.pts), [hx, hy] = bsScreen(c[0], c[1]);
  Object.assign(g, { type: 'herot', cx: hx, cy: hy, a0: Math.atan2(sy - hy, sx - hx), from: Object.assign({}, HE.rot), snap: heState() });
  return true;
}
function heRotMove(g, cx, cy) {
  const [sx, sy] = bsStageXY(cx, cy);
  let delta = (Math.atan2(sy - g.cy, sx - g.cx) - g.a0) * 180 / Math.PI;
  delta = Math.round(heNorm(delta) * 2) / 2;                 // half degrees while dragging
  heRotateBy(HE.sel, delta, g.from);
  HE.gen++;
  heScheduleImage();
  bsRenderBoard();
  const el = document.querySelector('#bs-panel .he-angle');
  const h = heHold(HE.sel);
  if (el && h) el.textContent = heDegText(h.deg);
}
function heRotEnd(g) {
  if (!g.moved || heState() === g.snap) return;
  HE.undo.push(g.snap);
  if (HE.undo.length > HE_UNDO_MAX) HE.undo.shift();
  HE.redo = [];
  heChanged(true);
}
function heLasso(gpts) {
  const pts = bsLassoDone(gpts);
  if (!pts) { bsRenderBoard(); showToast('Too small: draw all the way round the foothold', 'error'); return; }
  heAddFoot(pts);
}

// ── publish ───────────────────────────────────────────────────────────────────
function hePayload() {
  const M = heModel(), r = pts => pts.map(p => [bsR2(bsClamp(p[0], -5, 105)), bsR2(bsClamp(p[1], -5, 105))]);
  return M.list.map(h => {
    let x = h.x, y = h.y;
    if (h.isNew || x == null || y == null) { const c = tracePolyCentre(h.pts); x = bsR2(bsClamp(c[0], 0, 100)); y = bsR2(bsClamp(c[1], 0, 100)); }
    const o = { id: h.id, kind: h.kind, x, y, outline: r(h.pts), mirror: h.mirror || null };
    if (h.kind === 'foot') o.name = h.name;
    return o;
  });
}
// The edited board image as a JPEG of the same size.
function heImageBlob() {
  return new Promise((res, rej) => HE.canvas.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', HE_JPEG_Q));
}
// A hand hold or foothold of the board with no outline can't be published (the server
// refuses the whole board): say which, before anything is uploaded (BRD-04).
function heMissingOutlines() {
  return (BS.live ? BS.live.holds : []).filter(h => (h.kind === 'hand' || (h.kind === 'foot' && !HE.removed.includes(h.id)))
    && !HE.outlines[h.id] && !(Array.isArray(h.outline) && h.outline.length >= 3)).map(h => h.name || h.id);
}
// The board moved while editing: lay the edits over it as it is now (same image), or
// drop them (a new image). Nothing is published; the user checks and publishes again.
async function heStale() {
  const keep = BS.live;
  if (!(await bsLoadLive()) || !BS.live) { BS.live = keep; showToast('The board changed since you opened it, and it couldn’t be reloaded: try again', 'error'); bsRenderPanel(); return; }
  if (BS.live.image !== HE.img.path) {
    heDropDraft();
    Object.assign(HE, { rot: {}, added: [], removed: [], pairs: {}, outlines: {}, undo: [], redo: [], sel: null, tool: null, img: null, canvas: null, masks: null, version: null });
    HE.regions.clear(); HE.gen++;
    delete BS.img.edit;
    showToast('A new board image was published from somewhere else meanwhile, so your edits were dropped: open Edit holds again', 'error');
    bsGo('start');
    return;
  }
  const lost = heRebase(HE.baseRef);
  HE.version = BS.live.version;
  HE.baseRef = heRefAll();
  HE.tool = null;
  heChanged(true);
  heRebasedToast(lost);
}
async function hePublish() {
  if (HE.busy) return;
  const missing = heMissingOutlines();
  if (missing.length) {
    showToast(`${missing.slice(0, 3).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no outline: draw ${missing.length === 1 ? 'one' : 'them'} (PB Console → Holds) before publishing here`, 'error');
    return;
  }
  HE.busy = true; bsRenderPanel();
  try {
    // the cheap check first, so nothing is uploaded for a publish the server would refuse
    const { data: cur, error: curErr } = await sb.from('board_config').select('updated_at').eq('wall', BS_WALL).maybeSingle();
    if (curErr) throw curErr;
    if (cur && cur.updated_at !== HE.version) { HE.busy = false; await heStale(); return; }
    let path = HE.img.path;
    if (heModel().list.some(h => h.deg)) {
      if (HE.raf) { cancelAnimationFrame(HE.raf); HE.raf = 0; }
      heRenderImage();
      const blob = await heImageBlob();
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
      path = `setup/${stamp}-edit.jpg`;
      const { error: upErr } = await sb.storage.from(BOARD_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (upErr) throw upErr;
    }
    // corners null = the board keeps its own (never a made-up full-image quad: BRD-13)
    const { data, error } = await sb.rpc('admin_publish_board', {
      p_wall: BS_WALL, p_image_path: path, p_photo_path: BS.live.photo || null,
      p_corners: null, p_holds: hePayload(), p_smooth: null, p_expected_version: HE.version,
    });
    if (error) throw error;
    console.info('hold editor: published, board version', data);
    heDropDraft();
    Object.assign(HE, { rot: {}, added: [], removed: [], pairs: {}, outlines: {}, undo: [], redo: [], sel: null, tool: null, img: null, canvas: null, masks: null, version: null });
    HE.regions.clear(); HE.gen++;
    delete BS.img.edit;
    HE.busy = false;
    showToast('Published: the edited board is live on everyone’s next load', 'success');
    await bsAfterBoardChange();
    bsGo('start');
  } catch (e) {
    console.error('hold editor: publish', e);
    HE.busy = false;
    if (bsIsStale(e)) { await heStale(); return; }
    showToast(bsPublishError(e), 'error');
    bsRenderPanel();
  }
}

// The panel's buttons (setup.js passes every data-act starting "he-").
function heAct(act, b) {
  if (act === 'he-open') heOpen();
  else if (act === 'he-close') heClose();
  else if (act === 'he-undo') heUndo();
  else if (act === 'he-redo') heRedo();
  else if (act === 'he-desel') { HE.sel = null; HE.tool = null; bsRenderBoard(); bsRenderPanel(); }
  else if (act === 'he-tool-off') { HE.tool = null; bsRenderBoard(); bsRenderPanel(); }
  else if (act === 'he-rot') heRotButton(+b.dataset.d);
  else if (act === 'he-rot0') heRotReset();
  else if (act === 'he-tap') { HE.tool = 'tap'; HE.sel = null; bsRenderBoard(); bsRenderPanel(); heEnsureMasks().then(() => { if (HE.tool === 'tap') bsRenderPanel(); }); }
  else if (act === 'he-draw') { HE.tool = 'draw'; HE.sel = null; bsRenderBoard(); bsRenderPanel(); }
  else if (act === 'he-pair') { HE.tool = 'pair'; bsRenderPanel(); }
  else if (act === 'he-unpair') { const h = heHold(HE.sel); if (h && h.kind === 'foot') { heSnap(); heSetPair(h.id, null); HE.suggested = null; heChanged(false); } }
  else if (act === 'he-del') heDelete();
  else if (act === 'he-cut') heCut();
  else if (act === 'he-summary') { HE.tool = 'summary'; HE.sel = null; bsRenderBoard(); bsRenderPanel(); }
  else if (act === 'he-publish') hePublish();
}
