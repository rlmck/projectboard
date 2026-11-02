// admin-reset-passphrase: an admin gives an account a new PIN or passphrase.
//
// POST { target: "<account id>" }
//   ->  200 { passphrase: "1234", kind: "pin", signedOut }                  an account made with a PIN
//   ->  200 { passphrase: "word-word-word-word", kind: "passphrase", signedOut }   an older account
// (The field keeps the name `passphrase` for both, so an app that hasn't updated
// yet still shows what was set.)
//
// The only place the service-role key is used, and it never leaves Supabase:
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase at runtime.
// Nothing secret lives in this file. Deploy (manual step 6):
//   npx supabase functions deploy admin-reset-passphrase --project-ref uqirowyfqwiceyjznosl
// and keep "Verify JWT" on, so the gateway rejects calls without a valid session.
//
// What it does:
//   1. answers CORS for the app's origins only;
//   2. reads the caller from their own access token, and refuses anyone who isn't
//      an admin (403), their own account (400) and unknown accounts (404);
//   3. reads the account's user_metadata: pin: true (set by the app at sign-up
//      since 2 Nov 2026) means a PIN account, which gets a new 4-digit PIN, padded
//      exactly as the app pads it (pinPassword(), keep in sync with app/account.js);
//      anything else is an older passphrase account, which gets four words from
//      the EFF large wordlist with crypto.getRandomValues (rejection sampling, so
//      no modulo bias: about 51.7 bits), as before. Nothing about the account is
//      changed except its password;
//   4. sets it as the account's password;
//   5. signs the account out on every device (admin_revoke_sessions, plan D5);
//   6. logs 'reset_passphrase' in admin_actions (ids only; the same for PINs);
//   7. returns it once. It's never logged or stored in plain text.
//
// See plan.md §3 and db/30 items 11 and 17.

import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { WORDS } from './eff_large_wordlist.ts';

const ALLOWED_ORIGINS = new Set([
  'https://symmetryboard.co.uk',
  'https://dev-projectboard.rosslewismckechnie.workers.dev',
  'http://localhost:8000',   // the local copy test (plan.md §6)
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function reply(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// A uniform index in [0, n): draw 32 random bits, and redraw the few values above
// the largest multiple of n so every index is equally likely.
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

function makePassphrase(): string {
  if (WORDS.length !== 7776) throw new Error('wordlist has the wrong length');
  return Array.from({ length: 4 }, () => WORDS[randomIndex(WORDS.length)]).join('-');
}

// A PIN: 4 digits, every one of the 10,000 equally likely.
function makePin(): string {
  return String(randomIndex(10000)).padStart(4, '0');
}
// What Supabase stores for a PIN: the project's minimum password length is 15, so
// the 4 digits are padded into a fixed, public longer form. KEEP IN SYNC with
// pinPassword() in app/account.js.
const pinPassword = (pin: string) => 'symmetryboard-pin-' + pin;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405, origin);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return reply({ error: 'Sign in first.' }, 401, origin);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return reply({ error: 'The function isn’t configured.' }, 500, origin);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Who's calling? (From their own token, checked by Supabase Auth.)
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return reply({ error: 'Your session has expired. Sign in again.' }, 401, origin);
  const callerId = who.user.id;

  const { data: me, error: meErr } = await admin.from('profiles').select('is_admin').eq('id', callerId).maybeSingle();
  if (meErr) return reply({ error: 'Couldn’t check your admin role.' }, 500, origin);
  if (!me?.is_admin) return reply({ error: 'Only admins can give a new PIN or passphrase.' }, 403, origin);

  let body: { target?: unknown } | null = null;
  try { body = await req.json(); } catch { body = null; }
  const target = typeof body?.target === 'string' ? body.target : '';
  if (!UUID_RE.test(target)) return reply({ error: 'No account given.' }, 400, origin);
  if (target.toLowerCase() === callerId.toLowerCase()) {
    return reply({ error: 'You can’t reset your own PIN here. Ask another admin.' }, 400, origin);
  }

  const { data: found, error: findErr } = await admin.from('profiles').select('id').eq('id', target).maybeSingle();
  if (findErr) return reply({ error: 'Couldn’t look up that account.' }, 500, origin);
  if (!found) return reply({ error: 'That account doesn’t exist any more.' }, 404, origin);

  // PIN or passphrase? (Read only: nothing here changes the account.)
  const { data: authUser, error: userErr } = await admin.auth.admin.getUserById(target);
  if (userErr || !authUser?.user) {
    console.error('reset: getUserById failed', userErr?.status, userErr?.code);
    return reply({ error: 'Couldn’t look up that account. Nothing was changed.' }, 500, origin);
  }
  const kind = authUser.user.user_metadata?.pin === true ? 'pin' : 'passphrase';

  const passphrase = kind === 'pin' ? makePin() : makePassphrase();
  const password = kind === 'pin' ? pinPassword(passphrase) : passphrase;
  const { error: setErr } = await admin.auth.admin.updateUserById(target, { password });
  if (setErr) {
    console.error('reset: updateUserById failed', setErr.status, setErr.code);
    return reply({ error: kind === 'pin' ? 'Couldn’t set the new PIN. Nothing was changed.' : 'Couldn’t set the new passphrase. Nothing was changed.' }, 500, origin);
  }

  // The password has changed now, so from here on it must be returned whatever
  // else fails, or nobody would know it.
  let signedOut = true;
  const { error: revokeErr } = await admin.rpc('admin_revoke_sessions', { target });
  if (revokeErr) { signedOut = false; console.error('reset: admin_revoke_sessions failed', revokeErr.code); }

  const { error: logErr } = await admin.from('admin_actions')
    .insert({ admin_id: callerId, target_id: target, action: 'reset_passphrase' });
  if (logErr) console.error('reset: admin_actions insert failed', logErr.code);

  return reply({ passphrase, kind, signedOut }, 200, origin);
});
