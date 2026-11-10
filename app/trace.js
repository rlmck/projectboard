// trace.js: auto-tracing the holds on a cartoon board image (board setup, setup.js).
// Classic script, one shared global scope, no DOM: everything here is a pure function
// of the pixels, so tools/trace_score.js runs the very same code in Node and scores it
// against the hand-traced outlines (docs/board-setup-plan.md, "Auto-tracing").
//
// The method (the cartoon: flat background colours, a dark outline round every hold):
//  1 the background palette: the few colours that fill most of the flat (low-gradient)
//    pixels (pink, white, near-black on today's board);
//  2 background = large connected regions within reach of a palette colour; a hold's
//    darker drop shadow on a palette colour counts as background too;
//  3 everything else is a hold: holes are filled (anything enclosed is the hold), so
//    the outermost outline wins; dark holds stand out by their colour difference from
//    the background around them even where their outline merges into it;
//  4 touching holds are split at their necks (distance-transform seeds, then a
//    seeded flood within the shape: a watershed on the distance map);
//  5 each region's outer boundary is traced, smoothed (Gaussian along the contour)
//    and simplified to a polygon in image pixels.

const TRACE_REF = 1400;   // the image size (longest side, px) the lengths below are tuned for
const TRACE_WORK = 2200;  // the setup flow traces the cartoon scaled to this (longest side, px): finer outlines
const TRACE_DEFAULTS = {
  bgTol: 44,          // a pixel this close (RGB distance) to a palette colour may be background
  darkTol: 24,        // the same, for a near-black background (dark grey holds sit close to it)
  shadowTol: 0.62,    // a shadow: the same hue as a palette colour, down to this fraction of its brightness
  minBg: 0.004,      // a background region is at least this share of the image
  minHold: 0.00005,   // a hold is at least this share of the image (smaller specks are noise)
  maxHold: 0.03,      // and at most this share (anything bigger is background that leaked)
  splitRatio: 0.55,   // two peaks of the distance map split a shape if the neck between them is below this share of the smaller peak
  smoothSigma: 1.5,   // contour smoothing, in boundary pixels
  simplify: 0.5,      // polygon simplification tolerance, in pixels
  grow: 0,            // grow each hold by this many pixels (to the outline's outer edge)
  greyShadowTol: 0.72, // on a white background, a shadow is a light neutral grey down to this
  lineRadius: 3,      // the outline finder's reach: dark lines up to about twice this wide
  lineContrast: 45,   // how much darker than its surroundings a line pixel is
  lineGrow: 0,        // lines thickened by this many pixels to close gaps
  trimToOutline: true, // cut off what lies outside a shape's own closed outline
  edgeReach: 2,       // an edge between two background colours is at most about twice this wide
  inset: 1.25,          // move the traced outline inwards by this many pixels
  trimMin: 0.6,       // ... when the outline encloses at least this share of it
};

