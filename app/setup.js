// ProjectBoard - ordered classic <script>s sharing ONE global scope (no ES modules, no
// build step). Order: state, core, problems, admin, account, authoring, circuits,
// challenge, leaderboard, wall, trace, setup, holdedit, app. This file: Board setup
// (#setup, admins), session 2a of docs/board-setup-plan.md. The hold editor (Edit holds,
// the step 'edit') lives in holdedit.js and uses this file's stage and gestures.
//
// The flow, one step at a time, on a phone:
//   start    the board as it is (holds, footholds, its corners), a saved draft to carry
//            on with, and Undo for the last publish (db/42 admin_undo_board)
//   photos   the straight-on photo and the cartoon (same framing), scaled down and
//            uploaded to the 'board' bucket (admin-only writes) under setup/
//   corners  the board's four corners on the cartoon and the photo (the trace's area,
//            saved to board_config.corners)
//   lineup   the first time only (board_config has no corners yet): four hand holds
//            tapped on today's board image (it's cropped, so its corners can't be
//            marked), then the same four on the cartoon, in the same order
//   trace    the holds auto-traced on the cartoon (trace.js), then matched to today's
//            holds: a first guess through a homography (the line-up's four point pairs,
//            or on a later run today's corners -> board -> the cartoon's corners),
//            refined by an affine fit to the first matches: each hand hold keeps its
//            id, name and LED
//            With today's hand holds as a prior (bsPrior), every hold's outline is
//            fitted where it is on the cartoon, and only the exceptions are left to check
//   review   the exceptions first (flagged or turned hand holds, new footholds); any
//            shape: a hand hold (fix its match), a foothold, or deleted; Tap to trace,
//            use the fitted shape, add, move, turn or redraw any outline. Every hand hold
//            needs exactly one shape.
//   mirror   pairs by reflecting about the board's centre line, nearest hold of the
//            same kind (never hand <-> foot); hand pairs that differ from today's are
//            flagged and keep today's unless changed
//   publish  one transaction (admin_publish_board): positions, outlines and pairs in
//            the holds table, footholds FT1, FT2… (left to right, bottom row first),
//            the cartoon as the board image, the old board saved for Undo
// The draft (paths, corners, shapes, pairs) is saved on this device as it goes; the
// images live in Storage, so a draft can be carried on after a reload.

const BS_WALL = 'HangoutPortland';
const BS_DRAFT = 'pb-board-setup';
const BS_DRAFT_V = 2;            // the draft's format: 2 since the prior-guided trace (10 Nov 2026)
const BS_CARTOON_MAX = 2000;     // the cartoon is stored (and shown in the app) at most this many px across
const BS_PHOTO_MAX = 3000;       // the photo, for camera LED mapping (2b)
const BS_MATCH = 0.025;          // a shape matches a hold within this share of the board's width
const BS_PAIR = 0.03;            // a reflection finds its partner within this share of the board's width
const BS_STEPS = ['start', 'photos', 'corners', 'lineup', 'trace', 'review', 'mirror', 'publish'];
const BS_STEP_NAMES = { photos: 'Photos', corners: 'Corners', lineup: 'Line up', trace: 'Trace', review: 'Review', mirror: 'Mirror pairs', publish: 'Publish' };
const BS_LU_SPREAD = 0.08;       // line-up: the smallest triangle of the four holds, as a share of the hand holds' box
const BS_CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];

const BS = {
  step: 'start',
  live: null,          // { holds: rows, corners, photo, image, version, versions }
  loading: false,
  img: {},             // kind ('cartoon' | 'photo' | 'current') -> { bmp, w, h, path, file }
  corners: {},         // kind -> [[x%, y%] × 4]  (TL, TR, BR, BL)
  cornerKind: 'cartoon',
  lineup: { cur: [null, null, null, null], cart: [null, null, null, null] },  // hold ids on today's image; [x%, y%] on the cartoon
  luKind: 'current',   // the line-up's picture: 'current' (today's board) | 'cartoon'
  luSel: 0,            // the line-up slot the next tap fills (0-3), or null
  shapes: [],          // [{ key, pts: [[x%, y%]…], kind: 'hand'|'foot'|'extra', id }]
  seq: 0,
  pred: {},            // hold id -> predicted [x%, y%] on the cartoon (from today's board)
  mirror: null,        // hold id -> partner id (hand: itself = stays put; foot: null = none)
  flags: [],           // [{ id, today, reflection }] hand pairs the reflection disagrees with
  sel: null,           // a shape key, or 'hold:<id>' (a hand hold with no shape)
  tool: null,          // 'draw' | 'redraw' | 'move' | 'pair' | null
  undo: [],
  traced: false,
  xf: null,            // today's image % -> cartoon % (bsMatch)
  fits: {},            // hand hold id -> today's outline fitted on the cartoon [[x%, y%]…] (bsPrior)
  stats: null,         // what the prior did: { traced, fitted, flag, changed, feet, dropped, ms }
  masks: null,         // the trace's masks (Tap to trace), at the trace's size; not saved
  busy: false,
  confirmUndo: 0,
  v: { s: 1, tx: 0, ty: 0, fitW: 0, sw: 0, sh: 0 },
  ptrs: new Map(),
  g: null,             // the gesture under way
};

// ── small helpers ─────────────────────────────────────────────────────────────
const bsEl = id => document.getElementById(id);
const bsR2 = v => Math.round(v * 100) / 100;
const bsClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bsImgKind = () => (BS.step === 'corners' ? BS.cornerKind : BS.step === 'lineup' ? BS.luKind : BS.step === 'edit' ? 'edit' : 'cartoon');
const bsCur = () => BS.img[bsImgKind()];
const bsShape = key => BS.shapes.find(s => s.key === key) || null;
const bsShapeOf = id => BS.shapes.find(s => s.id === id) || null;
const bsLiveHand = () => (BS.live ? BS.live.holds.filter(h => h.kind === 'hand') : []);
const bsName = id => {
  const h = BS.live && BS.live.holds.find(r => r.id === id);
  if (h) return h.name;
  const s = bsShapeOf(id);
  return (s && s.name) || id;
};

function bsCentre(pts) { return tracePolyCentre(pts); }

