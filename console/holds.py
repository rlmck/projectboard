"""Holds: outlines, footholds and mirror pairs, edited on the laptop (PB Console's Holds tab).

The phone's Edit holds (app/holdedit.js) and this tab send the same thing: a list of edits
(set an outline, add or delete a foothold, pair footholds, a foothold's FTn name) to
admin_edit_holds() (db/48, super admin only), which lays them over the holds as they are,
under the board row's lock, checks them (the one copy of the rules: 3-400 points, foot <->
foot pairs that point back, never hand <-> foot, no foothold a problem uses deleted, every
hand hold keeps an outline, a new foothold's number above every one ever used) and publishes
through the same internals as admin_publish_board (a board_versions row, one version bump,
Undo works). Board Setup's new photo keeps the whole-board admin_publish_board.

- reads are public (the anon key, as the app): the holds table, board_config's image,
  corners, version and outline smoothing, and which footholds a problem's Specific feet
  uses; the board image itself comes from the public `board` bucket;
- the page builds the edit list (bsEditOps() in app/setup.js, shared with the phone); here
  it's only checked for shape (check_ops), never validated: the database does that;
- preview() and publish() run over direct Postgres (db/.env, the Data phase's path,
  castlog.py's connection), in one transaction, as the super admin (the request's JWT
  claims set to that profile, role authenticated: what PostgREST does for a signed-in
  phone), naming the version the page loaded (the server refuses any other: 'stale').
  preview() runs the very same call and rolls it back, so the change list the confirm shows
  is the server's own; publish() commits it. Only once it has committed are the old rows
  written to console/data/undo/ (review CON-07: a refused or rolled-back publish leaves no
  record). undo_last() is the app's Undo the last publish (admin_undo_board), and records the
  rows it replaced the same way. A closed tab stops a publish only before the RPC (CON-03).

No board image is ever written here: Storage needs a signed-in session, which the console
doesn't have (Turnstile guards sign-in). A turn (which re-draws the hold's pixels) and a
new photo or cartoon stay in the app (Ross, 15 Nov 2026).
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
UNDO = os.path.join(HERE, 'data', 'undo')
WALL = 'HangoutPortland'
SNAPSHOT_FILES = ['app/board-fallback.jpg', 'app/hold_map.json', 'app/mirror_map.json', 'app/hold_shapes.json',
                  'app/foot_holds.json']

OUTLINE_MAX = 400                          # holds_outline_ok() (db/42): shown on the page only
FOOT_MAX = 300
EDIT_OPS = ('outline', 'position', 'add_foot', 'delete_foot', 'pair', 'name', 'smooth')   # admin_edit_holds (db/48; smooth db/49), never 'image'/'turn' here
EDITS_MAX = 2000
IMAGE_PATH = re.compile(r'^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$')
UA = 'pb-console (laptop)'


class Refused(ValueError):
    pass


# -- reads (public, the anon key) ---------------------------------------------------

def _settings(env=None):
    from checks import supabase_settings
    return supabase_settings(env)


def _rest(query, env=None):
    url, key = _settings(env)
    req = urllib.request.Request('%s/rest/v1/%s' % (url, query),
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _num(v):
    return None if v is None else float(v)


def _row(h):
    return {'id': h['id'], 'name': h.get('name'), 'kind': h.get('kind'), 'led': h.get('led'),
            'x': _num(h.get('x')), 'y': _num(h.get('y')), 'outline': h.get('outline'), 'mirror': h.get('mirror')}


def feet_in_use(env=None):
    """{foothold id: how many problems' Specific feet use it}."""
    used = {}
    for p in _rest('problems?select=feet_holds&feet_holds=not.is.null', env):
        for f in p.get('feet_holds') or []:
            used[f] = used.get(f, 0) + 1
    return used


def snapshot_version():
    """The board version the app's bundled snapshot was taken from (app/hold_map.json __meta)."""
    try:
        with open(os.path.join(REPO, 'app', 'hold_map.json'), encoding='utf-8') as f:
            return ((json.load(f).get('__meta') or {}).get('board_updated_at')) or None
    except (OSError, ValueError):
        return None


def same_version(a, b):
    """Two board versions (timestamps as text) the same instant? '…089+00:00' == '…089Z'."""
    def t(v):
        try:
            return datetime.datetime.fromisoformat(str(v).replace('Z', '+00:00'))
        except ValueError:
            return None
    ta, tb = t(a), t(b)
    return ta is not None and ta == tb


def board(env=None):
    """Everything the Holds tab draws: the board row, every hold, the feet in use, and whether
    the bundled snapshot and the database path are there."""
    bc = _rest('board_config?select=image_path,photo_path,corners,updated_at,foot_id_max,hold_shapes->__meta'
               '&wall=eq.%s' % WALL, env)
    if not bc:
        raise RuntimeError('no board_config row for %s' % WALL)
    bc = bc[0]
    rows = [_row(h) for h in _rest('holds?select=id,name,kind,led,x,y,outline,mirror&wall=eq.%s&order=id' % WALL, env)]
    meta = bc.get('__meta') or {}
    snap = snapshot_version()
    import castlog
    return {
        'board': {'version': bc.get('updated_at'), 'image_path': bc.get('image_path'),
                  'photo_path': bc.get('photo_path'), 'corners': bc.get('corners'),
                  'foot_id_max': int(bc.get('foot_id_max') or 0),
                  'smooth': meta.get('smooth') if isinstance(meta.get('smooth'), (int, float)) else 0.7},
        'holds': [h for h in rows if h['kind'] in ('hand', 'foot')],
        'feet_used': feet_in_use(env),
        'snapshot': {'version': snap, 'behind': not same_version(snap, bc.get('updated_at'))},
        'can_publish': bool(castlog._db_url()),
        'limits': {'points': OUTLINE_MAX, 'feet': FOOT_MAX},
    }


_IMAGE = {}


def image(path, env=None):
    """The board image's bytes from the public bucket (kept in memory per path: a new image
    always has a new path)."""
    if not isinstance(path, str) or not IMAGE_PATH.match(path) or '..' in path:
        raise ValueError('path: a board image path')
    if path not in _IMAGE:
        url, _ = _settings(env)
        req = urllib.request.Request('%s/storage/v1/object/public/board/%s' % (url, urllib.parse.quote(path)),
                                     headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        _IMAGE.clear()
        _IMAGE[path] = data
    return _IMAGE[path]


# -- the edits (pure: no network) ---------------------------------------------------

def check_ops(ops):
    """The page's edit list, checked for shape only (the database validates it: db/48)."""
    if not isinstance(ops, list) or not ops:
        raise Refused('edits: a list of edits (nothing to publish)')
    if len(ops) > EDITS_MAX:
        raise Refused('edits: far too many')
    for o in ops:
        if not isinstance(o, dict) or o.get('op') not in EDIT_OPS:
            raise Refused('edits: %r isn\'t an edit the console sends' % (o.get('op') if isinstance(o, dict) else o,))
        if o['op'] == 'smooth':                # the board-wide outline smoothing (db/49): no hold
            v = o.get('value')
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
                raise Refused('edits: the smoothing is a number from 0 to 1')
            continue
        if not isinstance(o.get('id'), str) or not 1 <= len(o['id']) <= 20:
            raise Refused('edits: every edit names its hold')
    return ops


# -- writes (direct Postgres, as the super admin) -----------------------------------

def _conn():
    import castlog
    url = castlog._db_url()
    if not url:
        raise Refused('no db/.env on this laptop: the console can\'t publish')
    return castlog._connect(url)


def _as_super_admin(conn):
    """The request's JWT claims set to the super admin's profile and the role to authenticated,
    for this transaction only: auth.uid() and is_super_admin() then answer as for his phone."""
    rows = conn.run('select id::text from public.profiles where is_super_admin')
    if len(rows) != 1:
        raise Refused('expected exactly one super admin, found %d' % len(rows))
    conn.run("select set_config('request.jwt.claims', :c, true)",
             c=json.dumps({'sub': rows[0][0], 'role': 'authenticated'}))
    conn.run('set local role authenticated')


def _undo_file(kind, data):
    os.makedirs(UNDO, exist_ok=True)
    path = os.path.join(UNDO, '%s-%s.json' % (datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), kind))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1, default=str)
    return path