// img: { data: RGBA bytes, width, height }. opts.roi: optional quad [[x,y]×4] in pixels;
// shapes whose centre falls outside it are dropped. -> { shapes: [{pts, area, cx, cy}], palette, ms }
function traceHolds(img, opts) {
  const t0 = Date.now();
  const W = img.width, H = img.height, N = W * H, src = img.data;
  const o = traceOpts(W, H, opts);

  // 1 a light blur (3×3 box, twice) against JPEG noise
  let r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) { r[i] = src[j]; g[i] = src[j + 1]; b[i] = src[j + 2]; }
  for (let k = 0; k < 2; k++) { r = traceBox3(r, W, H); g = traceBox3(g, W, H); b = traceBox3(b, W, H); }

  // 2 flat pixels and the palette
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  const flat = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
      const gx = lum[i + 1] - lum[i - 1], gy = lum[i + W] - lum[i - W];
      if (gx * gx + gy * gy < 36) flat[i] = 1;
    }
  }
  const palette = tracePalette(r, g, b, flat, N);

  // the outlines: thin dark lines (a black-hat: the closed image minus the image),
  // thickened a pixel to close small gaps. They are never background, so a light
  // hold on a light background can't leak out through its outline.
  const closed = traceMinFilter(traceMaxFilter(lum, W, H, o.lineRadius), W, H, o.lineRadius);
  let line = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (closed[i] - lum[i] > o.lineContrast) line[i] = 1;
  for (let k = 0; k < o.lineGrow; k++) line = traceDilate(line, W, H);

  // 3 background candidates: near a palette colour, or a darker shade of one (a shadow)
  const cand = new Uint8Array(N);
  const tol2 = o.bgTol * o.bgTol, darkTol2 = o.darkTol * o.darkTol;
  const pairs = [];
  palette.forEach((a, i) => palette.forEach((c, j) => {
    if (j <= i || (traceSaturation(a) < 0.25 && traceSaturation(c) < 0.25)) return;
    const d = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    pairs.push({ a, d, dd: d[0] * d[0] + d[1] * d[1] + d[2] * d[2], ia: i, ic: j });
  }));
  // where each background colour is, a few pixels wide: an edge pixel counts as a
  // mix of two colours only when both are right beside it
  const near = palette.map(p => {
    const m = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const dr = r[i] - p[0], dg = g[i] - p[1], db = b[i] - p[2];
      if (dr * dr + dg * dg + db * db < tol2) m[i] = 1;
    }
    return traceMaxFilter(m, W, H, o.edgeReach);
  });
  for (let i = 0; i < N; i++) {
    if (line[i]) continue;
    for (const p of palette) {
      const dr = r[i] - p[0], dg = g[i] - p[1], db = b[i] - p[2];
      if (dr * dr + dg * dg + db * db < (p[0] + p[1] + p[2] < 200 ? darkTol2 : tol2)) { cand[i] = 1; break; }
      // a shadow: the colour scaled down by k (shadowTol..1), within tolerance
      const pp = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
      if (pp < 3000) continue;                      // no shadows on near-black
      const grey = traceSaturation(p) < 0.25;
      const k = (r[i] * p[0] + g[i] * p[1] + b[i] * p[2]) / pp;
      if (k < (grey ? o.greyShadowTol : o.shadowTol) || k > 1) continue;
      const er = r[i] - k * p[0], eg = g[i] - k * p[1], eb = b[i] - k * p[2];
      if (er * er + eg * eg + eb * eb < tol2 * (grey ? 0.12 : 0.35)) { cand[i] = 1; break; }
    }
    if (cand[i]) continue;
    // an edge between two background colours (antialiasing): a mix of the two. Not
    // between two greys (white and black), where the mixes are the grey holds.
    for (const s of pairs) {
      const t = ((r[i] - s.a[0]) * s.d[0] + (g[i] - s.a[1]) * s.d[1] + (b[i] - s.a[2]) * s.d[2]) / s.dd;
      if (t <= 0 || t >= 1 || !near[s.ia][i] || !near[s.ic][i]) continue;
      const er = r[i] - s.a[0] - t * s.d[0], eg = g[i] - s.a[1] - t * s.d[1], eb = b[i] - s.a[2] - t * s.d[2];
      if (er * er + eg * eg + eb * eb < tol2 * 0.5) { cand[i] = 1; break; }
    }
  }
  // the large connected regions are the background; small ones are holes in holds
  const bgLab = traceLabel(cand, W, H, 4);
  if (o.debug) Object.assign(o.debug, { cand, line, bgLab, r, g, b });
  const big = new Uint8Array(bgLab.count + 1);
  for (let l = 1; l <= bgLab.count; l++) if (bgLab.area[l] >= o.minBg * N) big[l] = 1;
  let fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) fg[i] = big[bgLab.lab[i]] ? 0 : 1;

  // 4 a light opening (cuts hairline bridges and specks), then the holds
  fg = traceDilate(traceErode(fg, W, H), W, H);
  if (o.debug) o.debug.fg = fg;
  const lab = traceLabel(fg, W, H, 4);
  if (o.debug) o.debug.lab = lab;
  const shapes = [];
  const minA = o.minHold * N, maxA = o.maxHold * N;
  for (let l = 1; l <= lab.count; l++) {
    const a = lab.area[l];
    if (a < minA || a > maxA) continue;
    const bb = lab.box[l];
    for (const part of traceSplit(lab.lab, W, l, bb, o, line)) {
      const pts = traceOutline(part, o);
      if (!pts || pts.length < 3) continue;
      const c = tracePolyCentre(pts);
      if (o.roi && !tracePointInPoly(c[0], c[1], o.roi)) continue;
      shapes.push({ pts, area: part.area, cx: c[0], cy: c[1] });
    }
  }
  const out = { shapes, palette, width: W, height: H, ms: Date.now() - t0 };
  if (o.keepMasks) out.masks = { fg, line, W, H };   // for tracePriorFit / traceTap
  return out;
}

// The settings for an image W × H: the defaults' lengths are for an image about
// TRACE_REF pixels across, so they're scaled.
function traceOpts(W, H, opts) {
  const o = Object.assign({}, TRACE_DEFAULTS, opts || {});
  const k = Math.max(W, H) / TRACE_REF;
  ['smoothSigma', 'simplify', 'inset'].forEach(key => { o[key] *= k; });
  ['lineRadius', 'edgeReach'].forEach(key => { o[key] = Math.max(1, Math.round(o[key] * k)); });
  return o;
}

