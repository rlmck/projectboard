// PB Console: Advanced's sections (Config, Deploy, LED map, Tests, Backups), the Runbook,
// Home's "Light a problem" and the opening-hours editor (the Opening hours tile's drawer).
// Uses console.js's helpers (window.PB): every call carries the token, every action goes
// through /api/preview (the confirm) and /api/action.
'use strict';

(function () {
  const PB = window.PB;
  if (!PB) return;
  const $ = (id) => document.getElementById(id);
  const esc = PB.esc;

  async function get(path) {
    const { status, data } = await PB.apiJson(path);
    if (status !== 200) throw new Error(data.error || 'HTTP ' + status);
    return data;
  }

  function fail(el, e) {
    el.innerHTML = '<p class="banner bad">' + esc(e.message || e) + '</p>';
  }

  function pre(text) {
    return '<pre class="out">' + esc(text) + '</pre>';
  }

  function when(t) {
    return t ? new Date(t * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
  }

  // -- Config (Advanced) ---------------------------------------------------------------------------
  let cfg = null;

  async function loadConfig() {
    const box = $('cfg-form');
    box.innerHTML = '<p class="muted">Reading config.env from the Pi…</p>';
    try {
      cfg = await get('/api/config');
    } catch (e) { return fail(box, e); }
    const groups = {};
    cfg.keys.forEach((k) => { if (k.group !== 'Opening hours') (groups[k.group] = groups[k.group] || []).push(k); });
    box.innerHTML = Object.keys(groups).map((g) => '<fieldset class="card"><h3>' + esc(g) + '</h3>' +
      groups[g].map((k) => {
        const v = cfg.values[k.key] == null ? '' : cfg.values[k.key];
        const field = k.choices
          ? '<select data-key="' + esc(k.key) + '">' + k.choices.map((c) => '<option' + (c === v ? ' selected' : '') + ' value="' + esc(c) + '">' + esc(c || '(empty)') + '</option>').join('') + '</select>'
          : '<input data-key="' + esc(k.key) + '" value="' + esc(v) + '" size="' + (k.key === 'SUPABASE_ANON_KEY' ? 40 : 18) + '">';
        return '<label class="cfg-row"><span class="cfg-key">' + esc(k.key) + '</span>' + field +
          '<span class="muted">' + esc(k.help) + (k.restart ? ' · restarts the listener' : ' · re-read, no restart') + '</span></label>';
      }).join('') + '</fieldset>').join('');
    $('cfg-drift').hidden = !cfg.drift;
    $('cfg-drift-text').textContent = cfg.drift || '';
    $('cfg-backups').innerHTML = cfg.backups.length ? cfg.backups.map((b) =>
      '<details><summary>' + esc(b.name) + ' <button class="btn small" data-restore="' + esc(b.name) + '">Put this back</button></summary>' +
      pre(b.diff || '(the same as now)') + '</details>').join('') : '<p class="muted">No backups yet: the first change makes one.</p>';
  }

  function changedValues() {
    const out = {};
    document.querySelectorAll('#cfg-form [data-key]').forEach((el) => {
      const k = el.dataset.key;
      const was = cfg.values[k] == null ? '' : cfg.values[k];
      if (el.value.trim() !== was) out[k] = el.value.trim();
    });
    return out;
  }

  async function applyConfig() {
    const values = changedValues();
    if (!Object.keys(values).length) { PB.toast('Nothing changed'); return; }
    if (await PB.runAction('config-set', { values }, 'Config: ' + Object.keys(values).join(', '))) loadConfig();
  }

  // -- The opening hours (Home: the Opening hours tile's drawer) -----------------------------------
  // HOURS_MON..HOURS_SUN, London time: one row a day, from / to or Closed. A "to" of 00:00 is
  // midnight (24:00); a "to" before the "from" runs past midnight. Written with config-set.
  const DAY_NAME = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };
  let hoursCfg = null;

  async function hoursEditor(box) {
    box.innerHTML = '<p class="muted">Reading the opening hours from the Pi…</p>';
    try { hoursCfg = await get('/api/config'); } catch (e) { return fail(box, e); }
    if (!box.isConnected) return;
    const keys = hoursCfg.keys.filter((k) => k.group === 'Opening hours');
    box.innerHTML = '<table class="audit hours-table"><tr><th>Day</th><th>From</th><th>To</th><th>Closed</th></tr>' +
      keys.map((k) => {
        const v = String(hoursCfg.values[k.key] == null ? '' : hoursCfg.values[k.key]).trim().toLowerCase();
        const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(v);
        const closed = v === 'closed';
        const from = m ? m[1] : '', to = m ? (m[2] === '24:00' ? '00:00' : m[2]) : '';
        return '<tr data-hours="' + esc(k.key) + '"><td>' + esc(DAY_NAME[k.key.slice(6)] || k.key) + '</td>' +
          '<td><input type="time" step="60" data-part="from" value="' + esc(from) + '"' + (closed ? ' disabled' : '') + '></td>' +
          '<td><input type="time" step="60" data-part="to" value="' + esc(to) + '"' + (closed ? ' disabled' : '') + '></td>' +
          '<td><input type="checkbox" data-part="closed"' + (closed ? ' checked' : '') + ' aria-label="Closed all day"></td></tr>' +
          (m || closed ? '' : '<tr><td></td><td colspan="3" class="muted">Now ' + esc(v || '(empty: the default)') + '</td></tr>');
      }).join('') + '</table>' +
      (hoursCfg.drift ? '<p class="banner warn">The laptop\'s and the Pi\'s settings differ, so changes are refused: Advanced → Config to pick one.</p>' : '') +
      '<div class="btn-row"><button class="btn primary" data-hours-apply="1">Save the hours</button></div>' +
      '<p class="note">London time. The Pi re-reads them within 10 s; no restart. For one evening, use Stay on (Board) instead.</p>';
    box.addEventListener('change', (ev) => {
      if (ev.target.dataset.part !== 'closed') return;
      ev.target.closest('tr').querySelectorAll('input[type="time"]').forEach((el) => { el.disabled = ev.target.checked; });
    });
  }

  function hoursChanges(box) {
    const out = {};
    box.querySelectorAll('[data-hours]').forEach((row) => {
      const k = row.dataset.hours, day = DAY_NAME[k.slice(6)];
      const from = row.querySelector('[data-part="from"]').value, to = row.querySelector('[data-part="to"]').value;
      let v;
      if (row.querySelector('[data-part="closed"]').checked) v = 'closed';
      else if (!from || !to) throw new Error(day + ': set both times, or tick Closed');
      else if (from === to) throw new Error(day + ': from and to are the same');
      else v = from + '-' + (to === '00:00' ? '24:00' : to);
      const was = String(hoursCfg.values[k] == null ? '' : hoursCfg.values[k]).trim().toLowerCase();
      if (v !== was) out[k] = v;
    });
    return out;
  }

  async function saveHours(box) {
    let values;
    try { values = hoursChanges(box); } catch (e) { PB.toast(e.message); return; }
    if (!Object.keys(values).length) { PB.toast('Nothing changed'); return; }
    if (await PB.runAction('config-set', { values }, 'Opening hours: ' + Object.keys(values).map((k) => k.slice(6)).join(', '))) hoursEditor(box);
  }

  // -- Deploy (Advanced) -----------------------------------------------------------------------------
  async function loadDrift() {
    const box = $('drift-out');
    box.innerHTML = '<p class="muted">Hashing every installed file on the Pi…</p>';
    let d;
    try { d = await get('/api/drift'); } catch (e) { return fail(box, e); }
    const bad = d.files.filter((f) => f.state !== 'same');
    const label = { same: 'same', differs: 'differs: deploy', missing: 'not on the Pi', unreadable: 'root only' };
    const a = d.autodeploy || {};
    const auto = !a.checked_at ? 'Automatic updates have not run yet on this laptop.'
      : a.result === 'up to date' || a.result === 'deployed'
        ? 'Automatic updates: the Pi has main ' + esc((a.deployed_commit || '').slice(0, 7)) + (a.deployed_at ? ', put there ' + esc(a.deployed_at.replace('T', ' ')) : '') + '. Last checked ' + esc(a.checked_at.replace('T', ' ')) + '.'
        : 'Automatic updates: main ' + esc((a.target || '').slice(0, 7)) + ' is waiting (' + esc(a.waiting || a.result) + '). Last checked ' + esc(a.checked_at.replace('T', ' ')) + '.';
    box.innerHTML =
      '<p>' + auto + '</p>' +
      '<p>' + (d.files.length - bad.length) + ' of ' + d.files.length + ' files the same as the repo.</p>' +
      (bad.length ? '<table class="audit"><tr><th>Repo</th><th>On the Pi</th><th></th></tr>' + bad.map((f) =>
        '<tr><td>' + esc(f.repo) + '</td><td>' + esc(f.pi) + '</td><td class="r-' + (f.state === 'differs' ? 'failed' : 'cancelled') + '">' +
        esc(label[f.state] || f.state) + '</td></tr>').join('') + '</table>' : '') +
      (d.config_drift ? '<p class="banner warn">The board\'s settings on this laptop and on the Pi don\'t match, so automatic updates are paused. Open Config and keep the right copy.</p>' : '') +
      '<h3>On the Pi, not in the repo</h3>' +
      (d.extra.length ? d.extra.map((x) => '<div class="svc"><span class="dot"></span><span class="name">' + esc(x.path) + '</span><span class="muted">' +
        esc(x.pull_to ? '→ ' + x.pull_to : 'not pullable') + '</span><div class="btn-row">' +
        (x.pull_to ? '<button class="btn small" data-pull="' + esc(x.path) + '">Pull into the repo</button>' : '') + '</div></div>').join('')
        : '<p class="muted">Nothing.</p>') +
      '<h3>NetworkManager profiles</h3>' + d.nm.map((n) => '<div class="svc"><span class="dot"></span><span class="name">' + esc(n.name) +
        '</span><span class="muted">→ ' + esc(n.pull_to) + '</span><div class="btn-row"><button class="btn small" data-pullnm="' + esc(n.name) +
        '">Pull (secrets stripped)</button></div></div>').join('');
  }

  async function deploy(dry) {
    // No password: the Pi lets the deploy install without one (pb-deploy sudoers, 30 Oct 2026).
    await PB.runAction('deploy', { dry_run: dry }, dry ? 'Deploy (dry run)' : 'Deploy to the Pi');
  }

  // -- LED map (Advanced) -------------------------------------------------------------------------------
  async function loadLedmap() {
    let d;
    try { d = await get('/api/ledmap'); } catch (e) { $('ledmap-state').textContent = e.message; return; }
    $('ledmap-state').textContent = 'pb-ledmap is ' + (d.state || '?');
    const frame = $('ledmap-frame');
    if (d.state === 'active' && !frame.src) frame.src = d.url;
    if (d.state !== 'active') frame.removeAttribute('src');
    $('ledmap-cam').src = $('ledmap-cam').src || (PB.state().cam_url || '');
    $('ledmap-history').innerHTML = d.history.length ? d.history.map((h) => '<li>' + esc(h.name) + ': ' +
      esc(Object.entries(h.counts).map(([k, v]) => v + ' ' + k).join(', ')) + '</li>').join('') : '<li class="muted">None saved yet.</li>';
  }

  async function uploadLedmap(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const results = JSON.parse(await file.text());
      const { status, data } = await PB.apiJson('/api/ledmap-results', { results });
      PB.toast(status === 200 ? 'Saved as ' + data.saved : (data.error || 'refused'));
      loadLedmap();
    } catch (e) { PB.toast('Not a mapping export: ' + e.message); }
    ev.target.value = '';
  }

  // -- Light a problem (Home) ------------------------------------------------------------------------------
  let problems = null;

  async function loadProblems() {
    if (problems) return;
    problems = [];
    try { problems = (await get('/api/problems')).problems; } catch (e) { problems = null; return; }
    $('ov-cast-list').innerHTML = problems.map((p) => '<option value="' + esc(p.name) + '">' + esc((p.grade || '') + (p.benchmark ? ' ★' : '')) + '</option>').join('');
  }

  function castProblem() {
    const name = $('ov-cast-name').value.trim();
    if (!name) { PB.toast('Type a problem name'); $('ov-cast-name').focus(); return; }
    if (problems && problems.length && !problems.some((p) => p.name === name)) { PB.toast('No problem called ' + name); return; }
    const mirror = $('ov-cast-mirror').checked;
    PB.runAction('test-cast', { name, mirror }, 'Light ' + name + (mirror ? ' (mirrored)' : ''));
  }

  // -- Tests (Advanced) --------------------------------------------------------------------------------------
  async function loadTests() {
    const box = $('tests-list');
    let d;
    try { d = await get('/api/acceptance'); } catch (e) { return fail(box, e); }
    box.innerHTML = d.tests.map((t) => '<div class="card test ' + (t.result || '') + '"><h3>' + esc(t.title) +
      (t.result ? ' <span class="pill ' + (t.result === 'pass' ? 'r-ok' : 'r-failed') + '">' + esc(t.result) + ' ' + esc((t.at || '').replace('T', ' ')) + '</span>' : '') +
      '</h3><p class="note">' + esc(t.expect) + '</p><div class="btn-row">' +
      t.steps.map((s) => '<button class="btn" data-test=\'' + esc(JSON.stringify(s.args)) + '\'>' + esc(s.label) + '</button>').join('') +
      '</div><textarea data-note="' + esc(t.id) + '" rows="2" placeholder="Notes: what happened">' + esc(t.note) + '</textarea>' +
      '<div class="btn-row"><button class="btn small" data-result="pass" data-id="' + esc(t.id) + '">Pass</button>' +
      '<button class="btn small danger" data-result="fail" data-id="' + esc(t.id) + '">Fail</button>' +
      '<button class="btn small" data-result="" data-id="' + esc(t.id) + '">Clear</button></div></div>').join('');
  }

  async function saveResult(id, result) {
    const note = document.querySelector('[data-note="' + id + '"]').value;
    const { status, data } = await PB.apiJson('/api/acceptance-note', { id, result: result || null, note });
    PB.toast(status === 200 ? 'Saved' : data.error);
    loadTests();
  }

  async function lastNight() {
    const box = $('night-out');
    box.innerHTML = '<p class="muted">Reading the journal around the night\'s start and end…</p>';
    try {
      const d = await get('/api/last-night' + ($('night-date').value ? '?date=' + $('night-date').value : ''));
      box.innerHTML = '<p>Night ' + esc(d.start.replace('T', ' ')) + ' to ' + esc(d.end.replace('T', ' ')) + ', ' + d.ignored_casts + ' casts ignored.</p><ul class="checks">' +
        d.checks.map((c) => '<li class="' + (c.ok ? 'r-ok' : 'r-failed') + '">' + (c.ok ? '✓ ' : '✗ ') + esc(c.check) + (c.at ? ' <span class="muted">' + esc(c.at) + '</span>' : '') + '</li>').join('') +
        '</ul><details><summary>The journal lines</summary>' + pre((d.lines_start || []).join('\n') + '\n…\n' + (d.lines_end || []).join('\n')) + '</details>';
    } catch (e) { fail(box, e); }
  }

  // -- Backups (Advanced; weekly by themselves) -----------------------------------------------------------------
  async function loadBackups() {
    try {
      const d = await get('/api/backups');
      const s = d.state || {};
      $('backup-state').textContent = 'Last good backup: ' + when(s.ok_at) + (s.how ? ' (' + s.how + ')' : '') +
        (s.result === 'failed' ? '. The last try (' + when(s.tried_at) + ') failed: ' + (s.error || '?') : '') +
        '. Next: ' + (s.next_at ? when(s.next_at) : 'as soon as the laptop\'s scheduled task next runs') +
        ' (weekly, by the scheduled task that keeps the Pi up to date).';
      $('backups-list').innerHTML = d.backups.length ? d.backups.map((b) => '<li>' + esc(b.path) + ' <span class="muted">' +
        Math.max(1, Math.round(b.bytes / 1024)) + ' KB</span></li>').join('') : '<li class="muted">None yet.</li>';
    } catch (e) { $('backups-list').textContent = e.message; }
  }

  // -- Runbook (only while the Pi is offline) ----------------------------------------------------------------
  async function loadRunbook() {
    const box = $('runbook-out');
    if (box.dataset.loaded) return;
    try {
      const d = await get('/api/runbook');
      box.innerHTML = d.sections.map((s) => '<details class="card"' + (s.title.startsWith('Wi-Fi') ? ' open' : '') + '><summary><strong>' +
        esc(s.title) + '</strong></summary>' + pre(s.text) + '</details>').join('');
      box.dataset.loaded = '1';
    } catch (e) { fail(box, e); }
  }

  // -- wiring -------------------------------------------------------------------------------------------
  PB.tabHooks.config = loadConfig;
  PB.tabHooks.deploy = loadDrift;
  PB.tabHooks.ledmap = loadLedmap;
  PB.tabHooks.tests = loadTests;
  PB.tabHooks.backups = loadBackups;
  PB.tabHooks.runbook = loadRunbook;
  PB.tabHooks.overview = loadProblems;
  PB.hoursEditor = hoursEditor;
  PB.afterAction = (action) => {
    if (action.startsWith('config')) {
      if ($('adv-config').open) loadConfig();
    }
    if (action === 'deploy' || action.startsWith('pull')) loadDrift();
    if (action === 'ledmap') setTimeout(loadLedmap, 1500);
    if (action.startsWith('backup')) loadBackups();
  };

  document.body.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.dataset.restore) { ev.preventDefault(); PB.runAction('config-restore', { name: t.dataset.restore }, 'Put back ' + t.dataset.restore); }
    if (t.dataset.pull) PB.runAction('pull-file', { path: t.dataset.pull }, 'Pull ' + t.dataset.pull);
    if (t.dataset.pullnm) PB.runAction('pull-nm', { name: t.dataset.pullnm }, 'Pull profile ' + t.dataset.pullnm);
    if (t.dataset.test) PB.runAction('test-step', { args: JSON.parse(t.dataset.test) }, 'Test: ' + t.textContent);
    if (t.dataset.result !== undefined && t.dataset.id) saveResult(t.dataset.id, t.dataset.result);
    if (t.dataset.hoursApply) saveHours(t.closest('[data-hours-box]'));
  });
  $('cfg-apply').addEventListener('click', applyConfig);
  $('cfg-reload').addEventListener('click', loadConfig);
  $('cfg-push').addEventListener('click', () => PB.runAction('config-push', {}, "Pi's config.env ← laptop's"));
  $('cfg-pull').addEventListener('click', () => PB.runAction('config-pull', {}, "laptop's pi/config.env ← Pi's"));
  $('drift-reload').addEventListener('click', loadDrift);
  $('deploy-dry').addEventListener('click', () => deploy(true));
  $('deploy-go').addEventListener('click', () => deploy(false));
  $('ledmap-start').addEventListener('click', () => PB.runAction('ledmap', { state: 'start' }, 'Start LED mapping'));
  $('ledmap-stop').addEventListener('click', () => PB.runAction('ledmap', { state: 'stop' }, 'Stop LED mapping'));
  $('ledmap-file').addEventListener('change', uploadLedmap);
  $('ov-cast-name').addEventListener('focus', loadProblems);
  $('ov-cast-name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') castProblem(); });
  $('ov-cast-go').addEventListener('click', castProblem);
  $('night-check').addEventListener('click', lastNight);
  $('backup-now').addEventListener('click', () => PB.runAction('backup-now', {}, 'Back up now'));
  $('backup-pi').addEventListener('click', () => PB.runAction('backup-pi', {}, 'Back up the Pi'));
  $('backup-sb').addEventListener('click', () => PB.runAction('backup-supabase', {}, 'Export Supabase'));
}());
