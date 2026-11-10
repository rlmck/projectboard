// PB Console phases 5-15: Config, Deploy, Release, LED mapping, Test cast,
// Acceptance tests, Backups, Power, Runbook. Uses console.js's
// helpers (window.PB): every call carries the token, every action goes through
// /api/preview (the confirm) and /api/action.
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

  // -- Config (phase 5) ---------------------------------------------------------------------------
  let cfg = null;

  async function loadConfig() {
    const box = $('cfg-form');
    box.innerHTML = '<p class="muted">Reading config.env from the Pi…</p>';
    try {
      cfg = await get('/api/config');
    } catch (e) { return fail(box, e); }
    const groups = {};
    cfg.keys.forEach((k) => { (groups[k.group] = groups[k.group] || []).push(k); });
    box.innerHTML = Object.keys(groups).map((g) => g === 'Opening hours' ? hoursTable(groups[g]) : '<fieldset class="card"><h3>' + esc(g) + '</h3>' +
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

  // The opening hours (HOURS_MON..HOURS_SUN, London time): one row a day, from / to or Closed.
  // A "to" of 00:00 is midnight (24:00); a "to" before the "from" runs past midnight.
  const DAY_NAME = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };

  function hoursTable(keys) {
    return '<fieldset class="card cfg-hours"><h3>Opening hours</h3>' +
      '<p class="muted">Day mode inside these, night outside: LEDs dark, casts ignored, the wall screen off. London time. ' +
      'Re-read within 10 s, no restart. For one evening, use Board → Stay on until instead.</p>' +
      '<table class="audit"><tr><th>Day</th><th>From</th><th>To</th><th>Closed</th></tr>' +
      keys.map((k) => {
        const v = String(cfg.values[k.key] == null ? '' : cfg.values[k.key]).trim().toLowerCase();
        const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(v);
        const closed = v === 'closed';
        const from = m ? m[1] : '', to = m ? (m[2] === '24:00' ? '00:00' : m[2]) : '';
        return '<tr data-hours="' + esc(k.key) + '"><td>' + esc(DAY_NAME[k.key.slice(6)] || k.key) + '</td>' +
          '<td><input type="time" step="60" data-part="from" value="' + esc(from) + '"' + (closed ? ' disabled' : '') + '></td>' +
          '<td><input type="time" step="60" data-part="to" value="' + esc(to) + '"' + (closed ? ' disabled' : '') + '></td>' +
          '<td><input type="checkbox" data-part="closed"' + (closed ? ' checked' : '') + ' aria-label="Closed all day"></td></tr>' +
          (m || closed ? '' : '<tr><td></td><td colspan="3" class="muted">Now ' + esc(v || '(empty: the default)') + '</td></tr>');
      }).join('') + '</table></fieldset>';
  }

  function hoursValue(row) {
    if (row.querySelector('[data-part="closed"]').checked) return 'closed';
    const from = row.querySelector('[data-part="from"]').value, to = row.querySelector('[data-part="to"]').value;
    if (!from || !to) return null;
    return from + '-' + (to === '00:00' ? '24:00' : to);
  }

  function changedValues() {
    const out = {};
    document.querySelectorAll('#cfg-form [data-hours]').forEach((row) => {
      const k = row.dataset.hours, v = hoursValue(row);
      const was = String(cfg.values[k] == null ? '' : cfg.values[k]).trim().toLowerCase();
      if (v === null) throw new Error(DAY_NAME[k.slice(6)] + ': set both times, or tick Closed');
      if (v === row.querySelector('[data-part="from"]').value + '-' + row.querySelector('[data-part="from"]').value) throw new Error(DAY_NAME[k.slice(6)] + ': from and to are the same');
      if (v !== was) out[k] = v;
    });
    document.querySelectorAll('#cfg-form [data-key]').forEach((el) => {
      const k = el.dataset.key;
      const was = cfg.values[k] == null ? '' : cfg.values[k];
      if (el.value.trim() !== was) out[k] = el.value.trim();
    });
    return out;
  }

  async function applyConfig() {
    let values;
    try { values = changedValues(); } catch (e) { PB.toast(e.message); return; }
    if (!Object.keys(values).length) { PB.toast('Nothing changed'); return; }
    if (await PB.runAction('config-set', { values }, 'Config: ' + Object.keys(values).join(', '))) loadConfig();
  }

  // -- Deploy (phase 6) -----------------------------------------------------------------------------
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

  // -- Release (phase 7) ----------------------------------------------------------------------------
  let git = null;
  let pollTimer = null;

  async function loadGit() {
    const box = $('git-status');
    try { git = await get('/api/git'); } catch (e) { return fail(box, e); }
    const c = git.checks;
    box.innerHTML =
      '<div class="kv"><span class="k">Branch</span><span>' + esc(git.branch) + ' at ' + esc(git.head) + '</span>' +
      '<span class="k">To ship</span><span>' + (git.ahead_main ? esc(git.ahead_main) + ' commit(s) here not live yet: Ship sends them'
        : 'nothing: live has everything committed here') + '</span>' +
      '<span class="k">To pull</span><span>' + (git.behind_main ? esc(git.behind_main) + ' commit(s) on live not here: Pull first'
        : 'nothing: up to date with live') + '</span>' +
      '<span class="k">Staging</span><span>' + (!git.staging_ff ? 'has commits live doesn\'t (diverged): ask Claude Code'
        : git.dev_behind ? 'older than here by ' + esc(git.dev_behind) + ' commit(s). Fine: it only updates on Staging'
        : 'same as here') + '</span>' +
      '<span class="k">App version</span><span>' + esc(c.stamp_main || '?') + ' live' +
        (c.stamp_head && c.stamp_head !== c.stamp_main ? ', ' + esc(c.stamp_head) + ' after Ship' : '') + '</span></div>' +
      (git.branch !== 'main' ? '<p class="banner warn">On ' + esc(git.branch) + ': Ship and Rollback work on main.</p>' : '');
    $('git-rollback-pick').innerHTML = git.recent_main.map((r) =>
      '<option value="' + esc(r.hash) + '">' + esc(r.hash + ' ' + r.date + ' ' + r.subject.slice(0, 60)) + '</option>').join('');
    $('git-files').innerHTML = git.files.length ? git.files.map((f) =>
      '<label class="check-row"><input type="checkbox" data-file="' + esc(f.path) + '"' + (f.xy === '??' ? '' : ' checked') + '> <code>' +
      esc(f.xy) + '</code> ' + esc(f.path) + ' <button class="btn small" type="button" data-diff="' + esc(f.path) + '">diff</button></label>').join('')
      : '<p class="muted">Nothing to commit.</p>';
    $('git-log').textContent = git.log.map((l) => l.hash + '  ' + l.date + '  ' + l.subject).join('\n');
  }

  async function showDiff(path) {
    try {
      const d = await get('/api/git-diff' + (path ? '?path=' + encodeURIComponent(path) : ''));
      $('git-diff').textContent = d.diff || '(no diff: a new file shows in full once added)';
    } catch (e) { $('git-diff').textContent = e.message; }
  }

  async function ship() {
    const files = Array.from(document.querySelectorAll('#git-files [data-file]:checked')).map((el) => el.dataset.file);
    const message = $('git-msg').value.trim();
    if (files.length && !message) { PB.toast('Write a commit message'); $('git-msg').focus(); return; }
    if (await PB.runAction('ship', { message, files }, 'Ship')) $('git-msg').value = '';
  }

  // Waits for the stamp of what was just pushed (HEAD): on live after Ship or Rollback,
  // on staging after Staging. A push that changes no shipped file keeps the same stamp.
  function pollLive(where) {
    clearInterval(pollTimer);
    const site = where === 'staging' ? 'staging' : 'cache';
    const started = Date.now();
    const tick = async () => {
      try {
        const l = await get('/api/live');
        const want = l.head;
        $('live-cache').textContent = 'live ' + l.cache + ' · staging ' + l.staging + ' · main ' + l.repo +
          (l[site] === want ? ' ✓ ' + (site === 'cache' ? 'live' : 'staging') + ' shows ' + want : ' · waiting for ' + want + '…');
        if (l[site] === want || Date.now() - started > 600000) clearInterval(pollTimer);
      } catch (e) { $('live-cache').textContent = e.message; }
    };
    tick();
    pollTimer = setInterval(tick, 15000);
  }

  // -- LED mapping (phase 8) --------------------------------------------------------------------------
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

  // -- Test cast (phase 9) ---------------------------------------------------------------------------
  let problems = [];

  async function loadProblems() {
    if (problems.length) return;
    try { problems = (await get('/api/problems')).problems; } catch (e) { $('cast-holds').innerHTML = esc(e.message); return; }
    $('cast-list').innerHTML = problems.map((p) => '<option value="' + esc(p.name) + '">' + esc((p.grade || '') + (p.benchmark ? ' ★' : '')) + '</option>').join('');
    $('cast-cam').src = $('cast-cam').src || (PB.state().cam_url || '');
  }

  async function showHolds() {
    const name = $('cast-name').value.trim();
    if (!name) return;
    try {
      const d = await get('/api/problem?name=' + encodeURIComponent(name));
      $('cast-holds').innerHTML = '<table class="audit"><tr><th>Role</th><th>Hold</th><th>Mirrored to</th></tr>' +
        d.holds.map((h) => '<tr><td class="role-' + h.role + '">' + esc(h.role) + '</td><td>' + esc(h.cell + ' (' + h.hold + ')') +
          '</td><td>' + esc(h.mirror_cell + ' (' + h.mirror + ')') + '</td></tr>').join('') + '</table>';
    } catch (e) { $('cast-holds').textContent = e.message; }
  }

  // Activity (phase 10) is static/activity.js.

  // -- Acceptance tests (phase 11) ---------------------------------------------------------------------
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

  // -- Backups (phase 12) -----------------------------------------------------------------------------
  async function loadBackups() {
    try {
      const d = await get('/api/backups');
      $('backups-list').innerHTML = d.backups.length ? d.backups.map((b) => '<li>' + esc(b.path) + ' <span class="muted">' +
        Math.max(1, Math.round(b.bytes / 1024)) + ' KB</span></li>').join('') : '<li class="muted">None yet.</li>';
    } catch (e) { $('backups-list').textContent = e.message; }
  }

  // -- Power (phase 14) --------------------------------------------------------------------------------
  function loadPower() {
    const o = PB.overview();
    const pins = o && o.board && o.board.config ? o.board.config.RELAY_PINS : '';
    $('power-state').textContent = pins ? 'RELAY_PINS=' + pins + ', but relay switching isn\'t built yet (pi/listener/power.py).'
      : 'Relay module not fitted (RELAY_PINS is empty).';
  }

  // -- Runbook (phase 15) ------------------------------------------------------------------------------
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
  PB.tabHooks.release = loadGit;
  PB.tabHooks.ledmap = loadLedmap;
  PB.tabHooks.cast = loadProblems;
  PB.tabHooks.tests = loadTests;
  PB.tabHooks.backups = loadBackups;
  PB.tabHooks.power = loadPower;
  PB.tabHooks.runbook = loadRunbook;
  PB.afterAction = (action) => {
    if (action.startsWith('config')) loadConfig();
    if (action === 'deploy' || action.startsWith('pull')) loadDrift();
    if (/^(git|ship|staging|rollback|build)/.test(action)) loadGit();
    if (action === 'ship' || action === 'rollback') pollLive('live');
    if (action === 'staging') pollLive('staging');
    if (action === 'ledmap') setTimeout(loadLedmap, 1500);
    if (action.startsWith('backup')) loadBackups();
  };

  document.body.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t.dataset.restore) { ev.preventDefault(); PB.runAction('config-restore', { name: t.dataset.restore }, 'Put back ' + t.dataset.restore); }
    if (t.dataset.pull) PB.runAction('pull-file', { path: t.dataset.pull }, 'Pull ' + t.dataset.pull);
    if (t.dataset.pullnm) PB.runAction('pull-nm', { name: t.dataset.pullnm }, 'Pull profile ' + t.dataset.pullnm);
    if (t.dataset.diff) showDiff(t.dataset.diff);
    if (t.dataset.test) PB.runAction('test-step', { args: JSON.parse(t.dataset.test) }, 'Test: ' + t.textContent);
    if (t.dataset.result !== undefined && t.dataset.id) saveResult(t.dataset.id, t.dataset.result);
  });
  $('cfg-apply').addEventListener('click', applyConfig);
  $('cfg-form').addEventListener('change', (ev) => {
    if (ev.target.dataset.part !== 'closed') return;
    ev.target.closest('tr').querySelectorAll('input[type="time"]').forEach((el) => { el.disabled = ev.target.checked; });
  });
  $('cfg-reload').addEventListener('click', loadConfig);
  $('cfg-push').addEventListener('click', () => PB.runAction('config-push', {}, "Pi's config.env ← laptop's"));
  $('cfg-pull').addEventListener('click', () => PB.runAction('config-pull', {}, "laptop's pi/config.env ← Pi's"));
  $('drift-reload').addEventListener('click', loadDrift);
  $('deploy-dry').addEventListener('click', () => deploy(true));
  $('deploy-go').addEventListener('click', () => deploy(false));
  $('git-reload').addEventListener('click', loadGit);
  $('git-pull').addEventListener('click', () => PB.runAction('git-pull', {}, 'git pull'));
  $('git-alldiff').addEventListener('click', () => showDiff(''));
  $('git-ship').addEventListener('click', ship);
  $('git-check').addEventListener('click', () => PB.runAction('build-check', {}, 'Build check'));
  $('git-staging').addEventListener('click', () => PB.runAction('staging', {}, 'Push to staging'));
  $('git-rollback').addEventListener('click', () => {
    const commit = $('git-rollback-pick').value;
    if (commit) PB.runAction('rollback', { commit }, 'Roll back ' + commit);
  });
  $('git-poll').addEventListener('click', () => pollLive('live'));
  $('ledmap-start').addEventListener('click', () => PB.runAction('ledmap', { state: 'start' }, 'Start LED mapping'));
  $('ledmap-stop').addEventListener('click', () => PB.runAction('ledmap', { state: 'stop' }, 'Stop LED mapping'));
  $('ledmap-file').addEventListener('change', uploadLedmap);
  $('cast-name').addEventListener('change', showHolds);
  $('cast-go').addEventListener('click', () => {
    const name = $('cast-name').value.trim();
    if (!name) { PB.toast('Choose a problem'); return; }
    const mirror = $('cast-mirror').checked;
    PB.runAction('test-cast', { name, mirror }, 'Test cast ' + name + (mirror ? ' (mirrored)' : ''));
  });
  $('night-check').addEventListener('click', lastNight);
  $('backup-pi').addEventListener('click', () => PB.runAction('backup-pi', {}, 'Back up the Pi'));
  $('backup-sb').addEventListener('click', () => PB.runAction('backup-supabase', {}, 'Export Supabase'));
}());