// Grey-level max/min over a (2r+1)² square, separable.
function traceMaxFilter(a, W, H, rad) { return traceRankFilter(a, W, H, rad, Math.max); }
function traceMinFilter(a, W, H, rad) { return traceRankFilter(a, W, H, rad, Math.min); }
// van Herk / Gil-Werman: O(1) a pixel whatever the radius (the window is clipped at the
// image's edges). Min is the max of the negated values.
function traceRankFilter(a, W, H, rad, f) {
  const sgn = f === Math.min ? -1 : 1, k = 2 * rad + 1;
  const L = Math.max(W, H) + 2 * rad + k;
  const buf = new Float32Array(L), g = new Float32Array(L), h = new Float32Array(L);
  const t = new Float32Array(a.length), out = new Float32Array(a.length);
  const pass = (src, dst, n, start, step) => {
    const m = Math.ceil((n + 2 * rad) / k) * k;
    for (let i = 0; i < m; i++) { const j = i - rad; buf[i] = j >= 0 && j < n ? sgn * src[start + j * step] : -Infinity; }
    for (let b0 = 0; b0 < m; b0 += k) {
      g[b0] = buf[b0];
      for (let i = b0 + 1; i < b0 + k; i++) g[i] = g[i - 1] > buf[i] ? g[i - 1] : buf[i];
      h[b0 + k - 1] = buf[b0 + k - 1];
      for (let i = b0 + k - 2; i >= b0; i--) h[i] = h[i + 1] > buf[i] ? h[i + 1] : buf[i];
    }
    for (let j = 0; j < n; j++) { const x = h[j], y = g[j + k - 1]; dst[start + j * step] = sgn * (x > y ? x : y); }
  };
  for (let y = 0; y < H; y++) pass(a, t, W, y * W, 1);
  for (let x = 0; x < W; x++) pass(t, out, H, x, W);
  return out;
}

function traceSaturation(p) {
  const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]);
  return mx ? (mx - mn) / mx : 0;
}

function traceBox3(a, W, H) {
  const t = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const l = x > 0 ? a[row + x - 1] : a[row + x], m = a[row + x], rr = x < W - 1 ? a[row + x + 1] : m;
      t[row + x] = (l + m + rr) / 3;
    }
  }
  for (let y = 0; y < H; y++) {
    const up = y > 0 ? -W : 0, dn = y < H - 1 ? W : 0;
    for (let x = 0, i = y * W; x < W; x++, i++) out[i] = (t[i + up] + t[i] + t[i + dn]) / 3;
  }
  return out;
}

// The background palette: the colours (5 bits a channel) that fill at least 1% of
// the image's flat pixels, merged when close, each the mean of its pixels.
function tracePalette(r, g, b, flat, N) {
  const cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (!flat[i]) continue;
    const q = ((r[i] >> 3) << 10) | ((g[i] >> 3) << 5) | (b[i] >> 3);
    cnt[q]++; sr[q] += r[i]; sg[q] += g[i]; sb[q] += b[i]; total++;
  }
  const bins = [];
  for (let q = 0; q < 32768; q++) if (cnt[q]) bins.push(q);
  bins.sort((p, q) => cnt[q] - cnt[p]);
  const pal = [];
  for (const q of bins) {
    const c = [sr[q] / cnt[q], sg[q] / cnt[q], sb[q] / cnt[q]];
    const near = pal.find(p => (p.c[0] - c[0]) ** 2 + (p.c[1] - c[1]) ** 2 + (p.c[2] - c[2]) ** 2 < 30 * 30);
    if (near) { near.n += cnt[q]; near.s[0] += sr[q]; near.s[1] += sg[q]; near.s[2] += sb[q]; continue; }
    if (cnt[q] < total * 0.01) continue;
    pal.push({ c, n: cnt[q], s: [sr[q], sg[q], sb[q]] });
  }
  return pal.filter(p => p.n >= total * 0.04).map(p => [p.s[0] / p.n, p.s[1] / p.n, p.s[2] / p.n]);
}

// Connected components of mask (4- or 8-connected): { lab, count, area[], box[] }.
function traceLabel(mask, W, H, conn) {
  const N = W * H, lab = new Int32Array(N), stack = new Int32Array(N);
  const area = [0], box = [null];
  let count = 0;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || lab[s]) continue;
    count++;
    let sp = 0, a = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[sp++] = s; lab[s] = count;
    while (sp) {
      const i = stack[--sp], x = i % W, y = (i - x) / W;
      a++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const push = j => { if (mask[j] && !lab[j]) { lab[j] = count; stack[sp++] = j; } };
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
      if (conn === 8) {
        if (x > 0 && y > 0) push(i - W - 1);
        if (x < W - 1 && y > 0) push(i - W + 1);
        if (x > 0 && y < H - 1) push(i + W - 1);
        if (x < W - 1 && y < H - 1) push(i + W + 1);
      }
    }
    area.push(a); box.push([x0, y0, x1, y1]);
  }
  return { lab, count, area, box };
}

function traceErode(m, W, H) {
  const out = new Uint8Array(m.length);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1, i = y * W + 1; x < W - 1; x++, i++) {
      out[i] = m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W] ? 1 : 0;
    }
  }
  return out;
}

function traceDilate(m, W, H) {
  const out = new Uint8Array(m.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0, i = y * W; x < W; x++, i++) {
      out[i] = m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W]) ? 1 : 0;
    }
  }
  return out;
}

