// PB Console Home: the status line, the tiles, the detail drawer and the command
// palette (Ctrl+K). Uses console.js's helpers (window.PB). The tiles draw from
// /api/overview's `metrics` (the raw numbers) and keep every line of the server's
// tiles (`tiles`) one click away in the drawer. The Pi's 7-day health log
// (/api/health-history, pb-healthlog on the Pi) and Activity's 7 days
// (/api/activity) are fetched less often. Every button still goes through
// PB.runAction, so the confirm and the busy check are unchanged.
//
// Home (10 Nov 2026): Board (webcam + controls + Light a problem), Health (temperature,
// power, Wi-Fi, disk, services, the app; click for the 7-day charts, restarts and every
// line), Activity (7 days), Opening hours (click to edit them), Recent actions. A backup
// shows only when it needs a look (the status line).
'use strict';

(function () {
  const PB = window.PB;
  if (!PB) return;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;
  const ACTIVITY_MS = 300000;
  const HISTORY_MS = 300000;
  const LABEL = { ok: 'OK', warn: 'Look', bad: 'Problem', unknown: '…' };
  const RANK = { unknown: 0, ok: 1, warn: 2, bad: 3 };
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const SERVICES = ['pb-listener', 'kiosk', 'pb-netwatch', 'board-cam', 'tailscaled', 'NetworkManager'];
  const SVC_NAMES = { 'pb-listener': 'Listener', kiosk: 'Wall screen', 'pb-netwatch': 'Wi-Fi watchdog', 'board-cam': 'Webcam',
    tailscaled: 'Tailscale', NetworkManager: 'Network' };
  const HEALTH_IDS = ['pi', 'hw', 'disk', 'wifi', 'svc-pb-listener', 'svc-kiosk', 'svc-pb-netwatch', 'svc-board-cam',
    'timers', 'health', 'errors', 'site', 'supabase'];

  // Each drawer: which of the server's tiles it shows in full, and (optionally) what goes above them.
  const GROUPS = {
    board: { title: 'The board', ids: ['listener', 'svc-pb-listener'], top: boardDetails },
    health: { title: 'Health', ids: HEALTH_IDS, top: healthDetails },
    schedule: { title: 'Opening hours', ids: ['schedule', 'timers'], top: scheduleDetails },
    backup: { title: 'Backups', ids: ['backup'], top: backupDetails },
  };

  let data = null;
  let byId = {};
  let act = null;
  let actAt = 0;
  let hist = null;
  let histAt = 0;
  let histErr = '';
  let drawerKey = null;

  // Dismiss (1 Nov 2026): a tile that needs a look can be dismissed; it shows as dismissed until its
  // `sig` (tiles.py) changes, so it comes back when something new happens or it gets worse. Recent
  // actions can be cleared up to now (Advanced → Audit keeps everything). Both live in this
  // browser's localStorage, a convenience only: without it they last until the page reloads.
  const DISMISS_KEY = 'pb-console-dismissed', CLEARED_KEY = 'pb-console-audit-cleared';
  let dismissed = load(DISMISS_KEY, {});
  let clearedAt = load(CLEARED_KEY, '');
  let audit = null;

  function load(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function save(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* this page load only */ }
  }

  // -- helpers -------------------------------------------------------------------------------

  function worst(levels) {
    return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'unknown');
  }

  function lvl(ids) {
    return worst(ids.map((i) => (byId[i] ? byId[i].level : 'unknown')));
  }

  function chip(level, text) {
    return '<span class="lvl-chip ' + esc(level) + '">' + esc(text || LABEL[level] || level) + '</span>';
  }

  function head(title, level, more) {
    return '<div class="t-head"><h2>' + esc(title) + '</h2>' + (level ? chip(level) : '') + (more || '') + '</div>';
  }

  function goBtn(tabName, text) {
    return '<button class="t-more" data-goto="' + esc(tabName) + '">' + esc(text) + ' ›</button>';
  }

  function applySizes(root) {
    // sizes go through the CSSOM: the CSP (style-src 'self') blocks inline style attributes
    root.querySelectorAll('[data-w]').forEach((x) => { x.style.width = x.dataset.w + '%'; });
    root.querySelectorAll('[data-h]').forEach((x) => { x.style.height = x.dataset.h + 'px'; });
    root.querySelectorAll('[data-op]').forEach((x) => { x.style.opacity = x.dataset.op; });
  }

  function setTile(id, html, level, group) {
    const el = $(id);
    if (!el) return;
    el.className = el.className.replace(/\b(ok|warn|bad|unknown)\b/g, '').trim() + (level ? ' ' + level : '');
    if (group) {
      el.dataset.detail = group;
      el.tabIndex = 0;
    }
    el.innerHTML = html;
    // a dismissed tile reads "Dismissed", not OK
    const c = el.querySelector('.t-head .lvl-chip');
    if (c && group && level === 'ok' && GROUPS[group].ids.some((i) => byId[i] && byId[i].dismissed)) {
      c.className = 'lvl-chip';
      c.textContent = 'Dismissed';
    }
    applySizes(el);
  }

  function span(s) {
    s = Math.max(0, Math.floor(s || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + ' min';
  }

  function ago(at) {
    if (!at) return '-';
    const s = Math.max(0, Date.now() / 1000 - at);
    if (s < 90) return Math.round(s) + ' s ago';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 172800) return span(s) + ' ago';
    return Math.floor(s / 86400) + ' days ago';
  }

  function hhmm(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso || '').slice(11, 16);
    const today = new Date().toDateString() === d.toDateString();
    return (today ? '' : d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ') + d.toTimeString().slice(0, 5);
  }

  function dayTime(t) {
    return new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function pct(x) {
    return x == null ? '?' : Math.round(x * 100) + '%';
  }

  function gb(n) {
    return n == null ? '?' : (n / 1e9).toFixed(1) + ' GB';
  }

  function meter(label, frac, text, warnAt, badAt, tip) {
    const l = frac == null ? '' : frac >= badAt ? 'bad' : frac >= warnAt ? 'warn' : '';
    return '<div class="meter"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><span>' + esc(label) +
      '</span><div class="track"><div class="fill ' + l + '" data-w="' + Math.round(Math.min(1, frac || 0) * 100) +
      '"></div></div><b>' + esc(text) + '</b></div>';
  }

  function hbars(rows) {
    if (!rows.length) return '<p class="empty">Nothing yet.</p>';
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return '<div class="hbars">' + rows.map((r) =>
      '<div class="hbar"><span class="name">' + esc(r[0]) + '</span><span class="n">' + esc(r[1]) +
      '</span><div class="track"><div class="fill" data-w="' + Math.max(2, Math.round((r[1] / max) * 100)) + '"></div></div></div>').join('') + '</div>';
  }

  // Vertical bars, rounded at the data end, anchored to a baseline; the max and the last labelled.
  function barChart(rows, labelFn, tipFn) {
    const W = 300, H = 70, top = 14, bottom = 16, n = rows.length || 1;
    const slot = W / n, w = Math.max(4, Math.min(28, slot - 6));
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const iMax = rows.findIndex((r) => r[1] === max);
    const base = top + H;
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + (top + H + bottom) + '" role="img" aria-label="Casts per day">' +
      '<line class="base" x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '"></line>' +
      rows.map((r, i) => {
        const x = i * slot + (slot - w) / 2, h = Math.round((r[1] / max) * H), y = base - h, rr = Math.min(4, h, w / 2);
        const bar = h ? '<path class="bar" d="M' + x + ',' + base + 'V' + (y + rr) + 'Q' + x + ',' + y + ' ' + (x + rr) + ',' + y +
          'H' + (x + w - rr) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + rr) + 'V' + base + 'Z"></path>' : '';
        const val = h && (i === iMax || i === n - 1) ? '<text class="val" x="' + (x + w / 2) + '" y="' + (y - 4) + '" text-anchor="middle">' + r[1] + '</text>' : '';
        return '<g data-tip="' + esc(tipFn(r)) + '"><rect class="hit" x="' + i * slot + '" y="0" width="' + slot + '" height="' + (base + bottom) + '"></rect>' +
          bar + val + '<text class="lab" x="' + (x + w / 2) + '" y="' + (base + 12) + '" text-anchor="middle">' + esc(labelFn(r[0])) + '</text></g>';
      }).join('') + '</svg>';
  }

  function gauge(value, lo, hi, level, unit) {
    const f = value == null ? 0 : Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    const arc = 'M10,56 A46,46 0 0 1 102,56';
    return '<svg class="gauge ' + esc(level) + '" viewBox="0 0 112 66" role="img" aria-label="' + esc(value + ' ' + unit) + '">' +
      '<path class="g-track" d="' + arc + '" fill="none" stroke-width="9" stroke-linecap="round" pathLength="100"></path>' +
      (f ? '<path class="g-fill" d="' + arc + '" fill="none" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="' +
        (f * 100).toFixed(1) + ' 100"></path>' : '') +
      '<text x="56" y="50" text-anchor="middle">' + esc(value == null ? '?' : value) + '</text>' +
      '<text class="g-unit" x="56" y="63" text-anchor="middle">' + esc(unit) + '</text></svg>';
  }

  function sigBars(signal, level) {
    const on = signal == null ? 0 : signal >= 85 ? 4 : signal >= 65 ? 3 : signal >= 45 ? 2 : signal > 0 ? 1 : 0;
    return '<span class="sig ' + esc(level) + '" aria-hidden="true">' + [6, 10, 14, 18].map((h, i) =>
      '<i class="' + (i < on ? 'on' : '') + '" data-h="' + h + '"></i>').join('') + '</span>';
  }

  // -- the health history (pb-healthlog on the Pi: a row every 5 minutes, 7 days) ---------------

  const WEEK = 7 * 86400, GAP = 15 * 60;

  function col(name) {
    return hist && hist.cols ? hist.cols.indexOf(name) : -1;
  }

  // [t, value] pairs for one column, nulls dropped
  function series(name) {
    const i = col(name);
    if (i < 0 || !hist.rows) return [];
    return hist.rows.filter((r) => r[i] != null).map((r) => [r[0], r[i]]);
  }

  // A line through [t, v] points over the last 7 days, broken where the Pi was off (a gap over 15 min).
  function linePath(pts, x, y) {
    let d = '', last = null;
    pts.forEach(([t, v]) => {
      d += (last == null || t - last > GAP ? 'M' : 'L') + x(t).toFixed(1) + ',' + y(v).toFixed(1);
      last = t;
    });
    return d;
  }

  // A small line for a tile: the last 7 days, no axes.
  function sparkline(pts, lo, hi, level) {
    if (pts.length < 2) return '<span class="spark-empty">' + esc(hist ? 'collecting…' : '') + '</span>';
    const W = 120, H = 26, now = Date.now() / 1000;
    const x = (t) => ((t - (now - WEEK)) / WEEK) * W;
    const y = (v) => H - 2 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - 4);
    return '<svg class="spark ' + esc(level || '') + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + linePath(pts, x, y) + '"></path></svg>';
  }

  // The drawer's 7-day chart: day lines labelled by weekday, dashed thresholds, a hover strip of
  // 2-hour slots saying the range in each.
  function weekChart(lines, opts) {
    const W = 480, H = 110, top = 8, bottom = 16, left = 30, now = Date.now() / 1000, from = now - WEEK;
    const x = (t) => left + ((t - from) / WEEK) * (W - left);
    const y = (v) => top + H - ((Math.max(opts.lo, Math.min(opts.hi, v)) - opts.lo) / (opts.hi - opts.lo)) * H;
    let g = '';
    const d0 = new Date(from * 1000);
    d0.setHours(24, 0, 0, 0);
    for (let d = d0.getTime() / 1000; d < now; d += 86400) {
      const dd = new Date(d * 1000);
      g += '<line class="grid" x1="' + x(d).toFixed(1) + '" x2="' + x(d).toFixed(1) + '" y1="' + top + '" y2="' + (top + H) + '"></line>' +
        '<text class="lab" x="' + (x(d) + 3).toFixed(1) + '" y="' + (top + H + 12) + '">' + esc(dd.toLocaleDateString('en-GB', { weekday: 'short' })) + '</text>';
    }
    [opts.lo, opts.hi].forEach((v) => {
      g += '<text class="lab" x="' + (left - 4) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    });
    (opts.marks || []).forEach(([v, cls]) => {
      g += '<line class="mark ' + cls + '" x1="' + left + '" x2="' + W + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"></line>';
    });
    const paths = lines.map(([pts, cls]) => '<path class="ln ' + cls + '" d="' + linePath(pts, x, y) + '"></path>').join('');
    const main = lines[0][0];
    let hits = '';
    for (let s = from; s < now; s += 7200) {
      const inSlot = main.filter(([t]) => t >= s && t < s + 7200).map(([, v]) => v);
      const tip = dayTime(s) + '–' + new Date((s + 7200) * 1000).toTimeString().slice(0, 5) + ': ' +
        (inSlot.length ? Math.min(...inSlot) + (Math.min(...inSlot) === Math.max(...inSlot) ? '' : '–' + Math.max(...inSlot)) + ' ' + opts.unit : 'no readings (off?)');
      hits += '<rect class="hit" x="' + x(s).toFixed(1) + '" y="' + top + '" width="' + ((7200 / WEEK) * (W - left)).toFixed(2) + '" height="' + H + '" data-tip="' + esc(tip) + '"></rect>';
    }
    return '<svg class="chart week" viewBox="0 0 ' + W + ' ' + (top + H + bottom) + '" role="img" aria-label="' + esc(opts.label) + '">' +
      g + paths + hits + '</svg>';
  }

  // Under-voltage and throttling as episodes (consecutive 5-minute rows count as one).
  function episodes(name) {
    const i = col(name);
    if (i < 0) return [];
    const out = [];
    let cur = null;
    hist.rows.forEach((r) => {
      if (r[i] > 0) {
        if (cur && r[0] - cur.end <= GAP) { cur.end = r[0]; cur.n += r[i]; } else { cur = { start: r[0], end: r[0], n: r[i] }; out.push(cur); }
      }
    });
    return out;
  }

  function eventStrip(uv, thr) {
    const W = 480, H = 22, left = 30, now = Date.now() / 1000, from = now - WEEK;
    const x = (t) => left + ((t - from) / WEEK) * (W - left);
    const bar = (e, cls, what) => '<rect class="ev ' + cls + '" x="' + (x(e.start - 300)).toFixed(1) + '" y="2" width="' +
      Math.max(2, x(e.end) - x(e.start - 300)).toFixed(1) + '" height="' + (H - 4) + '" data-tip="' + esc(what + ' ' + dayTime(e.start) +
      (e.end > e.start ? ' to ' + new Date(e.end * 1000).toTimeString().slice(0, 5) : '')) + '"></rect>';
    return '<svg class="chart strip" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Under-voltage and throttling over 7 days">' +
      '<rect class="strip-bg" x="' + left + '" y="2" width="' + (W - left) + '" height="' + (H - 4) + '"></rect>' +
      thr.map((e) => bar(e, 'thr', 'Throttled')).join('') + uv.map((e) => bar(e, 'uv', 'Under-voltage')).join('') + '</svg>';
  }

  // The tile's version of the power strip: a mark wherever under-voltage (or throttling) was seen.
  function miniStrip() {
    if (!hist || !hist.rows || hist.rows.length < 2) return sparkline([], 0, 1);
    const W = 120, H = 26, now = Date.now() / 1000;
    const x = (t) => ((t - (now - WEEK)) / WEEK) * W;
    const mark = (e, cls) => '<rect class="ev ' + cls + '" x="' + x(e.start - 300).toFixed(1) + '" y="4" width="' +
      Math.max(2, x(e.end) - x(e.start - 300)).toFixed(1) + '" height="' + (H - 8) + '"></rect>';
    return '<svg class="spark strip" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<rect class="strip-bg" x="0" y="' + (H / 2 - 1) + '" width="' + W + '" height="2"></rect>' +
      episodes('thr').map((e) => mark(e, 'thr')).join('') + episodes('uv').map((e) => mark(e, 'uv')).join('') + '</svg>';
  }

  function histNote() {
    if (hist && hist.rows && hist.rows.length) {
      return hist.running && hist.running !== 'active' ? '<p class="note warn-text">pb-healthlog is ' + esc(hist.running) + ' on the Pi: no new readings.</p>' : '';
    }
    if (histErr) return '<p class="note">The 7-day history: ' + esc(histErr) + '</p>';
    if (hist && hist.running !== 'active') return '<p class="note">The 7-day history starts once the Pi has pb-healthlog (its next automatic update).</p>';
    return hist ? '<p class="note">Collecting: the first reading comes 5 minutes after pb-healthlog starts.</p>' : '';
  }

  // -- Day or night ---------------------------------------------------------------------------
  // From the Pi's mode.py --json (the opening hours, the stay-on override, NIGHT_FORCE), which the
  // overview carries as board.schedule. Times are London time, as the laptop's.
  const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  function night(b) {
    const s = (b && b.schedule) || null;
    if (!s) return {};
    const out = { isNight: s.mode === 'night', today: (s.hours || {})[DAYS[new Date().getDay()]] };
    if (s.force) out.forced = s.force;
    else if (!/^(on|yes|1|true)$/.test(s.night_mode || 'on')) out.forced = 'off';
    if (s.stay_on_until) out.stay = s.stay_on_until.slice(11, 16);
    if (s.next_change) {
      out.at = hhmm(s.next_change);
      out.inMin = Math.max(0, Math.round((new Date(s.next_change) - Date.now()) / 60000));
    }
    return out;
  }

  function modeLabel(nt) {
    if (nt.forced) return nt.forced === 'off' ? 'No night mode' : 'Forced ' + nt.forced;
    if (nt.stay) return 'Staying on until ' + nt.stay;
    return nt.isNight === undefined ? '?' : nt.isNight ? 'Night' : 'Day';
  }

  // -- the tiles -------------------------------------------------------------------------------

  function renderHero(m) {
    const tiles = (data && data.tiles) || [];
    const bad = tiles.filter((t) => t.level === 'bad'), warn = tiles.filter((t) => t.level === 'warn');
    const level = !data ? 'unknown' : !data.pi_ok ? 'bad' : bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
    const hero = $('hero');
    hero.className = 'hero ' + level;
    hero.querySelector('.hero-icon').textContent = level === 'ok' ? '✓' : level === 'unknown' ? '…' : '!';
    const n = bad.length + warn.length, nd = tiles.filter((t) => t.dismissed).length;
    $('hero-title').textContent = !data.pi_ok ? "The Pi isn't answering" : !n ? (nd ? 'Nothing new to look at' : 'Everything is running') :
      n + (n === 1 ? ' thing needs' : ' things need') + ' a look';
    $('hero-chips').innerHTML = (!data.pi_ok ? '<button class="btn small" data-goto="runbook">What to do: the Runbook</button>' : '') +
      bad.concat(warn).map((t) =>
        '<span class="chip-pair"><button class="lvl-chip ' + t.level + '" data-tile="' + esc(t.id) + '" title="' + esc(t.value) + '">' + esc(t.title) +
        (t.id === 'backup' ? ': ' + esc(t.value) : '') +
        '</button><button class="chip-x" data-dismiss="' + esc(t.id) + '" title="Dismiss until it changes" aria-label="Dismiss ' + esc(t.title) + '">×</button></span>').join('') +
      (n > 1 ? '<button class="t-more" data-dismiss="*">Dismiss all</button>' : '') +
      (nd ? '<button class="t-more" data-undismiss="*">' + nd + ' dismissed · show again</button>' : '');
    const l = m.listener || {}, nt = night(data.board);
    const kpis = [
      ['Pi up', m.pi ? span(m.pi.uptime_s) : 'offline'],
      ['Casts 24 h', l.casts_24h != null ? l.casts_24h : '-'],
      ['Last cast', l.last_cast_at ? ago(l.last_cast_at) : '-'],
      ['Mode', modeLabel(nt)],
    ];
    $('hero-kpis').innerHTML = kpis.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('');
  }

  function renderBoard() {
    const b = data.board || {}, cfg = b.config || {}, l = (data.metrics || {}).listener || {};
    const level = lvl(GROUPS.board.ids);
    const c = $('board-chip');
    c.className = 'lvl-chip ' + level;
    c.textContent = LABEL[level];
    $('ov-leds').textContent = b.leds === 'cast' ? 'Showing ' + (l.last_cast_name || 'a cast') :
      b.leds === 'night' ? 'LEDs dark: night' : b.leds === 'off' ? 'LEDs off (by hand)' : b.leds ? 'Idle: ' + (b.pattern || b.override || b.leds) : '';
    const nt = night(b);
    $('ov-mode').textContent = nt.isNight === undefined ? '' : modeLabel(nt) +
      (nt.forced || !nt.at ? '' : ' · ' + (nt.isNight ? 'lights at ' : 'dark at ') + nt.at);
    const sel = $('ov-pattern');
    if (!sel.options.length) {
      sel.innerHTML = (PB.state().patterns || []).map(([n, about]) => '<option value="' + esc(n) + '" title="' + esc(about) + '">' + esc(n) + '</option>').join('') +
        '<option value="tour">tour (each for 60 s)</option><option value="cycle">cycle (IDLE_CYCLE)</option>';
    }
    // the listener's pattern reads like "wave (IDLE_PATTERN)": the option is the first word
    if (document.activeElement !== sel) sel.value = (b.override || b.pattern || cfg.IDLE_PATTERN || sel.value || '').split(' ')[0];
    const force = cfg.NIGHT_FORCE || 'auto';
    document.querySelectorAll('#ov-night .btn').forEach((el) => el.classList.toggle('on', el.dataset.mode === force));
    document.querySelectorAll('#ov-screen .btn').forEach((el) => el.classList.toggle('on', (el.dataset.state === 'off') === !!b.screen_off));
    $('ov-stay-end').hidden = !(b.schedule && b.schedule.stay_on_until);
    const r = $('ov-bright');
    if (!r.matches(':active') && document.activeElement !== r && b.scale != null) {
      r.value = Math.round(b.scale * 100);
      $('ov-bright-out').textContent = r.value + '%';
    }
  }

  function boardDetails() {
    const b = (data && data.board) || {}, cfg = b.config || {}, sc = b.schedule || {}, l = (data.metrics || {}).listener || {};
    const recent = ((data.metrics || {}).casts_recent || []).slice().reverse().slice(0, 8);
    const rows = [
      ['LEDs', b.leds || '?'], ['Pattern', b.pattern || '-'], ['Idle plan', b.plan || '-'], ['Idle override', b.override || 'none'],
      ['Brightness', b.scale != null && b.scale < 1 ? 'x' + b.scale + ' (pb-idle, until a restart)' : 'as configured (' + (cfg.BRIGHTNESS || '?') + ' cast, ' + (cfg.IDLE_BRIGHTNESS || '?') + ' idle)'],
      ['Mode', b.mode || '?'],
      ['Override', sc.stay_on_until ? 'staying on until ' + sc.stay_on_until.replace('T', ' ') : cfg.NIGHT_FORCE ? 'forced ' + cfg.NIGHT_FORCE + ' (NIGHT_FORCE)' : 'none: the opening hours'],
      ['Screen', b.screen_off ? 'off by hand' : 'normal'],
      ['Listener', (l.state || '?') + (l.connected_since ? ', connected ' + ago(l.connected_since).replace(' ago', '') : '')],
    ];
    return '<section class="d-sec"><dl class="kv">' + rows.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>' +
      '<p class="note">Pattern, LEDs off and brightness last until the listener restarts; the permanent ones are in Advanced → Config.</p></section>' +
      '<section class="d-sec"><div class="t-head"><h3>Last casts</h3></div>' + (recent.length ? '<ul class="list">' + recent.map((c) =>
        '<li><span class="when">' + esc(hhmm(c.at)) + '</span><span class="grow">' + esc(c.name) + '</span>' + (c.mirror ? '<span class="tag">mirrored</span>' : '') + '</li>').join('') + '</ul>'
        : '<p class="empty">No casts in the last 24 hours.</p>') + '</section>';
  }

  // One row of the Health tile: a name, the value, a little 7-day line or a meter.
  function hrow(level, name, value, extra, tip) {
    return '<div class="hrow ' + esc(level) + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><span class="dot"></span><span class="h-name">' + esc(name) +
      '</span><span class="h-val">' + value + '</span><span class="h-x">' + (extra || '') + '</span></div>';
  }

  function powerSummary(m) {
    const hw = m.hw || {};
    const now = (hw.throttle || []).filter((t) => / now$/.test(t));
    const uv = hist ? episodes('uv') : [];
    if (now.some((t) => /under-voltage/.test(t))) return ['bad', 'Under-voltage now', 'the supply is too low: check the power lead and the 5 V supply'];
    if (uv.length) {
      const last = uv[uv.length - 1];
      return ['warn', 'Under-voltage ' + uv.length + (uv.length === 1 ? ' time' : ' times') + ' this week', 'last ' + dayTime(last.start)];
    }
    if (now.length) return ['warn', now[0].replace(/ now$/, ''), 'the Pi is slowing itself down'];
    const sinceBoot = (hw.throttle || []).filter((t) => /since boot/.test(t));
    if (sinceBoot.length && !hist) return ['warn', 'OK now', sinceBoot.join(', ')];
    return ['ok', 'OK', hist && hist.rows && hist.rows.length ? 'no under-voltage this week' : 'no under-voltage since boot'];
  }

  function renderHealth(m) {
    if (!m.pi) {
      return setTile('t-health', head('Health', 'bad') + '<div class="big mid">The Pi isn\'t answering</div><p class="sub">' +
        esc((byId.pi && byId.pi.lines[0]) || '') + '</p><div class="t-foot">' + goBtn('runbook', 'Runbook') + '</div>', 'bad', 'health');
    }
    const hw = m.hw || {}, w = m.wifi || {};
    const t = hw.temp_c, tl = t == null ? 'unknown' : t < 70 ? 'ok' : t < 80 ? 'warn' : 'bad';
    const temps = series('tmax');
    const tmax = temps.length ? Math.max(...temps.map((p) => p[1])) : null;
    const [pl, pv, ptip] = powerSummary(m);
    const level = worst([lvl(HEALTH_IDS), pl]);        // under-voltage this week is worth a look too
    const wl = byId.wifi ? byId.wifi.level : 'unknown';
    const dl = byId.disk ? byId.disk.level : 'unknown';
    const svc = m.services || {};
    const down = SERVICES.filter((u) => svc[u] && byId['svc-' + u] && byId['svc-' + u].level !== 'ok');
    const sl = worst(SERVICES.map((u) => (byId['svc-' + u] ? byId['svc-' + u].level : 'ok')).concat([lvl(['timers'])]));
    const restartable = PB.state().units || [];
    const appL = lvl(['site', 'supabase']);
    const h = m.health || {}, e = m.errors || {};
    const fixL = lvl(['health', 'errors']);
    setTile('t-health', head('Health', level, '<button class="t-more" data-detail-open="health">7 days ›</button>') +
      '<div class="health-top">' + gauge(t, 30, 85, tl, '°C') + '<div class="hrows">' +
      hrow(tl, 'Temperature', esc(t == null ? '?' : t + ' °C'), sparkline(temps, 30, 85, tl),
        tmax != null ? 'Highest this week: ' + tmax + ' °C' : 'The Pi throttles itself at 80 °C') +
      hrow(pl, 'Power', esc(pv), miniStrip(), ptip) +
      hrow(wl, 'Wi-Fi', w.rescue_up ? 'rescue hotspot' : w.ssid ? esc(w.signal + '%') + ' ' + sigBars(w.signal, wl) : 'not connected',
        sparkline(series('wifi'), 0, 100, wl), (w.ssid || '') + (w.ip ? ' · ' + w.ip : '')) +
      hrow(dl, 'Disk', esc(pct(hw.disk_used) + ' used'), sparkline(series('disk'), 0, 100, dl), gb(hw.disk_free) + ' free of ' + gb(hw.disk_total)) +
      '</div></div>' +
      '<div class="hrows">' +
      hrow(sl, 'Services', down.length ? down.map((u) => esc(SVC_NAMES[u] || u) + ' ' + esc((svc[u] || {}).state || '?') +
        (restartable.includes(u) ? ' <button class="icon-btn" data-act="service" data-unit="' + esc(u) + '" data-verb="restart">Restart</button>' : '')).join(', ')
        : 'all ' + SERVICES.filter((u) => svc[u]).length + ' running', '') +
      hrow(appL, 'App', appL === 'ok' ? 'live site and Supabase OK' : esc((byId.site && byId.site.level !== 'ok' ? 'site: ' + byId.site.value : '') +
        (byId.supabase && byId.supabase.level !== 'ok' ? ' Supabase: ' + byId.supabase.value : '')), '') +
      hrow(fixL, 'Self-healing', esc((h.day || 0) + ' fixes in 24 h · ' + (e.total || 0) + ' errors logged'), '',
        'What the Pi fixed by itself (Wi-Fi, restarts) and how many error lines its journal has in 24 h') +
      '</div>' + histNote(), level, 'health');
  }

  function healthDetails() {
    const m = (data && data.metrics) || {};
    if (!m.pi) return '<p class="banner bad">The Pi isn\'t answering. <button class="btn small" data-goto="runbook">The Runbook</button></p>';
    const uv = hist ? episodes('uv') : [], thr = hist ? episodes('thr') : [];
    const svc = m.services || {}, restartable = PB.state().units || [];
    const charts = hist && hist.rows && hist.rows.length ? [
      '<h3>Temperature (°C)</h3>' + weekChart([[series('temp'), 'a'], [series('tmax'), 'b']], { lo: 30, hi: 85, unit: '°C', label: 'Temperature over 7 days', marks: [[70, 'warn'], [80, 'bad']] }) +
        '<p class="note">The line is each 5-minute reading; the faint one the highest in those 5 minutes. Amber from 70 °C; the Pi slows itself down at 80 °C.</p>',
      '<h3>Power</h3>' + eventStrip(uv, thr) +
        '<p class="note">' + (uv.length ? 'Under-voltage (red) ' + uv.length + (uv.length === 1 ? ' time' : ' times') + ', last ' + esc(dayTime(uv[uv.length - 1].start)) + '. '
          : 'No under-voltage this week. ') + (thr.length ? 'Throttled (amber) ' + thr.length + (thr.length === 1 ? ' time' : ' times') + '. ' : '') +
        'The Pi 4 can\'t measure its supply voltage; its firmware flags when it drops below about 4.63 V, checked every 15 s.</p>',
      '<h3>Wi-Fi signal (%)</h3>' + weekChart([[series('wifi'), 'a']], { lo: 0, hi: 100, unit: '%', label: 'Wi-Fi signal over 7 days', marks: [[50, 'warn'], [30, 'bad']] }),
      '<h3>Disk used (%)</h3>' + weekChart([[series('disk'), 'a']], { lo: 0, hi: 100, unit: '%', label: 'Disk used over 7 days', marks: [[80, 'warn'], [90, 'bad']] }),
    ].join('') : histNote();
    const rows = SERVICES.filter((u) => svc[u]).map((u) => {
      const s = svc[u], t = byId['svc-' + u], l = t ? t.level : s.state === 'active' ? 'ok' : 'bad';
      return '<li class="' + l + '"><span class="dot"></span><span class="grow">' + esc(SVC_NAMES[u] || u) + ' <span class="muted">' + esc(u) + '</span></span>' +
        (s.restarts && s.restarts !== '0' ? '<span class="tag dim" data-tip="restarted by systemd since boot">↻ ' + esc(s.restarts) + '</span>' : '') +
        '<span class="when">' + esc(s.state || '?') + '</span>' + (restartable.includes(u) ? '<button class="icon-btn" data-act="service" data-unit="' + esc(u) +
        '" data-verb="restart">Restart</button>' : '') + '</li>';
    }).join('');
    return '<section class="d-sec">' + charts + '</section>' +
      '<section class="d-sec"><div class="t-head"><h3>Services</h3></div><ul class="list">' + rows + '</ul>' +
      '<div class="btn-row"><button class="btn small" data-act="service" data-unit="kiosk" data-verb="restart">Restart the wall screen (loads the latest app)</button>' +
      '<button class="btn small danger" data-act="reboot">Reboot the Pi</button></div>' +
      '<p class="note">Each asks first, and checks whether someone is using the board.</p></section>';
  }

  function renderCasts() {
    const more = goBtn('activity', 'Activity');
    if (!act) return setTile('t-casts', head('Activity · 7 days', null, more) + '<p class="empty">Reading the journal…</p>');
    const days = act.per_day || [];
    const day = (iso) => new Date(iso + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short' });
    setTile('t-casts', head('Activity · 7 days', null, more) +
      '<div><div class="big">' + act.total + '</div><div class="sub">casts' +
      (act.ignored_night ? ' · ' + act.ignored_night + ' tried outside the hours' : '') + '</div></div>' +
      barChart(days, (d) => day(d).slice(0, 2), (r) => day(r[0]) + ' ' + r[0].slice(8) + ': ' + r[1] + ' casts') +
      '<h3 class="t-sub">Most cast</h3>' + hbars((act.top || []).slice(0, 3).map(([n, c]) => [n, c])));
  }

  function renderSchedule() {
    const nt = night(data.board), level = lvl(['schedule']);
    const big = nt.forced || nt.stay ? modeLabel(nt) :
      nt.inMin == null ? '?' : (nt.isNight ? 'Lights on in ' : 'Night in ') + span(nt.inMin * 60);
    const sc = (data.board && data.board.schedule) || {}, hours = sc.hours && !sc.hours.error ? sc.hours : null;
    const order = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'], today = DAYS[new Date().getDay()];
    setTile('t-schedule', head('Opening hours', level, '<button class="t-more" data-detail-open="schedule">Edit ›</button>') +
      '<div><div class="big mid">' + esc(big) + '</div><div class="sub">' + esc(nt.at ? 'next switch ' + nt.at : '') + '</div></div>' +
      (nt.stay ? '<div class="btn-row"><button class="btn small" data-act="stay-on" data-until="end">End override</button></div>' : '') +
      (hours ? '<ul class="list week-hours">' + order.map((d) => '<li class="' + (d === today ? 'today' : '') + '"><span class="when">' + d[0] + d.slice(1).toLowerCase() +
        '</span><span class="grow">' + esc(hours[d] === 'closed' ? 'closed' : String(hours[d] || '?').replace('-', '–')) + '</span></li>').join('') + '</ul>'
        : '<p class="empty">' + esc((sc.hours && sc.hours.error) || 'Hours unknown') + '</p>'), level, 'schedule');
  }

  function scheduleDetails() {
    return '<section class="d-sec"><div class="t-head"><h3>The hours</h3></div><div data-hours-box="1" id="hours-box"></div></section>' +
      '<section class="d-sec"><div class="t-head"><h3>One evening</h3></div><p class="note">Stay on until a time (Board → Stay on): day mode until then, ' +
      'ending by itself. Force night / Force day (Board → Night) are for tests and stay until Auto.</p></section>';
  }

  function backupDetails() {
    const b = (data && data.backup) || {};
    return '<section class="d-sec"><p class="note">The Pi\'s settings (secrets stripped on the Pi) and the public Supabase tables go into ' +
      '<code>backups/&lt;date&gt;/</code> every week, by the laptop\'s scheduled task (the one that keeps the Pi up to date).' +
      (b.running ? ' A backup is running now.' : '') + '</p><div class="btn-row"><button class="btn primary" data-act="backup">Back up now</button>' +
      '<button class="btn" data-goto="backups">Advanced → Backups</button></div></section>';
  }

  function renderAudit(rows) {
    if (rows) audit = rows;
    const last = (audit || []).filter((r) => !/^console (start|stop)$/.test(r.action) && !(clearedAt && r.time <= clearedAt)).slice(-6).reverse();
    setTile('t-audit', head('Recent actions', null, (last.length ? '<button class="t-more" data-clear-audit="1" title="Hide these here; Advanced → Audit keeps them">Clear</button>' : '') +
      goBtn('audit', 'All')) +
      (last.length ? '<ul class="list">' + last.map((r) => '<li><span class="when">' + esc(hhmm(r.time)) + '</span><span class="tag ' +
        (r.result === 'ok' ? 'ok' : r.result === 'cancelled' ? 'dim' : 'bad') + '">' + esc(r.result) + '</span><span class="grow"><b>' + esc(r.action) +
        '</b> <span class="muted">' + esc(r.detail || '') + '</span></span>' + (r.ms != null ? '<span class="when">' + (r.ms / 1000).toFixed(1) + ' s</span>' : '') +
        '</li>').join('') + '</ul>' : '<p class="empty">' + (clearedAt ? 'Nothing since you cleared it.' : 'Nothing run from the console yet.') + '</p>'));
  }

  function navDots() {
    const set = (k, l) => { const d = $('nav-dot-' + k); if (d) d.className = 'nav-dot ' + (l || ''); };
    const tiles = (data && data.tiles) || [];
    set('overview', data && !data.pi_ok ? 'bad' : worst(tiles.map((t) => t.level)));
  }

  // the server's tiles with this browser's dismissals applied (copies: PB.overview() stays as it came)
  function applyDismissed(d) {
    let changed = false;
    const tiles = (d.tiles || []).map((t) => {
      if (!(t.id in dismissed)) return t;
      if ((t.level === 'warn' || t.level === 'bad') && dismissed[t.id] === t.sig) {
        return Object.assign({}, t, { level: 'ok', was: t.level, dismissed: true });
      }
      delete dismissed[t.id];      // it changed, or it's fine now: forget the dismissal
      changed = true;
      return t;
    });
    if (changed) save(DISMISS_KEY, dismissed);
    return Object.assign({}, d, { tiles });
  }

  function dismiss(id) {
    const live = (PB.overview() || {}).tiles || [];
    live.filter((t) => (id === '*' || t.id === id) && (t.level === 'warn' || t.level === 'bad')).forEach((t) => { dismissed[t.id] = t.sig; });
    save(DISMISS_KEY, dismissed);
    render(PB.overview());
  }

  function undismiss(id) {
    if (id === '*') dismissed = {}; else delete dismissed[id];
    save(DISMISS_KEY, dismissed);
    render(PB.overview());
  }

  function render(d) {
    d = applyDismissed(d);
    data = d;
    byId = {};
    (d.tiles || []).forEach((t) => { byId[t.id] = t; });
    const m = d.metrics || {};
    renderHero(m);
    renderBoard();
    renderHealth(m);
    renderSchedule();
    renderCasts();
    navDots();
    if (drawerKey && drawerKey !== 'schedule') openDrawer(drawerKey);      // the hours editor keeps what's typed
    if (Date.now() - actAt > ACTIVITY_MS) loadActivity();
    if (d.pi_ok && Date.now() - histAt > HISTORY_MS) loadHistory();
  }

  async function loadActivity() {
    actAt = Date.now();
    try {
      const { status, data: a } = await PB.apiJson('/api/activity?days=7');
      if (status === 200) act = a;
    } catch (e) { /* the tile keeps its last numbers */ }
    renderCasts();
  }

  async function loadHistory(refresh) {
    histAt = Date.now();
    try {
      const { status, data: h } = await PB.apiJson('/api/health-history' + (refresh ? '?refresh=1' : ''));
      if (status === 200) { hist = h; histErr = ''; } else histErr = h.error || 'HTTP ' + status;
    } catch (e) { histErr = e.message; }
    if (data) {
      renderHealth(data.metrics || {});
      if (drawerKey === 'health') openDrawer('health');
    }
  }

  // -- the drawer: the detail behind a tile ----------------------------------------------------

  function openDrawer(key) {
    const g = GROUPS[key];
    if (!g) return;
    const scroll = drawerKey === key ? $('drawer').scrollTop : 0;
    drawerKey = key;
    $('drawer-title').textContent = g.title;
    const lines = g.ids.filter((i) => byId[i]).map((i) => {
      const t = byId[i];
      const act = t.dismissed ? '<span class="lvl-chip">Dismissed (was ' + esc(LABEL[t.was]) + ')</span><button class="t-more" data-undismiss="' + esc(t.id) + '">Show again</button>' :
        chip(t.level) + (t.level === 'warn' || t.level === 'bad' ? '<button class="t-more" data-dismiss="' + esc(t.id) + '" title="Dismiss until it changes">Dismiss</button>' : '');
      return '<section class="d-sec"><div class="t-head"><h3>' + esc(t.title) + '</h3>' + act + '</div><div class="d-val">' +
        esc(t.value) + '</div><ul>' + (t.lines || []).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></section>';
    }).join('');
    $('drawer-body').innerHTML = (g.top ? g.top() : '') + (key === 'health' ? '<details class="d-more"><summary>Every line (for Claude)</summary>' + lines + '</details>' : lines);
    applySizes($('drawer-body'));
    if (key === 'schedule' && PB.hoursEditor) PB.hoursEditor($('hours-box'));
    $('drawer').hidden = false;
    $('drawer').scrollTop = scroll;
  }

  function closeDrawer() {
    drawerKey = null;
    $('drawer').hidden = true;
  }

  // -- the command palette ----------------------------------------------------------------------

  let items = [];
  let sel = 0;

  function commands() {
    const out = [];
    document.querySelectorAll('.nav [data-tab]').forEach((b) => { if (!b.hidden) out.push({ label: b.textContent.trim(), kind: 'Section', run: () => PB.showTab(b.dataset.tab) }); });
    document.querySelectorAll('details.adv').forEach((d) => out.push({ label: 'Advanced: ' + d.querySelector('summary strong').textContent, kind: 'Section', run: () => PB.showTab(d.dataset.adv) }));
    const a = (label, action, args) => out.push({ label, kind: 'Action', run: () => PB.runAction(action, args, label) });
    out.push({ label: 'Refresh Home now', kind: 'Action', run: () => $('refresh').click() });
    out.push({ label: 'Health: the 7-day charts', kind: 'Home', run: () => { PB.showTab('overview'); openDrawer('health'); } });
    out.push({ label: 'Edit the opening hours', kind: 'Home', run: () => { PB.showTab('overview'); openDrawer('schedule'); } });
    out.push({ label: 'Light a problem', kind: 'Home', run: () => { PB.showTab('overview'); $('ov-cast-name').focus(); } });
    a('LEDs: idle now', 'idle', { cmd: 'now' });
    a('LEDs off', 'idle', { cmd: 'off' });
    a('LEDs back to the default', 'idle', { cmd: 'default' });
    (PB.state().patterns || []).forEach(([n]) => a('Idle pattern: ' + n, 'idle', { cmd: n }));
    a('Idle pattern: tour', 'idle', { cmd: 'tour' });
    a('Night mode: auto (the opening hours)', 'night', { mode: 'auto' });
    a('End the stay-on override', 'stay-on', { until: 'end' });
    a('Night mode: force night', 'night', { mode: 'night' });
    a('Night mode: force day', 'night', { mode: 'day' });
    a('Wall screen on', 'screen', { state: 'on' });
    a('Wall screen off', 'screen', { state: 'off' });
    (PB.state().units || []).forEach((u) => a('Restart ' + u, 'service', { unit: u, verb: 'restart' }));
    a('Reboot the Pi', 'reboot', {});
    a('Back up now', 'backup-now', {});
    out.push({ label: 'Dismiss everything that needs a look', kind: 'Home', run: () => dismiss('*') });
    out.push({ label: 'Show dismissed things again', kind: 'Home', run: () => undismiss('*') });
    out.push({ label: 'Clear recent actions', kind: 'Home', run: () => { PB.showTab('overview'); const b = document.querySelector('[data-clear-audit]'); if (b) b.click(); } });
    return out;
  }

  function drawPalette() {
    const words = $('palette-q').value.toLowerCase().split(/\s+/).filter(Boolean);
    items = commands().filter((c) => words.every((w) => (c.label + ' ' + c.kind).toLowerCase().includes(w)));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    $('palette-list').innerHTML = items.map((c, i) => '<li role="option" data-i="' + i + '" aria-selected="' + (i === sel) + '"><span>' +
      esc(c.label) + '</span><span class="kind">' + esc(c.kind) + '</span></li>').join('') || '<li class="muted">Nothing matches.</li>';
    const cur = $('palette-list').querySelector('[aria-selected="true"]');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    const p = $('palette');
    if (p.open) return;
    $('palette-q').value = '';
    sel = 0;
    drawPalette();
    p.showModal();
    $('palette-q').focus();
  }

  function runPick(i) {
    const c = items[i];
    $('palette').close();
    if (c) c.run();
  }

  // -- wiring -------------------------------------------------------------------------------------

  function onTab(name) {
    const img = $('ov-cam'), url = PB.state().cam_url;
    if (name === 'overview' && url) {
      if (img.dataset.live !== '1') {
        img.dataset.live = '1';
        $('ov-cam-note').hidden = true;
        img.src = url;
      }
    } else if (img.dataset.live === '1') {
      img.dataset.live = '';
      img.src = BLANK;      // stops the MJPEG stream while Home is hidden
    }
    if (name !== 'overview') closeDrawer();
  }

  function wire() {
    const img = $('ov-cam');
    img.addEventListener('error', () => { if (img.dataset.live === '1') $('ov-cam-note').hidden = false; });
    $('ov-cam-wrap').addEventListener('click', () => openDrawer('board'));
    $('ov-bright').addEventListener('input', () => { $('ov-bright-out').textContent = $('ov-bright').value + '%'; });
    $('ov-bright-set').addEventListener('click', () => {
      const v = Number($('ov-bright').value) / 100;
      PB.runAction('brightness', { value: v }, 'Brightness ' + Math.round(v * 100) + '%');
    });
    $('ov-pattern-set').addEventListener('click', () => {
      const n = $('ov-pattern').value;
      if (n) PB.runAction('idle', { cmd: n }, 'pb-idle ' + n);
    });
    $('drawer-close').addEventListener('click', closeDrawer);

    document.body.addEventListener('click', (ev) => {
      const dis = ev.target.closest('[data-dismiss]'), undis = ev.target.closest('[data-undismiss]');
      if (dis) { dismiss(dis.dataset.dismiss); return; }
      if (undis) { undismiss(undis.dataset.undismiss); return; }
      if (ev.target.closest('[data-clear-audit]')) {
        clearedAt = (audit || []).reduce((m, r) => (r.time > m ? r.time : m), clearedAt || '');
        save(CLEARED_KEY, clearedAt);
        renderAudit();
        return;
      }
      const open = ev.target.closest('[data-detail-open]');
      if (open) { openDrawer(open.dataset.detailOpen); return; }
      const go = ev.target.closest('[data-goto]');
      if (go) { closeDrawer(); PB.showTab(go.dataset.goto); return; }
      const chipEl = ev.target.closest('[data-tile]');
      if (chipEl) {
        const key = Object.keys(GROUPS).find((k) => GROUPS[k].ids.includes(chipEl.dataset.tile));
        if (key) openDrawer(key); else PB.toast(chipEl.title);
        return;
      }
      if (ev.target.closest('button, a, input, select, label, summary, [data-act], .drawer')) return;
      const tile = ev.target.closest('.t[data-detail]');
      if (tile) openDrawer(tile.dataset.detail);
    });
    $('bento').addEventListener('keydown', (ev) => {
      const tile = ev.target.closest('.t[data-detail]');
      if (tile && ev.target === tile && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openDrawer(tile.dataset.detail); }
    });

    // tooltips for chart marks and anything else with data-tip
    const tip = $('tip');
    document.addEventListener('mouseover', (ev) => {
      const el = ev.target.closest('[data-tip]');
      if (!el) { tip.hidden = true; return; }
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip;
      tip.style.left = Math.max(80, Math.min(window.innerWidth - 80, r.left + r.width / 2)) + 'px';
      tip.style.top = Math.max(40, r.top) + 'px';
      tip.hidden = false;
    });
    window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

    // the palette
    $('palette-open').addEventListener('click', openPalette);
    $('palette-q').addEventListener('input', () => { sel = 0; drawPalette(); });
    $('palette-q').addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); drawPalette(); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') { sel = Math.max(0, sel - 1); drawPalette(); ev.preventDefault(); }
      if (ev.key === 'Enter') { ev.preventDefault(); runPick(sel); }
    });
    $('palette-list').addEventListener('click', (ev) => {
      const li = ev.target.closest('[data-i]');
      if (li) runPick(Number(li.dataset.i));
    });
    $('palette').addEventListener('click', (ev) => { if (ev.target === $('palette')) $('palette').close(); });
    document.addEventListener('keydown', (ev) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target || {}).tagName || '');
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openPalette(); return; }
      if (ev.key === '/' && !typing && !document.querySelector('dialog[open]') && !document.querySelector('#tab-holds:not([hidden])')) { ev.preventDefault(); openPalette(); return; }
      if (ev.key === 'Escape' && drawerKey && !document.querySelector('dialog[open]')) closeDrawer();
    });
  }

  PB.dash = { render, onTab, onState: (s) => renderAudit(s.audit), openDrawer, reloadHistory: () => loadHistory(true) };
  wire();
  // console.js may have got its first answers before this file ran
  if (PB.overview()) render(PB.overview());
  if (PB.state().audit) renderAudit(PB.state().audit);
  const cur = document.querySelector('.nav [aria-selected="true"]');
  onTab(cur ? cur.dataset.tab : 'overview');
}());
