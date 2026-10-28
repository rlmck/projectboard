// PB Console page. Every data call goes to /api/ with this launch's token
// (X-PB-Token); the token arrives in the address's #t= part from start.sh,
// is kept in sessionStorage for this tab, and is taken out of the address bar.
'use strict';

const TOKEN_KEY = 'pb-console-token';
const OVERVIEW_MS = 30000;
const $ = (id) => document.getElementById(id);

let token = '';
let state = { units: [], patterns: [], log_sources: [] };
let overview = null;
let running = false;
let logAbort = null;

function readToken() {
  const m = location.hash.match(/(?:^#|&)t=([A-Za-z0-9_-]{20,})/);
  try {
    if (m) sessionStorage.setItem(TOKEN_KEY, m[1]);
    token = (m && m[1]) || sessionStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    token = m ? m[1] : '';
  }
  if (m) history.replaceState(null, '', location.pathname);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms || 4000);
}

async function api(path, body, signal) {
  const opts = { headers: { 'X-PB-Token': token }, signal };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    $('no-token').hidden = false;
    throw new Error('no token');
  }
  return res;
}

async function apiJson(path, body) {
  const res = await api(path, body);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Read a streamed text response line by line. onLine(text) for output; returns the @@result object.
async function readStream(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line === '@@ping') continue;
      if (line.startsWith('@@result ')) {
        try { result = JSON.parse(line.slice(9)); } catch (e) { /* ignore */ }
        continue;
      }
      onLine(line);
    }
  }
  if (buf) onLine(buf);
  return result;
}

// -- tabs ----------------------------------------------------------------------

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
  try { localStorage.setItem('pb-console-tab', name); } catch (e) { /* ignore */ }
  if (name === 'audit') loadState();
  if (name === 'board') startCam();
  const hook = window.PB && window.PB.tabHooks[name];
  if (hook) hook();
}

// -- overview ------------------------------------------------------------------

