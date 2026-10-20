// ProjectBoard - this file was split out of the former single app.js. The pieces load as
// ordered classic <script>s sharing ONE global scope (no ES modules, no build step). Order:
// state, core, problems, admin, account, authoring, circuits, challenge, leaderboard, app. This file: the signed-in user's data: ticks, favourites, auth, profile.

  // Load the signed-in user's ticks into myTicks; clear for guests. RLS limits
  // the rows to this user, so we never see anyone else's sends.
  async function loadTicks() {
    if (!session) { myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set(); return; }
    const { data, error } = await sb.from('ticks').select('problem_id, mirrored').eq('user_id', session.user.id);
    if (error) { console.warn('ticks load failed', error); return; }
    myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set();
    (data || []).forEach(r => {
      const id = String(r.problem_id);
      myTicks.add(id);
      (r.mirrored ? myTicksMirrored : myTicksNormal).add(id);
    });
  }

  // Keep the "ticked in any orientation" union in sync after one orientation flips.
  function recomputeAnyTick(id) {
    id = String(id);
    if (myTicksNormal.has(id) || myTicksMirrored.has(id)) myTicks.add(id);
    else myTicks.delete(id);
  }

  // ── Toggle writes (ticks + favourites) ──────────────────────────────────────
  // Each toggle flips the UI at once (optimistic), then brings the database into
  // line. Only one write per item is ever in flight: a tap while one is running
  // just flips the UI again, and when the write lands the loop sends one more if
  // the screen now wants the other state. Without this, a double tap sent an
  // insert and a delete together, and whichever the server ran last won, so the
  // database could end up ticked while the screen showed unticked.
  //   key     — one per item and kind ('tick:<id>:<mirrored>', 'fave:<id>', …)
  //   was     — the state the database held before this tap
  //   wanted  — reads the state the screen shows now
  //   write   — (state) => the insert (true) or delete (false) request
  //   revert  — (dbState, error) => put the UI back to what the database holds
  //   done    — (dbState) => the success toast, once the loop settles on a change
  const togglesInFlight = new Set();

  async function settleToggle(key, was, wanted, write, revert, done) {
    if (togglesInFlight.has(key)) return;   // the running loop picks up the new state
    togglesInFlight.add(key);
    let db = was;
    try {
      while (session && wanted() !== db) {
        const target = wanted();
        const res = await write(target);
        // 23505 = unique violation: the row already exists, which is the state
        // we wanted, so it counts as success.
        if (res.error && res.error.code !== '23505') { revert(db, res.error); return; }
        db = target;
      }
      if (db !== was) done(db);
    } finally {
      togglesInFlight.delete(key);
    }
  }

  // Toggle the current problem's tick, in the orientation the detail view shows.
  async function toggleTick() {
    if (!session) { showToast('Sign in to track ticks', 'success'); location.hash = '#auth'; return; }
    const p = currentProblem;
    if (!p) return;
    const id = String(p.id);
    const mirrored = !!detailMirror;
    // Read the set afresh each time: loadTicks replaces it on a sign-in event.
    const orientSet = () => mirrored ? myTicksMirrored : myTicksNormal;
    const wasTicked = orientSet().has(id);
    const setTicked = on => {
      if (on) orientSet().add(id); else orientSet().delete(id);
      recomputeAnyTick(id);
      updateTickButton();
      renderList();
    };
    setTicked(!wasTicked);   // optimistic

    await settleToggle(`tick:${id}:${mirrored}`, wasTicked, () => orientSet().has(id),
      on => on
        ? sb.from('ticks').insert({ user_id: session.user.id, problem_id: id, mirrored })
        : sb.from('ticks').delete().eq('user_id', session.user.id).eq('problem_id', id).eq('mirrored', mirrored),
      db => { setTicked(db); showToast('Could not save — check connection', 'error'); },
      on => {
        leaderboardLoaded = false;   // points changed — refresh on next leaderboard/profile view
        showToast(on ? 'Ticked ✓' : 'Removed tick', 'success');
      });
  }

  // ── Favourites (personal "saved" list — private to the signed-in user) ───────
  // Problems live in the existing `likes` table; circuits in `circuit_likes`
  // (needs db/15). Both mirror the ticks pattern: optimistic toggle, revert on
  // failure, idempotent via the (user, item) primary key.

  function updateFaveButton() {
    const btn = document.getElementById('detail-fave');
    if (!btn) return;
    const faved = !!(currentProblem && isFaved(currentProblem.id));
    btn.classList.toggle('faved', faved);
    btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    btn.setAttribute('aria-label', faved ? 'Remove from favourites' : 'Add to favourites');
  }

  function updateCircuitFaveButton() {
    const btn = document.getElementById('circuit-detail-fave');
    if (!btn) return;
    const faved = !!(currentCircuit && isCircuitFaved(currentCircuit.id));
    btn.classList.toggle('faved', faved);
    btn.setAttribute('aria-pressed', faved ? 'true' : 'false');
    btn.setAttribute('aria-label', faved ? 'Remove from favourites' : 'Add to favourites');
  }

  // Sync the filter pills' enabled + lit state. The auth-only pills (favourites /
  // exclude-done) render muted for a guest and reset their state; they stay clickable
  // so a tap can show the "sign in" toast. Benchmarks/Looping are never disabled.
  function updateFaveControls() {
    if (!session) { favesOnly = false; excludeDone = false; circuitFavesOnly = false; circuitExcludeDone = false; }
    // [pill id, active state, needs-auth] for both lists.
    const pills = [
      ['pill-faves',  favesOnly,           true],
      ['pill-bench',  benchOnly,           false],
      ['pill-done',   excludeDone,         true],
      ['cpill-faves', circuitFavesOnly,    true],
      ['cpill-loop',  circuitLoopOnly,     false],
      ['cpill-done',  circuitExcludeDone,  true],
    ];
    pills.forEach(([id, active, needsAuth]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active', active);
      el.setAttribute('aria-pressed', active ? 'true' : 'false');
      el.classList.toggle('disabled', needsAuth && !session);
    });
  }

  // Load both favourite sets for the signed-in user; clear for guests. RLS limits
  // the rows to this user. A missing circuit_likes table (db/15 not applied yet)
  // just leaves circuit favourites empty rather than breaking the load.
  async function loadFaves() {
    if (!session) { myFaves = new Set(); myCircuitFaves = new Set(); return; }
    const [pf, cf] = await Promise.all([
      sb.from('likes').select('problem_id').eq('user_id', session.user.id),
      sb.from('circuit_likes').select('circuit_id').eq('user_id', session.user.id),
    ]);
    if (pf.error) console.warn('favourites load failed', pf.error);
    else myFaves = new Set((pf.data || []).map(r => String(r.problem_id)));
    if (cf.error) console.warn('circuit favourites load failed', cf.error);
    else myCircuitFaves = new Set((cf.data || []).map(r => String(r.circuit_id)));
  }

  // Toggle a problem's favourite (optimistic; see settleToggle).
  async function toggleFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isFaved(id);
    const setFaved = on => {
      if (on) myFaves.add(id); else myFaves.delete(id);
      updateFaveButton();
      renderList();
    };
    setFaved(!was);

    await settleToggle('fave:' + id, was, () => isFaved(id),
      on => on
        ? sb.from('likes').insert({ user_id: session.user.id, problem_id: id })
        : sb.from('likes').delete().eq('user_id', session.user.id).eq('problem_id', id),
      db => { setFaved(db); showToast('Could not save — check connection', 'error'); },
      on => showToast(on ? 'Added to favourites ♥' : 'Removed from favourites', 'success'));
  }

  // Toggle a circuit's favourite. Same shape; needs the db/15 circuit_likes table.
  async function toggleCircuitFave(id) {
    if (!session) { showToast('Sign in to save favourites', 'success'); location.hash = '#auth'; return; }
    id = String(id);
    const was = isCircuitFaved(id);
    const setFaved = on => {
      if (on) myCircuitFaves.add(id); else myCircuitFaves.delete(id);
      updateCircuitFaveButton();
      renderCircuits();
    };
    setFaved(!was);

    await settleToggle('cfave:' + id, was, () => isCircuitFaved(id),
      on => on
        ? sb.from('circuit_likes').insert({ user_id: session.user.id, circuit_id: id })
        : sb.from('circuit_likes').delete().eq('user_id', session.user.id).eq('circuit_id', id),
      (db, err) => {
        setFaved(db);
        console.warn('circuit favourite failed', err);
        showToast('Could not save — check connection', 'error');
      },
      on => showToast(on ? 'Added to favourites ♥' : 'Removed from favourites', 'success'));
  }

  // ── Auth: nickname + passphrase accounts (db/30, plan.md) ─────────────────────
  // No email and no Google. You sign up with a nickname and a four-word passphrase
  // the app makes for you; Supabase Auth gets a placeholder email nobody ever sees
  // or uses, and signing in looks it up by nickname (login_email()). Lose the
  // passphrase and only an admin can give you a new one (admin.js, the Edge
  // Function admin-reset-passphrase).

  // The placeholder email: u-<16 base32 chars>@users.invalid. .invalid can never
  // receive mail (RFC 2606), and nothing is ever sent to it: Confirm email, password
  // reset and security notifications all stay off (plan.md manual step 7).
  // KEEP IN SYNC with db/30's pattern ^u-[a-z2-7]{16}@users\.invalid$ (in
  // auth_users_placeholder_only() and login_email()), which refuses anything else.
  const PLACEHOLDER_DOMAIN = 'users.invalid';
  const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
  function placeholderEmail() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);   // 256 is a multiple of 32, so & 31 has no bias
    return 'u-' + Array.from(bytes, b => BASE32[b & 31]).join('') + '@' + PLACEHOLDER_DOMAIN;
  }

  // Cloudflare Turnstile, the robot check. Supabase checks its token on sign-up AND
  // on sign-in once CAPTCHA protection is on (manual step 9). The site key is public;
  // the secret key lives only in the Supabase dashboard. The script loads only when
  // #auth opens, so guests browsing never load it. CSP: script-src + frame-src
  // https://challenges.cloudflare.com (_headers).
  const TURNSTILE_SITE_KEY = '0x4AAAAAAFaUU-JF4RC7asVt';
  const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  let turnstileLoading = null;   // the script's load promise
  let turnstileWidget = null;    // the rendered widget's id
  let captchaToken = '';         // the current token ('' = not passed yet / used up)

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (!turnstileLoading) {
      turnstileLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TURNSTILE_SRC;
        s.async = true;
        s.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile missing'));
        s.onerror = () => { turnstileLoading = null; s.remove(); reject(new Error('Turnstile failed to load')); };
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }

  // Show (and if need be render) the robot check under the current step. A fresh
  // token is fetched each time a step that needs one opens: tokens are single-use
  // and expire after 5 minutes.
  async function showCaptcha() {
    const box = document.getElementById('auth-captcha');
    box.hidden = false;
    captchaToken = '';
    updateAuthSubmit();
    try {
      const ts = await loadTurnstile();
      if (turnstileWidget === null) {
        turnstileWidget = ts.render(box, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'dark',
          size: 'flexible',
          callback: token => { captchaToken = token; updateAuthSubmit(); },
          'expired-callback': () => { captchaToken = ''; updateAuthSubmit(); },
          'error-callback': () => { captchaToken = ''; updateAuthSubmit(); },
        });
      } else {
        ts.reset(turnstileWidget);
      }
    } catch (err) {
      console.warn('robot check failed to load', err);
      authError('Couldn’t load the robot check. Check your connection, then go back and try again.');
    }
  }
  function hideCaptcha() { document.getElementById('auth-captcha').hidden = true; }
  // After every attempt (a token works once), ask for a new one.
  function resetCaptcha() {
    captchaToken = '';
    if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
    updateAuthSubmit();
  }

  // ── Nicknames ────────────────────────────────────────────────────────────────
  // The rules live in the database (db/30 nickname_check): 3–20 characters,
  // A–Z a–z 0–9 _ -, unique ignoring case, and no contact details, reserved or
  // offensive words. The app checks the first two itself for instant feedback and
  // asks nickname_problem() for the rest. Every save is re-checked server-side,
  // which answers with the same codes (SQLSTATE 23514, message = the code).
  const NICK_MSG = {
    length:    'Use 3 to 20 characters.',
    chars:     'Use only letters, numbers, _ and -. No spaces.',
    contact:   'That looks like a phone number, email or web address. Pick a nickname instead.',
    reserved:  'That nickname is reserved. Pick another.',
    offensive: 'That nickname isn’t allowed. Pick another.',
    taken:     'That nickname is taken. Try another.',
  };
  function nickLocalProblem(n) {
    if (n.length < 3 || n.length > 20) return 'length';
    if (!/^[A-Za-z0-9_-]+$/.test(n)) return 'chars';
    return null;
  }
  // null = fine, else a NICK_MSG code. Throws if the server can't be asked.
  async function nicknameProblem(n) {
    const local = nickLocalProblem(n);
    if (local) return local;
    const { data, error } = await sb.rpc('nickname_problem', { n });
    if (error) throw error;
    return data || null;
  }
  // The message for a refused nickname save (the trigger's code, or the unique index).
  function nickSaveError(error) {
    if (!error) return '';
    if (NICK_MSG[error.message]) return NICK_MSG[error.message];
    if (error.code === '23505') return NICK_MSG.taken;
    if (error.code === '23514') return 'That nickname isn’t allowed. Pick another.';
    return 'Couldn’t save — check your connection.';
  }

  // A live check under a nickname field: runs 400 ms after typing stops, and on
  // demand (run(), which the Next / Save buttons await). Returns null when the
  // nickname is fine, else a NICK_MSG code, 'empty' or 'offline'. Stale answers
  // (the field changed while the server was asked) don't touch the message.
  //   opts.same(n)       true when n is the account's current nickname (any case): skip "taken"
  //   opts.allowReserved admins may use reserved words (admin rename)
  function nickChecker(inputId, outId, opts = {}) {
    const input = document.getElementById(inputId);
    const out = document.getElementById(outId);
    let seq = 0, timer = null;
    const show = (text, ok) => { out.textContent = text; out.classList.toggle('ok', !!ok); };
    async function run() {
      clearTimeout(timer);
      const mine = ++seq;
      const n = input.value.trim();
      if (!n) { show(''); return 'empty'; }
      const local = nickLocalProblem(n);
      if (local) { show(NICK_MSG[local]); return local; }
      show('Checking…');
      let code;
      try { code = await nicknameProblem(n); }
      catch (err) {
        console.warn('nickname check failed', err);
        if (mine === seq) show('Couldn’t check — check your connection.');
        return 'offline';
      }
      if (code === 'taken' && opts.same && opts.same(n)) code = null;
      if (code === 'reserved' && opts.allowReserved) {
        if (mine === seq) show('A reserved word: allowed, because you’re an admin.', true);
        return null;
      }
      if (mine === seq) show(code ? NICK_MSG[code] : '✓ Available', !code);
      return code;
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      seq++;
      show('');
      timer = setTimeout(run, 400);
    });
    return { run, clear() { clearTimeout(timer); seq++; show(''); } };
  }
  // Made on first use (admin.js loads before this file, so nothing here runs at load).
  const nickCheckers = {};
  function getNickChecker(key, inputId, outId, opts) {
    return nickCheckers[key] || (nickCheckers[key] = nickChecker(inputId, outId, opts));
  }

  // "Suggest one": a climbing word + an animal, e.g. Crimpy_Otter. Every pair is at
  // most 20 characters and passes the nickname rules; a taken one is skipped.
  const NICK_ADJ = ['Crimpy','Chalky','Sloper','Pinchy','Jugsy','Dyno','Flashy','Sendy','Pumped','Gritty',
    'Sticky','Grippy','Bouncy','Mighty','Nimble','Sneaky','Speedy','Steady','Swift','Plucky',
    'Brave','Bold','Clever','Lucky','Sunny','Cosmic','Rocket','Turbo','Zippy','Snappy',
    'Fizzy','Jolly','Cheeky','Breezy','Stompy','Smeary','Heelhook','Toehook','Campus','Overhang'];
  const NICK_ANIMAL = ['Otter','Gecko','Badger','Falcon','Puffin','Lemur','Ibex','Goat','Marmot','Lynx',
    'Panda','Koala','Fox','Hare','Heron','Wombat','Beaver','Raven','Owl','Squirrel',
    'Hedgehog','Pika','Yak','Llama','Tiger','Moose','Seal','Dolphin','Kestrel','Osprey',
    'Newt','Toad','Gibbon','Sloth','Tapir','Quokka','Chamois','Penguin','Walrus','Narwhal'];
  function randomIndex(n) {
    // Rejection sampling: redraw the few 32-bit values above the largest multiple
    // of n, so every index is equally likely (no modulo bias).
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) { crypto.getRandomValues(buf); if (buf[0] < limit) return buf[0] % n; }
  }
  async function suggestNickname() {
    const input = document.getElementById('signup-nick');
    const btn = document.getElementById('signup-suggest');
    btn.disabled = true;
    let pick = '';
    try {
      for (let i = 0; i < 6; i++) {
        pick = NICK_ADJ[randomIndex(NICK_ADJ.length)] + '_' + NICK_ANIMAL[randomIndex(NICK_ANIMAL.length)];
        if (!(await nicknameProblem(pick))) break;
      }
    } catch (err) { console.warn('suggest: check failed', err); }   // still fill one in; the check below says why
    btn.disabled = false;
    input.value = pick;
    getNickChecker('signup', 'signup-nick', 'signup-nick-check').run();
  }

  // ── Passphrases ──────────────────────────────────────────────────────────────
  // Four words from the EFF large wordlist (7,776 words, CC BY, credited on
  // privacy.html; built by tools/make_wordlist.py), picked with
  // crypto.getRandomValues: about 51.7 bits. Joined with hyphens. The Edge Function
  // makes reset passphrases the same way from the same list.
  let wordlistLoading = null;
  function loadWordlist() {
    if (!wordlistLoading) {
      wordlistLoading = fetch('eff_large_wordlist.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(j => {
          if (!j || !Array.isArray(j.words) || j.words.length !== 7776) throw new Error('bad wordlist');
          return j.words;
        })
        .catch(err => { wordlistLoading = null; throw err; });
    }
    return wordlistLoading;
  }
  async function makePassphrase() {
    const words = await loadWordlist();
    return Array.from({ length: 4 }, () => words[randomIndex(words.length)]).join('-');
  }
  // What people type at sign-in: any case, spaces or underscores between the words.
  const normalisePassphrase = s => String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-');

  // Copy text to the clipboard, falling back to selecting it (then long-press → Copy).
  async function copyText(text, el, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    if (!ok && el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { ok = document.execCommand('copy'); } catch (e) {}
    }
    if (btn) {
      btn.textContent = ok ? 'Copied ✓' : 'Long-press to copy';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
  }

  // ── The #auth screen ─────────────────────────────────────────────────────────
  const authError = msg => { document.getElementById('auth-error').textContent = msg || ''; };

  // Switch step. Leaving step 2 forgets the passphrase (a new one is made next time).
  function setAuthMode(mode) {
    authMode = mode;
    const steps = { signin: 'auth-step-signin', signup: 'auth-step-nick', 'signup-save': 'auth-step-save' };
    Object.entries(steps).forEach(([m, id]) => { document.getElementById(id).hidden = m !== mode; });
    const copy = {
      signin:        ['Sign in', 'Accounts let you set problems and track your sends. Browsing and casting work without one.', 'Sign in', 'New here?', 'Create an account'],
      signup:        ['Pick a nickname', 'No email needed. Step 1 of 2.', 'Next', 'Already have an account?', 'Sign in'],
      'signup-save': ['Save your passphrase', 'Step 2 of 2. You’ll need this to sign in.', 'Create account', 'Wrong nickname?', 'Go back'],
    }[mode];
    document.getElementById('auth-title').textContent = copy[0];
    document.getElementById('auth-sub').textContent = copy[1];
    document.getElementById('auth-submit').textContent = copy[2];
    document.getElementById('auth-toggle-text').textContent = copy[3];
    document.getElementById('auth-toggle-link').textContent = copy[4];
    authError('');
    if (mode !== 'signup-save') forgetPassphrase();
    if (mode === 'signup') hideCaptcha(); else showCaptcha();
    updateAuthSubmit();
  }

  function forgetPassphrase() {
    signupPass = '';
    document.getElementById('signup-pass-show').textContent = '';
    document.getElementById('signup-pass-field').value = '';
    document.getElementById('signup-user-field').value = '';
    document.getElementById('signup-saved').checked = false;
  }

  // The toggle link: sign in ↔ sign up; on step 2 it goes back to step 1.
  function authToggle() {
    if (authMode === 'signin') setAuthMode('signup');
    else if (authMode === 'signup') setAuthMode('signin');
    else setAuthMode('signup');
  }

  // The main button needs a passed robot check (sign-in and step 2) and, on step 2,
  // the "I've saved it" box. (A busy button stays disabled until its request ends.)
  function updateAuthSubmit() {
    const btn = document.getElementById('auth-submit');
    if (btn.dataset.busy) return;
    let ready = true;
    if (authMode === 'signin') ready = !!captchaToken;
    if (authMode === 'signup-save') ready = !!captchaToken && !!signupPass && document.getElementById('signup-saved').checked;
    btn.disabled = !ready;
  }
  function setAuthBusy(on) {
    const btn = document.getElementById('auth-submit');
    if (on) { btn.dataset.busy = '1'; btn.disabled = true; }
    else { delete btn.dataset.busy; updateAuthSubmit(); }
  }

  async function authSubmit(e) {
    if (e) e.preventDefault();
    if (document.getElementById('auth-submit').disabled) return;
    if (authMode === 'signin') return signIn();
    if (authMode === 'signup') return signupNext();
    return signupCreate();
  }

  // Sign-up step 1 → 2: the nickname must pass, then a passphrase is made.
  async function signupNext() {
    authError('');
    setAuthBusy(true);
    const code = await getNickChecker('signup', 'signup-nick', 'signup-nick-check').run();
    if (code) {
      setAuthBusy(false);
      if (code === 'empty') authError('Pick a nickname first.');
      return;
    }
    let pass;
    try { pass = await makePassphrase(); }
    catch (err) {
      console.warn('wordlist load failed', err);
      setAuthBusy(false);
      authError('Couldn’t make your passphrase. Check your connection and try again.');
      return;
    }
    setAuthBusy(false);
    signupNick = document.getElementById('signup-nick').value.trim();
    setAuthMode('signup-save');
    signupPass = pass;
    document.getElementById('signup-nick-show').textContent = signupNick;
    document.getElementById('signup-pass-show').textContent = pass;
    document.getElementById('signup-user-field').value = signupNick;
    document.getElementById('signup-pass-field').value = pass;
    updateAuthSubmit();
  }

  // Sign-up step 2: create the account. Nothing exists until this succeeds.
  async function signupCreate() {
    authError('');
    if (!signupNick || !signupPass) { setAuthMode('signup'); return; }
    setAuthBusy(true);
    const { data, error } = await sb.auth.signUp({
      email: placeholderEmail(),
      password: signupPass,
      options: { data: { nickname: signupNick }, captchaToken },
    });
    resetCaptcha();
    if (error) {
      console.warn('sign-up failed', error);
      // Supabase hides the database's reason ("Database error saving new user"),
      // so ask whether the nickname is still free.
      let code = null;
      try { code = await nicknameProblem(signupNick); } catch (e) {}
      setAuthBusy(false);
      if (code) {
        setAuthMode('signup');
        authError(code === 'taken' ? 'That nickname was just taken. Pick another.' : NICK_MSG[code]);
        return;
      }
      authError(authErrorMessage(error));
      return;
    }
    setAuthBusy(false);
    if (!data.session) {   // only if "Confirm email" were on, which it must never be
      authError('Your account was made, but you’re not signed in. Try signing in.');
      return;
    }
    const nick = signupNick;
    signupNick = '';
    forgetPassphrase();
    showToast('Welcome, ' + nick, 'success');
    location.hash = '#list';   // onAuthStateChange loads the profile
  }

  async function signIn() {
    authError('');
    const nick = document.getElementById('signin-nick').value.trim();
    const password = normalisePassphrase(document.getElementById('signin-pass').value);
    if (!nick || !password) { authError('Enter your nickname and passphrase.'); return; }
    setAuthBusy(true);
    const { data: email, error: lookupErr } = await sb.rpc('login_email', { nick });
    if (lookupErr) {
      console.warn('login lookup failed', lookupErr);
      setAuthBusy(false);
      authError('Couldn’t sign in — check your connection.');
      return;
    }
    if (!email) {   // unknown nickname: the same message as a wrong passphrase
      setAuthBusy(false);
      authError(WRONG_LOGIN);
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password, options: { captchaToken } });
    resetCaptcha();
    setAuthBusy(false);
    if (error) { console.warn('sign-in failed', error); authError(authErrorMessage(error)); return; }
    document.getElementById('signin-pass').value = '';
    location.hash = '#list';   // onAuthStateChange loads the profile, ticks and favourites
  }

  const WRONG_LOGIN = 'That nickname and passphrase don’t match.';
  function authErrorMessage(error) {
    const code = error && error.code;
    if (code === 'invalid_credentials') return WRONG_LOGIN;
    if (code === 'captcha_failed') return 'The robot check didn’t work. Wait for it to finish, then try again.';
    if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || (error && error.status === 429)) {
      return 'Too many tries. Wait a few minutes, then try again.';
    }
    if (error && (error.name === 'AuthRetryableFetchError' || error.status === 0)) return 'Couldn’t reach the server — check your connection.';
    return 'Something went wrong. Please try again.';
  }

  function toggleShowPass() {
    const input = document.getElementById('signin-pass');
    const btn = document.getElementById('signin-show');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  }

  // ── Session ──────────────────────────────────────────────────────────────────
  async function initAuth() {
    const { data } = await sb.auth.getSession();
    session = data.session || null;
    // Not ready until the profile has loaded too: admin-only routes judge is_admin
    // from it, and a router() run in between (loadProblems calls it) would bounce
    // an admin, or let a non-admin see an admin screen.
    if (session) await loadProfile();
    authReady = true;
    if (session) { await loadTicks(); await loadFaves(); }
    retryChallengeSaves();   // a challenge attempt kept on the phone from last time (challenge.js)
    updateFaveControls();
    renderProfile();
    if (loaded) renderList();   // refresh tick + fave flags (skip if problems still loading)
    if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
    if (currentView === 'circuits') renderCircuits();
    if (currentView === 'circuit-detail') updateCircuitFaveButton();
    // Re-evaluate the route now auth is known (gates #create for guests). Not on
    // #auth: that would send someone halfway through sign-up back to the start.
    if (currentView !== 'auth') router();

    sb.auth.onAuthStateChange((event, s) => {
      session = s || null;
      // INITIAL_SESSION fires the moment this is registered and repeats what
      // initAuth has just loaded; TOKEN_REFRESHED (hourly) only swaps the token.
      // Neither changes who is signed in, so neither reloads anything.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      // supabase-js runs this callback while holding its auth lock, and a Supabase
      // query awaited in here would wait on that lock, so do the work after it returns.
      setTimeout(() => onAuthChanged(event), 0);
    });
  }

  // A real change of who's signed in (SIGNED_IN, SIGNED_OUT, USER_UPDATED):
  // reload or clear the user's data and re-render.
  async function onAuthChanged() {
    if (session) { await loadProfile(); await loadTicks(); await loadFaves(); }
    else {
      profile = null; myTicks = new Set(); myTicksNormal = new Set(); myTicksMirrored = new Set(); myFaves = new Set(); myCircuitFaves = new Set(); leaderboardLoaded = false;
      adminUsers = []; adminUsersLoaded = false;   // the member list: don't keep it after an admin signs out
    }
    // Challenge boards and history belong to whoever was signed in.
    forgetChallengeData();
    retryChallengeSaves();
    updateFaveControls();
    renderProfile();
    if (loaded) renderList();
    if (currentView === 'detail') { updateTickButton(); updateFaveButton(); }
    if (currentView === 'circuits') renderCircuits();
    if (currentView === 'circuit-detail') { updateCircuitFaveButton(); document.getElementById('circuit-menu-delete').hidden = !canEditCircuit(currentCircuit); }
    if (currentView === 'challenge') renderChallengeBody();
    if (currentView === 'leaderboard') renderLeaderboard();
    // Signed out (or lost admin) while on an admin screen: route away from it.
    if ((currentView === 'outlines' || currentView === 'admin') && !isAdmin()) router();
  }

  // Every account has a profile now: the sign-up trigger (db/30) creates it with
  // the chosen nickname, or the sign-up fails.
  async function loadProfile() {
    if (!session) { profile = null; return; }
    const { data, error } = await sb
      .from('profiles').select('id, username, is_admin, is_public').eq('id', session.user.id).maybeSingle();
    // A load *error* is not the same as "no profile": don't null an existing profile.
    if (error) { console.warn('profile load failed', error); return; }
    profile = data || null;
  }

  // An admin-only write that RLS refused (no error, 0 rows) most likely means this
  // account was demoted since the profile loaded. Re-read the profile so the admin
  // controls disappear, and leave an admin screen if we're on one.
  async function recheckAdmin() {
    await loadProfile();
    updateAdminUI();
    renderProfile();
    if ((currentView === 'outlines' || currentView === 'admin') && !isAdmin()) router();
  }

  // Signs out this device only: 'local' leaves the account's other devices signed
  // in (the default, 'global', revoked every one of them). supabase-js 2.116 drops
  // the local session even when the server call fails (offline), which is what
  // matters here, so judge by whether a session is left, not by the error.
  async function doSignOut() {
    const { error } = await sb.auth.signOut({ scope: 'local' });
    if (error) console.warn('sign-out request failed', error);
    const { data } = await sb.auth.getSession();
    if (data.session) { showToast('Couldn’t sign out — check connection', 'error'); return; }
    showToast('Signed out', 'success');
    location.hash = '#list';
  }

  // ── Change nickname (Profile) ────────────────────────────────────────────────
  const nameChecker = () => getNickChecker('name', 'name-input', 'name-check',
    { same: n => !!(profile && n.toLowerCase() === String(profile.username).toLowerCase()) });

  function openNameModal() {
    if (!profile) return;
    document.getElementById('name-input').value = profile.username || '';
    document.getElementById('name-error').textContent = '';
    nameChecker().clear();
    document.getElementById('name-modal').classList.add('show');
    setTimeout(() => document.getElementById('name-input').focus(), 50);
  }
  function closeNameModal() { document.getElementById('name-modal').classList.remove('show'); }

  async function saveDisplayName() {
    const errEl = document.getElementById('name-error');
    errEl.textContent = '';
    if (!session || !profile) { errEl.textContent = 'Session expired — please sign in again.'; return; }
    const name = document.getElementById('name-input').value.trim();
    if (name === profile.username) { closeNameModal(); return; }
    const btn = document.getElementById('name-save'); btn.disabled = true;
    const code = await nameChecker().run();
    if (code) {
      btn.disabled = false;
      if (code === 'empty') errEl.textContent = 'Pick a nickname.';
      return;
    }
    // .select(): an update RLS refuses "succeeds" with 0 rows.
    const { data, error } = await sb.from('profiles').update({ username: name }).eq('id', session.user.id).select('id');
    btn.disabled = false;
    if (error || !data || !data.length) {
      if (error) console.warn('nickname save failed', error);
      errEl.textContent = error ? nickSaveError(error) : 'Couldn’t save — please sign in again.';
      return;
    }
    closeNameModal();
    await loadProfile();
    if (profileNames[session.user.id]) profileNames[session.user.id] = name;   // reflect the rename on this user's problems
    leaderboardLoaded = false;
    renderProfile();
    renderList();
    if (currentView === 'detail') router();
    showToast('Nickname changed', 'success');
  }

  // ── The Ranks switch (Profile) ───────────────────────────────────────────────
  // Off by default (db/30 profiles.is_public). Covers Ranks only: setter names are
  // always shown (plan.md D1).
  async function toggleRanks() {
    if (!session || !profile) return;
    const want = !profile.is_public;
    const btn = document.getElementById('profile-ranks');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.toggle('on', want);   // optimistic
    btn.setAttribute('aria-pressed', want ? 'true' : 'false');
    const { data, error } = await sb.from('profiles').update({ is_public: want }).eq('id', session.user.id).select('id');
    btn.disabled = false;
    if (error || !data || !data.length) {
      if (error) console.warn('ranks switch failed', error);
      btn.classList.toggle('on', !want);
      btn.setAttribute('aria-pressed', !want ? 'true' : 'false');
      showToast('Couldn’t save — check connection', 'error');
      return;
    }
    profile.is_public = want;
    leaderboardLoaded = false;
    forgetChallengeData();   // the challenge boards list opted-in climbers too
    showToast(want ? 'You’re on Ranks' : 'You’re hidden from Ranks', 'success');
  }

  // ── Delete my account (Profile) ──────────────────────────────────────────────
  // Server-side (db/30 delete_my_account): the account, ticks, favourites and
  // points go; problems and circuits stay with the nickname (plan.md D2). The
  // only admin left is refused (D7).
  function openAccountDelete() {
    document.getElementById('account-delete-error').textContent = '';
    document.getElementById('account-delete-modal').classList.add('show');
  }
  function closeAccountDelete() { document.getElementById('account-delete-modal').classList.remove('show'); }

  async function doDeleteAccount() {
    const errEl = document.getElementById('account-delete-error');
    const btn = document.getElementById('account-delete-confirm');
    errEl.textContent = '';
    btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Deleting…';
    const { error } = await sb.rpc('delete_my_account');
    btn.disabled = false; btn.textContent = prev;
    if (error) {
      console.warn('delete_my_account failed', error);
      errEl.textContent = error.message === 'last_admin'
        ? 'You’re the only admin. Make someone else an admin first.'
        : 'Couldn’t delete your account — check your connection.';
      return;
    }
    closeAccountDelete();
    // The account and its sessions are gone on the server; clear this device too.
    // (The server call may fail now that the session doesn't exist; the local
    // session is dropped either way.)
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    leaderboardLoaded = false;
    await loadProfileNames();   // their routes now show the kept nickname
    if (loaded) renderList();
    showToast('Your account has been deleted', 'success');
    location.hash = '#list';
  }

  // Personal stats from the user's ticks (private to them).
  function tickStats() {
    const total = myTicks.size;
    let hardest = null;
    allProblems.forEach(p => {
      if (!isTicked(p.id) || gradeRank(p.grade) === 999) return;   // skip un-ticked / ungraded
      if (!hardest || gradeRank(p.grade) > gradeRank(hardest.grade)) hardest = p;
    });
    return { total, hardest };
  }

  function renderProfile() {
    const el = document.getElementById('profile-content');
    if (!el) return;
    const userSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    if (session && profile) {
      const editSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
      const { total, hardest } = tickStats();
      const hardestHtml = hardest
        ? `<span class="grade-badge">${escHtml(fontGrade(hardest.grade))}</span> <span class="hardest-name">${escHtml(displayName(hardest))}</span>`
        : '—';
      const onRanks = !!profile.is_public;
      el.innerHTML = `
        <div class="shell-card profile-card">
          <div class="shell-icon">${userSvg}</div>
          <div class="profile-name-row">
            <div class="shell-title" style="margin-bottom:0">${escHtml(profile.username)}</div>
            <button class="icon-btn profile-edit" id="profile-edit-name" aria-label="Change nickname">${editSvg}</button>
          </div>
          <div class="shell-sub" style="margin:6px 0 16px">If you set a problem, your nickname is shown on it.</div>
          <button class="btn-block btn-ghost" id="profile-signout">Sign out</button>
        </div>
        <div class="cc-option-row">
          <span class="cc-option-label">Show me on Ranks<br><small>Off: only you can see your points and challenge scores.</small></span>
          <button class="cc-toggle${onRanks ? ' on' : ''}" id="profile-ranks" type="button" aria-pressed="${onRanks}" aria-label="Show me on Ranks"><span class="cc-toggle-knob"></span></button>
        </div>
        <div class="profile-row"><span class="k">Total points</span><span class="v" id="profile-points">${leaderboardLoaded ? userPoints() : '…'}</span></div>
        <div class="profile-row"><span class="k">Total ticks</span><span class="v">${total}</span></div>
        <div class="profile-row"><span class="k">Hardest send</span><span class="v">${hardestHtml}</span></div>
        ${profile.is_admin ? `<a class="btn-block btn-ghost profile-admin" href="#admin">Admin tools</a>` : ''}
        <button class="btn-block btn-ghost profile-delete" id="profile-delete">Delete my account and all my data</button>`;
      document.getElementById('profile-signout').addEventListener('click', doSignOut);
      document.getElementById('profile-edit-name').addEventListener('click', openNameModal);
      document.getElementById('profile-ranks').addEventListener('click', toggleRanks);
      document.getElementById('profile-delete').addEventListener('click', openAccountDelete);
      // Total points comes from the leaderboard RPC (single source of truth); fill async.
      loadLeaderboard().then(() => {
        const pe = document.getElementById('profile-points');
        if (pe) pe.textContent = leaderboardError ? '—' : userPoints();
      });
    } else if (session) {
      // Signed in, but the profile didn't load (offline, or an account with none).
      el.innerHTML = `
        <div class="shell-card profile-card">
          <div class="shell-icon">${userSvg}</div>
          <div class="shell-title">Couldn’t load your profile</div>
          <div class="shell-sub">Check your connection and try again.</div>
          <button class="btn-block btn-ghost" id="profile-signout">Sign out</button>
        </div>`;
      document.getElementById('profile-signout').addEventListener('click', doSignOut);
    } else {
      el.innerHTML = `
        <div class="shell-card profile-card">
          <div class="shell-icon">${userSvg}</div>
          <div class="shell-title">Browsing as guest</div>
          <div class="shell-sub">Sign in to set problems and track your sends. No email needed: just a nickname.</div>
          <button class="btn-block btn-primary" id="profile-signin">Sign in</button>
        </div>`;
      document.getElementById('profile-signin').addEventListener('click', () => { location.hash = '#auth'; });
    }
  }