def _refusal(e):
    """A database refusal (pg8000's error: a dict with M, D, C) -> Refused in words, or None."""
    info = e.args[0] if getattr(e, 'args', None) and isinstance(e.args[0], dict) else None
    if not info:
        return None
    msg, detail = info.get('M') or '', info.get('D') or ''
    if msg == 'stale':
        return Refused('the board changed since this page loaded it (a publish from the phone?): '
                       'Reload, check your draft, and publish again')
    if msg == 'no_change':
        return Refused('nothing to publish (the draft matches the live board)')
    return Refused(detail or msg or 'the database refused it')


def _edit(ops, version, out, commit):
    """admin_edit_holds() as the super admin in one transaction, committed or rolled back.
    -> (result {version, changes}, the rows it replaces)."""
    check_ops(ops)
    conn = _conn()
    try:
        conn.run('begin')
        rows = [dict(zip(('id', 'name', 'kind', 'led', 'x', 'y', 'outline', 'mirror'), r)) for r in conn.run(
            'select id, name, kind, led, x, y, outline, mirror from public.holds where wall = :w', w=WALL)]
        for r in rows:
            r['x'], r['y'] = _num(r['x']), _num(r['y'])
        if commit:
            import procs
            procs.check_cancelled(out)      # the last point to stop: inside the transaction, rolled back
        _as_super_admin(conn)
        try:
            res = conn.run('select public.admin_edit_holds(:w, cast(:v as timestamptz), cast(:e as jsonb))',
                           w=WALL, v=str(version), e=json.dumps(ops))
        except Exception as e:          # noqa: BLE001
            r = _refusal(e)
            if r:
                raise r from None
            raise
        result = res[0][0]
        if isinstance(result, str):
            result = json.loads(result)
        conn.run('reset role')
        conn.run('commit' if commit else 'rollback')
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    finally:
        conn.close()
    return result, rows


