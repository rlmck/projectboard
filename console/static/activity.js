// PB Console phase 10: Activity. A dashboard (the default) and the log of every cast.
// The design is tools/activity-dashboard-prototype.html (fake data): this is that page,
// fed by /api/activity-history (console/activity_history.py): the console's own cast
// history from the Pi's journal, plus nicknames, ticks and accounts from the database
// when db/.env is on this laptop. Every time arrives already in UK local time (d = the
// date, h = the hour, w = the weekday, 0 = Monday); t is ms since 1970 for ordering.
// The browser does the counting and the cross-filtering: every panel applies every
// filter except its own dimension, so a selected item still shows its siblings dimmed.
// No inline styles: sizes from data go through element.style; charts are inline SVG.
'use strict';

(function () {
  const PB = window.PB;
  if (!PB) return;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;

  // -- dates: day numbers (days since 1970-01-01, UK dates) ------------------------------------
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WDP = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5);
  const utc = (di) => new Date(di * 864e5);
  const dow = (di) => (utc(di).getUTCDay() + 6) % 7;
  const monday = (di) => di - dow(di);
  const fmtD = (di) => WD[dow(di)] + ' ' + utc(di).getUTCDate() + ' ' + MON[utc(di).getUTCMonth()];
  const fmtS = (di) => utc(di).getUTCDate() + ' ' + MON[utc(di).getUTCMonth()];
  const hh = (h) => String(h).padStart(2, '0') + ':00';
  const fontGrade = (g) => String(g || '').toUpperCase();     // the app's display of problem grades
  const UKTIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric',
    month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // -- data -------------------------------------------------------------------------------------
  let D = null;                 // the response
  let CASTS = [];               // problem casts and circuit runs received in the daytime
  let NIGHT = [];               // problem casts and circuit runs ignored at night
  let ALL = [];                 // every journal event (the log): casts, night ones, circuit views
  let TK = [];                  // ticks
  let ACC = [];                 // accounts
  let JOINED = {};              // nickname -> day joined
  let TODAY = 0;
  let START = 0;
  let HIST = 0;                 // the first day of the console's cast history (the journal's oldest line)
  let NAMES = false;            // nicknames, ticks and accounts read (db/.env)
  let loading = false;

  function prepare(d) {
    D = d;
    TODAY = dayNum(d.today);
    NAMES = d.names === 'ok';
    ALL = d.casts.map((c) => Object.assign({}, c, { di: dayNum(c.d), kind: c.k === 'p' ? 'problem' : c.k === 'c' ? 'circuit' : 'view' }));
    CASTS = ALL.filter((e) => e.kind !== 'view' && !e.x);
    NIGHT = ALL.filter((e) => e.kind !== 'view' && e.x);
    TK = d.ticks.map((t) => Object.assign({}, t, { di: dayNum(t.d), tk: true, mem: true }));
    ACC = d.accounts.map((a) => Object.assign({}, a, { di: dayNum(a.d) }));
    JOINED = {};
    ACC.forEach((a) => { JOINED[a.who] = a.di; });
    const firsts = [].concat(CASTS.map((e) => e.di), NIGHT.map((e) => e.di), TK.map((e) => e.di), ACC.map((e) => e.di));
    START = firsts.length ? Math.min(TODAY, ...firsts) : TODAY;
    HIST = ALL.length ? Math.min(...ALL.map((e) => e.di)) : TODAY;
    if (!NAMES) { S.metric = 'casts'; if (S.tab === 'ticked') S.tab = 'problems'; if (S.f.who && S.f.who !== 'member' && S.f.who !== 'guest') S.f.who = null; }
  }

  // -- state ------------------------------------------------------------------------------------
  const S = { view: 'dash', range: 7, by: 'day', metric: 'casts', tab: 'problems',
    f: { bucket: null, wd: null, hr: null, who: null, problem: null, source: null } };
  let BK = [];                  // the buckets on the main chart

  const rangeStart = () => S.range === 0 ? START : TODAY - (S.range - 1);
  const rangeEnd = () => TODAY + 1;
  const whoOk = (e, w) => w === 'guest' ? !e.mem : w === 'member' ? !!e.mem : e.who === w;

  function ok(e, skip, rg) {
    const a = rg ? rg[0] : rangeStart(), b = rg ? rg[1] : rangeEnd(), f = S.f;
    if (e.di < a || e.di >= b) return false;
    if (skip !== 'bucket' && f.bucket && !(e.di >= f.bucket.a && e.di < f.bucket.b)) return false;
    if (skip !== 'cell') {
      if (f.wd !== null && e.w !== f.wd) return false;
      if (f.hr !== null && e.h !== f.hr) return false;
    }
    if (skip !== 'who' && f.who && !whoOk(e, f.who)) return false;
    if (skip !== 'problem' && f.problem && e.n !== f.problem) return false;
    if (skip !== 'source' && f.source && !e.tk && e.s !== f.source) return false;
    return true;
  }
  const casts = (skip, rg) => CASTS.filter((e) => ok(e, skip, rg));
  const ticks = (skip, rg) => TK.filter((e) => ok(e, skip, rg));
  const activeSet = (rg) => {
    const s = new Set();
    casts(null, rg).forEach((e) => { if (e.who) s.add(e.who); });
    ticks(null, rg).forEach((e) => s.add(e.who));
    return s;
  };
  const joinedIn = (a, b) => ACC.filter((m) => m.di >= a && m.di < b);

  // -- interaction ------------------------------------------------------------------------------
  function setF(k, v) { S.f[k] = S.f[k] === v ? null : v; renderAll(); }
  function clearAll() { S.f = { bucket: null, wd: null, hr: null, who: null, problem: null, source: null }; renderAll(); }

  function onClick(ev) {
    const el = ev.target.closest('#tab-activity [data-ad]');
    if (!el || el.disabled) return;
    const a = el.dataset.ad, v = el.dataset.v;
    if (a === 'view') { S.view = v; renderAll(); return; }
    if (!D) return;
    if (a === 'range') { S.range = +v; if (S.range === 7) S.by = 'day'; S.f.bucket = null; }
    else if (a === 'by') { S.by = v; S.f.bucket = null; }
    else if (a === 'metric') S.metric = v;
    else if (a === 'tab') { S.tab = v; S.f.problem = null; }
    else if (a === 'bucket') {
      const b = BK[+el.dataset.i], cur = S.f.bucket;
      S.f.bucket = cur && cur.a === b.a && cur.kind === b.kind ? null : b;
    } else if (a === 'cell') {
      const wd = +el.dataset.wd, hr = +el.dataset.hr, same = S.f.wd === wd && S.f.hr === hr;
      S.f.wd = same ? null : wd; S.f.hr = same ? null : hr;
    } else if (a === 'wd') {
      const wd = +v, same = S.f.wd === wd && S.f.hr === null;
      S.f.wd = same ? null : wd; S.f.hr = null;
    } else if (a === 'hr') {
      const hr = +v, same = S.f.hr === hr && S.f.wd === null;
      S.f.hr = same ? null : hr; S.f.wd = null;
    } else if (a === 'who' || a === 'problem' || a === 'source') { setF(a, v); return; }
    else if (a === 'unset') { if (v === 'cell') { S.f.wd = null; S.f.hr = null; } else S.f[v] = null; }
    else if (a === 'clear') { clearAll(); return; }
    else return;
    renderAll();
    refocus(el);
  }

  // After a redraw, put the keyboard focus back on the same bar, cell or label.
  function refocus(el) {
    if (document.activeElement !== document.body && document.contains(document.activeElement)) return;
    const d = el.dataset;
    const sel = '[data-ad="' + d.ad + '"]' + (d.i !== undefined ? '[data-i="' + d.i + '"]' : '') +
      (d.wd !== undefined ? '[data-wd="' + d.wd + '"][data-hr="' + d.hr + '"]' : '') +
      (d.v !== undefined ? '[data-v="' + CSS.escape(d.v) + '"]' : '');
    const again = document.querySelector('#tab-activity ' + sel);
    if (again && again.focus) again.focus({ preventScroll: true });
  }

  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const t = ev.target;
    if (t && t.closest && t.closest('#tab-activity svg') && t.dataset && t.dataset.ad) {
      ev.preventDefault();
      t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }

  // The tooltip: follows the mouse, or sits by a bar or cell that has the keyboard focus.
  function showTip(text, x, y) {
    const tip = $('ad-tip');
    tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(y + 14, innerHeight - h - 8)) + 'px';
  }
  function onMove(ev) {
    const el = ev.target.closest && ev.target.closest('#tab-activity [data-tip]');
    if (!el) { $('ad-tip').hidden = true; return; }
    showTip(el.dataset.tip, ev.clientX, ev.clientY);
  }
  function onFocus(ev) {
    const el = ev.target.closest && ev.target.closest('#tab-activity [data-tip]');
    if (!el) { $('ad-tip').hidden = true; return; }
    const r = el.getBoundingClientRect();
    showTip(el.dataset.tip, r.left + r.width / 2, r.top + Math.min(r.height, 40));
  }

  // -- render -----------------------------------------------------------------------------------
  function widths(root) { root.querySelectorAll('[data-w]').forEach((e) => { e.style.width = e.dataset.w + '%'; }); }
  const nice = (v) => {
    for (const st of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) if (Math.ceil(v / st) <= 5) return { step: st, max: Math.max(st, st * Math.ceil(v / st)) };
    return { step: 1000, max: 1000 * Math.ceil(v / 1000) };
  };
  const SRC = { wall: 'wall', phone: 'phone', console: 'console' };
  const srcName = (s) => SRC[s] || 'not recorded';

  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 6e4));
    if (m < 60) return m + ' min';
    if (m < 48 * 60) return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
    return Math.round(m / 1440) + ' days';
  }

  function renderHeader() {
    document.querySelectorAll('#ad-view button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
    document.querySelectorAll('#ad-range button').forEach((b) => b.classList.toggle('on', +b.dataset.v === S.range));
    document.querySelectorAll('#ad-by button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === S.by);
      b.disabled = b.dataset.v === 'week' && S.range === 7;
    });
    document.querySelectorAll('#ad-metric button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === S.metric);
      b.disabled = !NAMES && b.dataset.v !== 'casts';
    });
    $('ad-by').hidden = S.view === 'log';
    const last = CASTS[CASTS.length - 1];
    $('ad-last').innerHTML = last ? 'Last cast <b>' + esc(ago(last.t)) + ' ago</b>: ' + esc(last.n) + ' (' + esc(srcName(last.s)) + ')'
      : D ? 'No casts yet' : '';
    const notes = [];
    if (D && D.pi && !D.pi.ok) notes.push('The Pi didn\'t answer (' + D.pi.error + '): the saved history so far.');
    if (D && !NAMES) notes.push('Nicknames, ticks and new accounts need db/.env (' + D.names + '): casts show member or guest only.');
    $('ad-note').textContent = notes.join(' ');
    $('ad-note').title = notes.join(' ');
  }

  function renderChips() {
    const f = S.f, out = [];
    const chip = (txt, k) => '<button type="button" class="ad-chip" data-ad="unset" data-v="' + k + '" title="Remove this filter">' + esc(txt) + '<i aria-hidden="true">×</i></button>';
    if (f.bucket) out.push(chip(f.bucket.kind === 'day' ? fmtD(f.bucket.a) : 'Week of ' + fmtS(f.bucket.a), 'bucket'));
    if (f.wd !== null || f.hr !== null) {
      out.push(chip([f.wd !== null ? WDP[f.wd] : 'Any day', f.hr !== null ? hh(f.hr) + '–' + hh(f.hr + 1) : null].filter(Boolean).join(' · '), 'cell'));
    }
    if (f.who) out.push(chip(f.who === 'guest' ? 'Guests (wall and signed-out phones)' : f.who === 'member' ? 'Members' : f.who, 'who'));
    if (f.problem) out.push(chip(f.problem, 'problem'));
    if (f.source) out.push(chip('From the ' + f.source, 'source'));
    $('ad-chips').innerHTML = out.length ? out.join('') + '<button type="button" class="ad-clear" data-ad="clear">Clear all</button>'
      : '<span class="ad-hint">Click a bar, a heatmap square, a member, a problem or a source to filter everything on the page.</span>';
  }

  function renderTiles() {
    const f = S.f, a = rangeStart(), b = rangeEnd();
    const showPrev = !f.bucket && S.range > 0;
    const pr = showPrev ? [a - S.range, a] : null;
    const prevLbl = 'before (' + S.range + ' days)';
    const delta = (cur, prev) => {
      if (!showPrev) return '<span class="ad-td">' + (S.range === 0 ? 'since ' + fmtS(START) : '') + '</span>';
      const pct = prev === 0 ? null : Math.round((cur - prev) / prev * 100);
      const arrow = pct === null || pct === 0 ? '' : pct > 0 ? '<span class="ad-up">▲ ' + pct + '%</span> ' : '<span class="ad-down">▼ ' + Math.abs(pct) + '%</span> ';
      return '<span class="ad-td">' + arrow + '<span>vs ' + prev + ' ' + prevLbl + '</span></span>';
    };
    const needs = '<span class="ad-td">needs db/.env</span>';
    const tile = (l, v, d) => '<div class="ad-tile"><div class="ad-tl">' + l + '</div><div class="ad-tv">' + v + '</div>' + d + '</div>';
    const cNow = casts().length, cPrev = showPrev ? casts(null, pr).length : 0;
    // Before the cast history begins there's nothing to compare with: say so rather than "vs 0".
    const castDelta = showPrev && pr[0] < HIST && cPrev === 0
      ? '<span class="ad-td">no cast history before ' + fmtS(HIST) + '</span>' : delta(cNow, cPrev);
    const byDay = {};
    casts('bucket').forEach((e) => { byDay[e.di] = (byDay[e.di] || 0) + 1; });
    const top = Object.entries(byDay).sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
    let h = tile('Casts', cNow, castDelta);
    if (NAMES) {
      const mNow = activeSet().size, mPrev = showPrev ? activeSet(pr).size : 0;
      const jr = f.bucket ? [Math.max(f.bucket.a, a), f.bucket.b] : [a, b];
      const sNow = joinedIn(jr[0], jr[1]), sPrev = showPrev ? joinedIn(pr[0], pr[1]).length : 0;
      const tNow = ticks().length, tPrev = showPrev ? ticks(null, pr).length : 0;
      h += tile('Active members', mNow, delta(mNow, mPrev)) +
        tile('New accounts', sNow.length, f.bucket || S.range === 0
          ? '<span class="ad-td">' + sNow.slice(0, 3).map((m) => esc(m.who)).join(', ') + (sNow.length > 3 ? '…' : '') + '</span>'
          : delta(sNow.length, sPrev)) +
        tile('Ticks', tNow, delta(tNow, tPrev));
    } else {
      h += tile('Active members', '–', needs) + tile('New accounts', '–', needs) + tile('Ticks', '–', needs);
    }
    h += tile('Busiest day', top ? fmtD(+top[0]) : '–', '<span class="ad-td">' + (top ? top[1] + ' cast' + (top[1] === 1 ? '' : 's') : '') + '</span>');
    $('ad-tiles').innerHTML = h;
  }

  const METRIC = { casts: ['Casts', 'ad-b-wall'], members: ['Active members', 'ad-b-members'], ticks: ['Ticks', 'ad-b-ticks'],
    signups: ['New accounts', 'ad-b-signups'] };

  function renderMain() {
    BK = [];
    const a = rangeStart(), end = TODAY;
    if (S.by === 'day') for (let d = a; d <= end; d++) BK.push({ a: d, b: d + 1, kind: 'day' });
    else for (let d = monday(a); d <= end; d += 7) BK.push({ a: d, b: d + 7, kind: 'week' });
    const cs = casts('bucket'), ts = ticks('bucket');
    const anyUnknown = cs.some((e) => !SRC[e.s]);
    const vals = BK.map((bk) => {
      const inB = (e) => e.di >= bk.a && e.di < bk.b;
      if (S.metric === 'casts') {
        const x = cs.filter(inB), r = { wall: 0, phone: 0, console: 0, unknown: 0 };
        x.forEach((e) => { r[SRC[e.s] ? e.s : 'unknown']++; });
        return Object.assign({ total: x.length }, r);
      }
      if (S.metric === 'members') {
        const s = new Set();
        cs.filter(inB).forEach((e) => { if (e.who) s.add(e.who); });
        ts.filter(inB).forEach((e) => s.add(e.who));
        return { total: s.size, names: [...s] };
      }
      if (S.metric === 'ticks') return { total: ts.filter(inB).length };
      const j = joinedIn(Math.max(bk.a, a), bk.b);
      return { total: j.length, names: j.map((m) => m.who) };
    });
    const [title, cls] = METRIC[S.metric];
    $('ad-main-title').textContent = title + (S.by === 'week' ? ' per week' : ' per day');
    $('ad-main-sub').textContent = fmtS(a) + ' – ' + fmtS(TODAY);
    $('ad-legend').innerHTML = S.metric === 'casts'
      ? '<span><i class="ad-k-wall"></i>Wall</span><span><i class="ad-k-phone"></i>Phone</span><span><i class="ad-k-console"></i>Console</span>' +
        (anyUnknown ? '<span><i class="ad-k-unknown"></i>Not recorded</span>' : '') : '';

    const el = $('ad-plot-main'), W = el.clientWidth || 760, H = el.clientHeight || 300;
    const m = { l: 34, r: 6, t: 16, b: 26 }, pw = W - m.l - m.r, ph = Math.max(10, H - m.t - m.b);
    const mx = Math.max(1, ...vals.map((v) => v.total)), sc = nice(mx);
    const band = pw / BK.length, bw = Math.min(band * 0.72, 64);
    const sel = S.f.bucket && S.f.bucket.kind === (S.by === 'week' ? 'week' : 'day') ? S.f.bucket.a : null;
    const labEvery = Math.max(1, Math.ceil(BK.length / Math.max(1, Math.floor(pw / 46))));
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="' + esc(title) + ' chart">';
    for (let v = 0; v <= sc.max; v += sc.step) {
      const y = m.t + ph - v / sc.max * ph;
      s += '<line class="ad-grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y + '" y2="' + y + '"/><text class="ad-axis" x="' + (m.l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + v + '</text>';
    }
    BK.forEach((bk, i) => {
      const x = m.l + i * band + (band - bw) / 2, v = vals[i], dim = sel !== null && sel !== bk.a;
      let y = m.t + ph;
      const seg = (n, c) => {
        if (!n) return;
        const h = n / sc.max * ph;
        y -= h;
        s += '<rect class="ad-bar ' + c + (dim ? ' ad-dim' : '') + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(h, 1) + '" rx="2"/>';
      };
      if (S.metric === 'casts') { seg(v.wall, 'ad-b-wall'); seg(v.phone, 'ad-b-phone'); seg(v.console, 'ad-b-console'); seg(v.unknown, 'ad-b-unknown'); }
      else seg(v.total, cls);
      if (BK.length <= 16 && v.total) s += '<text class="ad-val" x="' + (x + bw / 2) + '" y="' + (m.t + ph - v.total / sc.max * ph - 5) + '" text-anchor="middle">' + v.total + '</text>';
      const showLab = S.by === 'week' ? i % labEvery === 0 : BK.length <= 14 || (labEvery <= 7 ? dow(bk.a) === 0 : i % labEvery === 0);
      if (showLab) {
        s += '<text class="ad-axis" x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' +
          (S.by === 'week' ? 'w/c ' + fmtS(bk.a) : BK.length <= 14 ? WD[dow(bk.a)] + ' ' + utc(bk.a).getUTCDate() : fmtS(bk.a)) + '</text>';
      }
      let t = (bk.kind === 'day' ? fmtD(bk.a) : 'Week of Mon ' + fmtS(bk.a)) + '\n' + v.total + ' ' + title.toLowerCase();
      if (S.metric === 'casts') t += '\nWall ' + v.wall + ' · Phone ' + v.phone + ' · Console ' + v.console + (v.unknown ? ' · Not recorded ' + v.unknown : '');
      if (v.names && v.names.length) t += '\n' + v.names.slice(0, 6).join(', ') + (v.names.length > 6 ? '…' : '');
      s += '<rect class="ad-hit" data-ad="bucket" data-i="' + i + '" data-tip="' + esc(t) + '" tabindex="0" role="button" aria-pressed="' + (sel === bk.a) +
        '" aria-label="' + esc(t.replace(/\n/g, ', ')) + '" x="' + (m.l + i * band) + '" y="' + m.t + '" width="' + band + '" height="' + (ph + m.b - 6) + '"/>';
      if (sel === bk.a) s += '<rect class="ad-selbox" x="' + (m.l + i * band + 1) + '" y="' + (m.t - 2) + '" width="' + (band - 2) + '" height="' + (ph + 2) + '" rx="4"/>';
    });
    el.innerHTML = s + '</svg>';
  }

  function renderHeat() {
    const cs = casts('cell'), grid = Array.from({ length: 7 }, () => Array(15).fill(0));
    cs.forEach((e) => { if (e.h >= 8 && e.h <= 22) grid[e.w][e.h - 8]++; });
    const mx = Math.max(1, ...grid.flat());
    const el = $('ad-plot-heat'), W = el.clientWidth || 420, H = el.clientHeight || 300;
    const lx = 34, ty = 18, cw = (W - lx - 2) / 15, ch = Math.max(4, (H - ty - 2) / 7);
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Casts by weekday and hour">';
    for (let h = 0; h < 15; h++) {
      const hr = h + 8, on = S.f.hr === hr && S.f.wd === null;
      s += '<text class="ad-lab' + (on ? ' ad-sel' : '') + '" data-ad="hr" data-v="' + hr + '" tabindex="0" role="button" aria-pressed="' + on +
        '" aria-label="Every day ' + hh(hr) + '–' + hh(hr + 1) + '" x="' + (lx + h * cw + cw / 2) + '" y="12" text-anchor="middle">' + String(hr).padStart(2, '0') + '</text>';
    }
    for (let d = 0; d < 7; d++) {
      const on = S.f.wd === d && S.f.hr === null;
      s += '<text class="ad-lab' + (on ? ' ad-sel' : '') + '" data-ad="wd" data-v="' + d + '" tabindex="0" role="button" aria-pressed="' + on +
        '" aria-label="' + WDP[d] + '" x="' + (lx - 8) + '" y="' + (ty + d * ch + ch / 2 + 4) + '" text-anchor="end">' + WD[d] + '</text>';
      for (let h = 0; h < 15; h++) {
        const v = grid[d][h], hr = h + 8, sel = S.f.wd === d && S.f.hr === hr;
        const t = WDP[d] + ' ' + hh(hr) + '–' + hh(hr + 1) + '\n' + v + ' cast' + (v === 1 ? '' : 's');
        s += '<rect class="ad-cell ' + (v ? 'ad-cell-on' : 'ad-cell-0') + (sel ? ' ad-sel' : '') + '"' +
          (v ? ' fill-opacity="' + (0.14 + 0.86 * Math.sqrt(v / mx)).toFixed(3) + '"' : '') +
          ' data-ad="cell" data-wd="' + d + '" data-hr="' + hr + '" data-tip="' + esc(t) + '" tabindex="0" role="button" aria-pressed="' + sel +
          '" aria-label="' + esc(t.replace(/\n/g, ', ')) + '" x="' + (lx + h * cw + 1.5) + '" y="' + (ty + d * ch + 1.5) + '" width="' + Math.max(1, cw - 3) +
          '" height="' + Math.max(1, ch - 3) + '" rx="4"/>';
        if (v && cw > 26 && ch > 22) s += '<text class="ad-cnum" x="' + (lx + h * cw + cw / 2) + '" y="' + (ty + d * ch + ch / 2 + 3.5) + '" text-anchor="middle">' + v + '</text>';
      }
    }
    el.innerHTML = s + '</svg>';
    const flat = grid.flat(), peak = flat.indexOf(Math.max(...flat));
    $('ad-heat-sub').textContent = flat.some(Boolean) ? 'Busiest: ' + WDP[Math.floor(peak / 15)] + ' at ' + hh(peak % 15 + 8) : '';
  }

  function listRow(cls, act, v, label, bar, nums, sel, dim) {
    return '<button type="button" class="ad-row ' + cls + (sel ? ' ad-sel' : '') + (dim ? ' ad-dim' : '') + '" data-ad="' + act + '" data-v="' + esc(v) +
      '" aria-pressed="' + !!sel + '"><span class="ad-rl">' + label + '</span><span class="ad-rb"><i class="' + bar[0] + '" data-w="' + bar[1].toFixed(1) + '"></i></span>' + nums + '</button>';
  }
  const empty = '<div class="ad-empty">Nothing matches the current filters.</div>';

  function renderWho() {
    const cs = casts('who'), tk = ticks('who'), cnt = {}, tkc = {};
    const f = S.f.who;
    const guests = cs.filter((e) => !e.mem).length;
    let h;
    if (!NAMES) {
      const mem = cs.length - guests, mx = Math.max(1, mem, guests);
      $('ad-who-sub').textContent = 'no nicknames without db/.env';
      h = '<div class="ad-lh ad-r4"><span>Who</span><span></span><span class="ad-num">casts</span><span class="ad-num"></span></div>' +
        listRow('ad-r4', 'who', 'member', 'Signed-in members', ['ad-green', mem / mx * 100], '<span class="ad-rv">' + mem + '</span><span class="ad-rv ad-m"></span>', f === 'member', f && f !== 'member') +
        listRow('ad-r4', 'who', 'guest', 'Guests <em>wall and signed-out</em>', ['ad-grey', guests / mx * 100], '<span class="ad-rv">' + guests + '</span><span class="ad-rv ad-m"></span>', f === 'guest', f && f !== 'guest');
      if (!cs.length) h = empty;
      $('ad-who').innerHTML = h;
      widths($('ad-who'));
      return;
    }
    cs.forEach((e) => { if (e.who) cnt[e.who] = (cnt[e.who] || 0) + 1; });
    tk.forEach((e) => { tkc[e.who] = (tkc[e.who] || 0) + 1; });
    const names = new Set([...Object.keys(cnt), ...Object.keys(tkc)]);
    if (f && f !== 'guest' && f !== 'member') names.add(f);
    const rows = [...names].map((n) => ({ n, c: cnt[n] || 0, t: tkc[n] || 0 })).sort((a, b) => (b.c + b.t) - (a.c + a.t) || a.n.localeCompare(b.n));
    const shown = rows.slice(0, 6);
    if (f && f !== 'guest' && f !== 'member' && !shown.find((r) => r.n === f)) shown[Math.min(5, shown.length)] = rows.find((r) => r.n === f);
    const mxc = Math.max(1, guests, ...shown.map((r) => r.c));
    const newCut = TODAY - 6;
    const active = [...names].filter((n) => cnt[n] || tkc[n]).length;
    $('ad-who-sub').textContent = active + ' active member' + (active === 1 ? '' : 's');
    h = '<div class="ad-lh ad-r4"><span>Member</span><span></span><span class="ad-num">casts</span><span class="ad-num">ticks</span></div>';
    h += shown.map((r) => {
      const isNew = JOINED[r.n] !== undefined && JOINED[r.n] >= newCut;
      return listRow('ad-r4', 'who', r.n, esc(r.n) + (isNew ? '<span class="ad-badge">new</span>' : ''), ['', r.c / mxc * 100],
        '<span class="ad-rv">' + r.c + '</span><span class="ad-rv ad-m">' + r.t + '</span>', f === r.n, f && f !== r.n);
    }).join('');
    h += listRow('ad-r4', 'who', 'guest', 'Guests <em>wall and signed-out</em>', ['ad-grey', guests / mxc * 100],
      '<span class="ad-rv">' + guests + '</span><span class="ad-rv ad-m"></span>', f === 'guest', f && f !== 'guest');
    if (!cs.length && !tk.length) h = empty;
    $('ad-who').innerHTML = h;
    widths($('ad-who'));
  }

  function renderTop() {
    document.querySelectorAll('#ad-top-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === S.tab);
      b.setAttribute('aria-pressed', String(b.dataset.v === S.tab));
      b.disabled = b.dataset.v === 'ticked' && !NAMES;
    });
    const cnt = {}, grade = {};
    if (S.tab === 'ticked') ticks('problem').forEach((e) => { cnt[e.n] = (cnt[e.n] || 0) + 1; if (e.g) grade[e.n] = fontGrade(e.g); });
    else {
      const kind = S.tab === 'circuits' ? 'circuit' : 'problem';
      casts('problem').filter((e) => e.kind === kind).forEach((e) => {
        cnt[e.n] = (cnt[e.n] || 0) + 1;
        if (e.g) grade[e.n] = kind === 'problem' ? fontGrade(e.g) : e.g;     // circuits keep their lowercase sport grade
      });
    }
    const f = S.f.problem;
    if (f && !(f in cnt)) cnt[f] = 0;
    const rows = Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
    if (f && !rows.find((r) => r[0] === f)) rows[rows.length - 1] = [f, cnt[f]];
    const mx = Math.max(1, ...rows.map((r) => r[1]));
    const colour = S.tab === 'circuits' ? 'ad-gold' : S.tab === 'ticked' ? 'ad-green' : '';
    $('ad-top').innerHTML = rows.length ? rows.map(([n, c]) => listRow('ad-r3', 'problem', n, esc(n) + (grade[n] ? '<em>' + esc(grade[n]) + '</em>' : ''),
      [colour, c / mx * 100], '<span class="ad-rv">' + c + '</span>', f === n, f && f !== n)).join('') : empty;
    widths($('ad-top'));
  }

  function renderMix() {
    const bySrc = { wall: 0, phone: 0, console: 0 };
    let unknown = 0;
    casts('source').forEach((e) => { if (SRC[e.s]) bySrc[e.s]++; else unknown++; });
    const cw = casts('who'), mem = cw.filter((e) => e.mem).length, gst = cw.length - mem;
    const all = casts();
    const probs = all.filter((e) => e.kind === 'problem'), runs = all.filter((e) => e.kind === 'circuit');
    const mir = probs.length ? Math.round(probs.filter((e) => e.m).length / probs.length * 100) : 0;
    const fin = runs.filter((e) => e.how === 'finished').length;
    const avg = runs.length ? Math.round(runs.reduce((s, e) => s + (e.mv || 0), 0) / runs.length) : 0;
    const night = NIGHT.filter((e) => ok(e, 'cell')).length;
    const f = S.f, ms = Math.max(1, ...Object.values(bySrc)), mw = Math.max(1, mem, gst);
    const r = (act, v, label, bar, n, sel, dim) => listRow('ad-r3', act, v, label, bar, '<span class="ad-rv">' + n + '</span>', sel, dim);
    let h = '<div class="ad-sec">Where from</div>';
    h += [['wall', 'Wall screen', ''], ['phone', 'Phone', 'ad-blue'], ['console', 'Console tests', 'ad-gold']].map(([k, l, c]) =>
      r('source', k, l, [c, bySrc[k] / ms * 100], bySrc[k], f.source === k, f.source && f.source !== k)).join('');
    h += '<div class="ad-sec">Who</div>';
    h += r('who', 'member', 'Signed-in members', ['ad-green', mem / mw * 100], mem, f.who === 'member', f.who && f.who !== 'member');
    h += r('who', 'guest', 'Guests', ['ad-grey', gst / mw * 100], gst, f.who === 'guest', f.who && f.who !== 'guest');
    h += '<div class="ad-facts">' +
      '<span><b>' + mir + '%</b> of problem casts were mirrored</span>' +
      '<span><b>' + runs.length + '</b> circuit run' + (runs.length === 1 ? '' : 's') + ', <b>' + (runs.length ? Math.round(fin / runs.length * 100) : 0) + '%</b> reached the top' +
        (runs.length ? ', ' + avg + ' moves on average' : '') + '</span>' +
      '<span><b>' + night + '</b> cast' + (night === 1 ? '' : 's') + ' tried outside the opening hours and ignored</span>' +
      (unknown ? '<span><b>' + unknown + '</b> from before the app said where from</span>' : '') + '</div>';
    $('ad-mix').innerHTML = h;
    widths($('ad-mix'));
  }

  // -- the log: every journal event in the range, newest first ----------------------------------
  const FROM = { wall: 'Wall kiosk', phone: 'Phone', console: 'PB Console (test)' };
  function renderLog() {
    const a = rangeStart(), b = rangeEnd();
    const rows = ALL.filter((e) => e.di >= a && e.di < b).sort((x, y) => y.t - x.t);
    const nCasts = rows.filter((e) => e.kind !== 'view' && !e.x).length;
    const nNight = rows.filter((e) => e.kind !== 'view' && e.x).length;
    const nViews = rows.filter((e) => e.kind === 'view').length;
    const who = (c) => c.who ? '<strong>' + esc(c.who) + '</strong>' : c.sg === 'member' ? 'Member' : c.sg === 'guest' ? 'Guest' : '—';
    const note = (c) => {
      if (c.x) return '<span class="tag bad">ignored: night</span>' + (c.kind === 'view' ? ' <span class="tag dim">circuit</span> holds lit' : c.kind === 'circuit' ? ' <span class="tag dim">circuit</span>' : '');
      if (c.kind === 'view') return '<span class="tag dim">circuit</span> holds lit';
      if (c.kind === 'circuit') {
        return '<span class="tag dim">circuit</span> ' + esc(c.how || '?') + ' after ' + c.mv + ' move' + (c.mv === 1 ? '' : 's') +
          (c.iv ? ' · ' + esc(String(c.iv)) + ' s a move' : '') + ' · ' + (c.loop ? 'loop' : 'once');
      }
      return c.m ? '<span class="tag dim">mirrored</span>' : '';
    };
    $('ad-log').innerHTML =
      '<p class="ad-logsum"><strong>' + nCasts + '</strong> cast' + (nCasts === 1 ? '' : 's') + ' (problems and circuit runs), ' + nNight +
      ' ignored at night, ' + nViews + ' circuit' + (nViews === 1 ? '' : 's') + ' lit on the wall, ' + fmtS(a) + ' – ' + fmtS(TODAY) + '.' +
      ' The Pi\'s journal goes back to ' + esc((D && D.journal_from) || '?') + '; the console keeps ' + ((D && D.cached) || 0) + ' events of its own.</p>' +
      (rows.length ? '<table class="audit"><tr><th>Date and time (UK)</th><th>Climb</th><th>From</th><th>Who</th><th></th></tr>' +
        rows.map((c) => '<tr><td>' + esc(UKTIME.format(new Date(c.t))) + '</td><td><strong>' + esc(c.n) + '</strong></td><td>' +
          esc(c.s ? FROM[c.s] || c.s : '—') + '</td><td>' + who(c) + '</td><td>' + note(c) + '</td></tr>').join('') + '</table>'
        : '<p class="muted">No casts in this period.</p>') +
      '<p class="note">From the Pi\'s journal, kept by the console as the journal expires. A circuit run is dated when it started ' +
      '(its line is written when it ends: runs still going aren\'t listed yet). Each cast says where it was sent from and whether someone ' +
      'was signed in, never who (<code>docs/cast-contract.md</code> §3); members\' nicknames come from the private cast log (db/34), matched to the journal.</p>';
  }

  // -- layout -----------------------------------------------------------------------------------
  // The dashboard fills the window below the console's own chrome, without page scrolling.
  function fit() {
    const ad = $('ad');
    if (!ad || $('tab-activity').hidden) return;
    const top = ad.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(520, window.innerHeight - top - 16);
    ad.style.height = h + 'px';
    ad.classList.toggle('ad-compact', h < 800);
  }

  function renderAll() {
    $('ad-dash').hidden = S.view !== 'dash';
    $('ad-log').hidden = S.view !== 'log';
    renderHeader();
    if (!D) return;
    fit();
    if (S.view === 'log') { renderLog(); return; }
    // the lists first: the bottom row's height decides how much room the charts get
    renderChips(); renderTiles(); renderWho(); renderTop(); renderMix(); renderMain(); renderHeat();
  }

  async function load(refresh) {
    if (loading) return;
    loading = true;
    $('ad-reload').disabled = true;
    $('ad-last').textContent = refresh ? 'Reading the Pi\'s journal and the database…' : 'Loading…';
    try {
      const { status, data } = await PB.apiJson('/api/activity-history?days=0' + (refresh ? '' : '&refresh=0'));
      if (status !== 200) throw new Error(data.error || 'HTTP ' + status);
      prepare(data);
    } catch (e) {
      $('ad-note').textContent = 'Couldn\'t read the activity: ' + (e.message || e);
    } finally {
      loading = false;
      $('ad-reload').disabled = false;
    }
    renderAll();
  }

  PB.tabHooks.activity = () => { fit(); load(true); };
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('focusin', onFocus);
  $('ad-reload').addEventListener('click', () => load(true));
  let q = 0;
  const redraw = () => {
    cancelAnimationFrame(q);
    q = requestAnimationFrame(() => {
      if (!D || $('tab-activity').hidden) return;
      fit();
      if (S.view === 'dash') { renderMain(); renderHeat(); }
    });
  };
  window.addEventListener('resize', redraw);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(redraw);
    ['ad', 'ad-plot-main', 'ad-plot-heat'].forEach((id) => ro.observe($(id)));
  }
  renderHeader();
}());