// Linear solve (Gaussian elimination, partial pivoting); null if singular.
function bsSolve(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// The homography taking four points `src` to four points `q`; src defaults to the unit
// square (0,0) (1,0) (1,1) (0,1), so a quad (TL, TR, BR, BL) gives board (u, v) -> image.
function bsHom(q, src = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = q[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const h = bsSolve(A, b);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}
function bsHomApply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
function bsHomInv(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
          B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
          C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
// % of an image -> board (u, v) in 0..1 through that image's corners, and back.
function bsToBoard(kind, x, y) {
  const H = bsHomInv(bsHom(BS.corners[kind]));
  return bsHomApply(H, x, y);
}
// Pixel size of the board on the cartoon (for distances that mean the same both ways).
function bsBoardPx() {
  const q = BS.corners.cartoon, im = BS.img.cartoon;
  if (!q || !im) return { w: 1, h: 1 };
  return bsQuadPx(q, im.w, im.h);
}
// The pixel size of the board inside corners q (%) of an image w × h.
function bsQuadPx(q, w, h) {
  const px = p => [p[0] / 100 * w, p[1] / 100 * h];
  const [a, b, c, d] = q.map(px);
  return { w: (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - d[0], c[1] - d[1])) / 2,
           h: (Math.hypot(d[0] - a[0], d[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2 };
}

// ── the draft (this device) ───────────────────────────────────────────────────
function bsSave() {
  if (BS.step === 'start' || BS.step === 'edit') return;   // the hold editor keeps its own draft (holdedit.js)
  try {
    const img = {};
    Object.keys(BS.img).forEach(k => { const m = BS.img[k]; if (m && m.path) img[k] = { path: m.path, w: m.w, h: m.h }; });
    localStorage.setItem(BS_DRAFT, JSON.stringify({
      v: BS_DRAFT_V, t: Date.now(), step: BS.step, img, corners: BS.corners, shapes: BS.shapes, seq: BS.seq,
      xf: BS.xf, fits: BS.fits, stats: BS.stats,
      pred: BS.pred, mirror: BS.mirror, flags: BS.flags, traced: BS.traced, lineup: BS.lineup,
      version: BS.live && BS.live.version,
    }));
  } catch (e) { /* full or blocked: the draft lives in memory */ }
}
function bsDraft() {
  try { const d = JSON.parse(localStorage.getItem(BS_DRAFT) || 'null'); return d && d.t ? d : null; }
  catch (e) { return null; }
}
function bsDropDraft() { try { localStorage.removeItem(BS_DRAFT); } catch (e) {} }

// ── loading the live board ────────────────────────────────────────────────────
async function bsLoadLive() {
  BS.loading = true;
  const [h, bc, ver] = await Promise.all([
    sb.from('holds').select('id,name,kind,led,x,y,outline,mirror').eq('wall', BS_WALL).order('id').limit(2000),
    sb.from('board_config').select('*').eq('wall', BS_WALL).maybeSingle(),
    sb.from('board_versions').select('id,saved_at,reason,undone_at,board_updated_at').eq('wall', BS_WALL)
      .order('id', { ascending: false }).limit(20),
  ]);
  BS.loading = false;
  if (h.error || bc.error || !bc.data) {
    console.warn('board setup: load failed', h.error || bc.error);
    BS.live = null;
    return false;
  }
  BS.live = {
    holds: h.data || [], corners: bc.data.corners || null, photo: bc.data.photo_path || null,
    image: bc.data.image_path || null, version: bc.data.updated_at,
    versions: ver.error ? [] : (ver.data || []),
  };
  return true;
}

// The public URL of an object in the board bucket.
const bsUrl = path => `${SUPA_URL}/storage/v1/object/public/${BOARD_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function bsBitmapFromUrl(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('image ' + res.status);
  return createImageBitmap(await res.blob());
}

// A picked file -> a bitmap no bigger than `max` across, plus its JPEG for upload.
async function bsReadFile(file, max) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { bmp = await createImageBitmap(file); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
  const out = await createImageBitmap(c);
  return { bmp: out, w, h, blob, path: null };
}

// ── entry ─────────────────────────────────────────────────────────────────────
async function initSetup() {
  if (!BS.live && !BS.loading) {
    bsRender();
    await bsLoadLive();
  }
  bsRender();
}

function bsGo(step) {
  BS.step = step;
  BS.sel = null; BS.tool = null; BS.g = null;
  bsSave();
  bsRender();
  if (bsBoardStep()) requestAnimationFrame(() => bsLayout(false));
}
const bsBoardStep = () => ['corners', 'lineup', 'trace', 'review', 'mirror', 'publish', 'edit'].includes(BS.step);
// The line-up is needed only while today's board has no corners (the first run).
const bsNeedLineup = () => !!(BS.live && !BS.live.corners);
const bsSteps = () => BS_STEPS.filter(s => s !== 'lineup' || bsNeedLineup());

// ── rendering: the frame ──────────────────────────────────────────────────────
function bsRender() {
  const view = bsEl('view-setup');
  if (!view) return;
  const board = bsBoardStep();
  view.classList.toggle('bs-board', board);
  const steps = bsSteps(), i = steps.indexOf(BS.step);
  bsEl('bs-title').textContent = BS.step === 'start' ? 'Board setup' : BS.step === 'edit' ? 'Edit holds' : BS_STEP_NAMES[BS.step];
  bsEl('bs-stepno').textContent = BS.step === 'start' || BS.step === 'edit' ? '' : `${i} of ${steps.length - 1}`;
  if (!board) { bsRenderPage(); bsEl('bs-panel').innerHTML = ''; return; }
  bsEl('bs-page').innerHTML = '';
  bsDrawImage();
  bsRenderBoard();
  bsRenderPanel();
}

// The page steps: start and photos.
function bsRenderPage() {
  const el = bsEl('bs-page');
  if (BS.step === 'photos') { el.innerHTML = bsPhotosHtml(); return; }
  if (!BS.live) {
    el.innerHTML = BS.loading ? '<div class="spinner"></div>'
      : '<div class="state-msg"><div class="icon">⚠️</div>Couldn’t load the board.<br><button class="btn-block bs-mt" data-act="reload">Try again</button></div>';
    return;
  }
  const L = BS.live, hands = L.holds.filter(h => h.kind === 'hand').length, feet = L.holds.filter(h => h.kind === 'foot').length;
  const last = L.versions.find(v => v.reason === 'publish' && !v.undone_at);
  const draft = bsDraft();
  const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="bs-card">
      <div class="bs-card-title">The board now</div>
      <div class="bs-facts">
        <div><b>${hands}</b> hand holds</div>
        <div><b>${feet}</b> footholds</div>
        <div>Corners ${L.corners ? 'marked' : '<b>not marked yet</b>'}</div>
      </div>
      <p class="bs-muted">Publishing a new board keeps every hand hold’s name, LED and problems: only its position, outline and mirror partner change. Footholds come from the new photo.</p>
    </div>
    ${L.image && hands ? heStartCard() : ''}
    ${draft && draft.v !== BS_DRAFT_V ? `
    <div class="bs-card">
      <div class="bs-card-title">Your draft is from an older version</div>
      <p class="bs-muted">Saved on this phone ${escHtml(when(draft.t))}, at <b>${escHtml(BS_STEP_NAMES[draft.step] || draft.step)}</b>, with the cartoon you uploaded then. Board setup now uses today’s holds to trace the cartoon, so only the holds that changed are left to check. <b>Start again</b> to pick the photo and your final cartoon.</p>
      <div class="bs-row">
        <button class="ol-btn ol-publish" data-act="new">Start again</button>
        <button class="ol-btn" data-act="resume">Carry on with it</button>
      </div>
    </div>` : draft ? `
    <div class="bs-card">
      <div class="bs-card-title">Your draft</div>
      <p class="bs-muted">Saved on this phone ${escHtml(when(draft.t))}, at <b>${escHtml(BS_STEP_NAMES[draft.step] || draft.step)}</b>. To use a different cartoon, Start again below.</p>
      <div class="bs-row">
        <button class="ol-btn ol-publish" data-act="resume">Carry on</button>
        <button class="ol-btn" data-act="discard">Discard it</button>
      </div>
    </div>` : ''}
    <div class="bs-card">
      <div class="bs-card-title">Set up a new board</div>
      <p class="bs-muted">You’ll need a straight-on photo of the whole board, footholds included, and the cartoon made from it (same framing).</p>
      <button class="ol-btn ${draft ? '' : 'ol-publish'} bs-wide" data-act="new">${draft ? 'Start again (drops the draft)' : 'Start'}</button>
    </div>
    ${last ? `
    <div class="bs-card">
      <div class="bs-card-title">Undo the last publish</div>
      <p class="bs-muted">Puts back the board as it was before ${escHtml(when(last.saved_at))}: its image, positions, outlines, mirror pairs and footholds.</p>
      <button class="ol-btn bs-wide bs-danger" data-act="undo" id="bs-undo-btn">${BS.confirmUndo > Date.now() ? 'Tap again to undo' : 'Undo the last publish'}</button>
    </div>` : ''}`;
}

function bsPhotosHtml() {
  const tile = (kind, title, hint) => {
    const m = BS.img[kind];
    return `
      <label class="bs-pick ${m ? 'done' : ''}">
        <input type="file" accept="image/*" data-kind="${kind}" id="bs-file-${kind}" />
        <span class="bs-pick-thumb">${m ? `<canvas data-thumb="${kind}"></canvas>` : '<span class="bs-pick-plus">+</span>'}</span>
        <span class="bs-pick-text"><b>${title}</b><span>${m ? `${m.w} × ${m.h}${m.path ? ' · uploaded' : ''}` : hint}</span></span>
      </label>`;
  };
  const ready = BS.img.cartoon && BS.img.photo;
  return `
    <div class="bs-card">
      <p class="bs-muted">Both pictures need the same framing: the whole board, straight on, footholds included. They’re uploaded to the app’s storage (admins only can write there).</p>
      ${tile('photo', 'The photo', 'Straight on, even light')}
      ${tile('cartoon', 'The cartoon', 'Made from that photo')}
      <button class="ol-btn ol-publish bs-wide bs-mt" data-act="upload" ${ready && !BS.busy ? '' : 'disabled'}>${BS.busy ? 'Uploading…' : 'Upload and go on'}</button>
    </div>`;
}

function bsThumbs() {
  document.querySelectorAll('#bs-page canvas[data-thumb]').forEach(c => {
    const m = BS.img[c.dataset.thumb];
    if (!m || !m.bmp) return;
    const k = 120 / Math.max(m.w, m.h);
    c.width = Math.round(m.w * k); c.height = Math.round(m.h * k);
    c.getContext('2d').drawImage(m.bmp, 0, 0, c.width, c.height);
  });
}

// ── the board stage ───────────────────────────────────────────────────────────
function bsDrawImage() {
  if (BS.step === 'edit') { heDrawImage(); return; }
  const m = bsCur(), c = bsEl('bs-img');
  if (!m || !m.bmp) { c.width = 1; c.height = 1; return; }
  const key = (m.path || m.w + 'x' + m.h) + BS.step + bsImgKind();
  if (c.dataset.src === key && c.width === m.w) return;
  c.width = m.w; c.height = m.h;
  c.getContext('2d').drawImage(m.bmp, 0, 0);
  c.dataset.src = key;
  bsLayout(false);
}

function bsLayout(keep) {
  const st = bsEl('bs-stage'), m = bsCur();
  if (!st || !m) return;
  const sw = st.clientWidth, sh = st.clientHeight;
  if (!sw || !sh) return;
  const aspect = m.w / m.h, V = BS.v;
  const fitW = Math.max(100, Math.min(sw - 16, (sh - 16) * aspect));
  if (keep && V.fitW && V.sw) {
    const bx = (V.sw / 2 - V.tx) / (V.fitW * V.s), by = (V.sh / 2 - V.ty) / (V.fitW * V.s / V.aspect);
    V.fitW = fitW; V.aspect = aspect;
    V.tx = sw / 2 - bx * fitW * V.s; V.ty = sh / 2 - by * fitW * V.s / aspect;
  } else {
    V.fitW = fitW; V.aspect = aspect; V.s = 1;
    V.tx = (sw - fitW) / 2; V.ty = (sh - fitW / aspect) / 2;
  }
  V.sw = sw; V.sh = sh;
  bsApply();
}
const bsW = () => BS.v.fitW * BS.v.s;
const bsH = () => BS.v.fitW * BS.v.s / (BS.v.aspect || 1);
function bsClampView() {
  const V = BS.v, m = Math.min(V.sw, V.sh) * 0.4, w = bsW(), h = bsH();
  V.tx = w <= V.sw ? (V.sw - w) / 2 : Math.min(m, Math.max(V.sw - w - m, V.tx));
  V.ty = h <= V.sh ? (V.sh - h) / 2 : Math.min(m, Math.max(V.sh - h - m, V.ty));
}
function bsApply() {
  const wrap = bsEl('bs-canvas');
  if (!wrap) return;
  wrap.style.width = bsW() + 'px';
  wrap.style.height = bsH() + 'px';
  wrap.style.transform = `translate(${BS.v.tx}px,${BS.v.ty}px)`;
  bsRenderOver();
}
function bsZoomAt(s, sx, sy) {
  const V = BS.v, bx = (sx - V.tx) / bsW(), by = (sy - V.ty) / bsH();
  V.s = bsClamp(s, 1, Math.max(2, 12 * 400 / V.fitW));
  V.tx = sx - bx * bsW(); V.ty = sy - by * bsH();
  bsClampView();
}
function bsZoomTo(x, y, s) {
  const V = BS.v;
  V.s = bsClamp(s, 1, Math.max(2, 12 * 400 / V.fitW));
  V.tx = V.sw / 2 - x / 100 * bsW(); V.ty = V.sh / 2 - y / 100 * bsH();
  bsClampView(); bsApply();
}
function bsFit() { bsLayout(false); }
// stage px <-> image %
function bsStageXY(cx, cy) { const r = bsEl('bs-stage').getBoundingClientRect(); return [cx - r.left, cy - r.top]; }
function bsPct(cx, cy) { const [sx, sy] = bsStageXY(cx, cy); return [(sx - BS.v.tx) / bsW() * 100, (sy - BS.v.ty) / bsH() * 100]; }
function bsScreen(x, y) { return [BS.v.tx + x / 100 * bsW(), BS.v.ty + y / 100 * bsH()]; }

const bsPath = pts => pts.length ? 'M' + pts.map(p => `${bsR2(p[0])},${bsR2(p[1])}`).join('L') + 'Z' : '';

// The shapes (svg, % viewBox).
function bsRenderBoard() {
  const svg = bsEl('bs-svg');
  if (!svg) return;
  if (BS.step === 'corners') {
    const q = BS.corners[BS.cornerKind];
    svg.innerHTML = q ? `<path class="bs-quad" d="${bsPath(q)}"/>` : '';
    bsRenderOver();
    return;
  }
  if (BS.step === 'lineup') { svg.innerHTML = ''; bsRenderOver(); return; }
  if (BS.step === 'edit') { heRenderBoard(); return; }
  let out = '';
  const partner = BS.step === 'mirror' && BS.sel ? bsPartnerOf(bsShape(BS.sel)) : null;
  BS.shapes.forEach(s => {
    if (!s.pts || s.pts.length < 3) return;
    let cls = 'bs-s ' + s.kind;
    if (s.chk === 'cand') cls += ' cand';
    else if (s.chk && BS.step === 'review') cls += ' chk';
    if (s.key === BS.sel) cls += ' sel';
    if (partner && s.key === partner.key) cls += ' partner';
    if (BS.step === 'mirror' && s.kind === 'hand' && BS.flags.some(f => f.id === s.id)) cls += ' flag';
    out += `<path class="${cls}" d="${bsPath(s.pts)}"/>`;
  });
  if (BS.step === 'mirror' && BS.sel && partner && partner.key !== BS.sel) {
    const a = bsCentre(bsShape(BS.sel).pts), b = bsCentre(partner.pts);
    out += `<line class="bs-link" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }
  if (BS.g && BS.g.type === 'lasso' && BS.g.pts.length > 1) {
    out += `<polyline class="bs-lasso" points="${BS.g.pts.map(p => p.join(',')).join(' ')}"/>`;
  }
  svg.innerHTML = out;
  bsRenderOver();
}

// The overlay: corner handles, hand holds with no shape, the selected label.
function bsRenderOver() {
  const over = bsEl('bs-over');
  if (!over || !bsBoardStep()) return;
  let html = '';
  if (BS.step === 'corners') {
    const q = BS.corners[BS.cornerKind] || [];
    q.forEach((p, i) => {
      const [x, y] = bsScreen(p[0], p[1]);
      html += `<div class="bs-corner" style="left:${x}px;top:${y}px"><span>${i + 1}</span></div>`;
    });
  } else if (BS.step === 'lineup') {
    html = bsLuOver();
  } else if (BS.step === 'edit') {
    over.innerHTML = heOverHtml();
    return;
  } else if (BS.step === 'review') {
    bsMissing().forEach(id => {
      const p = BS.pred[id];
      if (!p) return;
      const [x, y] = bsScreen(p[0], p[1]);
      html += `<div class="bs-miss ${BS.sel === 'hold:' + id ? 'sel' : ''}" style="left:${x}px;top:${y}px">${escHtml(bsName(id))}</div>`;
    });
    const rh = bsRotHandle();
    if (rh) html += `<div class="bs-rot" style="left:${rh[0]}px;top:${rh[1]}px">↻</div>`;
  }
  const s = BS.sel && bsShape(BS.sel);
  if (s && s.pts.length && BS.step !== 'corners' && BS.step !== 'lineup') {
    const c = bsCentre(s.pts), top = Math.min(...s.pts.map(p => p[1]));
    const [x, y] = bsScreen(c[0], top);
    const label = s.kind === 'extra' ? 'Extra shape' : s.kind === 'foot' ? (s.name || 'Foothold') : bsName(s.id);
    html += `<div class="bs-label" style="left:${x}px;top:${y}px">${escHtml(label)}</div>`;
  }
  over.innerHTML = html;
}

// ── the panel (below the board) ───────────────────────────────────────────────
function bsCounts() {
  const hands = bsLiveHand().length;
  const matched = new Set(BS.shapes.filter(s => s.kind === 'hand').map(s => s.id)).size;
  return {
    hands, matched,
    missing: hands - matched,
    feet: BS.shapes.filter(s => s.kind === 'foot').length,
    extra: BS.shapes.filter(s => s.kind === 'extra').length,
    check: BS.shapes.filter(s => s.kind === 'hand' && s.chk).length,       // flagged or turned: to confirm
    cand: BS.shapes.filter(s => s.chk === 'cand').length,                   // new footholds not yet kept
    ok: BS.shapes.filter(s => s.kind === 'hand' && !s.chk).length,
  };
}
// What Review still asks for, in the order Next to fix goes through it.
function bsQueue() {
  const order = { flag: 0, changed: 1, cand: 2 };
  return BS.shapes.filter(s => s.chk).sort((a, b) => order[a.chk] - order[b.chk]);
}
const bsOpen = c => c.missing || c.extra || c.check || c.cand;
function bsTraceSummary() {
  const st = BS.stats;
  if (!st) return `Traced ${BS.shapes.length} shapes. Next, check them.`;
  const c = bsCounts();
  return `Traced from today’s holds: <b>${c.ok}</b> matched, <b>${c.check}</b> to check, <b>${c.feet}</b> footholds. Next, check them.`;
}
function bsMissing() {
  const have = new Set(BS.shapes.filter(s => s.kind === 'hand').map(s => s.id));
  return bsLiveHand().map(h => h.id).filter(id => !have.has(id));
}

function bsRenderPanel() {
  const p = bsEl('bs-panel');
  const back = `<button class="ol-btn" data-act="prev">Back</button>`;
  if (BS.step === 'corners') {
    const kinds = ['cartoon', 'photo'];
    const names = { cartoon: 'Cartoon', photo: 'Photo' };
    p.innerHTML = `
      <div class="bs-tabs">${kinds.map(k => `<button class="bs-tab ${k === BS.cornerKind ? 'on' : ''} ${BS.corners[k] ? 'done' : ''}" data-act="ckind" data-kind="${k}">${names[k]}</button>`).join('')}</div>
      <p class="bs-hint">Drag the four numbered corners onto the corners of the board, footholds included (1 top left, then clockwise). Pinch to zoom.</p>
      <div class="ol-row">${back}<button class="ol-btn ol-publish" data-act="next" ${kinds.every(k => BS.corners[k]) && !BS.busy ? '' : 'disabled'}>Next</button></div>`;
    return;
  }
  if (BS.step === 'lineup') { p.innerHTML = bsLuPanel(); return; }
  if (BS.step === 'trace') {
    p.innerHTML = `
      <p class="bs-hint">${BS.busy ? 'Tracing the holds… this takes a few seconds.' : BS.traced
        ? bsTraceSummary() : bsHasPriorHolds() ? 'Find every hold’s outline on the cartoon, starting from today’s holds. Only what changed is left to check.' : 'Find every hold’s outline on the cartoon. You can fix anything it gets wrong next.'}</p>
      <div class="ol-row">${back}<button class="ol-btn ol-publish" data-act="${BS.traced ? 'next' : 'trace'}" ${BS.busy ? 'disabled' : ''}>${BS.traced ? 'Next' : 'Trace the holds'}</button></div>
      ${BS.traced && !BS.busy ? '<div class="ol-row bs-mt"><button class="ol-btn" data-act="trace">Trace again (loses your fixes)</button></div>' : ''}`;
    return;
  }
  if (BS.step === 'review') { p.innerHTML = bsReviewPanel(); return; }
  if (BS.step === 'mirror') { p.innerHTML = bsMirrorPanel(); return; }
  if (BS.step === 'publish') { p.innerHTML = bsPublishPanel(); return; }
  if (BS.step === 'edit') { p.innerHTML = hePanel(); return; }
}

function bsReviewPanel() {
  const c = bsCounts();
  const back = `<button class="ol-btn" data-act="prev">Back</button>`;
  const status = `<div class="bs-status">
      ${BS.stats || c.check || c.cand
        ? `<span class="ok">${c.ok} matched</span><span class="${c.check ? 'bad' : 'ok'}">${c.check} to check</span><span>${c.feet} footholds${c.cand ? ` (${c.cand} new)` : ''}</span>${c.missing ? `<span class="bad">${c.missing} with no outline</span>` : ''}`
        : `<span class="${c.missing ? 'bad' : 'ok'}">${c.matched}/${c.hands} hand holds</span><span>${c.feet} footholds</span>`}
      ${c.extra ? `<span class="bad">${c.extra} extra</span>` : ''}
      <button class="bs-link-btn" data-act="nextissue" ${bsOpen(c) ? '' : 'disabled'}>Next to fix ›</button>
    </div>`;
  if (BS.tool === 'tap') {
    return status + `<p class="bs-hint">${BS.busy ? 'Getting the cartoon ready…' : 'Tap inside the hold to trace just that hold. Pinch to zoom first if it’s small.'}</p>
      <div class="ol-row"><button class="ol-btn" data-act="tool-off">Cancel</button></div>`;
  }
  if (BS.tool === 'draw' || BS.tool === 'redraw') {
    return status + `<p class="bs-hint">Draw round the hold with one finger (two fingers zoom).</p>
      <div class="ol-row"><button class="ol-btn" data-act="tool-off">Cancel</button></div>`;
  }
  if (BS.tool === 'move') {
    return status + `<p class="bs-hint">Drag the outline to move it; drag the ↻ handle to turn it.</p>
      <div class="ol-row"><button class="ol-btn ol-publish" data-act="tool-off">Done</button></div>`;
  }
  const tapBtn = `<button class="ol-btn" data-act="tap">Tap to trace</button>`;
  if (BS.sel && BS.sel.startsWith('hold:')) {
    const id = BS.sel.slice(5), nm = escHtml(bsName(id));
    return status + `<p class="bs-hint"><b>${nm}</b> has no outline yet. Tap to trace it, draw it, or pick an extra shape and make it ${nm}.</p>
      <div class="ol-row">${tapBtn}${BS.fits[id] ? `<button class="ol-btn" data-act="usefit">Use fitted shape</button>` : ''}<button class="ol-btn" data-act="draw-for">Draw ${nm}</button></div>
      <div class="ol-row"><button class="ol-btn" data-act="desel">Close</button></div>`;
  }
  const s = BS.sel && bsShape(BS.sel);
  if (s) {
    const opts = ['<option value="">Hand hold…</option>'].concat(
      bsMissing().map(id => `<option value="${escAttr(id)}">${escHtml(bsName(id))} (no outline)</option>`),
      bsLiveHand().filter(h => h.id !== s.id && !bsMissing().includes(h.id))
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
        .map(h => `<option value="${escAttr(h.id)}">${escHtml(h.name)}</option>`));
    const fit = s.kind === 'hand' && BS.fits[s.id] && s.src !== 'fitted';
    return status + bsCheckHint(s) + `
      <div class="ol-row"><select class="ol-jump" data-act="assign" aria-label="Make this shape a hand hold">${opts.join('')}</select>
        ${s.chk === 'cand' ? '' : `<button class="ol-btn ${s.kind === 'foot' ? 'on' : ''}" data-act="foot">${s.kind === 'foot' ? 'Foothold ✓' : 'Foothold'}</button>`}</div>
      <div class="ol-row">${tapBtn}${fit ? `<button class="ol-btn" data-act="usefit">Use fitted shape</button>` : ''}<button class="ol-btn" data-act="move">Move</button><button class="ol-btn" data-act="redraw">Redraw</button></div>
      <div class="ol-row"><button class="ol-btn bs-danger" data-act="delete">Delete</button><button class="ol-btn" data-act="desel">Close</button></div>`;
  }
  return status + `
    <div class="ol-row">${c.cand ? `<button class="ol-btn ol-publish" data-act="acceptall">Accept all unflagged (${c.cand} footholds)</button>` : ''}
      ${c.extra ? `<button class="ol-btn" data-act="extras-feet">All extras → footholds</button>` : ''}</div>
    <div class="ol-row">${tapBtn}<button class="ol-btn" data-act="draw">Add a shape</button>
      <button class="ol-btn" data-act="undo-edit" ${BS.undo.length ? '' : 'disabled'}>Undo</button></div>
    ${c.check ? `<p class="bs-hint">${c.check} hand hold${c.check === 1 ? '' : 's'} to check: tap <b>Next to fix ›</b>.</p>` : ''}
    <div class="ol-row">${back}<button class="ol-btn ol-publish" data-act="next" ${bsOpen(c) ? 'disabled' : ''}>Next</button></div>`;
}

// Why a shape is in the queue, and the button that settles it.
function bsCheckHint(s) {
  if (!s.chk) return '';
  const f = s.fit || {};
  let why;
  if (s.chk === 'cand') why = `A new foothold, found where no hand hold is. Keep it, or Delete it if it isn’t one.`;
  else if (s.chk === 'changed') why = `<b>${escHtml(bsName(s.id))}</b> looks turned (about ${Math.abs(f.turn || 0)}°)${f.grow && Math.abs(f.grow - 1) > 0.15 ? ' or resized' : ''} since today’s board. Check its outline${s.src === 'traced' ? ' (traced from the cartoon)' : ''}.`;
  else if ((f.score || 0) < 0.5) why = `Nothing like <b>${escHtml(bsName(s.id))}</b> was found here: is it on the cartoon? Its old outline is shown where it should be. Tap to trace or Draw it, or Move it.`;
  else why = `<b>${escHtml(bsName(s.id))}</b>: no clear outline on the cartoon, so today’s outline is shown fitted here. Check it, or Tap to trace it.`;
  return `<p class="bs-hint">${why}</p><div class="ol-row"><button class="ol-btn ol-publish" data-act="ok">${s.chk === 'cand' ? 'Keep this foothold' : 'Looks right'}</button></div>`;
}

function bsMirrorPanel() {
  const back = `<button class="ol-btn" data-act="prev">Back</button>`;
  const hand = BS.shapes.filter(s => s.kind === 'hand'), feet = BS.shapes.filter(s => s.kind === 'foot');
  const handPairs = hand.filter(s => BS.mirror[s.id] && BS.mirror[s.id] !== s.id).length / 2;
  const centre = hand.filter(s => !BS.mirror[s.id] || BS.mirror[s.id] === s.id).length;
  const footPairs = feet.filter(s => BS.mirror[s.id]).length / 2;
  const open = BS.flags.filter(f => BS.mirror[f.id] !== f.today);
  let html = `<div class="bs-status"><span>${handPairs} hand pairs · ${centre} stay put</span><span>${footPairs} foothold pairs · ${feet.length - footPairs * 2} unpaired</span></div>`;
  if (BS.flags.length) {
    html += `<div class="bs-flags"><p class="bs-hint"><b>${BS.flags.length}</b> hand hold${BS.flags.length === 1 ? '' : 's'} reflect${BS.flags.length === 1 ? 's' : ''} differently from today’s pairs. Today’s are kept unless you choose otherwise.</p>`
      + BS.flags.map(f => `<div class="bs-flag"><button class="bs-link-btn" data-act="showhold" data-id="${escAttr(f.id)}">${escHtml(bsName(f.id))}</button>
          <span>today ${escHtml(f.today === f.id ? 'itself' : bsName(f.today))}, reflection ${escHtml(f.reflection === f.id ? 'itself' : bsName(f.reflection))}</span>
          <button class="bs-mini ${BS.mirror[f.id] === f.reflection ? 'on' : ''}" data-act="flagpick" data-id="${escAttr(f.id)}" data-to="${BS.mirror[f.id] === f.reflection ? 'today' : 'reflection'}">${BS.mirror[f.id] === f.reflection ? 'Use today’s' : 'Use reflection'}</button></div>`).join('')
      + `</div>`;
  } else {
    html += `<p class="bs-hint">Every hand hold pairs the same as today. Tap a hold to see its partner.</p>`;
  }
  const s = BS.sel && bsShape(BS.sel);
  if (BS.tool === 'pair' && s) {
    html += `<p class="bs-hint">Tap the hold to pair with <b>${escHtml(s.kind === 'foot' ? s.name || 'this foothold' : bsName(s.id))}</b> (same kind only).</p>
      <div class="ol-row"><button class="ol-btn" data-act="tool-off">Cancel</button></div>`;
  } else if (s) {
    const p = bsPartnerOf(s);
    html += `<div class="ol-row"><span class="bs-sel-text">${escHtml(s.kind === 'foot' ? s.name || 'Foothold' : bsName(s.id))} ↔ ${p && p.key !== s.key ? escHtml(p.kind === 'foot' ? p.name || 'foothold' : bsName(p.id)) : 'no partner'}</span></div>
      <div class="ol-row"><button class="ol-btn" data-act="pair">Change partner</button><button class="ol-btn" data-act="unpair">No partner</button><button class="ol-btn" data-act="desel">Close</button></div>`;
  }
  html += `<div class="ol-row">${back}<button class="ol-btn ol-publish" data-act="next">Next</button></div>`;
  if (open.length) html = html.replace('<div class="bs-status">', `<div class="bs-status"><span class="bad">${open.length} changed from today</span>`);
  return html;
}

function bsPublishPanel() {
  const c = bsCounts(), problems = bsPublishProblems();
  const back = `<button class="ol-btn" data-act="prev">Back</button>`;
  const dropped = BS.live ? BS.live.holds.filter(h => h.kind === 'foot' && !bsShapeOf(h.id)).length : 0;
  return `
    <ul class="bs-checks">
      <li class="${c.missing ? 'bad' : 'ok'}">${c.matched} of ${c.hands} hand holds have one outline each (names and LEDs unchanged)</li>
      <li class="${c.extra ? 'bad' : 'ok'}">${c.extra ? c.extra + ' extra shapes left' : 'No extra shapes'}</li>
      ${c.check || c.cand ? `<li class="bad">${c.check + c.cand} shapes still to check in Review</li>` : ''}
      <li class="ok">${c.feet} footholds${c.feet ? `, FT1–FT${c.feet}` : ''}${dropped ? ` (${dropped} of today’s footholds weren’t found and will go)` : ''}</li>
      <li class="${problems.length ? 'bad' : 'ok'}">${problems.length ? escHtml(problems[0]) : 'Mirror pairs: every pair is two holds of the same kind'}</li>
      <li class="ok">The cartoon becomes the app’s board picture. Undo puts today’s back.</li>
    </ul>
    <div class="ol-row">${back}<button class="ol-btn ol-publish" data-act="publish" ${bsOpen(c) || problems.length || BS.busy ? 'disabled' : ''}>${BS.busy ? 'Publishing…' : 'Publish the board'}</button></div>`;
}

// ── steps: photos ─────────────────────────────────────────────────────────────
async function bsPickFile(input) {
  const kind = input.dataset.kind, f = input.files && input.files[0];
  if (!f) return;
  try {
    const m = await bsReadFile(f, kind === 'cartoon' ? BS_CARTOON_MAX : BS_PHOTO_MAX);
    BS.img[kind] = m;
    delete BS.corners[kind];
    if (kind === 'cartoon') { BS.shapes = []; BS.traced = false; BS.mirror = null; BS.xf = null; BS.fits = {}; BS.stats = null; BS.masks = null; }
  } catch (e) {
    console.warn('board setup: image', e);
    showToast('Couldn’t read that picture', 'error');
  }
  bsRender(); bsThumbs();
}

async function bsUpload() {
  if (BS.busy) return;
  BS.busy = true; bsRender(); bsThumbs();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  try {
    for (const kind of ['photo', 'cartoon']) {
      const m = BS.img[kind];
      if (m.path) continue;
      const path = `setup/${stamp}-${kind}.jpg`;
      const { error } = await sb.storage.from(BOARD_BUCKET).upload(path, m.blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw error;
      m.path = path;
    }
    BS.busy = false;
    bsDefaultCorners();
    BS.cornerKind = 'cartoon';
    bsGo('corners');
  } catch (e) {
    console.warn('board setup: upload', e);
    BS.busy = false;
    showToast('Upload failed: ' + (e && e.message ? e.message : 'check the connection'), 'error');
    bsRender(); bsThumbs();
  }
}

// ── steps: corners ────────────────────────────────────────────────────────────
function bsDefaultCorners() {
  const inset = [[4, 4], [96, 4], [96, 96], [4, 96]];
  ['cartoon', 'photo'].forEach(k => { if (!BS.corners[k]) BS.corners[k] = inset.map(p => p.slice()); });
}
function bsCornerKind(kind) {
  BS.cornerKind = kind;
  bsRender();
}

// ── steps: line up (the first run only) ───────────────────────────────────────
// Today's board image is cropped (no footholds section), so its corners aren't the
// board's. Instead: four hand holds tapped on it (snapped to the nearest hand hold),
// then the same four on the cartoon, in the same order. Their four point pairs give
// the homography (today's image % -> cartoon %) behind bsMatch()'s first guess.
const bsLuEmpty = () => ({ cur: [null, null, null, null], cart: [null, null, null, null] });
const bsLuHold = id => (BS.live && id ? BS.live.holds.find(h => h.id === id) : null) || null;
const bsLuFirstFree = arr => { const i = arr.indexOf(null); return i < 0 ? null : i; };
const bsLuCurDone = () => BS.lineup.cur.every(Boolean);
const bsLuReady = () => bsLuCurDone() && BS.lineup.cart.every(Boolean);
const bsLuOnImage = h => h.x != null && h.y != null && +h.x >= 0 && +h.x <= 100 && +h.y >= 0 && +h.y <= 100;

// Today's board image, loaded once (the app's current BOARD_IMG: the holds' x, y are % of it).
async function bsLuLoad() {
  if (BS.img.current) return true;
  try {
    const bmp = await bsBitmapFromUrl(BOARD_IMG);
    BS.img.current = { bmp, w: bmp.width, h: bmp.height, path: null };
    return true;
  } catch (e) {
    console.warn('board setup: today’s image', e);
    showToast('Couldn’t load today’s board image', 'error');
    return false;
  }
}
// The four today's-board points ([x%, y%]) of the picked holds.
const bsLuCurPts = () => BS.lineup.cur.map(id => { const h = bsLuHold(id); return h ? [+h.x, +h.y] : null; });

// Why these four won't do, or null. pts in % of an image w × h; ref = the area (px²) they
// should spread over. Too close, nearly in a line, or one inside the other three's
// triangle: a homography from them would swing wildly away from them.
function bsLuSpreadProblem(pts, w, h, ref) {
  const P = pts.map(p => [p[0] / 100 * w, p[1] / 100 * h]);
  const tri = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  const T = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
  const areas = T.map(([a, b, c]) => Math.abs(tri(P[a], P[b], P[c])));
  if (Math.min(...areas) < BS_LU_SPREAD * ref) return 'spread';
  // convex: no point inside the triangle of the other three
  for (let k = 0; k < 4; k++) {
    const o = [0, 1, 2, 3].filter(i => i !== k), whole = areas[T.findIndex(t => !t.includes(k))];
    const parts = Math.abs(tri(P[k], P[o[0]], P[o[1]])) + Math.abs(tri(P[k], P[o[1]], P[o[2]])) + Math.abs(tri(P[k], P[o[2]], P[o[0]]));
    if (parts <= whole * 1.0001) return 'spread';
  }
  return null;
}
// The orientation of each triple: the same four holds tapped in the same order turn the same way.
function bsLuTurns(pts, w, h) {
  const P = pts.map(p => [p[0] / 100 * w, p[1] / 100 * h]);
  return [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]].map(([a, b, c]) =>
    Math.sign((P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0])));
}
// What's wrong with the line-up so far: 'spread' (today's four), 'cspread' / 'order'
// (the cartoon's), or null.
function bsLuProblem() {
  if (!bsLuCurDone()) return null;
  const cur = BS.img.current || { w: 100, h: 100 }, hands = bsLiveHand().filter(h => h.x != null);
  const xs = hands.map(h => +h.x / 100 * cur.w), ys = hands.map(h => +h.y / 100 * cur.h);
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  if (bsLuSpreadProblem(bsLuCurPts(), cur.w, cur.h, box)) return 'spread';
  if (!BS.lineup.cart.every(Boolean)) return null;
  const im = BS.img.cartoon, bp = bsBoardPx();
  if (bsLuSpreadProblem(BS.lineup.cart, im.w, im.h, bp.w * bp.h * 0.25)) return 'cspread';
  const a = bsLuTurns(bsLuCurPts(), cur.w, cur.h), b = bsLuTurns(BS.lineup.cart, im.w, im.h);
  if (a.some((t, i) => t !== b[i])) return 'order';
  return null;
}
// today's image % -> cartoon %, from the four pairs (null until they're all there).
function bsLuHom() {
  if (!bsLuReady()) return null;
  return bsHom(BS.lineup.cart, bsLuCurPts());
}

function bsLuKind(kind) {
  if (kind === 'cartoon' && (!bsLuCurDone() || bsLuProblem() === 'spread')) return;
  BS.luKind = kind;
  BS.luSel = bsLuFirstFree(kind === 'current' ? BS.lineup.cur : BS.lineup.cart);
  bsRender();
}
function bsLuClear() {
  BS.lineup = bsLuEmpty();
  BS.luKind = 'current'; BS.luSel = 0;
  bsSave(); bsRender();
}
// The slot whose marker is under the finger, or -1.
function bsLuHit(cx, cy) {
  const [sx, sy] = bsStageXY(cx, cy);
  const pts = BS.luKind === 'current' ? bsLuCurPts() : BS.lineup.cart;
  let best = -1, bd = 22;
  pts.forEach((p, i) => { if (!p) return; const [x, y] = bsScreen(p[0], p[1]); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } });
  return best;
}
function bsLuTap(g) {
  const L = BS.lineup, hit = bsLuHit(g.sx, g.sy);
  if (hit >= 0) { BS.luSel = hit; bsRenderOver(); bsRenderPanel(); return; }
  if (BS.luSel == null) { showToast('Tap a numbered hold first to change it', 'error'); return; }
  if (BS.luKind === 'current') {
    // snap to the nearest hand hold on today's image
    const [sx, sy] = bsStageXY(g.sx, g.sy);
    let best = null, bd = 44;
    bsLiveHand().forEach(h => {
      if (!bsLuOnImage(h)) return;
      const [x, y] = bsScreen(+h.x, +h.y), d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = h; }
    });
    if (!best) { showToast('Tap on a hand hold', 'error'); return; }
    if (L.cur.includes(best.id)) { showToast(`${best.name} is already picked`, 'error'); return; }
    L.cart[BS.luSel] = null;                                   // a new hold: its cartoon spot goes
    L.cur[BS.luSel] = best.id;
    BS.luSel = bsLuFirstFree(L.cur);
    if (BS.luSel == null && !bsLuProblem() && !L.cart.every(Boolean)) {
      BS.luKind = 'cartoon';                                   // all four: on to the cartoon
      BS.luSel = bsLuFirstFree(L.cart);
      bsSave(); bsRender();
      return;
    }
  } else {
    L.cart[BS.luSel] = [bsR2(bsClamp(g.x, 0, 100)), bsR2(bsClamp(g.y, 0, 100))];
    BS.luSel = bsLuFirstFree(L.cart);
  }
  bsSave(); bsRenderOver(); bsRenderPanel();
}
// The overlay: today's hand holds as dots, the picked four numbered (and named).
function bsLuOver() {
  let html = '';
  const L = BS.lineup, cur = BS.luKind === 'current';
  if (cur) {
    bsLiveHand().forEach(h => {
      if (!bsLuOnImage(h) || L.cur.includes(h.id)) return;
      const [x, y] = bsScreen(+h.x, +h.y);
      html += `<div class="bs-ludot" style="left:${x}px;top:${y}px"></div>`;
    });
  }
  const pts = cur ? bsLuCurPts() : L.cart;
  pts.forEach((p, i) => {
    if (!p) return;
    const [x, y] = bsScreen(p[0], p[1]), h = bsLuHold(L.cur[i]);
    html += cur
      ? `<div class="bs-lu ${BS.luSel === i ? 'sel' : ''}" style="left:${x}px;top:${y}px">${i + 1} ${escHtml(h ? h.name : '')}</div>`
      : `<div class="bs-corner ${BS.luSel === i ? 'sel' : ''}" style="left:${x}px;top:${y}px"><span>${i + 1} ${escHtml(h ? h.name : '')}</span></div>`;
  });
  return html;
}
function bsLuPanel() {
  const L = BS.lineup, prob = bsLuProblem(), cur = BS.luKind === 'current';
  const back = `<button class="ol-btn" data-act="prev">Back</button>`;
  const curOk = bsLuCurDone() && prob !== 'spread';
  const sel = BS.luSel, selName = sel != null && L.cur[sel] ? escHtml(bsName(L.cur[sel])) : '';
  const names = L.cur.map((id, i) => `<span class="${sel === i ? 'on' : ''}">${i + 1}: ${id ? escHtml(bsName(id)) : '–'}${!cur && id && !L.cart[i] ? ' (to tap)' : ''}</span>`).join('');
  let hint;
  if (prob === 'spread') hint = `<p class="bs-hint bad">These four are too close together or nearly in a line. Pick four hand holds spread out, as near the board’s four corners as you can: tap a numbered hold, then the hold to use instead.</p>`;
  else if (cur && sel != null) hint = `<p class="bs-hint">Today’s board: tap <b>hold ${sel + 1} of 4</b>${selName ? ` (instead of ${selName})` : ''}. Pick four hand holds spread out, as near the board’s corners as you can; a tap snaps to the nearest hold.</p>`;
  else if (cur) hint = `<p class="bs-hint">Four holds picked. Tap a numbered hold to change it, or go on to the cartoon.</p>`;
  else if (prob === 'order') hint = `<p class="bs-hint bad">The cartoon’s four aren’t in the same order as today’s (or one is on the wrong hold). Tap a number, then where that hold is.</p>`;
  else if (prob === 'cspread') hint = `<p class="bs-hint bad">These four are bunched together on the cartoon: check each is on the right hold.</p>`;
  else if (sel != null) hint = `<p class="bs-hint">Cartoon: tap the middle of <b>${selName}</b> (hold ${sel + 1} of 4). Drag a number to fine-tune it.</p>`;
  else hint = `<p class="bs-hint">All four lined up. Drag a number to fine-tune it, or tap it and then where it should be.</p>`;
  return `
    <div class="bs-tabs">
      <button class="bs-tab ${cur ? 'on' : ''} ${curOk ? 'done' : ''}" data-act="lukind" data-kind="current">Today’s board</button>
      <button class="bs-tab ${cur ? '' : 'on'} ${bsLuReady() && !prob ? 'done' : ''}" data-act="lukind" data-kind="cartoon" ${curOk ? '' : 'disabled'}>Cartoon</button>
    </div>
    <div class="bs-status bs-lu-list">${names}</div>
    ${hint}
    <div class="ol-row">${back}<button class="ol-btn" data-act="luclear" ${L.cur.some(Boolean) ? '' : 'disabled'}>Start again</button>
      <button class="ol-btn ol-publish" data-act="next" ${bsLuReady() && !prob ? '' : 'disabled'}>Next</button></div>`;
}

// ── steps: trace + match ──────────────────────────────────────────────────────
async function bsTrace() {
  if (BS.busy) return;
  BS.busy = true; bsRenderPanel();
  await new Promise(r => setTimeout(r, 60));            // let "Tracing…" paint first
  try {
    const { data, w, h } = bsCartoonData();
    const res = bsTraceData(data, w, h);
    BS.traced = true;
    BS.mirror = null;
    console.info('board setup: traced %d shapes in %d ms, prior %s', res.shapes.length, res.ms, BS.stats ? BS.stats.ms + ' ms' : 'none');
  } catch (e) {
    console.error('board setup: trace', e);
    showToast('Tracing failed', 'error');
  }
  BS.busy = false;
  bsSave();
  bsRender();
}

// The cartoon's pixels at the trace's size (TRACE_WORK across).
function bsCartoonData() {
  const m = BS.img.cartoon;
  const k = TRACE_WORK / Math.max(m.w, m.h);
  const w = Math.round(m.w * k), h = Math.round(m.h * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(m.bmp, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), w, h };
}

// The trace, the match and (when the board has hand holds with outlines) the prior,
// on the cartoon's pixels at the trace's size (w × h). Also run by tools/trace_prior_score.js.
function bsTraceData(data, w, h) {
  const roi = BS.corners.cartoon.map(p => [p[0] / 100 * w, p[1] / 100 * h]);
  const res = traceHolds(data, { roi: bsGrowQuad(roi, 0.02), keepMasks: true });
  BS.masks = res.masks;
  BS.seq = 0;
  BS.shapes = res.shapes.map(s => ({
    key: 's' + (++BS.seq), kind: 'extra', id: null,
    pts: s.pts.map(p => [bsR2(bsClamp(p[0] / w * 100, -5, 105)), bsR2(bsClamp(p[1] / h * 100, -5, 105))]),
  }));
  BS.undo = [];
  BS.fits = {};
  BS.stats = null;
  bsMatch();
  if (bsHasPrior()) bsPrior(res.masks, w, h, res.shapes);
  return res;
}

// A quad grown about its centre by a share of its size (the corner marks are rough).
function bsGrowQuad(q, f) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  return q.map(p => [cx + (p[0] - cx) * (1 + f), cy + (p[1] - cy) * (1 + f)]);
}

// Today's holds (hand and foot) onto the cartoon, then each to its nearest shape.
// The mapping found (today's image % -> cartoon %: a homography, then an affine
// correction) is kept in BS.xf, so today's outlines can be mapped too (the prior).
function bsMatch() {
  // first guess: a later run goes through the corners stored with today's board (today's
  // image -> board -> cartoon); the first run through the line-up's four holds (today's
  // image -> cartoon directly)
  const curQ = (BS.live.corners && BS.live.corners.image) || null;
  const Hl = curQ ? null : bsLuHom();
  const Hg = Hl || bsMul3(bsHom(BS.corners.cartoon), curQ ? bsHomInv(bsHom(curQ)) : [0.01, 0, 0, 0, 0.01, 0, 0, 0, 1]);
  let A = [1, 0, 0, 0, 1, 0];
  const old = BS.live.holds.filter(h => (h.kind === 'hand' || h.kind === 'foot') && h.x != null);
  const predOf = () => { const p = {}; old.forEach(h => { p[h.id] = bsXfApply({ H: Hg, A }, +h.x, +h.y); }); return p; };
  let pred = predOf();
  const im = BS.img.cartoon, bw = bsBoardPx().w;
  const px = p => [p[0] / 100 * im.w, p[1] / 100 * im.h];
  const cents = BS.shapes.map(s => px(bsCentre(s.pts)));
  const assign = (tol) => {
    const cand = [];
    old.forEach(h => {
      const p = px(pred[h.id]);
      cents.forEach((c, j) => {
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d <= tol) cand.push([d, h, j]);
      });
    });
    cand.sort((a, b) => a[0] - b[0]);
    const usedH = new Set(), usedS = new Set(), pairs = [];
    cand.forEach(([d, h, j]) => {
      if (usedH.has(h.id) || usedS.has(j)) return;
      usedH.add(h.id); usedS.add(j); pairs.push([h, j]);
    });
    return pairs;
  };
  // refine: an affine fit from the guesses to the matched shapes, twice
  for (let it = 0; it < 2; it++) {
    const pairs = assign(bw * BS_MATCH * (it ? 1 : 2));
    if (pairs.length < 6) break;
    const rows = [], bx = [], by = [];
    pairs.forEach(([h, j]) => { const p = pred[h.id]; rows.push([p[0], p[1], 1]); const c = bsCentre(BS.shapes[j].pts); bx.push(c[0]); by.push(c[1]); });
    const fx = bsLsq(rows, bx), fy = bsLsq(rows, by);
    if (!fx || !fy) break;
    // compose: the new fit after the old one
    A = [fx[0] * A[0] + fx[1] * A[3], fx[0] * A[1] + fx[1] * A[4], fx[0] * A[2] + fx[1] * A[5] + fx[2],
         fy[0] * A[0] + fy[1] * A[3], fy[0] * A[1] + fy[1] * A[4], fy[0] * A[2] + fy[1] * A[5] + fy[2]];
    pred = predOf();
  }
  BS.xf = { H: Hg, A };
  BS.pred = {};
  Object.keys(pred).forEach(id => { BS.pred[id] = [bsR2(pred[id][0]), bsR2(pred[id][1])]; });
  BS.shapes.forEach(s => { s.kind = 'extra'; s.id = null; delete s.name; });
  assign(bw * BS_MATCH).forEach(([h, j]) => {
    BS.shapes[j].kind = h.kind;
    BS.shapes[j].id = h.id;
  });
}
// Least squares: rows [a, b, 1] -> the 3 coefficients best giving rhs.
function bsLsq(rows, rhs) {
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
  rows.forEach((r, i) => { for (let a = 0; a < 3; a++) { v[a] += r[a] * rhs[i]; for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; } });
  return bsSolve(M, v);
}
function bsMul3(P, Q) {
  const C = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(P[i * 3] * Q[j] + P[i * 3 + 1] * Q[3 + j] + P[i * 3 + 2] * Q[6 + j]);
  return C;
}
// today's image % -> cartoon %, through BS.xf
function bsXfApply(xf, x, y) {
  const [u, v] = bsHomApply(xf.H, x, y), A = xf.A;
  return [A[0] * u + A[1] * v + A[2], A[3] * u + A[4] * v + A[5]];
}

// ── the prior: today's outlines guide the trace ──────────────────────────────
// Every hand hold of today's board has an outline. Mapped through BS.xf onto the
// cartoon, each is fitted where its hold is (tracePriorFit: a band round the mapped
// spot, ±45°, a little scale), then:
//  (a) the traced shape agreeing with the fitted outline (IoU >= iouTraced) is used:
//      it follows the cartoon exactly;
//  (b) otherwise the fitted outline itself, if it scores >= fitOk;
//  (c) otherwise the fitted outline, flagged for a fix.
// A hold whose fit needed more turn or scale than the board's unchanged holds show is
// "changed": flagged too, so it's confirmed. Footholds: traced shapes no hand hold's
// outline covers. Review then shows only the exceptions (shape.chk).
const BS_PRIOR = {
  band: 0.025,       // the search band round the mapped spot, a share of the board's width
  iouTraced: 0.75,   // (a) a traced shape this close to the fitted outline is used...
  perTraced: 1.35,   //     ... unless its outline is this much longer (a leak along an edge)
  fitOk: 0.8,        // (b) the fitted outline's score (0..1) needed to accept it
  turnGain: 0.1,     // changed: turning bought this much score...
  turnShape: 0.2,    //     ... and changed the outline's shape this much (1 - IoU with it unturned)
  grow: 0.2,         // changed: scaled this much more or less than the board's holds are (median)
  cover: 0.35,       // a traced shape this much inside a hand hold's outline is part of it
  footMin: 0.25,     // a foothold: at least this share of the median candidate's area,
  footMax: 4,        //     at most this many times it,
  footRound: 3,      //     and no stringier than this (perimeter² / 4π area: a circle is 1)
};
// Measured on Ross's final cartoon (10 Nov 2026), unchanged holds: turn gain p90 0.012,
// largest 0.07; turn shape p90 0.08; traced IoU with the fit median 0.90; scale median
// 1.04, p90 1.13. The two turned holds: gain 0.30-0.33, shape 0.47-0.50.
const bsHasPriorHolds = () => bsLiveHand().filter(h => Array.isArray(h.outline) && h.outline.length >= 3).length >= 6;
const bsHasPrior = () => !!(BS.xf && bsHasPriorHolds());
const bsSmooth = () => (typeof shapeSmooth === 'function' ? shapeSmooth() : 0.7);

function bsPrior(masks, w, h) {
  const t0 = Date.now();
  const P = BS_PRIOR, scale = w / BS.img.cartoon.w;
  const band = bsBoardPx().w * scale * P.band;
  const toPx = p => [p[0] / 100 * w, p[1] / 100 * h];
  const toPct = p => [bsR2(bsClamp(p[0] / w * 100, -5, 105)), bsR2(bsClamp(p[1] / h * 100, -5, 105))];
  const traced = BS.shapes.map(s => { const pts = s.pts.map(toPx); return { s, pts, bb: traceBBox(pts), area: tracePolyArea(pts) }; });
  const hands = bsLiveHand().filter(h => Array.isArray(h.outline) && h.outline.length >= 3);
  const sm = bsSmooth(), rows = [];
  hands.forEach(h => {
    const mapped = traceCurve(h.outline, sm).map(p => toPx(bsXfApply(BS.xf, +p[0], +p[1])));
    const f = tracePriorFit(masks, mapped, band);
    const fb = traceBBox(f.pts), pad = band * 0.5;
    let best = null, bi = 0;
    traced.forEach(t => {
      if (t.bb[2] < fb[0] - pad || t.bb[0] > fb[2] + pad || t.bb[3] < fb[1] - pad || t.bb[1] > fb[3] + pad) return;
      const v = tracePolyIoU(t.pts, f.pts);
      if (v > bi) { bi = v; best = t; }
    });
    if (best && bsPerim(best.pts) > P.perTraced * bsPerim(f.pts)) bi = Math.min(bi, P.iouTraced - 0.01);
    rows.push({ h, f, best, iou: bi });
  });
  // a traced shape goes to one hold at most: the one it agrees with best
  const owner = new Map();
  rows.forEach(r => { if (r.best && r.iou >= P.iouTraced && (!owner.has(r.best) || owner.get(r.best).iou < r.iou)) owner.set(r.best, r); });
  const shapes = [], fits = {}, used = new Set();
  let nT = 0, nF = 0, nFlag = 0, nChg = 0;
  const scales = rows.map(r => r.f.scale).sort((a, b) => a - b), mScale = scales[Math.floor(scales.length / 2)] || 1;
  rows.forEach(r => {
    const changed = (r.f.turnGain >= P.turnGain && r.f.turnShape >= P.turnShape) || Math.abs(r.f.scale / mScale - 1) > P.grow;
    fits[r.h.id] = r.f.pts.map(toPct);
    const s = { key: 's' + (++BS.seq), kind: 'hand', id: r.h.id };
    if (r.best && owner.get(r.best) === r) { s.pts = r.best.s.pts; s.src = 'traced'; used.add(r.best); nT++; }
    else { s.pts = fits[r.h.id]; s.src = 'fitted'; if (r.f.score >= P.fitOk) nF++; else { s.chk = 'flag'; nFlag++; } }
    if (changed && !s.chk) { s.chk = 'changed'; nChg++; }
    s.fit = { turn: Math.round(r.f.rot), grow: +r.f.scale.toFixed(2), score: +r.f.score.toFixed(2), iou: +r.iou.toFixed(2),
              gain: +r.f.turnGain.toFixed(3), shape: +r.f.turnShape.toFixed(2) };
    shapes.push(s);
  });
  // footholds: traced shapes left over that no hand hold's outline covers
  const handPx = shapes.map(s => ({ pts: s.pts.map(toPx) })).map(o => ({ pts: o.pts, bb: traceBBox(o.pts) }));
  const left = traced.filter(t => !used.has(t) && t.s.kind !== 'foot').filter(t => !handPx.some(o =>
    !(o.bb[2] < t.bb[0] || o.bb[0] > t.bb[2] || o.bb[3] < t.bb[1] || o.bb[1] > t.bb[3]) && tracePolyCover(t.pts, o.pts) >= P.cover));
  const areas = left.map(t => t.area).sort((a, b) => a - b), med = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  let nFeet = 0, nDrop = traced.length - used.size - left.length;
  traced.filter(t => t.s.kind === 'foot').forEach(t => { shapes.push(t.s); nFeet++; nDrop--; });   // today's footholds
  left.forEach(t => {
    const per = bsPerim(t.pts);
    if (t.area < P.footMin * med || t.area > P.footMax * med || per * per / (4 * Math.PI * t.area) > P.footRound) { nDrop++; return; }
    shapes.push({ key: t.s.key, kind: 'foot', id: bsNextFootIdIn(shapes), pts: t.s.pts, chk: 'cand' });
    nFeet++;
  });
  BS.shapes = shapes;
  BS.fits = fits;
  BS.stats = { traced: nT, fitted: nF, flag: nFlag, changed: nChg, feet: nFeet, dropped: nDrop, ms: Date.now() - t0 };
}
function bsPerim(pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; p += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return p;
}
function bsNextFootIdIn(list) {
  let n = 0;
  const seen = id => { const m = /^foot(\d+)$/.exec(id || ''); if (m) n = Math.max(n, +m[1]); };
  (BS.live ? BS.live.holds : []).forEach(h => seen(h.id));
  list.forEach(s => seen(s.id));
  return 'foot' + (n + 1);
}

// ── review edits ──────────────────────────────────────────────────────────────
function bsPushUndo() {
  BS.undo.push(JSON.stringify(BS.shapes));
  if (BS.undo.length > 40) BS.undo.shift();
}
function bsUndoEdit() {
  if (!BS.undo.length) return;
  BS.shapes = JSON.parse(BS.undo.pop());
  BS.sel = null; BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
function bsNextFootId() {
  let n = 0;
  const seen = id => { const m = /^foot(\d+)$/.exec(id || ''); if (m) n = Math.max(n, +m[1]); };
  (BS.live ? BS.live.holds : []).forEach(h => seen(h.id));
  BS.shapes.forEach(s => seen(s.id));
  return 'foot' + (n + 1);
}
function bsAssign(key, id) {
  const s = bsShape(key);
  if (!s || !id) return;
  bsPushUndo();
  const prev = bsShapeOf(id);
  if (prev && prev !== s) { prev.kind = 'extra'; prev.id = null; }
  s.kind = 'hand'; s.id = id; delete s.name; delete s.chk;
  BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
function bsToggleFoot(key) {
  const s = bsShape(key);
  if (!s) return;
  bsPushUndo();
  delete s.chk;
  if (s.kind === 'foot') { s.kind = 'extra'; s.id = null; delete s.name; }
  else { s.kind = 'foot'; s.id = bsNextFootId(); }
  BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
function bsDelete(key) {
  bsPushUndo();
  BS.shapes = BS.shapes.filter(s => s.key !== key);
  BS.sel = null; BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
// Every extra shape becomes a foothold (delete any stray shapes first).
function bsExtrasToFeet() {
  const extras = BS.shapes.filter(s => s.kind === 'extra');
  if (!extras.length) return;
  bsPushUndo();
  extras.forEach(s => { s.kind = 'foot'; s.id = bsNextFootId(); });
  BS.mirror = null; BS.sel = null;
  showToast(`${extras.length} shape${extras.length === 1 ? '' : 's'} marked as footholds`, 'success');
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
function bsNextIssue() {
  const miss = bsMissing();
  const extra = BS.shapes.filter(s => s.kind === 'extra');
  if (miss.length) {
    BS.sel = 'hold:' + miss[0];
    const p = BS.pred[miss[0]];
    if (p) bsZoomTo(p[0], p[1], 4);
  } else if (extra.length) {
    BS.sel = extra[0].key;
    const c = bsCentre(extra[0].pts);
    bsZoomTo(c[0], c[1], 4);
  } else {
    const q = bsQueue();
    if (q.length) {
      // the next one after the selected one, so Next to fix moves on even without a decision
      const i = q.findIndex(x => x.key === BS.sel), s = q[(i + 1) % q.length];
      BS.sel = s.key;
      const c = bsCentre(s.pts);
      bsZoomTo(c[0], c[1], 4);
    }
  }
  bsRenderBoard(); bsRenderPanel();
}

// Settle a shape in the queue (Looks right / Keep this foothold).
function bsAccept(key) {
  const s = bsShape(key);
  if (!s || !s.chk) return;
  bsPushUndo();
  delete s.chk;
  bsSave();
  const q = bsQueue();
  if (q.length) bsNextIssue(); else { BS.sel = null; bsRenderBoard(); bsRenderPanel(); }
}
// Accept all unflagged: every new foothold kept (flagged and turned hand holds still wait).
function bsAcceptAll() {
  const c = BS.shapes.filter(s => s.chk === 'cand');
  if (!c.length) return;
  bsPushUndo();
  c.forEach(s => { delete s.chk; });
  BS.mirror = null;
  showToast(`${c.length} footholds kept`, 'success');
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
// The hold's outline as fitted from today's (for the selected shape, or a hold with none).
function bsUseFit() {
  const id = BS.sel && BS.sel.startsWith('hold:') ? BS.sel.slice(5) : (bsShape(BS.sel) || {}).id;
  const pts = id && BS.fits[id];
  if (!pts) return;
  bsPushUndo();
  let s = bsShapeOf(id);
  if (!s) { s = { key: 's' + (++BS.seq), kind: 'hand', id }; BS.shapes.push(s); }
  s.pts = pts.map(p => p.slice()); s.src = 'fitted'; delete s.chk;
  BS.sel = s.key; BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
// The trace's masks for Tap to trace (after a reload they're traced again, once).
async function bsEnsureMasks() {
  if (BS.masks) return BS.masks;
  if (!BS.img.cartoon || !BS.img.cartoon.bmp) return null;
  BS.busy = true; bsRenderPanel();
  await new Promise(r => setTimeout(r, 60));
  try {
    const { data } = bsCartoonData();
    BS.masks = traceHolds(data, { keepMasks: true }).masks;
  } catch (e) { console.error('board setup: masks', e); }
  BS.busy = false;
  return BS.masks;
}
// Tap to trace at (x, y) % of the cartoon: just the hold there. It replaces the selected
// shape's outline (or gives the selected hold with no outline one); with nothing
// selected, the shape under the tap, or the hand hold whose fitted outline is there; or
// else it's a new shape (make it a foothold or a hand hold).
async function bsTapTrace(x, y) {
  if (BS.busy) return;
  const masks = await bsEnsureMasks();
  if (!masks) { showToast('Couldn’t read the cartoon', 'error'); return; }
  let target = null, holdId = null;
  if (BS.sel && BS.sel.startsWith('hold:')) holdId = BS.sel.slice(5);
  else if (BS.sel && bsShape(BS.sel)) target = bsShape(BS.sel);
  else {
    const under = bsShapeAt(x, y);
    if (under && tracePointInPoly(x, y, under.pts)) target = under;
    else {
      holdId = Object.keys(BS.fits).find(id => tracePointInPoly(x, y, BS.fits[id])) || null;
      if (holdId && bsShapeOf(holdId)) { target = bsShapeOf(holdId); holdId = null; }
    }
  }
  const px = p => [p[0] / 100 * masks.W, p[1] / 100 * masks.H];
  const ref = target ? target.pts : holdId ? BS.fits[holdId] : null;
  const pts = traceTap(masks, x / 100 * masks.W, y / 100 * masks.H, ref ? { maxArea: tracePolyArea(ref.map(px)) * 3 } : {});
  if (!pts) { showToast('No hold found there: try Draw', 'error'); bsRenderPanel(); return; }
  const pct = pts.map(p => [bsR2(bsClamp(p[0] / masks.W * 100, -5, 105)), bsR2(bsClamp(p[1] / masks.H * 100, -5, 105))]);
  bsPushUndo();
  if (target) {
    target.pts = pct; target.src = 'tapped';
    if (target.chk !== 'cand') delete target.chk;
    BS.sel = target.key;
  } else {
    const s = { key: 's' + (++BS.seq), kind: holdId ? 'hand' : 'extra', id: holdId, pts: pct, src: 'tapped' };
    BS.shapes.push(s);
    BS.sel = s.key;
  }
  BS.tool = null; BS.mirror = null;
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
// Turn a shape's outline by `deg` about its centre (in pixels, so it doesn't skew).
function bsTurn(pts, deg) {
  const m = BS.img.cartoon, sx = m.w / 100, sy = m.h / 100;
  const c = bsCentre(pts), cs = Math.cos(deg * Math.PI / 180), sn = Math.sin(deg * Math.PI / 180);
  return pts.map(p => {
    const ux = (p[0] - c[0]) * sx, uy = (p[1] - c[1]) * sy;
    return [bsR2(c[0] + (cs * ux - sn * uy) / sx), bsR2(c[1] + (sn * ux + cs * uy) / sy)];
  });
}
// Where the turn handle of the selected shape is (stage px), in Move.
function bsRotHandle() {
  const s = BS.step === 'review' && BS.tool === 'move' && BS.sel && bsShape(BS.sel);
  if (!s || !s.pts.length) return null;
  const c = bsCentre(s.pts), top = Math.min(...s.pts.map(p => p[1]));
  const [x, y] = bsScreen(c[0], top);
  return [x, y - 34];
}

// A finished lasso -> a smoothed, simplified outline in %.
function bsLassoDone(pts) {
  if (pts.length < 6) return null;
  const m = bsCur(), px = pts.map(p => [p[0] / 100 * m.w, p[1] / 100 * m.h]);
  if (tracePolyArea(px) < 20) return null;
  const sm = traceSimplify(traceSmoothRing(px, 2), 0.8);
  return sm.map(p => [bsR2(bsClamp(p[0] / m.w * 100, -5, 105)), bsR2(bsClamp(p[1] / m.h * 100, -5, 105))]);
}

// ── mirror pairs ──────────────────────────────────────────────────────────────
function bsPartnerOf(s) {
  if (!s || !s.id || !BS.mirror) return null;
  const m = BS.mirror[s.id];
  return m ? bsShapeOf(m) : null;
}
// The board's mirror: reflect about its vertical centre line, then match each hold
// to the nearest of the same kind. A cartoon is never exactly symmetric (and the
// photo may be a little skewed), so the reflection is fitted to the holds: the
// centre line first (the best of a sweep), then an affine correction from the
// first matches (twice). Pairs are mutual nearest matches; hand <-> foot never.
function bsMirrorFit(hand, bp) {
  const near = (pts, x, y) => { let bd = Infinity; pts.forEach(q => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) bd = d; }); return bd; };
  const cap = bp.w * 0.05;
  let best = bp.w / 2, bs = Infinity;
  for (let c = bp.w * 0.4; c <= bp.w * 0.6; c += bp.w * 0.0025) {
    let t = 0;
    hand.forEach(p => { t += Math.min(cap, near(hand, 2 * c - p[0], p[1])); });
    if (t < bs) { bs = t; best = c; }
  }
  let T = [-1, 0, 2 * best, 0, 1, 0];                  // x' = a x + b y + c, y' = d x + e y + f
  const ap = (T, p) => [T[0] * p[0] + T[1] * p[1] + T[2], T[3] * p[0] + T[4] * p[1] + T[5]];
  for (let it = 0; it < 3; it++) {
    const A = [], bx = [], by = [];
    hand.forEach(p => {
      const r = ap(T, p);
      let q = null, bd = Infinity;
      hand.forEach(h => { const d = Math.hypot(h[0] - r[0], h[1] - r[1]); if (d < bd) { bd = d; q = h; } });
      if (q && bd <= bp.w * BS_PAIR * (it ? 1 : 1.5)) { A.push([p[0], p[1], 1]); bx.push(q[0]); by.push(q[1]); }
    });
    if (A.length < 12) break;
    const fit = rhs => {
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
      A.forEach((r, i) => { for (let a = 0; a < 3; a++) { v[a] += r[a] * rhs[i]; for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; } });
      return bsSolve(M, v);
    };
    const fx = fit(bx), fy = fit(by);
    if (!fx || !fy) break;
    T = fx.concat(fy);
  }
  return p => ap(T, p);
}
function bsMakeMirror() {
  const Hi = bsHomInv(bsHom(BS.corners.cartoon)), bp = bsBoardPx();
  const pos = s => { const c = bsCentre(s.pts), uv = bsHomApply(Hi, c[0], c[1]); return [uv[0] * bp.w, uv[1] * bp.h]; };
  const reflect = bsMirrorFit(BS.shapes.filter(s => s.kind === 'hand').map(pos), bp);
  const mirror = {}, flags = [];
  ['hand', 'foot'].forEach(kind => {
    const list = BS.shapes.filter(s => s.kind === kind).map(s => ({ s, p: pos(s) }));
    const nearest = a => {
      const [rx, ry] = reflect(a.p);
      let best = null, bd = Infinity;
      list.forEach(b => { const d = Math.hypot(b.p[0] - rx, b.p[1] - ry); if (d < bd) { bd = d; best = b; } });
      return bd <= bp.w * BS_PAIR ? best : null;
    };
    const near = new Map(list.map(a => [a, nearest(a)]));
    list.forEach(a => {
      const b = near.get(a);
      const mutual = b && near.get(b) === a;
      if (kind === 'hand') mirror[a.s.id] = mutual ? b.s.id : a.s.id;
      else mirror[a.s.id] = mutual && b !== a ? b.s.id : null;
    });
  });
  // hand holds: today's pairs are the reference; differences are flagged, today's kept
  const today = {};
  bsLiveHand().forEach(h => { today[h.id] = h.mirror || h.id; });
  BS.shapes.filter(s => s.kind === 'hand').forEach(s => {
    if (today[s.id] && mirror[s.id] !== today[s.id]) flags.push({ id: s.id, today: today[s.id], reflection: mirror[s.id] });
  });
  flags.forEach(f => { mirror[f.id] = f.today; });
  BS.mirror = mirror;
  BS.flags = flags;
}
// Set a's partner to b (both directions), freeing their old partners.
function bsSetPair(a, b) {
  const self = s => (s.kind === 'hand' ? s.id : null);
  [a, b].forEach(s => {
    if (!s) return;
    const old = BS.mirror[s.id];
    if (old && old !== s.id) { const o = bsShapeOf(old); if (o) BS.mirror[o.id] = self(o); }
  });
  if (!b || a === b) { BS.mirror[a.id] = self(a); return; }
  BS.mirror[a.id] = b.id; BS.mirror[b.id] = a.id;
}
function bsFlagPick(id, to) {
  const f = BS.flags.find(x => x.id === id);
  if (!f) return;
  const a = bsShapeOf(id), target = to === 'reflection' ? f.reflection : f.today;
  bsSetPair(a, bsShapeOf(target));
  bsSave(); bsRenderBoard(); bsRenderPanel();
}
// The checks Publish makes (as the server does).
function bsPublishProblems() {
  const out = [];
  if (!BS.mirror) return ['Mirror pairs aren’t made yet'];
  BS.shapes.filter(s => s.kind !== 'extra').forEach(s => {
    const m = BS.mirror[s.id];
    if (!m || m === s.id) return;
    const p = bsShapeOf(m);
    if (!p || p.kind !== s.kind || BS.mirror[p.id] !== s.id) out.push(`${s.kind === 'foot' ? s.name || s.id : bsName(s.id)}: its mirror partner doesn’t pair back`);
  });
  return out;
}

// Footholds: FT1, FT2… left to right, bottom row first (rows by the board's own up).
function bsNameFeet() {
  const feet = BS.shapes.filter(s => s.kind === 'foot');
  const names = bsFootNameList(feet.map(s => s.pts), BS.corners.cartoon, BS.img.cartoon.w, BS.img.cartoon.h);
  feet.forEach((s, i) => { s.name = names[i]; });
}
// The names (FT1, FT2…) of footholds given as outlines (% of an image w × h whose board
// corners are q), in the list's order. The hold editor (holdedit.js) uses it too.
function bsFootNameList(list, q, w, h) {
  const Hi = bsHomInv(bsHom(q)), bp = bsQuadPx(q, w, h);
  const names = list.map(() => null);
  const feet = list.map((pts, i) => {
    const c = bsCentre(pts), uv = bsHomApply(Hi, c[0], c[1]);
    const ys = pts.map(p => bsHomApply(Hi, p[0], p[1])[1] * bp.h);
    return { i, u: uv[0], v: uv[1] * bp.h, ht: Math.max(...ys) - Math.min(...ys) };
  });
  if (!feet.length) return names;
  const hts = feet.map(f => f.ht).sort((a, b) => a - b);
  const tol = Math.max(hts[Math.floor(hts.length / 2)] * 0.6, bp.h * 0.01);
  feet.sort((a, b) => b.v - a.v);                      // bottom first
  const rows = [];
  feet.forEach(f => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.v - f.v) <= tol) { row.items.push(f); row.v = row.items.reduce((a, x) => a + x.v, 0) / row.items.length; }
    else rows.push({ v: f.v, items: [f] });
  });
  let n = 0;
  rows.forEach(r => r.items.sort((a, b) => a.u - b.u).forEach(f => { names[f.i] = 'FT' + (++n); }));
  return names;
}

// ── publish + undo ────────────────────────────────────────────────────────────
function bsPayload() {
  bsNameFeet();
  const r = pts => pts.map(p => [bsR2(bsClamp(p[0], -5, 105)), bsR2(bsClamp(p[1], -5, 105))]);
  return BS.shapes.filter(s => s.kind === 'hand' || s.kind === 'foot').map(s => {
    const c = bsCentre(s.pts);
    const o = { id: s.id, kind: s.kind, x: bsR2(bsClamp(c[0], 0, 100)), y: bsR2(bsClamp(c[1], 0, 100)), outline: r(s.pts),
                mirror: BS.mirror[s.id] != null ? BS.mirror[s.id] : null };
    if (s.kind === 'foot') o.name = s.name;
    return o;
  });
}
async function bsPublish() {
  if (BS.busy) return;
  BS.busy = true; bsRenderPanel();
  try {
    const corners = { image: BS.corners.cartoon.map(p => [bsR2(bsClamp(p[0], 0, 100)), bsR2(bsClamp(p[1], 0, 100))]) };
    if (BS.corners.photo) corners.photo = BS.corners.photo.map(p => [bsR2(bsClamp(p[0], 0, 100)), bsR2(bsClamp(p[1], 0, 100))]);
    const { data, error } = await sb.rpc('admin_publish_board', {
      p_wall: BS_WALL, p_image_path: BS.img.cartoon.path, p_photo_path: BS.img.photo ? BS.img.photo.path : null,
      p_corners: corners, p_holds: bsPayload(), p_smooth: null,
    });
    if (error) throw error;
    console.info('board setup: published, board version', data);
    bsDropDraft();
    BS.img = {}; BS.corners = {}; BS.shapes = []; BS.mirror = null; BS.flags = []; BS.traced = false; BS.pred = {};
    BS.xf = null; BS.fits = {}; BS.stats = null; BS.masks = null;
    BS.lineup = bsLuEmpty(); BS.luKind = 'current'; BS.luSel = 0;
    BS.busy = false;
    showToast('Published: the new board is live on everyone’s next load', 'success');
    await bsAfterBoardChange();
    bsGo('start');
  } catch (e) {
    console.error('board setup: publish', e);
    BS.busy = false;
    showToast(e && e.code === '42501' ? 'Only admins can publish a board' : 'Publish failed: ' + ((e && (e.details || e.message)) || 'check the connection'), 'error');
    bsRenderPanel();
  }
}
async function bsUndoPublish() {
  if (BS.busy) return;
  if (BS.confirmUndo < Date.now()) {
    BS.confirmUndo = Date.now() + 4000;
    bsRenderPage();
    setTimeout(() => { if (BS.step === 'start') bsRenderPage(); }, 4100);
    return;
  }
  BS.confirmUndo = 0; BS.busy = true;
  const { error } = await sb.rpc('admin_undo_board', { p_wall: BS_WALL });
  BS.busy = false;
  if (error) {
    console.error('board setup: undo', error);
    showToast('Undo failed: ' + (error.details || error.message || 'check the connection'), 'error');
    bsRenderPage();
    return;
  }
  showToast('Undone: the previous board is back', 'success');
  await bsAfterBoardChange();
  bsRender();
}
// The app picks up the new (or restored) board at once on this phone.
async function bsAfterBoardChange() {
  BS.live = null;
  await Promise.all([bsLoadLive(), loadBoardConfig(), loadHolds()]);
  applyBoardImage();
}

// ── pointer handling on the stage ─────────────────────────────────────────────
function bsDown(e) {
  if (!bsBoardStep() || !bsCur()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { bsEl('bs-stage').setPointerCapture(e.pointerId); } catch (err) {}
  BS.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (BS.ptrs.size === 2) {
    if (BS.g && BS.g.type === 'lasso') bsRenderBoard();
    const [a, b] = [...BS.ptrs.values()];
    const [mx, my] = bsStageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
    BS.g = { type: 'pinch', d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), s0: BS.v.s,
             bx: (mx - BS.v.tx) / bsW(), by: (my - BS.v.ty) / bsH() };
    bsLoupe(null);
    return;
  }
  if (BS.ptrs.size > 2) return;
  const [x, y] = bsPct(e.clientX, e.clientY);
  const g = { type: 'tap', id: e.pointerId, sx: e.clientX, sy: e.clientY, tx: BS.v.tx, ty: BS.v.ty, x, y, moved: false,
              touch: e.pointerType !== 'mouse' };
  if (BS.step === 'corners') {
    const i = bsHitCorner(e.clientX, e.clientY);
    if (i >= 0) Object.assign(g, { type: 'corner', i, start: BS.corners[BS.cornerKind][i].slice() });
  } else if (BS.step === 'edit') {
    heDown(g, e.clientX, e.clientY);
  } else if (BS.step === 'lineup' && BS.luKind === 'cartoon') {
    const i = bsLuHit(e.clientX, e.clientY);
    if (i >= 0) Object.assign(g, { type: 'lumark', i, start: BS.lineup.cart[i].slice() });
  } else if (BS.step === 'review' && (BS.tool === 'draw' || BS.tool === 'redraw')) {
    Object.assign(g, { type: 'lasso', pts: [[bsR2(x), bsR2(y)]] });
  } else if (BS.step === 'review' && BS.tool === 'move' && BS.sel && bsShape(BS.sel)) {
    bsPushUndo();
    const rh = bsRotHandle(), [sx, sy] = bsStageXY(e.clientX, e.clientY), s = bsShape(BS.sel);
    if (rh && Math.hypot(rh[0] - sx, rh[1] - sy) < 26) {
      const c = bsCentre(s.pts), [cx, cy] = bsScreen(c[0], c[1]);
      Object.assign(g, { type: 'rotate', startPts: s.pts.map(p => p.slice()), cx, cy, a0: Math.atan2(sy - cy, sx - cx) });
    } else Object.assign(g, { type: 'move', startPts: s.pts.map(p => p.slice()) });
  }
  BS.g = g;
}
function bsMove(e) {
  if (!BS.ptrs.has(e.pointerId)) return;
  BS.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = BS.g;
  if (!g) return;
  e.preventDefault();
  if (g.type === 'pinch') {
    const pts = [...BS.ptrs.values()];
    if (pts.length < 2) return;
    const [a, b] = pts, [mx, my] = bsStageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
    BS.v.s = bsClamp(g.s0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 1, Math.max(2, 12 * 400 / BS.v.fitW));
    BS.v.tx = mx - g.bx * bsW(); BS.v.ty = my - g.by * bsH();
    bsClampView(); bsApply();
    return;
  }
  if (e.pointerId !== g.id) return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (!g.moved) {
    if (Math.hypot(dx, dy) < 6) return;
    g.moved = true;
    if (g.type === 'tap') g.type = 'pan';
  }
  const ddx = dx / bsW() * 100, ddy = dy / bsH() * 100;
  if (g.type === 'pan') {
    BS.v.tx = g.tx + dx; BS.v.ty = g.ty + dy;
    bsClampView(); bsApply();
  } else if (g.type === 'corner') {
    const p = [bsR2(bsClamp(g.start[0] + ddx, 0, 100)), bsR2(bsClamp(g.start[1] + ddy, 0, 100))];
    BS.corners[BS.cornerKind][g.i] = p;
    bsRenderBoard();
    if (g.touch) bsLoupe(e.clientX, e.clientY, p);
  } else if (g.type === 'lumark') {
    const p = [bsR2(bsClamp(g.start[0] + ddx, 0, 100)), bsR2(bsClamp(g.start[1] + ddy, 0, 100))];
    BS.lineup.cart[g.i] = p;
    bsRenderOver();
    if (g.touch) bsLoupe(e.clientX, e.clientY, p);
  } else if (g.type === 'lasso') {
    const [x, y] = bsPct(e.clientX, e.clientY), last = g.pts[g.pts.length - 1];
    if (Math.hypot((x - last[0]) * BS.v.aspect, y - last[1]) > 0.12) { g.pts.push([bsR2(x), bsR2(y)]); bsRenderBoard(); }
    if (g.touch) bsLoupe(e.clientX, e.clientY, [x, y]);
  } else if (g.type === 'move') {
    bsShape(BS.sel).pts = g.startPts.map(p => [bsR2(p[0] + ddx), bsR2(p[1] + ddy)]);
    bsRenderBoard();
  } else if (g.type === 'herot') {
    heRotMove(g, e.clientX, e.clientY);
  } else if (g.type === 'rotate') {
    const [sx, sy] = bsStageXY(e.clientX, e.clientY);
    bsShape(BS.sel).pts = bsTurn(g.startPts, (Math.atan2(sy - g.cy, sx - g.cx) - g.a0) * 180 / Math.PI);
    bsRenderBoard();
  }
}
function bsUp(e) {
  if (!BS.ptrs.has(e.pointerId)) return;
  BS.ptrs.delete(e.pointerId);
  const g = BS.g;
  if (!g) return;
  if (g.type === 'pinch' || g.type === 'dead') {
    BS.g = BS.ptrs.size ? { type: 'dead' } : null;
    return;
  }
  if (e.pointerId !== g.id) return;
  BS.g = null;
  bsLoupe(null);
  if (g.type === 'corner') { bsSave(); bsRenderPanel(); return; }
  if (g.type === 'lumark') { if (!g.moved) BS.luSel = g.i; bsSave(); bsRenderOver(); bsRenderPanel(); return; }
  if (g.type === 'move' || g.type === 'rotate') {
    if (!g.moved) BS.undo.pop();
    else { const s = bsShape(BS.sel); if (s && s.chk !== 'cand') delete s.chk; }
    BS.mirror = null; bsSave(); bsRenderBoard(); bsRenderPanel(); return;
  }
  if (g.type === 'herot') { heRotEnd(g); return; }
  if (g.type === 'lasso' && BS.step === 'edit') { heLasso(g.pts); return; }
  if (g.type === 'lasso') {
    const pts = bsLassoDone(g.pts);
    if (!pts) { bsRenderBoard(); if (g.moved) showToast('Too small: draw all the way round the hold', 'error'); return; }
    bsPushUndo();
    if (BS.tool === 'redraw' && bsShape(BS.sel)) {
      const t = bsShape(BS.sel);
      t.pts = pts; t.src = 'drawn';
      if (t.chk !== 'cand') delete t.chk;
    } else {
      const s = { key: 's' + (++BS.seq), kind: 'extra', id: null, pts };
      if (BS.sel && BS.sel.startsWith('hold:')) { s.kind = 'hand'; s.id = BS.sel.slice(5); }
      BS.shapes.push(s);
      BS.sel = s.key;
    }
    BS.tool = null; BS.mirror = null;
    bsSave(); bsRenderBoard(); bsRenderPanel();
    return;
  }
  if (g.type === 'tap' && !g.moved) bsTap(g);
}
function bsWheel(e) {
  if (!bsBoardStep()) return;
  e.preventDefault();
  const [sx, sy] = bsStageXY(e.clientX, e.clientY);
  bsZoomAt(BS.v.s * Math.exp(-e.deltaY * 0.0015), sx, sy);
  bsApply();
}
function bsHitCorner(cx, cy) {
  const q = BS.corners[BS.cornerKind] || [], [sx, sy] = bsStageXY(cx, cy);
  let best = -1, bd = 36;
  q.forEach((p, i) => { const [x, y] = bsScreen(p[0], p[1]); const d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = i; } });
  return best;
}
// The shape under a tap: the smallest containing it, else the nearest close by.
function bsShapeAt(x, y) {
  let best = null, ba = Infinity;
  BS.shapes.forEach(s => {
    if (s.pts.length >= 3 && tracePointInPoly(x, y, s.pts)) { const a = tracePolyArea(s.pts); if (a < ba) { ba = a; best = s; } }
  });
  if (best) return best;
  let bd = Infinity;
  BS.shapes.forEach(s => {
    const c = bsCentre(s.pts), d = Math.hypot((c[0] - x) * BS.v.aspect, c[1] - y);
    if (d < bd) { bd = d; best = s; }
  });
  return bd < 2.5 ? best : null;
}
function bsTap(g) {
  if (BS.step === 'edit') { heTap(g); return; }
  if (BS.step === 'lineup') { bsLuTap(g); return; }
  if (BS.step === 'review' && BS.tool === 'tap') { bsTapTrace(g.x, g.y); return; }
  if (BS.step === 'review') {
    // a hand hold with no shape (its marker)
    const [sx, sy] = bsStageXY(g.sx, g.sy);
    const miss = bsMissing().find(id => { const p = BS.pred[id]; if (!p) return false; const [x, y] = bsScreen(p[0], p[1]); return Math.hypot(x - sx, y - sy) < 18; });
    if (miss) { BS.sel = 'hold:' + miss; bsRenderBoard(); bsRenderPanel(); return; }
    const s = bsShapeAt(g.x, g.y);
    if (s && BS.sel && BS.sel.startsWith('hold:') && s.kind === 'extra') { bsAssign(s.key, BS.sel.slice(5)); BS.sel = s.key; bsRenderBoard(); bsRenderPanel(); return; }
    BS.sel = s ? s.key : null;
    bsRenderBoard(); bsRenderPanel();
  } else if (BS.step === 'mirror') {
    const s = bsShapeAt(g.x, g.y);
    if (BS.tool === 'pair' && BS.sel && s) {
      const a = bsShape(BS.sel);
      if (s.kind !== a.kind) { showToast(a.kind === 'hand' ? 'A hand hold can only pair with a hand hold' : 'A foothold can only pair with a foothold', 'error'); return; }
      bsSetPair(a, s);
      BS.tool = null;
      bsSave(); bsRenderBoard(); bsRenderPanel();
      return;
    }
    BS.sel = s && s.kind !== 'extra' ? s.key : null;
    bsRenderBoard(); bsRenderPanel();
  }
}

// The magnifier above the finger (corners and drawing).
function bsLoupe(cx, cy, p) {
  const el = bsEl('bs-loupe');
  if (cx == null) { el.hidden = true; return; }
  const m = bsCur();
  if (!m || !m.bmp) return;
  const [sx, sy] = bsStageXY(cx, cy);
  el.hidden = false;
  el.style.left = (sx - 60) + 'px';
  el.style.top = Math.max(0, sy - 150) + 'px';
  const c = el.querySelector('canvas');
  c.width = 120; c.height = 120;
  const ctx = c.getContext('2d'), zoom = 3 * bsW() / m.w, r = 60 / zoom;
  const ix = p[0] / 100 * m.w, iy = p[1] / 100 * m.h;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--black').trim() || 'black';
  ctx.fillRect(0, 0, 120, 120);
  ctx.drawImage(m.bmp, ix - r, iy - r, 2 * r, 2 * r, 0, 0, 120, 120);
}

// ── wiring (app.js calls this once) ───────────────────────────────────────────
function bsWire() {
  bsEl('bs-back').addEventListener('click', () => {
    if (BS.step === 'edit') { if (HE.tool) heAct('he-tool-off'); else heClose(); return; }
    if (BS.step === 'start' || BS.step === 'photos') { if (BS.step === 'photos') bsGo('start'); else goBack(); return; }
    bsGo(bsSteps()[bsSteps().indexOf(BS.step) - 1]);
  });
  bsEl('bs-fit').addEventListener('click', bsFit);
  const page = bsEl('bs-page'), panel = bsEl('bs-panel');
  const onAct = async e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    if (act.startsWith('he-')) { heAct(act, b); return; }
    if (act === 'reload') { BS.live = null; initSetup(); }
    else if (act === 'new') { bsDropDraft(); Object.assign(BS, { img: {}, corners: {}, shapes: [], mirror: null, flags: [], traced: false, pred: {}, undo: [], lineup: bsLuEmpty(), luKind: 'current', luSel: 0, xf: null, fits: {}, stats: null, masks: null }); bsGo('photos'); }
    else if (act === 'discard') { bsDropDraft(); bsRender(); }
    else if (act === 'resume') await bsResume();
    else if (act === 'undo') bsUndoPublish();
    else if (act === 'upload') bsUpload();
    else if (act === 'prev') bsGo(bsSteps()[bsSteps().indexOf(BS.step) - 1]);
    else if (act === 'next') bsNext();
    else if (act === 'ckind') bsCornerKind(b.dataset.kind);
    else if (act === 'lukind') bsLuKind(b.dataset.kind);
    else if (act === 'luclear') bsLuClear();
    else if (act === 'trace') bsTrace();
    else if (act === 'nextissue') bsNextIssue();
    else if (act === 'draw') { BS.tool = 'draw'; BS.sel = null; bsRenderBoard(); bsRenderPanel(); }
    else if (act === 'draw-for') { BS.tool = 'draw'; bsRenderPanel(); }
    else if (act === 'redraw') { BS.tool = 'redraw'; bsRenderPanel(); }
    else if (act === 'move') { BS.tool = 'move'; bsRenderPanel(); bsRenderOver(); }
    else if (act === 'tool-off') { BS.tool = null; bsRenderBoard(); bsRenderPanel(); }
    else if (act === 'desel') { BS.sel = null; BS.tool = null; bsRenderBoard(); bsRenderPanel(); }
    else if (act === 'foot') bsToggleFoot(BS.sel);
    else if (act === 'delete') bsDelete(BS.sel);
    else if (act === 'extras-feet') bsExtrasToFeet();
    else if (act === 'tap') { BS.tool = 'tap'; bsRenderPanel(); bsEnsureMasks().then(() => { if (BS.tool === 'tap') bsRenderPanel(); }); }
    else if (act === 'usefit') bsUseFit();
    else if (act === 'ok') bsAccept(BS.sel);
    else if (act === 'acceptall') bsAcceptAll();
    else if (act === 'undo-edit') bsUndoEdit();
    else if (act === 'pair') { BS.tool = 'pair'; bsRenderPanel(); }
    else if (act === 'unpair') { const s = bsShape(BS.sel); if (s) { bsSetPair(s, null); bsSave(); bsRenderBoard(); bsRenderPanel(); } }
    else if (act === 'flagpick') bsFlagPick(b.dataset.id, b.dataset.to);
    else if (act === 'showhold') { const s = bsShapeOf(b.dataset.id); if (s) { BS.sel = s.key; const c = bsCentre(s.pts); bsZoomTo(c[0], c[1], 3); bsRenderBoard(); bsRenderPanel(); } }
    else if (act === 'publish') bsPublish();
  };
  page.addEventListener('click', onAct);
  panel.addEventListener('click', onAct);
  panel.addEventListener('change', e => {
    if (e.target.dataset.act === 'assign' && e.target.value) bsAssign(BS.sel, e.target.value);
  });
  page.addEventListener('change', e => { if (e.target.matches('input[type=file]')) bsPickFile(e.target); });
  const st = bsEl('bs-stage');
  st.addEventListener('pointerdown', bsDown);
  st.addEventListener('pointermove', bsMove);
  st.addEventListener('pointerup', bsUp);
  st.addEventListener('pointercancel', bsUp);
  st.addEventListener('wheel', bsWheel, { passive: false });
  st.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('resize', () => { if (currentView === 'setup' && bsBoardStep()) bsLayout(true); });
}

async function bsNext() {
  if (BS.step === 'corners') {
    if (!bsNeedLineup()) { bsGo('trace'); return; }
    BS.busy = true; bsRenderPanel();
    const ok = await bsLuLoad();
    BS.busy = false;
    if (!ok) { bsRenderPanel(); return; }
    BS.luKind = bsLuCurDone() && bsLuProblem() !== 'spread' ? 'cartoon' : 'current';
    BS.luSel = bsLuFirstFree(BS.luKind === 'current' ? BS.lineup.cur : BS.lineup.cart);
    bsGo('lineup');
    return;
  }
  if (BS.step === 'lineup') { if (bsLuReady() && !bsLuProblem()) bsGo('trace'); return; }
  if (BS.step === 'trace') { bsGo('review'); return; }
  if (BS.step === 'review') {
    if (!BS.mirror) bsMakeMirror();
    bsNameFeet();
    bsGo('mirror');
    return;
  }
  if (BS.step === 'mirror') { bsNameFeet(); bsGo('publish'); return; }
}

// Carry on with the saved draft: the images come back from Storage.
async function bsResume() {
  const d = bsDraft();
  if (!d) return;
  BS.busy = true;
  bsEl('bs-page').innerHTML = '<div class="spinner"></div>';
  try {
    const img = {};
    for (const k of Object.keys(d.img || {})) {
      const bmp = await bsBitmapFromUrl(bsUrl(d.img[k].path));
      img[k] = { bmp, w: bmp.width, h: bmp.height, path: d.img[k].path };
    }
    const lineup = d.lineup && Array.isArray(d.lineup.cur) && Array.isArray(d.lineup.cart) ? d.lineup : bsLuEmpty();
    if (bsNeedLineup() && (lineup.cur.some(Boolean) || d.step === 'lineup')) {
      const bmp = await bsBitmapFromUrl(BOARD_IMG);
      img.current = { bmp, w: bmp.width, h: bmp.height, path: null };
    }
    if (d.corners) delete d.corners.current;               // drafts from before the line-up
    // an older (v1) draft has no prior: its shapes carry no checks and work as before
    Object.assign(BS, { img, corners: d.corners || {}, shapes: d.shapes || [], seq: d.seq || 0, pred: d.pred || {},
                        mirror: d.mirror || null, flags: d.flags || [], traced: !!d.traced, undo: [], lineup,
                        xf: d.v === BS_DRAFT_V ? d.xf || null : null, fits: d.v === BS_DRAFT_V ? d.fits || {} : {},
                        stats: d.v === BS_DRAFT_V ? d.stats || null : null, masks: null });
    BS.luKind = lineup.cur.every(Boolean) ? 'cartoon' : 'current';
    BS.luSel = bsLuFirstFree(BS.luKind === 'current' ? lineup.cur : lineup.cart);
    BS.busy = false;
    if (d.version && BS.live && d.version !== BS.live.version) showToast('The board changed since this draft: check the matches', 'error');
    const step = d.step === 'lineup' && !bsNeedLineup() ? 'corners' : d.step;
    bsGo(BS_STEPS.includes(step) && step !== 'start' ? (img.cartoon || step === 'photos' ? step : 'photos') : 'photos');
  } catch (e) {
    console.warn('board setup: resume', e);
    BS.busy = false;
    showToast('Couldn’t load the draft’s pictures', 'error');
    bsRender();
  }
}
