// Cast test harness (not deployed). Part 1 listens on the board channel like the Pi
// does; part 2 drives the local app in an iframe (same origin, so its globals are
// reachable) and checks what actually arrives on the channel.

const SUPA_URL = 'https://uqirowyfqwiceyjznosl.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA';

const received = [];   // { t, payload } for every cast_problem heard
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. Listener ──────────────────────────────────────────────────────────────
const listenState = document.getElementById('listen-state');
const logEl = document.getElementById('log');
const listener = supabase.createClient(SUPA_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const listenReady = new Promise(resolve => {
  listener.channel('board:HangoutPortland')
    .on('broadcast', { event: 'cast_problem' }, msg => {
      const payload = msg.payload || {};
      received.push({ t: Date.now(), payload });
      const empty = logEl.querySelector('.empty');
      if (empty) empty.remove();
      const tr = document.createElement('tr');
      tr.className = 'fresh';
      [new Date().toLocaleTimeString(), payload.problem_name ?? '—', payload.mirror ? 'yes' : '', JSON.stringify(payload)]
        .forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
      logEl.prepend(tr);
    })
    .subscribe(status => {
      listenState.textContent = status === 'SUBSCRIBED' ? 'listening' : status.toLowerCase().replace(/_/g, ' ');
      listenState.className = 'pill ' + (status === 'SUBSCRIBED' ? 'ok' : 'bad');
      if (status === 'SUBSCRIBED') resolve();
    });
});

// ── 2. Automated checks ──────────────────────────────────────────────────────
const resultsEl = document.getElementById('results');
const frame = document.getElementById('app');
const runBtn = document.getElementById('run');

function report(ok, text) {
  const li = document.createElement('li');
  li.className = ok ? 'pass' : 'fail';
  li.textContent = text;
  resultsEl.appendChild(li);
  return ok;
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(100); }
  return pred();
}

// The app registers its service worker on this origin too, and a worker from an
// earlier run would serve the code it cached back then. Drop it (and its caches)
// first, so the run always tests the files on disk. Only this local origin's.
async function loadApp() {
  if (navigator.serviceWorker) {
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
  }
  if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  return new Promise(resolve => {
    frame.onload = () => resolve(frame.contentWindow);
    frame.src = '../app/index.html?cast-test=' + Date.now();
  });
}

const FAKE = ['A', 'B'].map(k => ({
  id: '~cast-test-' + k.toLowerCase(),
  name: '~cast-test-' + k,
  grade: '6a',
  setter: 'cast test',
  setter_id: null,
  finish_hold: 'hold230',
  intermediate_holds: ['hold100', 'hold120'],
  start_holds: ['hold2', 'hold4'],
  stars: 0,
  is_benchmark: false,
  feet_mode: 'any',
  created_at: '2000-01-01T00:00:00Z',
}));