// One component (label l in lab, box bb) -> its parts: [{ mask, x0, y0, w, h, area }].
// Holes are filled first. Touching holds are split where the distance map has more
// than one strong peak with a narrow neck between them.
function traceSplit(lab, W, l, bb, o, line) {
  const pad = 2 + Math.max(0, o.grow);
  const x0 = Math.max(0, bb[0] - pad), y0 = Math.max(0, bb[1] - pad);
  const w = bb[2] - bb[0] + 1 + 2 * pad, h = bb[3] - bb[1] + 1 + 2 * pad;
  const n = w * h, m = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < W && sy * W + sx < lab.length && lab[sy * W + sx] === l) m[y * w + x] = 1;
    }
  }
  traceFillHoles(m, w, h);
  const dist = traceDistance(m, w, h);
  let peak = 0;
  for (let i = 0; i < n; i++) if (dist[i] > peak) peak = dist[i];
  const parts = traceWatershed(m, dist, w, h, peak, o.splitRatio);
  const H = lab.length / W;
  return parts.map(pm => {
    let pmask = pm;
    if (line && o.trimToOutline) pmask = traceTrim(pmask, w, h, x0, y0, W, H, line, o.trimMin);
    for (let k = 0; k < o.grow; k++) pmask = traceDilate(pmask, w, h);
    for (let k = 0; k < -o.grow; k++) pmask = traceErode(pmask, w, h);
    let a = 0;
    for (let i = 0; i < n; i++) a += pmask[i];
    return { mask: pmask, x0, y0, w, h, area: a };
  }).filter(p => p.area > 0);
}

// Trim a shape to its own outline: when the dark outline (with the image's edge,
// where a hold is cut off) encloses most of the shape, what lies outside it (a soft
// shadow on white) is cut off. An outline with gaps encloses little: left alone.
function traceTrim(m, w, h, x0, y0, W, H, line, trimMin) {
  const n = w * h;
  let ln = new Uint8Array(n), area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, sx = x0 + x, sy = y0 + y;
      if (!m[i]) continue;
      area++;
      if (sx >= W || sy >= H || line[sy * W + sx] || sx === 0 || sy === 0 || sx === W - 1 || sy === H - 1) ln[i] = 1;
    }
  }
  ln = traceDilate(ln, w, h);
  traceFillHoles(ln, w, h);
  let ea = 0;
  for (let i = 0; i < n; i++) { ln[i] = ln[i] && m[i] ? 1 : 0; ea += ln[i]; }
  return ea >= trimMin * area ? ln : m;
}

function traceFillHoles(m, w, h) {
  const out = new Uint8Array(m.length), stack = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    if (out[i] || m[i]) continue;
    out[i] = 1;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < m.length - w) stack.push(i + w);
  }
  for (let i = 0; i < m.length; i++) m[i] = out[i] ? 0 : 1;
}

// Chamfer distance (3-4) to the nearest background pixel, in pixels.
function traceDistance(m, w, h) {
  const d = new Float32Array(w * h), INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

// A flooding watershed on the distance map: pixels are visited from the highest
// distance down; each joins a neighbouring basin, or starts a new one. When two
// basins meet, they merge unless both peaks stand well above the meeting level
// (the neck is under splitRatio of the smaller peak): those are two holds touching.
function traceWatershed(m, dist, w, h, peak, ratio) {
  const n = w * h, idx = [];
  for (let i = 0; i < n; i++) if (m[i]) idx.push(i);
  if (peak < 4) return [m];
  idx.sort((a, b) => dist[b] - dist[a]);
  const basin = new Int32Array(n), parent = [0], top = [0];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const walls = [];
  for (const i of idx) {
    const x = i % w, lvl = dist[i];
    const nb = [];
    if (x > 0 && basin[i - 1]) nb.push(find(basin[i - 1]));
    if (x < w - 1 && basin[i + 1]) nb.push(find(basin[i + 1]));
    if (i >= w && basin[i - w]) nb.push(find(basin[i - w]));
    if (i < n - w && basin[i + w]) nb.push(find(basin[i + w]));
    if (!nb.length) { const id = parent.length; parent.push(id); top.push(lvl); basin[i] = id; continue; }
    let a = nb[0];
    for (let k = 1; k < nb.length; k++) {
      const c = nb[k];
      if (c === a) continue;
      const lo = Math.min(top[a], top[c]);
      if (lo >= 5 && lvl < ratio * lo) { walls.push(i); continue; }   // two holds: keep apart
      // merge the smaller peak into the bigger
      if (top[c] > top[a]) { parent[a] = c; a = c; } else parent[c] = a;
    }
    basin[i] = a;
  }
  const groups = new Map();
  for (const i of idx) {
    const r0 = find(basin[i]);
    if (!groups.has(r0)) groups.set(r0, new Uint8Array(n));
    groups.get(r0)[i] = 1;
  }
  const out = [...groups.values()];
  if (out.length < 2) return [m];
  return out;
}

// A part's outer boundary -> a smoothed, simplified polygon in image pixels.
function traceOutline(part, o) {
  const { mask, w, h, x0, y0 } = part;
  // the biggest 8-connected piece only
  const lab = traceLabel(mask, w, h, 8);
  let best = 1;
  for (let l = 2; l <= lab.count; l++) if (lab.area[l] > lab.area[best]) best = l;
  if (!lab.count) return null;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = lab.lab[i] === best ? 1 : 0;
  const ring = traceBoundary(m, w, h);
  if (ring.length < 6) return null;
  let sm = traceSmoothRing(ring, o.smoothSigma);
  if (o.inset) sm = traceInset(sm, o.inset);
  const simple = traceSimplify(sm, o.simplify);
  return simple.map(p => [p[0] + x0, p[1] + y0]);
}

// Moore-neighbour boundary trace; points at pixel corners' centres (+0.5).
function traceBoundary(m, w, h) {
  let s = -1;
  for (let i = 0; i < m.length; i++) if (m[i]) { s = i; break; }
  if (s < 0) return [];
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x];
  const dx = [1, 1, 0, -1, -1, -1, 0, 1], dy = [0, 1, 1, 1, 0, -1, -1, -1];
  const sx = s % w, sy = (s - sx) / w;
  const pts = [[sx + 0.5, sy + 0.5]];
  let x = sx, y = sy, dir = 7, guard = 0;
  do {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;            // start left of the way we came
      const nx = x + dx[d], ny = y + dy[d];
      if (at(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; }
    }
    if (!found) break;
    if (x === sx && y === sy) break;
    pts.push([x + 0.5, y + 0.5]);
  } while (++guard < 200000);
  return pts;
}

