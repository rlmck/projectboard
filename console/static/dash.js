// PB Console Overview: the tiled dashboard, the detail drawer and the command
// palette (Ctrl+K). Uses console.js's helpers (window.PB). The tiles draw from
// /api/overview's `metrics` (the raw numbers) and keep every line of the old
// tiles (`tiles`) one click away in the drawer. Activity (/api/activity) and the
// repo (/api/git) are fetched less often. Every button still goes through
// PB.runAction, so the confirm and the busy check are unchanged.
'use strict';

(function () {
  const PB = window.PB;
  if (!PB) return;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;
  const ACTIVITY_MS = 300000;
  const GIT_MS = 120000;
  const LABEL = { ok: 'OK', warn: 'Look', bad: 'Problem', unknown: '…' };
  const RANK = { unknown: 0, ok: 1, warn: 2, bad: 3 };
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

  // Each tile's drawer: which of the server's tiles it shows in full, and the section to go to.
  const GROUPS = {
    listener: { title: 'Listener', ids: ['listener', 'svc-pb-listener'], tab: 'logs', go: 'Logs' },
    pi: { title: 'The Pi', ids: ['pi', 'hw', 'disk'], tab: 'services', go: 'Services' },
    wifi: { title: 'Wi-Fi', ids: ['wifi'], tab: 'logs', go: 'Logs' },
    services: { title: 'Services and timers', ids: ['svc-pb-listener', 'svc-kiosk', 'svc-pb-netwatch', 'svc-board-cam', 'timers'], tab: 'services', go: 'Services' },
    site: { title: 'Live site and Supabase', ids: ['site', 'supabase'], tab: 'release', go: 'Release' },
    health: { title: 'Self-healing', ids: ['health'], tab: 'logs', go: 'Logs' },
    errors: { title: 'Journal errors', ids: ['errors'], tab: 'logs', go: 'Logs' },
  };

  let data = null;
  let byId = {};
  let act = null;
  let actAt = 0;
  let git = null;
  let gitAt = 0;
  let drawerKey = null;
  let tab = 'overview';

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

  function setTile(id, html, level, group) {
    const el = $(id);
    if (!el) return;
    el.className = el.className.replace(/\b(ok|warn|bad|unknown)\b/g, '').trim() + (level ? ' ' + level : '');
    if (group) {
      el.dataset.detail = group;
      el.tabIndex = 0;
    }
    el.innerHTML = html;
    // sizes go through the CSSOM: the CSP (style-src 'self') blocks inline style attributes
    el.querySelectorAll('[data-w]').forEach((x) => { x.style.width = x.dataset.w + '%'; });
    el.querySelectorAll('[data-h]').forEach((x) => { x.style.height = x.dataset.h + 'px'; });
    el.querySelectorAll('[data-op]').forEach((x) => { x.style.opacity = x.dataset.op; });
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

  function hbars(rows, neutral) {
    if (!rows.length) return '<p class="empty">Nothing yet.</p>';
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return '<div class="hbars">' + rows.map((r) =>
      '<div class="hbar"' + (r[2] ? ' data-tip="' + esc(r[2]) + '"' : '') + '><span class="name">' + esc(r[0]) +
      '</span><span class="n">' + esc(r[1]) + '</span><div class="track"><div class="fill' + (neutral ? ' neutral' : '') +
      '" data-w="' + Math.max(2, Math.round((r[1] / max) * 100)) + '"></div></div></div>').join('') + '</div>';
  }

  // Vertical bars, rounded at the data end, anchored to a baseline; the max and the last labelled.
  function barChart(rows, labelFn, tipFn) {
    const W = 300, H = 84, top = 14, bottom = 16, n = rows.length || 1;
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
    return '<span class="sig ' + esc(level) + '" aria-hidden="true">' + [8, 14, 20, 26].map((h, i) =>
      '<i class="' + (i < on ? 'on' : '') + '" data-h="' + h + '"></i>').join('') + '</span>';
  }

  function stat(v, label) {
    return '<div class="stat"><b>' + esc(v == null ? '-' : v) + '</b><span>' + esc(label) + '</span></div>';
  }

  // Night: from the config the overview already carries. [isNight, label of the next switch, minutes to it]
  function night(cfg) {
    const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
    const s = toMin(cfg.NIGHT_START), e = toMin(cfg.NIGHT_END);
    if ((cfg.NIGHT_MODE || 'on') === 'off') return { forced: 'off' };
    if (cfg.NIGHT_FORCE) return { forced: cfg.NIGHT_FORCE, isNight: cfg.NIGHT_FORCE === 'night' };
    if (s == null || e == null) return {};
    const d = new Date(), now = d.getHours() * 60 + d.getMinutes();
    const isNight = s > e ? now >= s || now < e : now >= s && now < e;
    const next = isNight ? e : s;
    return { isNight, inMin: (next - now + 1440) % 1440, at: isNight ? cfg.NIGHT_END : cfg.NIGHT_START };
  }

  // -- the tiles -------------------------------------------------------------------------------

  function renderHero(m) {
    const tiles = (data && data.tiles) || [];
    const bad = tiles.filter((t) => t.level === 'bad'), warn = tiles.filter((t) => t.level === 'warn');
    const level = !data ? 'unknown' : !data.pi_ok ? 'bad' : bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
    const hero = $('hero');
    hero.className = 'hero ' + level;
    hero.querySelector('.hero-icon').textContent = level === 'ok' ? '✓' : level === 'unknown' ? '…' : '!';
    const n = bad.length + warn.length;
    $('hero-title').textContent = !data.pi_ok ? "The Pi isn't answering" : !n ? 'Everything is running' :
      n + (n === 1 ? ' thing needs' : ' things need') + ' a look';
    $('hero-chips').innerHTML = bad.concat(warn).map((t) =>
      '<button class="lvl-chip ' + t.level + '" data-tile="' + esc(t.id) + '" title="' + esc(t.value) + '">' + esc(t.title) + '</button>').join('');
    const l = m.listener || {}, cfg = (data.board && data.board.config) || {}, nt = night(cfg);
    const kpis = [
      ['Pi up', m.pi ? span(m.pi.uptime_s) : 'offline'],
      ['Live app', (m.site && m.site.cache) || '?'],
      ['Casts 24 h', l.casts_24h != null ? l.casts_24h : '-'],
      ['Last cast', l.last_cast_at ? ago(l.last_cast_at) : '-'],
      ['Mode', nt.forced ? (nt.forced === 'off' ? 'No night mode' : 'Forced ' + nt.forced) : nt.isNight ? 'Night' : 'Day'],
    ];
    $('hero-kpis').innerHTML = kpis.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('');
  }

  function renderBoard() {
    const b = data.board || {}, cfg = b.config || {}, l = (data.metrics || {}).listener || {};
    const level = lvl(['listener']);
    const c = $('board-chip');
    c.className = 'lvl-chip ' + level;
    c.textContent = LABEL[level];
    $('ov-leds').textContent = b.leds === 'cast' ? 'Showing ' + (l.last_cast_name || 'a cast') :
      b.leds === 'night' ? 'LEDs dark: night' : b.leds === 'off' ? 'LEDs off (by hand)' : b.leds ? 'Idle: ' + (b.pattern || b.override || b.leds) : '';
    const nt = night(cfg);
    $('ov-mode').textContent = nt.forced ? (nt.forced === 'off' ? 'No night mode' : 'Forced ' + nt.forced) : nt.isNight === undefined ? '' :
      (nt.isNight ? 'Night' : 'Day') + ' · ' + (nt.isNight ? 'lights at ' : 'dark at ') + nt.at;
    const sel = $('ov-pattern');
    if (!sel.options.length) {
      sel.innerHTML = (PB.state().patterns || []).map(([n, about]) => '<option value="' + esc(n) + '" title="' + esc(about) + '">' + esc(n) + '</option>').join('') +
        '<option value="tour">tour (each for 60 s)</option><option value="cycle">cycle (IDLE_CYCLE)</option>';
    }
    if (document.activeElement !== sel) sel.value = b.override || b.pattern || cfg.IDLE_PATTERN || sel.value;
    const force = cfg.NIGHT_FORCE || 'auto';
    document.querySelectorAll('#ov-night .btn').forEach((el) => el.classList.toggle('on', el.dataset.mode === force));
    document.querySelectorAll('#ov-screen .btn').forEach((el) => el.classList.toggle('on', (el.dataset.state === 'off') === !!b.screen_off));
    const r = $('ov-bright');
    if (!r.matches(':active') && document.activeElement !== r && b.scale != null) {
      r.value = Math.round(b.scale * 100);
      $('ov-bright-out').textContent = r.value + '%';
    }
  }

  function renderListener(m) {
    const l = m.listener, g = GROUPS.listener;
    if (!l) return setTile('t-listener', head('Listener', 'bad') + '<div class="big mid">No answer</div>', 'bad', 'listener');
    const level = lvl(g.ids);
    const now = l.leds === 'cast' ? l.last_cast_name : l.leds === 'night' ? 'Night: dark' : l.leds === 'off' ? 'LEDs off' : 'Idle · ' + (l.idle_pattern || l.leds || '?');
    const recent = (m.casts_recent || []).slice().reverse().slice(0, 5);
    setTile('t-listener', head('Listener', level) +
      '<div><div class="big mid">' + esc(now || '?') + '</div><div class="sub">' +
      esc((l.state || '?') + (l.connected_since ? ', connected ' + ago(l.connected_since).replace(' ago', '') : '') +
        (l.last_cast_at ? ' · last cast ' + ago(l.last_cast_at) : '')) + '</div></div>' +
      '<div class="stats">' + stat(l.casts_24h, 'casts 24 h') + stat(l.casts_shown, 'since start') +
      stat(l.idle_fps != null ? l.idle_fps : '-', 'idle fps') + stat(l.error_count, 'errors') + '</div>' +
      (recent.length ? '<ul class="list">' + recent.map((c) => '<li><span class="when">' + esc(hhmm(c.at)) + '</span><span class="grow">' +
        esc(c.name) + '</span>' + (c.mirror ? '<span class="tag">mirrored</span>' : '') + '</li>').join('') + '</ul>'
        : '<p class="empty">No casts in the last 24 hours.</p>'), level, 'listener');
  }

  function renderCasts() {
    if (!act) {
      return setTile('t-casts', head('Casts · 7 days', null, goBtn('activity', 'Activity')) + '<p class="empty">Reading the journal…</p>');
    }
    const days = act.per_day || [];
    const maxH = Math.max(1, ...act.per_hour.map((h) => h[1]));
    const day = (iso) => new Date(iso + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short' });
    setTile('t-casts', head('Casts · 7 days', null, goBtn('activity', 'Activity')) +
      '<div><div class="big">' + act.total + '</div><div class="sub">' +
      (act.total ? act.mirrored + ' mirrored (' + Math.round((100 * act.mirrored) / act.total) + '%) · ' : '') + act.ignored_night + ' ignored at night</div></div>' +
      barChart(days, (d) => day(d).slice(0, 2), (r) => day(r[0]) + ' ' + r[0].slice(8) + ': ' + r[1] + ' casts') +
      '<div><div class="hours">' + act.per_hour.map(([h, n]) => '<i class="' + (n ? '' : 'zero') + '" data-op="' +
        (n ? (0.25 + 0.75 * (n / maxH)).toFixed(2) : 1) + '" data-tip="' + String(h).padStart(2, '0') + ':00: ' + n + ' casts"></i>').join('') +
      '</div><div class="hours-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div>');
  }

  function renderTop() {
    if (!act) return setTile('t-top', head('Most cast · 7 days', null, goBtn('cast', 'Test cast')) + '<p class="empty">Reading the journal…</p>');
    setTile('t-top', head('Most cast · 7 days', null, goBtn('cast', 'Test cast')) +
      hbars((act.top || []).slice(0, 6).map(([n, c]) => [n, c])));
  }

  function renderPi(m) {
    const g = GROUPS.pi;
    if (!m.pi) {
      return setTile('t-pi', head('The Pi', 'bad') + '<div class="big mid">Unreachable</div><p class="sub">' +
        esc((byId.pi && byId.pi.lines[0]) || '') + '</p><div class="t-foot">' + goBtn('runbook', 'Runbook') + '</div>', 'bad', 'pi');
    }
    const hw = m.hw, level = lvl(g.ids);
    const t = hw.temp_c, tl = t == null ? 'unknown' : t < 70 ? 'ok' : t < 80 ? 'warn' : 'bad';
    setTile('t-pi', head('The Pi', level) +
      '<div class="pi-top">' + gauge(t, 30, 85, tl, '°C') + '<div class="pi-meters">' +
      meter('Disk', hw.disk_used, pct(hw.disk_used), 0.8, 0.9, gb(hw.disk_free) + ' free of ' + gb(hw.disk_total)) +
      meter('Memory', hw.mem_used, pct(hw.mem_used), 0.85, 0.95, gb(hw.mem_available) + ' available of ' + gb(hw.mem_total)) +
      meter('Load', hw.load ? Math.min(1, hw.load[0] / 4) : null, hw.load ? hw.load[0].toFixed(2) : '?', 0.75, 1, 'load average over 1, 5 and 15 min: ' + (hw.load || []).map((x) => x.toFixed(2)).join(' ')) +
      '</div></div>' +
      '<dl class="kv"><dt>Up</dt><dd>' + esc(span(m.pi.uptime_s)) + '</dd><dt>Power</dt><dd>' + esc((hw.throttle || [])[0] || '?') +
      '</dd><dt>Tailscale</dt><dd>' + esc(m.pi.tailscale || '?') + ' · clock ' + (m.pi.synced === 'yes' ? 'synced' : 'not synced') + '</dd></dl>', level, 'pi');
  }

  function renderWifi(m) {
    const w = m.wifi;
    if (!w) return setTile('t-wifi', head('Wi-Fi', 'unknown') + '<p class="empty">No answer from the Pi.</p>', 'unknown', 'wifi');
    const level = lvl(['wifi']);
    setTile('t-wifi', head('Wi-Fi', level) +
      '<div class="wifi-top"><div class="grow"><div class="big mid">' + esc(w.rescue_up ? 'Rescue hotspot' : w.ssid || 'Not connected') +
      '</div><div class="sub">' + esc(w.signal != null ? w.signal + '% signal' : '') + (w.freq ? ' · ' + esc(w.freq) : '') + '</div></div>' +
      sigBars(w.signal, level) + '</div>' +
      '<dl class="kv"><dt>Address</dt><dd>' + esc(w.ip || '-') + '</dd><dt>Profile</dt><dd>' + esc(w.connection || '-') +
      '</dd><dt>Rescue</dt><dd>' + (w.rescue_up ? '<span class="tag bad">UP</span>' : 'off') + '</dd></dl>', level, 'wifi');
  }

  function renderServices(m) {
    const svc = m.services || {}, restartable = PB.state().units || [];
    const order = ['pb-listener', 'kiosk', 'pb-netwatch', 'board-cam', 'tailscaled', 'NetworkManager'];
    const level = lvl(GROUPS.services.ids);
    const rows = order.filter((u) => svc[u]).map((u) => {
      const s = svc[u], t = byId['svc-' + u];
      const l = t ? t.level : s.state === 'active' ? 'ok' : 'bad';
      const r = s.restarts && s.restarts !== '0' ? '<span class="tag dim" data-tip="restarted by systemd since boot">↻ ' + esc(s.restarts) + '</span>' : '';
      const btn = restartable.includes(u) ? '<button class="icon-btn" data-act="service" data-unit="' + esc(u) + '" data-verb="restart" title="Restart ' + esc(u) + '">Restart</button>' : '';
      return '<li class="' + l + '"><span class="dot"></span><span class="grow">' + esc(u) + '</span>' + r +
        '<span class="when">' + esc(s.state || '?') + '</span>' + btn + '</li>';
    }).join('');
    const timers = m.timers || {};
    const tl = Object.keys(timers).map((t) => '<span class="tag ' + (timers[t].state === 'active' ? 'ok' : 'bad') + '">' + esc(t) + '</span>').join(' ');
    setTile('t-services', head('Services', level) + '<ul class="list">' + rows + '</ul>' +
      '<div class="t-foot">' + tl + '</div>', level, 'services');
  }

  function renderSite(m) {
    const s = m.site || {}, sb = m.supabase || {}, level = lvl(GROUPS.site.ids);
    const same = s.cache && s.repo && s.cache === s.repo;
    const row = (ok, name, val) => '<li class="' + (ok == null ? 'unknown' : ok ? 'ok' : 'bad') + '"><span class="dot"></span><span class="grow">' +
      esc(name) + '</span><span class="when">' + esc(val) + '</span></li>';
    setTile('t-site', head('Live site & Supabase', level) +
      '<div><div class="big mid">' + esc(s.cache || '?') + ' ' + (s.cache ? same ? '<span class="tag ok">= main</span>' :
        '<span class="tag bad">main ' + esc(s.repo) + '</span>' : '') + '</div><div class="sub">service worker CACHE on symmetryboard.co.uk</div></div>' +
      '<ul class="list">' +
      row(s.status == null ? null : s.status === 200, 'Live site', (s.status || 'no answer') + (s.ms != null ? ' · ' + s.ms + ' ms' : '')) +
      row(sb.status == null ? null : sb.status === 200, 'Supabase REST', (sb.status || 'no answer') + (sb.ms != null ? ' · ' + sb.ms + ' ms' : '')) +
      row(sb.rt_ok, 'Realtime join', sb.rt_ok == null ? 'not tried yet' : (sb.rt_ok ? 'ok' : 'failed') + (sb.rt_ms != null ? ' · ' + sb.rt_ms + ' ms' : '') +
        (sb.rt_at ? ' · ' + ago(sb.rt_at) : '')) + '</ul>', level, 'site');
  }

  function renderRelease() {
    if (!git) return setTile('t-release', head('Release', null, goBtn('release', 'Release')) + '<p class="empty">Reading the repo…</p>');
    const changed = git.files.length, unshipped = git.ahead_main || 0, behind = git.behind_main || 0;
    const level = git.branch !== 'main' || behind ? 'warn' : changed || unshipped ? 'warn' : 'ok';
    const todo = [changed && changed + ' changed file' + (changed === 1 ? '' : 's'), unshipped && unshipped + ' not shipped',
      behind && behind + ' to pull'].filter(Boolean);
    setTile('t-release', head('Release', level, goBtn('release', 'Release')) +
      '<div><div class="big mid">' + esc(todo.length ? todo.join(' · ') : 'all shipped') + '</div><div class="sub">' +
      esc(git.branch + ' at ' + git.head) + '</div></div>' +
      '<dl class="kv"><dt>CACHE</dt><dd>' + esc(git.checks.stamp_main || '?') + ' for main</dd>' +
      '<dt>Last commit</dt><dd>' + esc(git.log[0] ? git.log[0].subject : '-') + '</dd></dl>' +
      (git.branch !== 'main' ? '<p class="banner warn">On ' + esc(git.branch) + ': Ship works on main.</p>' : ''), level);
    const dot = $('nav-dot-release');
    if (dot) dot.className = 'nav-dot ' + level;
  }

  function renderHealth(m) {
    const h = m.health;
    if (!h) return setTile('t-health', head('Self-healing', 'unknown') + '<p class="empty">No answer from the Pi.</p>', 'unknown', 'health');
    const level = lvl(['health']);
    const counts = Object.entries(h.counts || {}).sort((a, b) => b[1] - a[1]);
    setTile('t-health', head('Self-healing', level) +
      '<div><div class="big">' + h.day + '</div><div class="sub">actions in 24 h · ' + h.week + ' in 7 days · ' + h.watchdog + ' watchdog timeouts</div></div>' +
      (counts.length ? '<div class="tags">' + counts.map(([a, n]) => '<span class="tag dim">' + esc(a) + ' ' + n + '</span>').join('') + '</div>' : '') +
      ((h.recent || []).length ? '<ul class="list">' + h.recent.slice().reverse().map((a) => '<li data-tip="' + esc(a.why) + '"><span class="when">' +
        esc(hhmm(a.at)) + '</span><span class="grow">' + esc(a.action + ': ' + a.why) + '</span></li>').join('') + '</ul>' : '<p class="empty">Nothing it had to fix this week.</p>'),
    level, 'health');
  }

  function renderErrors(m) {
    const e = m.errors;
    if (!e) return setTile('t-errors', head('Journal errors', 'unknown') + '<p class="empty">No answer from the Pi.</p>', 'unknown', 'errors');
    const level = lvl(['errors']), d = e.total - e.before;
    setTile('t-errors', head('Journal errors · 24 h', level) +
      '<div><div class="big">' + e.total + ' <span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' +
      (d > 0 ? '▲ ' + d : d < 0 ? '▼ ' + -d : '=') + '</span></div><div class="sub">day before: ' + e.before + ' · this boot: ' + esc(e.this_boot) + '</div></div>' +
      hbars(e.sources.map(([src, n, b]) => [src, n, src + ': ' + n + ' (day before ' + b + ')']), true), level, 'errors');
  }

  function renderSchedule(m) {
    const cfg = (data.board && data.board.config) || {}, nt = night(cfg), timers = m.timers || {};
    const big = nt.forced ? (nt.forced === 'off' ? 'Night mode off' : 'Forced ' + nt.forced) :
      nt.inMin == null ? '?' : (nt.isNight ? 'Lights on in ' : 'Night in ') + span(nt.inMin * 60);
    const names = { 'pb-health': 'Health check', 'pb-mode': 'Night switch', 'pb-weekly-reboot': 'Weekly reboot', 'pb-bootcheck': 'Boot check' };
    const nextOf = (s) => { const x = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(s || ''); return x ? hhmm(x[1] + 'T' + x[2]) : '-'; };
    setTile('t-schedule', head('Night & timers', null, goBtn('tests', 'Check a night')) +
      '<div><div class="big mid">' + esc(big) + '</div><div class="sub">dark ' + esc(cfg.NIGHT_START || '?') + ' → lights ' + esc(cfg.NIGHT_END || '?') + '</div></div>' +
      '<ul class="list">' + Object.keys(timers).map((t) => '<li class="' + (timers[t].state === 'active' ? 'ok' : 'bad') + '"><span class="dot"></span><span class="grow">' +
        esc(names[t] || t) + '</span><span class="when">' + esc(timers[t].next ? 'next ' + nextOf(timers[t].next) : 'last ' + nextOf(timers[t].last)) +
        '</span></li>').join('') + '</ul>');
  }

  function renderAudit(rows) {
    const last = (rows || []).filter((r) => !/^console (start|stop)$/.test(r.action)).slice(-7).reverse();
    setTile('t-audit', head('Recent actions', null, goBtn('audit', 'Audit')) +
      (last.length ? '<ul class="list">' + last.map((r) => '<li><span class="when">' + esc(hhmm(r.time)) + '</span><span class="tag ' +
        (r.result === 'ok' ? 'ok' : r.result === 'cancelled' ? 'dim' : 'bad') + '">' + esc(r.result) + '</span><span class="grow"><b>' + esc(r.action) +
        '</b> <span class="muted">' + esc(r.detail || '') + '</span></span>' + (r.ms != null ? '<span class="when">' + (r.ms / 1000).toFixed(1) + ' s</span>' : '') +
        '</li>').join('') + '</ul>' : '<p class="empty">Nothing run from the console yet.</p>'));
  }

  function navDots() {
    const set = (k, l) => { const d = $('nav-dot-' + k); if (d) d.className = 'nav-dot ' + (l || ''); };
    const tiles = (data && data.tiles) || [];
    set('overview', data && !data.pi_ok ? 'bad' : worst(tiles.map((t) => t.level)));
    set('services', lvl(GROUPS.services.ids));
    set('board', lvl(['listener']));
    set('logs', lvl(['errors']) === 'ok' ? '' : lvl(['errors']));
  }

  function render(d) {
    data = d;
    byId = {};
    (d.tiles || []).forEach((t) => { byId[t.id] = t; });
    const m = d.metrics || {};
    renderHero(m);
    renderBoard();
    renderListener(m);
    renderPi(m);
    renderWifi(m);
    renderServices(m);
    renderSite(m);
    renderHealth(m);
    renderErrors(m);
    renderSchedule(m);
    renderCasts();
    renderTop();
    renderRelease();
    navDots();
    if (drawerKey) openDrawer(drawerKey);
    if (Date.now() - actAt > ACTIVITY_MS) loadActivity();
    if (Date.now() - gitAt > GIT_MS) loadGit();
  }

  async function loadActivity() {
    actAt = Date.now();
    try {
      const { status, data: a } = await PB.apiJson('/api/activity?days=7');
      if (status === 200) act = a;
    } catch (e) { /* the tile keeps its last numbers */ }
    renderCasts();
    renderTop();
  }

  async function loadGit() {
    gitAt = Date.now();
    try {
      const { status, data: g } = await PB.apiJson('/api/git');
      if (status === 200) git = g;
    } catch (e) { /* as above */ }
    renderRelease();
  }

  // -- the drawer: every line, as the tiles had it ----------------------------------------------

  function openDrawer(key) {
    const g = GROUPS[key];
    if (!g) return;
    drawerKey = key;
    $('drawer-title').textContent = g.title;
    $('drawer-body').innerHTML = g.ids.filter((i) => byId[i]).map((i) => {
      const t = byId[i];
      return '<section class="d-sec"><div class="t-head"><h3>' + esc(t.title) + '</h3>' + chip(t.level) + '</div><div class="d-val">' +
        esc(t.value) + '</div><ul>' + (t.lines || []).map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul></section>';
    }).join('') + '<div class="btn-row"><button class="btn" data-goto="' + esc(g.tab) + '">Open ' + esc(g.go) + '</button></div>';
    $('drawer').hidden = false;
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
    document.querySelectorAll('.nav [data-tab]').forEach((b) => out.push({ label: b.textContent.trim(), kind: 'Section', run: () => PB.showTab(b.dataset.tab) }));
    const a = (label, action, args) => out.push({ label, kind: 'Action', run: () => PB.runAction(action, args, label) });
    out.push({ label: 'Refresh the overview now', kind: 'Action', run: () => $('refresh').click() });
    a('LEDs: idle now', 'idle', { cmd: 'now' });
    a('LEDs off', 'idle', { cmd: 'off' });
    a('LEDs back to the default', 'idle', { cmd: 'default' });
    (PB.state().patterns || []).forEach(([n]) => a('Idle pattern: ' + n, 'idle', { cmd: n }));
    a('Idle pattern: tour', 'idle', { cmd: 'tour' });
    a('Night mode: auto (clock)', 'night', { mode: 'auto' });
    a('Night mode: force night', 'night', { mode: 'night' });
    a('Night mode: force day', 'night', { mode: 'day' });
    a('Wall screen on', 'screen', { state: 'on' });
    a('Wall screen off', 'screen', { state: 'off' });
    (PB.state().units || []).forEach((u) => a('Restart ' + u, 'service', { unit: u, verb: 'restart' }));
    a('Reboot the Pi', 'reboot', {});
    Object.keys(GROUPS).forEach((k) => out.push({ label: 'Details: ' + GROUPS[k].title, kind: 'Overview', run: () => { PB.showTab('overview'); openDrawer(k); } }));
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
    tab = name;
    const img = $('ov-cam'), url = PB.state().cam_url;
    if (name === 'overview' && url) {
      if (img.dataset.live !== '1') {
        img.dataset.live = '1';
        $('ov-cam-note').hidden = true;
        img.src = url;
      }
    } else if (img.dataset.live === '1') {
      img.dataset.live = '';
      img.src = BLANK;      // stops the MJPEG stream while the overview is hidden
    }
    if (name !== 'overview') closeDrawer();
  }

  function wire() {
    const img = $('ov-cam');
    img.addEventListener('error', () => { if (img.dataset.live === '1') $('ov-cam-note').hidden = false; });
    $('ov-cam-wrap').addEventListener('click', () => PB.showTab('board'));
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
      const go = ev.target.closest('[data-goto]');
      if (go) { closeDrawer(); PB.showTab(go.dataset.goto); return; }
      const chipEl = ev.target.closest('[data-tile]');
      if (chipEl) {
        const key = Object.keys(GROUPS).find((k) => GROUPS[k].ids.includes(chipEl.dataset.tile));
        if (key) openDrawer(key); else PB.toast(chipEl.title);
        return;
      }
      if (ev.target.closest('button, a, input, select, label, [data-act]')) return;
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
      if (ev.key === '/' && !typing && !document.querySelector('dialog[open]')) { ev.preventDefault(); openPalette(); return; }
      if (ev.key === 'Escape' && drawerKey && !document.querySelector('dialog[open]')) closeDrawer();
    });
  }

  PB.dash = { render, onTab, onState: (s) => renderAudit(s.audit), openDrawer };
  wire();
  // console.js may have got its first answers before this file ran
  if (PB.overview()) render(PB.overview());
  if (PB.state().audit) renderAudit(PB.state().audit);
  const cur = document.querySelector('.nav [aria-selected="true"]');
  onTab(cur ? cur.dataset.tab : 'overview');
}());
