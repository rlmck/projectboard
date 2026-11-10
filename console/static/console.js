// PB Console page. Every data call goes to /api/ with this launch's token
// (X-PB-Token); the token arrives in the address's #t= part from start.sh,
// is kept in sessionStorage for this tab, and is taken out of the address bar.
//
// The sidebar (10 Nov 2026): Home · Holds · Activity · ⚙ Advanced, and the Runbook
// only while the Pi is offline. Advanced is one page of closed sections (Logs, Config,
// Deploy, LED map, Tests, Backups, Audit); opening one loads it. showTab('logs') (from
// a link, the palette or an old saved tab) opens Advanced at that section.
'use strict';

const TOKEN_KEY = 'pb-console-token';
const OVERVIEW_MS = 30000;
const ADVANCED = ['logs', 'config', 'deploy', 'ledmap', 'tests', 'backups', 'audit'];
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

function runHook(name) {
  const hook = window.PB && window.PB.tabHooks[name];
  if (hook) hook();
}

function openAdvanced(name) {
  const d = $('adv-' + name);
  if (!d) return;
  if (!d.open) d.open = true;          // the toggle event loads it
  else runHook(name);
  setTimeout(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30);
}

function showTab(name) {
  let section = null;
  if (ADVANCED.includes(name)) { section = name; name = 'advanced'; }
  if (!document.getElementById('tab-' + name)) name = 'overview';
  document.querySelectorAll('.nav [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
  try { localStorage.setItem('pb-console-tab', name); } catch (e) { /* ignore */ }
  runHook(name);
  if (window.PB && window.PB.dash) window.PB.dash.onTab(name);
  if (section) openAdvanced(section);
  else window.scrollTo(0, 0);
}

// -- overview ------------------------------------------------------------------

// Things that need Ross, in the sidebar (never above the page, so no screen is pushed down):
// only real problems, each in plain English with what to do and a button to the right place.
const TAB_NAMES = { config: 'Config', deploy: 'Deploy', overview: 'Home', backups: 'Backups' };
function renderAttention(items) {
  const box = $('attention');
  box.hidden = !items.length;
  box.innerHTML = items.map((a) => '<div class="att-item"><strong>' + esc(a.title) + '</strong><p>' + esc(a.todo) + '</p>' +
    (a.tab && TAB_NAMES[a.tab] ? '<button class="btn small" data-att-goto="' + esc(a.tab) + '">Open ' + TAB_NAMES[a.tab] + '</button>' : '') +
    '</div>').join('');
}

async function loadOverview(refresh) {
  $('updated').textContent = 'checking…';
  try {
    const { status, data } = await apiJson('/api/overview' + (refresh ? '?refresh=1' : ''));
    if (status !== 200) throw new Error(data.error || status);
    overview = data;
    $('stale').hidden = !!(window.PB.dash && data.metrics && data.backup);
    if (window.PB.dash) window.PB.dash.render(data);
    $('no-helper').hidden = !(data.pi_ok && data.helper === false);
    $('nav-runbook').hidden = !!data.pi_ok;
    renderAttention(data.attention || []);
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
    if (window.PB && window.PB.dash) window.PB.dash.onState(data);
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
      bb.textContent = (busy.pb_ledmap === 'active' ? 'An LED mapping session is running.' : 'Someone used the board in the last 15 minutes' +
        (names.length ? ': ' + names.join(', ') : busy.last_touch_at && busy.last_touch_at === busy.last_use_at ? ' (the wall screen was touched)' : '') + '.') + ' Going ahead may cut them off.';
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
    case 'stay-on': return ['stay-on', { until: d.until }, d.until === 'end' ? 'End the stay-on override' : 'Stay on until ' + d.until];
    case 'screen': return ['screen', { state: d.state }, 'Screen ' + d.state];
    case 'backup': return ['backup-now', {}, 'Back up now'];
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

// -- start -------------------------------------------------------------------------

async function boot() {
  readToken();
  if (!token) { $('no-token').hidden = false; return; }
  document.querySelectorAll('.nav [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('details.adv').forEach((d) => d.addEventListener('toggle', () => { if (d.open) runHook(d.dataset.adv); }));
  document.body.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const a = actionFromButton(el);
    if (a) runAction(...a);
  });
  $('refresh').addEventListener('click', () => loadOverview(true));
  $('attention').addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-att-goto]');
    if (go) showTab(go.dataset.attGoto);
  });
  $('output-close').addEventListener('click', () => { $('output').hidden = true; });
  $('ov-stay-go').addEventListener('click', () => {
    const t = $('ov-stay-until').value;
    if (!/^\d{2}:\d{2}$/.test(t)) { toast('Choose a time'); return; }
    runAction('stay-on', { until: t }, 'Stay on until ' + t);
  });
  $('log-form').addEventListener('submit', showLogs);
  $('log-stop').addEventListener('click', () => { if (logAbort) logAbort.abort(); });

  const s = await loadState();
  if (!s) return;
  $('log-source').innerHTML = (s.log_sources || []).map((n) => '<option>' + esc(n) + '</option>').join('');
  let tab = 'overview';
  try { tab = localStorage.getItem('pb-console-tab') || tab; } catch (e) { /* ignore */ }
  showTab(tab);
  loadOverview(false);
  setInterval(() => { if (!document.hidden) loadOverview(false); }, OVERVIEW_MS);
  setInterval(() => { if (!document.hidden && !running) loadState(); }, 10000);
}

window.PB = { api, apiJson, readStream, esc, toast, runAction, tabHooks: { audit: () => loadState() }, afterAction: null,
  state: () => state, overview: () => overview, showTab, isRunning: () => running, ADVANCED };
boot();