async function run() {
  runBtn.disabled = true;
  resultsEl.innerHTML = '';
  let passed = 0, total = 0;
  const check = (ok, text) => { total++; if (report(ok, text)) passed++; };

  await listenReady;
  const w = await loadApp();
  // The app's top-level let/const aren't window properties; a global eval reaches them.
  const g = expr => w.eval(expr);
  const ready = await waitFor(() => g('loaded && authReady'), 15000);
  if (!ready) { report(false, 'The app didn’t finish loading within 15 s'); runBtn.disabled = false; return; }
  await sleep(2500);   // let any start-up socket connect, so the check below is fair

  const warnings = [];
  const origWarn = w.console.warn;
  w.console.warn = (...a) => { warnings.push(a.join(' ')); origWarn.apply(w.console, a); };

  // The fake problems, and a location check that takes a while (like a first GPS fix).
  g('allProblems').push(...FAKE.map(p => ({ ...p })));
  const realFence = w.ensureCastLocation;
  let fenceDelay = 0;
  w.ensureCastLocation = async () => { await sleep(fenceDelay); return { ok: true }; };

  const doc = w.document;
  const btn = () => doc.getElementById('detail-cast');
  const toast = () => doc.getElementById('toast').textContent;
  const show = id => { w.location.hash = '#detail/' + encodeURIComponent(id); return sleep(300); };
  // What a swipe does: replace the entry and render in place.
  const swipeTo = id => { w.history.replaceState(w.history.state, '', '#detail/' + encodeURIComponent(id)); w.renderDetail(id); };
  const since = t => received.filter(r => r.t >= t && String(r.payload.problem_name || '').startsWith('~cast-test'));
  const idle = () => !btn().disabled && !btn().classList.contains('casting') && !btn().classList.contains('sent');
  const [A, B] = FAKE;

  // 1. No socket held open while browsing.
  const rt = g('sb').realtime;
  check(!rt.isConnected(), `No Realtime socket open while browsing (connected: ${rt.isConnected()})`);

  // 2. A plain cast arrives with the problem's name and no mirror flag.
  await show(A.id);
  let t0 = Date.now();
  btn().click();
  let got = await waitFor(() => since(t0).length >= 1, 8000);
  let hits = since(t0);
  check(got && hits[0].payload.problem_name === A.name && !('mirror' in hits[0].payload),
    `Cast on A delivers { problem_name: "${A.name}" } (got ${got ? JSON.stringify(hits[0].payload) : 'nothing'})`);
  check(/Cast: ~cast-test-A/.test(toast()), `Success toast names A (“${toast()}”)`);
  await waitFor(idle, 3000);
  check(idle(), 'Cast button returns to normal after the “sent” state');

  // 3. A mirrored cast carries mirror: true.
  w.toggleDetailMirror();
  t0 = Date.now();
  btn().click();
  got = await waitFor(() => since(t0).length >= 1, 8000);
  hits = since(t0);
  check(got && hits[0].payload.mirror === true && hits[0].payload.problem_name === A.name,
    `Mirrored cast delivers mirror: true (got ${got ? JSON.stringify(hits[0].payload) : 'nothing'})`);
  await waitFor(idle, 3000);
  w.toggleDetailMirror();

  // 4. Swiping away while "Locating" cancels the cast (F02).
  fenceDelay = 1500;
  t0 = Date.now();
  btn().click();
  await sleep(200);
  swipeTo(B.id);
  check(idle(), 'After the swipe, the cast button on B is ready to use');
  await sleep(3000);
  check(since(t0).length === 0, `Swiping to B during the location wait sends nothing (sent: ${JSON.stringify(since(t0).map(r => r.payload))})`);
  check(/cancel/i.test(toast()), `…and says so (“${toast()}”)`);

  // 5. Flipping the mirror while "Locating" cancels too (the orientation changed).
  await show(A.id);
  t0 = Date.now();
  btn().click();
  await sleep(200);
  w.toggleDetailMirror();
  await sleep(3000);
  check(since(t0).length === 0, `Mirroring during the location wait sends nothing (sent: ${JSON.stringify(since(t0).map(r => r.payload))})`);
  w.toggleDetailMirror();

  // 6. Tap on A, swipe to B, tap on B: only B is cast.
  await show(A.id);
  t0 = Date.now();
  btn().click();
  await sleep(200);
  swipeTo(B.id);
  btn().click();
  await sleep(4000);
  hits = since(t0);
  check(hits.length === 1 && hits[0].payload.problem_name === B.name,
    `Cast A, swipe, cast B: exactly one cast, of B (sent: ${JSON.stringify(hits.map(r => r.payload))})`);
  await waitFor(idle, 3000);

  // 7. A double tap casts once.
  t0 = Date.now();
  btn().click();
  btn().click();
  await sleep(4000);
  check(since(t0).length === 1, `Double tap casts once (casts: ${since(t0).length})`);
  await waitFor(idle, 3000);

  // 8. Staying put still casts after a slow location fix.
  t0 = Date.now();
  btn().click();
  got = await waitFor(() => since(t0).length >= 1, 8000);
  check(got && since(t0)[0].payload.problem_name === B.name, 'Waiting on the same problem still casts it after the location wait');
  await waitFor(idle, 3000);

  // 9. A failed send reports failure and frees the button.
  fenceDelay = 0;
  const chan = g('channel');
  const realSend = chan.httpSend;
  chan.httpSend = () => Promise.reject(new Error('simulated network failure'));
  t0 = Date.now();
  btn().click();
  await sleep(800);
  check(/failed/i.test(toast()) && idle() && since(t0).length === 0, `A failed send shows an error and frees the button (“${toast()}”)`);
  chan.httpSend = realSend;

  // 10. No deprecation warning from the library.
  check(!warnings.some(s => /falling back to REST/i.test(s)), 'No “falling back to REST API” deprecation warning');
  check(!rt.isConnected(), 'Still no Realtime socket after casting');

  w.ensureCastLocation = realFence;
  const li = document.createElement('li');
  li.className = 'summary';
  li.textContent = `${passed} of ${total} checks passed`;
  li.style.color = passed === total ? 'var(--ok)' : 'var(--bad)';
  resultsEl.appendChild(li);
  runBtn.disabled = false;
}

runBtn.addEventListener('click', () => run().catch(err => { report(false, 'The run crashed: ' + err.message); console.error(err); runBtn.disabled = false; }));