function renderTiles(tiles) {
  $('tiles').innerHTML = tiles.map((t) =>
    '<article class="tile ' + esc(t.level) + '">' +
    '<div class="tile-head"><span class="tile-title">' + esc(t.title) + '</span><span class="dot" title="' + esc(t.level) + '"></span></div>' +
    '<div class="tile-value">' + esc(t.value) + '</div>' +
    '<ul>' + (t.lines || []).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></article>').join('');
}

function renderServices() {
  if (!overview) return;
  const units = overview.units || {};
  $('services').innerHTML = (state.units || []).map((u) => {
    const s = units[u] || '?';
    const lvl = s === 'active' ? 'ok' : s === '?' ? 'unknown' : (u === 'kiosk' && overview.board && /^night/.test(overview.board.mode || '')) ? 'ok' : 'bad';
    return '<div class="svc ' + lvl + '"><span class="dot"></span><span class="name">' + esc(u) + '</span>' +
      '<span class="muted">' + esc(s) + '</span><div class="btn-row">' +
      ['start', 'stop', 'restart'].map((v) =>
        '<button class="btn small' + (v === 'stop' ? ' danger' : '') + '" data-act="service" data-unit="' + esc(u) + '" data-verb="' + v + '">' +
        v[0].toUpperCase() + v.slice(1) + '</button>').join('') + '</div></div>';
  }).join('');
}

function renderBoard() {
  const b = (overview && overview.board) || {};
  const cfg = b.config || {};
  const rows = [
    ['LEDs', b.leds || '?'],
    ['Pattern', b.pattern || '-'],
    ['Idle plan', b.plan || '-'],
    ['Override', b.override || 'none'],
    ['Brightness', b.scale != null && b.scale < 1 ? 'x' + b.scale + ' (pb-idle)' : 'as configured (' + (cfg.BRIGHTNESS || '?') + ' cast, ' + (cfg.IDLE_BRIGHTNESS || '?') + ' idle)'],
    ['Mode', b.mode || '?'],
    ['Night', (cfg.NIGHT_START || '?') + '–' + (cfg.NIGHT_END || '?') + (cfg.NIGHT_FORCE ? ', forced ' + cfg.NIGHT_FORCE : ', by the clock')],
    ['Screen', b.screen_off ? 'off by hand' : 'normal'],
    ['Casts (5 min)', (overview && overview.casts_5min ? overview.casts_5min.length : 0) + ''],
  ];
  $('board-now').innerHTML = rows.map(([k, v]) => '<span class="k">' + esc(k) + '</span><span>' + esc(v) + '</span>').join('');
  document.querySelectorAll('#patterns .btn').forEach((el) => el.classList.toggle('on', b.leds === el.dataset.cmd || (b.override || '') === el.dataset.cmd));
  const force = cfg.NIGHT_FORCE || 'auto';
  document.querySelectorAll('#night-seg .btn').forEach((el) => el.classList.toggle('on', el.dataset.mode === force));
  if (cfg.NIGHT_START && document.activeElement !== $('night-start')) $('night-start').value = cfg.NIGHT_START;
  if (cfg.NIGHT_END && document.activeElement !== $('night-end')) $('night-end').value = cfg.NIGHT_END;
  if (!$('brightness').matches(':active') && b.scale != null) {
    $('brightness').value = Math.round(b.scale * 100);
    $('brightness-out').textContent = Math.round(b.scale * 100) + '%';
  }
}

async function loadOverview(refresh) {
  $('updated').textContent = 'checking…';
  try {
    const { status, data } = await apiJson('/api/overview' + (refresh ? '?refresh=1' : ''));
    if (status !== 200) throw new Error(data.error || status);
    overview = data;
    renderTiles(data.tiles);
    $('no-helper').hidden = !(data.pi_ok && data.helper === false);
    const d = $('drift');
    d.hidden = !data.config_drift;
    if (data.config_drift) {
      d.innerHTML = "<strong>pi/config.env on the laptop differs from the Pi's config.env.</strong> " +
        'A deploy would put the laptop\'s copy on the Pi; night-mode changes are refused until they match.' +
        '<pre class="out">' + esc(data.config_drift) + '</pre>';
    }
    renderServices();
    renderBoard();
    $('updated').textContent = 'updated ' + new Date().toLocaleTimeString('en-GB');
  } catch (e) {
    $('updated').textContent = 'update failed: ' + e.message;
  }
}

async function loadState() {
  try {
    const { data } = await apiJson('/api/state');
    state = data;
    setLock(data.busy);
    $('audit').innerHTML = (data.audit || []).map((r) =>
      '<tr><td>' + esc(r.time.replace('T', ' ')) + '</td><td>' + esc(r.action) + '</td><td class="r-' + esc(r.result) + '">' +
      esc(r.result) + '</td><td>' + esc(r.detail || '') + (r.ms != null ? ' (' + (r.ms / 1000).toFixed(1) + ' s)' : '') + '</td></tr>').join('');
    return data;
  } catch (e) {
    return null;
  }
}

function setLock(name) {
  const p = $('lock-state');
  p.textContent = name ? 'running: ' + name : 'idle';
  p.classList.toggle('running', !!name);
}

// -- actions ---------------------------------------------------------------------

function confirmDialog(pre, title) {
  return new Promise((resolve) => {
    const d = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = pre.describe;
    const busy = pre.busy;
    const bb = $('confirm-busy');
    bb.hidden = true;
    if (pre.busy_check && busy == null) {
      bb.hidden = false;
      bb.textContent = "The Pi didn't answer the busy check: it may be offline. Going ahead will try anyway.";
    } else if (busy && busy.busy) {
      bb.hidden = false;
      const names = (busy.casts || []).map((c) => c.at.slice(11, 19) + ' ' + c.name + (c.mirror ? ' (mirrored)' : ''));
      bb.textContent = 'Someone cast in the last 5 minutes' + (names.length ? ': ' + names.join(', ') : '') + '. The board may be in use.';
    }
    const diff = $('confirm-diff');
    const extra = [pre.shown ? '$ ' + pre.shown : '', (pre.warnings || []).map((w) => '! ' + w).join('\n'),
      pre.log ? 'Commits:\n' + pre.log : '', pre.diff || ''].filter(Boolean).join('\n\n');
    diff.hidden = !(pre.config_drift || extra);
    diff.textContent = pre.config_drift || extra;
    $('confirm-ok').disabled = !!pre.config_drift;
    if (pre.config_drift) $('confirm-text').textContent = pre.describe + " — refused: the laptop's pi/config.env and the Pi's differ (below). Make them the same first.";
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'ok' ? { ok: true, override: !!(busy && busy.busy) || (pre.busy_check && busy == null) } : { ok: false });
    d.showModal();
  });
}

async function runAction(action, args, label) {
  // Returns true when the action ran and finished OK.
  if (running) { toast('Another action is running'); return; }
  running = true;
  setLock(label);
  try {
    const { status, data: pre } = await apiJson('/api/preview', { action, args });
    if (status !== 200) { toast(pre.error || 'refused'); return; }
    let go = { ok: true, override: false };
    if (pre.confirm) {
      go = await confirmDialog(pre, label);
      if (!go.ok) return;
    }
    const res = await api('/api/action', { action, args, confirm: pre.confirm ? true : undefined, override_busy: go.override || undefined });
    if (res.status !== 200) {
      const err = await res.json().catch(() => ({}));
      toast(err.error || 'refused (' + res.status + ')', 6000);
      return;
    }
    const out = $('output-text');
    $('output').hidden = false;
    $('output-title').textContent = label;
    out.textContent = '';
    const result = await readStream(res, (line) => {
      out.textContent += line + '\n';
      out.scrollTop = out.scrollHeight;
    });
    const ok = result && result.ok;
    $('output-title').textContent = label + (ok ? ' — done' : ' — failed' + (result ? ' (exit ' + result.code + ')' : ''));
    toast(label + (ok ? ': done' : ': failed'));
    return !!ok;
  } catch (e) {
    if (e.message !== 'no token') toast('Error: ' + e.message, 6000);
  } finally {
    running = false;
    setLock(null);
    setTimeout(() => loadOverview(true), 1500);
    if (window.PB && window.PB.afterAction) window.PB.afterAction(action);
  }
}

