"""Members' casts from the private cast log (db/34), for the Activity tab.

The public cast broadcast never says who cast (the channel is public); the app
records a signed-in member's cast in public.cast_log instead, which nobody can
read through the API. The console reads it here over direct Postgres with
db/.env's SUPABASE_DB_URL (the same path db/apply.py uses), read-only, and never
prints or returns the URL. With no db/.env, or no connection, Activity just has
no names.
"""
import os
import ssl

from procs import REPO

ENV = os.path.join(REPO, 'db', '.env')


def _db_url():
    try:
        with open(ENV, encoding='utf-8') as f:
            for line in f:
                if line.startswith('SUPABASE_DB_URL='):
                    v = line.split('=', 1)[1].strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                        v = v[1:-1]
                    return v or None
    except OSError:
        return None
    return None


def _connect(url):
    import pg8000.native
    rest = url.split('://', 1)[1]
    creds, hostpart = rest.rsplit('@', 1)
    user, password = creds.split(':', 1)
    hostport, _, database = hostpart.partition('/')
    host, _, port = hostport.partition(':')
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    last = None
    for _ in range(3):                      # the pooler sometimes refuses a good password once (28P01)
        try:
            return pg8000.native.Connection(user=user, password=password, host=host, port=int(port or 5432),
                                            database=database.split('?', 1)[0] or 'postgres', ssl_context=ctx,
                                            timeout=15)
        except Exception as e:              # noqa: BLE001
            last = e
    raise RuntimeError('no database connection (%s)' % type(last).__name__)


def members(days):
    """({'rows': [{at, kind, name, mirror, source, run, nickname}], 'error': None}): the last `days`
    days of the cast log, oldest first, with each member's current nickname. Never raises:
    a failure comes back as 'error' (a short reason, never the URL)."""
    url = _db_url()
    if not url:
        return {'rows': [], 'error': 'no db/.env on this laptop'}
    try:
        conn = _connect(url)
        try:
            conn.run('set session characteristics as transaction read only')
            rows = conn.run(
                "select c.created_at, c.kind, c.name, c.mirror, c.source, c.run, p.username "
                "from public.cast_log c left join public.profiles p on p.id = c.user_id "
                "where c.created_at > now() - make_interval(days => :days) order by c.created_at",
                days=int(days))
        finally:
            conn.close()
    except Exception as e:                  # noqa: BLE001
        msg = str(getattr(e, 'args', [''])[0] if getattr(e, 'args', None) else e)
        if isinstance(e, RuntimeError):
            reason = msg
        elif 'cast_log' in msg and 'does not exist' in msg:
            reason = 'the cast log table is missing (db/34)'
        else:
            reason = type(e).__name__
        return {'rows': [], 'error': reason}
    return {'rows': [{'at': r[0].isoformat(), 'kind': r[1], 'name': r[2], 'mirror': bool(r[3]), 'source': r[4],
                      'run': r[5], 'nickname': r[6] or '(account deleted)'} for r in rows], 'error': None}


def _reason(e):
    msg = str(getattr(e, 'args', [''])[0] if getattr(e, 'args', None) else e)
    if isinstance(e, RuntimeError):
        return msg
    if 'cast_log' in msg and 'does not exist' in msg:
        return 'the cast log table is missing (db/34)'
    return type(e).__name__


def history():
    """Everything the Activity dashboard needs from the database, in one read-only connection:
    {'rows': the whole cast log (as members()), 'ticks': [{at, nickname, name, grade, mirrored}],
    'accounts': [{nickname, at}], 'error': None}. Never raises: a failure comes back as 'error'
    with empty lists. Mirrored ticks are their own rows (ticks are unique per user, problem and
    mirrored), so each is a tick."""
    empty = {'rows': [], 'ticks': [], 'accounts': [], 'error': None}
    url = _db_url()
    if not url:
        return dict(empty, error='no db/.env on this laptop')
    try:
        conn = _connect(url)
        try:
            conn.run('set session characteristics as transaction read only')
            casts = conn.run(
                "select c.created_at, c.kind, c.name, c.mirror, c.source, c.run, p.username "
                "from public.cast_log c left join public.profiles p on p.id = c.user_id order by c.created_at")
            ticks = conn.run(
                "select t.ticked_at, p.username, pr.name, pr.grade, t.mirrored from public.ticks t "
                "join public.problems pr on pr.id = t.problem_id left join public.profiles p on p.id = t.user_id "
                "where t.ticked_at is not null order by t.ticked_at")
            accounts = conn.run("select username, created_at from public.profiles where created_at is not null "
                                "order by created_at")
        finally:
            conn.close()
    except Exception as e:                  # noqa: BLE001
        return dict(empty, error=_reason(e))
    return {'rows': [{'at': r[0].isoformat(), 'kind': r[1], 'name': r[2], 'mirror': bool(r[3]), 'source': r[4],
                      'run': r[5], 'nickname': r[6] or '(account deleted)'} for r in casts],
            'ticks': [{'at': r[0].isoformat(), 'nickname': r[1] or '(account deleted)', 'name': r[2], 'grade': r[3],
                       'mirrored': bool(r[4])} for r in ticks],
            'accounts': [{'nickname': r[0], 'at': r[1].isoformat()} for r in accounts],
            'error': None}