def preview(ops, version):
    """The change list the server would publish (the same call, rolled back)."""
    result, _ = _edit(ops, version, print, commit=False)
    return list(result.get('changes') or [])


def publish(ops, version, out=print):
    """One transaction: admin_edit_holds() as the super admin, naming the page's version,
    committed; then the old rows to console/data/undo/. Returns the new board version."""
    out('publishing %d edit(s) through admin_edit_holds(), as the super admin, over direct Postgres (db/.env)'
        % len(check_ops(ops)))
    result, rows = _edit(ops, version, out, commit=True)
    lines = result.get('changes') or []
    out('%d change(s):' % len(lines))
    for line in lines:
        out('  ' + line)
    out('published: board version %s' % result.get('version'))
    _record_undo(out, 'holds', {'table': 'holds', 'wall': WALL, 'board_version': str(version),
                                'published_version': str(result.get('version')), 'old': rows})
    return result.get('version')


def _record_undo(out, kind, data):
    """After a commit: the rows it replaced, in console/data/undo/. A failure here is reported,
    never raised: the database change has already happened."""
    try:
        path = _undo_file(kind, data)
        out('old rows: %s' % os.path.relpath(path, REPO))
    except OSError as e:
        out('! the change is made, but its undo record could not be written: %s' % e)


def undo_last(out=print):
    """The app's Undo the last publish: admin_undo_board() as the super admin. Once it has
    committed, the rows it replaced go to console/data/undo/ (as a publish's do)."""
    import procs
    conn = _conn()
    try:
        conn.run('begin')
        n = conn.run('select count(*) from public.board_versions where wall = :w', w=WALL)[0][0]
        if not n:
            raise Refused('there is no earlier board version to go back to')
        before = conn.run('select updated_at from public.board_config where wall = :w for update', w=WALL)
        rows = [dict(zip(('id', 'name', 'kind', 'led', 'x', 'y', 'outline', 'mirror'), r)) for r in conn.run(
            'select id, name, kind, led, x, y, outline, mirror from public.holds where wall = :w', w=WALL)]
        procs.check_cancelled(out)          # the last point to stop: rolled back
        _as_super_admin(conn)
        conn.run('select public.admin_undo_board(:w)', w=WALL)
        conn.run('reset role')
        ver = conn.run('select updated_at from public.board_config where wall = :w', w=WALL)[0][0]
        conn.run('commit')
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    finally:
        conn.close()
    out('undone: the board is back to version %s' % ver)
    _record_undo(out, 'undo', {'table': 'holds', 'wall': WALL, 'board_version': str(before[0][0]) if before else None,
                               'undone_to_version': str(ver), 'old': rows})
    return ver


# -- the bundled snapshot -------------------------------------------------------------

def run_tool(argv, out):
    """A repo tool (python), its output streamed to out. -> exit code."""
    import procs
    p = subprocess.run([sys.executable] + argv, cwd=REPO, capture_output=True, timeout=300,
                       creationflags=procs.NO_WINDOW)
    out((p.stdout + p.stderr).decode('utf-8', 'replace').rstrip())
    return p.returncode