function actionFromButton(el) {
  const d = el.dataset;
  switch (d.act) {
    case 'service': return ['service', { unit: d.unit, verb: d.verb }, d.verb[0].toUpperCase() + d.verb.slice(1) + ' ' + d.unit];
    case 'reboot': return ['reboot', {}, 'Reboot the Pi'];
    case 'idle': return ['idle', { cmd: d.cmd }, 'pb-idle ' + d.cmd];
    case 'night': return ['night', { mode: d.mode }, 'Night mode: ' + d.mode];
    case 'screen': return ['screen', { state: d.state }, 'Screen ' + d.state];
    default: return null;
  }
}

// -- logs ------------------------------------------------------------------------

async function showLogs(ev) {
  ev.preventDefault();
  if (logAbort) logAbort.abort();
  logAbort = new AbortController();
  const q = new URLSearchParams({
    source: $('log-source').value, since: $('log-since').value.trim(), until: $('log-until').value.trim(),
    lines: $('log-lines').value, filter: $('log-filter').value.trim(), follow: $('log-follow').checked ? '1' : '0',
  });
  const out = $('log-out');
  out.textContent = '';
  $('log-stop').disabled = false;
  try {
    const res = await api('/api/logs?' + q, undefined, logAbort.signal);
    if (res.status !== 200) {
      const err = await res.json().catch(() => ({}));
      out.textContent = err.error || 'failed (' + res.status + ')';
      return;
    }
    const follow = $('log-follow').checked;
    let pending = '';
    let timer = null;
    const flush = () => { out.textContent += pending; pending = ''; timer = null; if (follow) out.scrollTop = out.scrollHeight; };
    await readStream(res, (line) => { pending += line + '\n'; if (!timer) timer = setTimeout(flush, 120); });
    flush();
    if (!follow) out.scrollTop = out.scrollHeight;
  } catch (e) {
    if (e.name !== 'AbortError') out.textContent += '\n(' + e.message + ')';
  } finally {
    $('log-stop').disabled = true;
  }
}

// -- webcam ------------------------------------------------------------------------

function startCam() {
  const img = $('cam');
  if (!state.cam_url || img.src) return;
  $('cam-url').textContent = state.cam_url;
  img.onerror = () => { $('cam-note').textContent = "The webcam didn't answer (" + state.cam_url + '): is this laptop on Tailscale, and board-cam running?'; };
  img.src = state.cam_url;
}

// -- start -------------------------------------------------------------------------

async function boot() {
  readToken();
  if (!token) { $('no-token').hidden = false; return; }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.body.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const a = actionFromButton(el);
    if (a) runAction(...a);
  });
  $('refresh').addEventListener('click', () => loadOverview(true));
  $('output-close').addEventListener('click', () => { $('output').hidden = true; });
  $('brightness').addEventListener('input', () => { $('brightness-out').textContent = $('brightness').value + '%'; });
  $('brightness-apply').addEventListener('click', () => {
    const v = Number($('brightness').value) / 100;
    runAction('brightness', { value: v }, 'Brightness ' + Math.round(v * 100) + '%');
  });
  $('night-hours').addEventListener('click', () => {
    const s = $('night-start').value, e = $('night-end').value;
    runAction('night-hours', { start: s, end: e }, 'Night hours ' + s + '–' + e);
  });
  $('log-form').addEventListener('submit', showLogs);
  $('log-stop').addEventListener('click', () => { if (logAbort) logAbort.abort(); });

  const s = await loadState();
  if (!s) return;
  $('patterns').innerHTML = (s.patterns || []).map(([n, about]) =>
    '<button class="btn" data-act="idle" data-cmd="' + esc(n) + '" title="' + esc(about) + '">' + esc(n) + '</button>').join('');
  $('log-source').innerHTML = (s.log_sources || []).map((n) => '<option>' + esc(n) + '</option>').join('');
  let tab = 'overview';
  try { tab = localStorage.getItem('pb-console-tab') || tab; } catch (e) { /* ignore */ }
  showTab(tab);
  loadOverview(false);
  setInterval(() => { if (!document.hidden) loadOverview(false); }, OVERVIEW_MS);
  setInterval(() => { if (!document.hidden && !running) loadState(); }, 10000);
}

window.PB = { api, apiJson, readStream, esc, toast, runAction, tabHooks: {}, afterAction: null,
  state: () => state, overview: () => overview, showTab };
boot();