// Move each point of a ring along its inward normal by d pixels.
function traceInset(pts, d) {
  const n = pts.length;
  let a = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  const sgn = a > 0 ? 1 : -1;               // orientation: inward is to the left or right
  return pts.map((p, i) => {
    const pr = pts[(i - 1 + n) % n], nx = pts[(i + 1) % n];
    let tx = nx[0] - pr[0], ty = nx[1] - pr[1];
    const L = Math.hypot(tx, ty) || 1;
    tx /= L; ty /= L;
    return [p[0] - sgn * ty * d, p[1] + sgn * tx * d];
  });
}

function traceSmoothRing(pts, sigma) {
  const n = pts.length;
  if (sigma <= 0 || n < 5) return pts;
  const rad = Math.ceil(sigma * 2.5), wts = [];
  let sum = 0;
  for (let k = -rad; k <= rad; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); wts.push(v); sum += v; }
  return pts.map((_, i) => {
    let x = 0, y = 0;
    for (let k = -rad; k <= rad; k++) {
      const p = pts[((i + k) % n + n) % n], v = wts[k + rad];
      x += p[0] * v; y += p[1] * v;
    }
    return [x / sum, y / sum];
  });
}

// Ramer–Douglas–Peucker on a closed ring.
function traceSimplify(pts, tol) {
  const n = pts.length;
  if (n < 8) return pts;
  // split at the point farthest from the first
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const rdp = (a) => {
    if (a.length < 3) return a;
    const [p, q] = [a[0], a[a.length - 1]];
    const vx = q[0] - p[0], vy = q[1] - p[1], L = Math.hypot(vx, vy) || 1;
    let mi = -1, md = -1;
    for (let i = 1; i < a.length - 1; i++) {
      const d = Math.abs(vx * (p[1] - a[i][1]) - vy * (p[0] - a[i][0])) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md <= tol) return [p, q];
    const l = rdp(a.slice(0, mi + 1)), rr = rdp(a.slice(mi));
    return l.slice(0, -1).concat(rr);
  };
  const a = rdp(pts.slice(0, far + 1)), b = rdp(pts.slice(far).concat([pts[0]]));
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function tracePolyCentre(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    pts.forEach(p => { sx += p[0]; sy += p[1]; });
    return [sx / pts.length, sy / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function tracePolyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function tracePointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ── the prior: today's outlines as a guide (board setup on a board that has holds) ──
// tracePriorFit() moves one known outline (today's, mapped onto the cartoon) to where
// the cartoon's hold is: translation, a little scale and rotation (±45°), coarse then
// fine, scored on the trace's masks: inside on the foreground, a ring just outside on
// the background, the outline itself on a dark line. traceTap() traces just the hold
// under a tap. Both are pure: tools/trace_prior_score.js scores them in Node.
const TRACE_PRIOR = {
  rot: 45,            // the rotation searched, degrees either way
  scale: 0.25,        // the scale searched, either way
  nIn: 140,           // about this many interior samples a shape
  nEdge: 72,          // samples along the outline (and the ring outside it)
  wIn: 0.45, wOut: 0.35, wEdge: 0.2,   // the score's weights
  pull: 0.12,         // a penalty for straying from the mapped spot (at the band's edge)
  tapWin: 0.06,       // traceTap's window, either side, as a share of the image's long side
};

// The masks' line pixels grown by two (the outline as drawn is a few pixels wide).
function tracePriorLineNear(masks) {
  if (!masks.lineNear) masks.lineNear = traceDilate(traceDilate(masks.line, masks.W, masks.H), masks.W, masks.H);
  return masks.lineNear;
}

// Samples of a polygon, relative to its centre: inside (a grid), on the outline, and a
// ring `ringD` px outside it.
function tracePriorSamples(pts, ringD, nIn, nEdge) {
  const c = tracePolyCentre(pts), bb = traceBBox(pts), area = Math.max(1, tracePolyArea(pts));
  const step = Math.max(0.75, Math.sqrt(area / nIn));
  const inn = [];
  for (let y = bb[1] + step / 2; y < bb[3]; y += step) {
    for (let x = bb[0] + step / 2; x < bb[2]; x += step) if (tracePointInPoly(x, y, pts)) inn.push(x - c[0], y - c[1]);
  }
  // the outline resampled evenly, with its outward normals
  const n = pts.length, seg = [];
  let per = 0, a2 = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    seg.push(L); per += L; a2 += p[0] * q[1] - q[0] * p[1];
  }
  const sgn = a2 > 0 ? 1 : -1, edge = [], ring = [];
  for (let k = 0, i = 0, acc = 0; k < nEdge; k++) {
    const t = k / nEdge * per;
    while (i < n - 1 && acc + seg[i] < t) { acc += seg[i]; i++; }
    const p = pts[i], q = pts[(i + 1) % n], f = seg[i] ? (t - acc) / seg[i] : 0;
    const x = p[0] + (q[0] - p[0]) * f, y = p[1] + (q[1] - p[1]) * f;
    const L = seg[i] || 1, tx = (q[0] - p[0]) / L, ty = (q[1] - p[1]) / L;
    edge.push(x - c[0], y - c[1]);
    ring.push(x + sgn * ty * ringD - c[0], y - sgn * tx * ringD - c[1]);
  }
  return { c, inn: Float32Array.from(inn), edge: Float32Array.from(edge), ring: Float32Array.from(ring) };
}

// Agreement (0..1) of the samples placed at (cx, cy), rotated (cos, sin) and scaled.
function tracePriorScore(S, masks, near, o, cx, cy, cs, sn, sc) {
  const { fg, W, H } = masks;
  let fi = 0, fo = 0, fe = 0;
  const a = sc * cs, b = sc * sn;
  for (let i = 0; i < S.inn.length; i += 2) {
    const x = (cx + a * S.inn[i] - b * S.inn[i + 1]) | 0, y = (cy + b * S.inn[i] + a * S.inn[i + 1]) | 0;
    if (x >= 0 && y >= 0 && x < W && y < H && fg[y * W + x]) fi++;
  }
  for (let i = 0; i < S.ring.length; i += 2) {
    const x = (cx + a * S.ring[i] - b * S.ring[i + 1]) | 0, y = (cy + b * S.ring[i] + a * S.ring[i + 1]) | 0;
    if (x < 0 || y < 0 || x >= W || y >= H || !fg[y * W + x]) fo++;
  }
  for (let i = 0; i < S.edge.length; i += 2) {
    const x = (cx + a * S.edge[i] - b * S.edge[i + 1]) | 0, y = (cy + b * S.edge[i] + a * S.edge[i + 1]) | 0;
    if (x >= 0 && y >= 0 && x < W && y < H && near[y * W + x]) fe++;
  }
  return o.wIn * fi / Math.max(1, S.inn.length / 2) + o.wOut * fo / Math.max(1, S.ring.length / 2)
       + o.wEdge * fe / Math.max(1, S.edge.length / 2);
}

// pts: the outline mapped onto the image (px); band: how far (px) the hold may be from
// it. -> { pts, score, score0 (as mapped), rot (deg), scale, dx, dy }
function tracePriorFit(masks, pts, band, opts) {
  const o = Object.assign({}, TRACE_PRIOR, opts || {});
  const near = tracePriorLineNear(masks);
  const k = Math.max(masks.W, masks.H) / TRACE_REF;
  const S = tracePriorSamples(pts, 3 * k, o.nIn, o.nEdge);
  const [c0x, c0y] = S.c;
  const rad = d => d * Math.PI / 180;
  const ev = (dx, dy, r, sc) => tracePriorScore(S, masks, near, o, c0x + dx, c0y + dy, Math.cos(rad(r)), Math.sin(rad(r)), sc)
    - o.pull * (dx * dx + dy * dy) / (band * band);
  const score0 = ev(0, 0, 0, 1);
  // 1 where: translation only, on a grid over the band
  const s1 = Math.max(2, band / 12), top = [];
  for (let dy = -band; dy <= band + 1e-9; dy += s1) {
    for (let dx = -band; dx <= band + 1e-9; dx += s1) {
      if (dx * dx + dy * dy > band * band * 1.0001) continue;
      top.push([ev(dx, dy, 0, 1), dx, dy]);
    }
  }
  top.sort((a, b) => b[0] - a[0]);
  // 2 how it's turned: rotation and scale, coarse, at the best two spots
  let best = [top[0][0], top[0][1], top[0][2], 0, 1];
  const scales = [1 - o.scale, 1 - o.scale / 2, 1, 1 + o.scale / 2, 1 + o.scale];
  top.slice(0, 2).forEach(([, tx, ty]) => {
    for (let r = -o.rot; r <= o.rot; r += 5) {
      for (const sc of scales) { const v = ev(tx, ty, r, sc); if (v > best[0]) best = [v, tx, ty, r, sc]; }
    }
  });
  // 3 fine: two pixels then one, a degree, 2% at a time, until nothing improves
  for (let it = 0, st = 2; it < 12; it++) {
    const [, bx, by, br, bs] = best;
    let moved = false;
    for (const dr of [-2, -1, 0, 1, 2]) {
      for (const ds of [-0.02, 0, 0.02]) {
        const sc = Math.max(1 - o.scale, Math.min(1 + o.scale, bs + ds)), r = Math.max(-o.rot - 5, Math.min(o.rot + 5, br + dr));
        for (let jy = -1; jy <= 1; jy++) {
          for (let jx = -1; jx <= 1; jx++) {
            const v = ev(bx + jx * st, by + jy * st, r, sc);
            if (v > best[0] + 1e-9) { best = [v, bx + jx * st, by + jy * st, r, sc]; moved = true; }
          }
        }
      }
    }
    if (!moved) { if (st === 1) break; st = 1; }
  }
  const [score, dx, dy, rot, scale] = best;
  // the same fit without turning (from the best spot): how much the turn bought
  let flat = [ev(dx, dy, 0, scale), dx, dy, scale];
  for (let it = 0; it < 8; it++) {
    const [, bx, by, bs] = flat;
    let moved = false;
    for (const ds of [-0.02, 0, 0.02]) {
      const sc = Math.max(1 - o.scale, Math.min(1 + o.scale, bs + ds));
      for (let jy = -1; jy <= 1; jy++) {
        for (let jx = -1; jx <= 1; jx++) {
          const v = ev(bx + jx, by + jy, 0, sc);
          if (v > flat[0] + 1e-9) { flat = [v, bx + jx, by + jy, sc]; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
  const placed = tracePriorPlace(pts, S.c, dx, dy, rot, scale);
  // turnShape: how different the turn makes the outline (1 - IoU with it unturned): a
  // round hold turned 40° is the same shape
  const turnShape = Math.abs(rot) < 1 ? 0 : 1 - tracePolyIoU(placed, tracePriorPlace(pts, S.c, dx, dy, 0, scale));
  return { pts: placed, score, score0, rot, scale, dx, dy, turnGain: score - flat[0], turnShape };
}

// An outline moved by (dx, dy), turned by rot degrees and scaled about its centre c.
function tracePriorPlace(pts, c, dx, dy, rot, scale) {
  const cs = Math.cos(rot * Math.PI / 180) * scale, sn = Math.sin(rot * Math.PI / 180) * scale;
  return pts.map(p => {
    const ux = p[0] - c[0], uy = p[1] - c[1];
    return [c[0] + dx + cs * ux - sn * uy, c[1] + dy + sn * ux + cs * uy];
  });
}

function traceBBox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return [x0, y0, x1, y1];
}

// A polygon filled into a w × h grid whose top left is (x0, y0) (pixel centres, even-odd).
function traceRaster(pts, x0, y0, w, h) {
  const m = new Uint8Array(w * h), n = pts.length, xs = [];
  for (let y = 0; y < h; y++) {
    const py = y0 + y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > py) !== (b[1] > py)) xs.push(a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const s = Math.max(0, Math.ceil(xs[k] - x0 - 0.5)), e = Math.min(w - 1, Math.floor(xs[k + 1] - x0 - 0.5));
      for (let x = s; x <= e; x++) m[y * w + x] = 1;
    }
  }
  return m;
}

// Overlap of two polygons: intersection / union of their areas (pixels).
function tracePolyIoU(a, b) {
  const A = traceBBox(a), B = traceBBox(b);
  if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) return 0;
  const x0 = Math.floor(Math.min(A[0], B[0])), y0 = Math.floor(Math.min(A[1], B[1]));
  const w = Math.ceil(Math.max(A[2], B[2])) - x0 + 1, h = Math.ceil(Math.max(A[3], B[3])) - y0 + 1;
  const ma = traceRaster(a, x0, y0, w, h), mb = traceRaster(b, x0, y0, w, h);
  let i = 0, u = 0;
  for (let k = 0; k < ma.length; k++) { if (ma[k] & mb[k]) i++; if (ma[k] | mb[k]) u++; }
  return u ? i / u : 0;
}

// The share of polygon a's area that lies inside polygon b.
function tracePolyCover(a, b) {
  const A = traceBBox(a), B = traceBBox(b);
  if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) return 0;
  const x0 = Math.floor(A[0]), y0 = Math.floor(A[1]), w = Math.ceil(A[2]) - x0 + 1, h = Math.ceil(A[3]) - y0 + 1;
  const ma = traceRaster(a, x0, y0, w, h), mb = traceRaster(b, x0, y0, w, h);
  let i = 0, n = 0;
  for (let k = 0; k < ma.length; k++) { if (ma[k]) { n++; if (mb[k]) i++; } }
  return n ? i / n : 0;
}

// Trace just the hold under a tap at (x, y) px, on the masks of a whole trace: the
// foreground piece there (split from any hold touching it and trimmed to its own
// outline, as the trace does), or, where that leaks into the background or is far
// bigger than opts.maxArea, the area inside the dark outline grown out over it.
// -> the outline (px), or null.
function traceTap(masks, x, y, opts) {
  const { fg, line, W, H } = masks, o = traceOpts(W, H, Object.assign({}, TRACE_PRIOR, opts || {}));
  const maxA = Math.min(o.maxHold * W * H, o.maxArea || Infinity);
  let half = Math.round(o.tapWin * Math.max(W, H));
  const cx = Math.round(x), cy = Math.round(y);
  for (let tries = 0; tries < 2; tries++, half *= 2) {
    const x0 = Math.max(0, cx - half), y0 = Math.max(0, cy - half), x1 = Math.min(W, cx + half + 1), y1 = Math.min(H, cy + half + 1);
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3) return null;
    const m = new Uint8Array(w * h), ln = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) { const j = (y0 + yy) * W + x0 + xx; m[yy * w + xx] = fg[j]; ln[yy * w + xx] = line[j]; }
    }
    const seed = traceNearest(m, w, h, cx - x0, cy - y0, Math.max(3, o.lineRadius * 2));
    if (seed < 0) return null;
    const lab = traceLabel(m, w, h, 4), l = lab.lab[seed], bb = lab.box[l];
    const edge = (bb[0] === 0 && x0 > 0) || (bb[1] === 0 && y0 > 0) || (bb[2] === w - 1 && x1 < W) || (bb[3] === h - 1 && y1 < H);
    if (edge && tries === 0) continue;
    if (!edge && lab.area[l] <= maxA * 1.5) {
      const parts = traceSplit(lab.lab, w, l, bb, o, ln);
      const sx = seed % w, sy = (seed - sx) / w;
      let part = parts.find(p => { const px = sx - p.x0, py = sy - p.y0; return px >= 0 && py >= 0 && px < p.w && py < p.h && p.mask[py * p.w + px]; });
      if (!part) part = parts.sort((a, b) => b.area - a.area)[0];
      if (part && part.area <= maxA) {
        const pts = traceOutline(part, o);
        if (pts && pts.length >= 3) return pts.map(p => [p[0] + x0, p[1] + y0]);
      }
    }
    // it leaks (or it's far too big): inside the outline only, then out over the line
    const inner = new Uint8Array(w * h);
    for (let i = 0; i < inner.length; i++) inner[i] = m[i] && !ln[i] ? 1 : 0;
    // the piece with most pixels near the tap (a tap on a bolt hole's dark ring would
    // otherwise pick the speck inside it), not leaking out of the window
    const lab2 = traceLabel(inner, w, h, 4), R = Math.max(4, o.lineRadius * 4), cnt = new Map();
    for (let yy = Math.max(0, cy - y0 - R); yy <= Math.min(h - 1, cy - y0 + R); yy++) {
      for (let xx = Math.max(0, cx - x0 - R); xx <= Math.min(w - 1, cx - x0 + R); xx++) {
        const l = lab2.lab[yy * w + xx];
        if (l && (xx - cx + x0) ** 2 + (yy - cy + y0) ** 2 <= R * R) cnt.set(l, (cnt.get(l) || 0) + 1);
      }
    }
    let l2 = 0, bc = 0;
    cnt.forEach((c, l) => {
      const b = lab2.box[l];
      const out = (b[0] === 0 && x0 > 0) || (b[1] === 0 && y0 > 0) || (b[2] === w - 1 && x1 < W) || (b[3] === h - 1 && y1 < H);
      if (!out && lab2.area[l] <= maxA && c > bc) { bc = c; l2 = l; }
    });
    if (!l2) { if (tries === 0) continue; return null; }
    let mm = new Uint8Array(w * h);
    for (let i = 0; i < mm.length; i++) mm[i] = lab2.lab[i] === l2 ? 1 : 0;
    traceFillHoles(mm, w, h);
    for (let k = 0; k <= o.lineRadius; k++) mm = traceDilate(mm, w, h);
    const pts = traceOutline({ mask: mm, w, h, x0: 0, y0: 0 }, o);
    return pts && pts.length >= 3 ? pts.map(p => [p[0] + x0, p[1] + y0]) : null;
  }
  return null;
}

// The index of the set pixel of m nearest (x, y), within r; -1 if none.
function traceNearest(m, w, h, x, y, r) {
  let best = -1, bd = Infinity;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      if (!m[yy * w + xx]) continue;
      const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (d < bd && d <= r * r) { bd = d; best = yy * w + xx; }
    }
  }
  return best;
}

// A closed outline drawn as the app draws it (Catmull-Rom with tension s, as
// smoothShapePath in core.js), sampled 8 points a segment.
function traceCurve(pts, s) {
  const n = pts.length, k = s / 6, out = [];
  if (n < 3 || !s) return pts.map(p => [p[0], p[1]]);
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
