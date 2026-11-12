"""Holds: outlines, footholds and mirror pairs, edited on the laptop (PB Console's Holds tab).

The phone's Edit holds (app/holdedit.js) and Board Setup (app/setup.js) publish a whole
board through admin_publish_board() (db/42, super admin only since db/44). This is the
console's side of the same thing:

- reads are public (the anon key, as the app): the holds table, board_config's image,
  corners, version and outline smoothing, and which footholds a problem's Specific feet
  uses; the board image itself comes from the public `board` bucket;
- the page sends only its edits (outlines by hold id, new footholds, deleted footholds,
  foothold pairs, the footholds' FTn names); apply_edits() lays them over the live rows
  and builds exactly the payload hePayload() builds in the app;
- publish() runs over direct Postgres (db/.env, the Data phase's path, as tracks.py),
  in one transaction: the board row is locked and the write refused if the board
  version moved since the page loaded it; the payload is rebuilt from the rows as they
  are then; the old rows go to console/data/undo/; then, as the super admin (the
  request's JWT claims set to that profile, role authenticated: what PostgREST does for
  a signed-in phone), the very same admin_publish_board() call, naming the version it
  was built on (db/45: the server refuses any other). Its checks (every hand hold once,
  outlines 3-400 points, foot <-> foot pairs that point back, no foothold a problem
  uses dropped, a new foothold's number above every one ever used (foot_id_max),
  is_super_admin()) all apply unchanged. The board's corners are sent as null (kept as
  they are). undo_last() is the app's Undo the last publish (admin_undo_board).

No board image is ever written here: Storage needs a signed-in session, which the console
doesn't have (Turnstile guards sign-in). A turn (which re-draws the hold's pixels) and a
new photo or cartoon stay in the app's Board Setup.
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
SNAPSHOT_FILES = ['app/board-fallback.jpg', 'app/hold_map.json', 'app/mirror_map.json', 'app/hold_shapes.json']

OUTLINE_MIN, OUTLINE_MAX = 3, 400          # holds_outline_ok() (db/42)
FOOT_MAX = 300
HOLD_ID = re.compile(r'^hold\d{1,3}$')
FOOT_ID = re.compile(r'^foot\d{1,4}$')
FOOT_NAME = re.compile(r'^FT\d{1,3}$')
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

def _pts(v, what):
    if not isinstance(v, list) or not OUTLINE_MIN <= len(v) <= OUTLINE_MAX:
        raise Refused('%s: an outline needs %d-%d points' % (what, OUTLINE_MIN, OUTLINE_MAX))
    out = []
    for p in v:
        if (not isinstance(p, list) or len(p) != 2 or not all(isinstance(c, (int, float)) and not isinstance(c, bool)
                                                              for c in p)):
            raise Refused('%s: every point is [x, y]' % what)
        out.append([round(min(105.0, max(-5.0, float(p[0]))), 2), round(min(105.0, max(-5.0, float(p[1]))), 2)])
    return out


def check_edits(e):
    """The page's edits, checked for shape (never trusted): -> a clean copy, or Refused."""
    if not isinstance(e, dict):
        raise Refused('edits: an object')
    outlines, added, removed, pairs, names = (e.get('outlines') or {}, e.get('added') or [], e.get('removed') or [],
                                              e.get('pairs') or {}, e.get('names') or {})
    if not (isinstance(outlines, dict) and isinstance(added, list) and isinstance(removed, list)
            and isinstance(pairs, dict) and isinstance(names, dict)):
        raise Refused('edits: outlines {}, added [], removed [], pairs {}, names {}')
    if len(outlines) > 400 or len(added) > 100 or len(removed) > FOOT_MAX or len(pairs) > 2 * FOOT_MAX \
            or len(names) > FOOT_MAX + 100:
        raise Refused('edits: far too many')
    out = {'outlines': {}, 'added': [], 'removed': [], 'pairs': {}, 'names': {}}
    for k, v in outlines.items():
        if not (HOLD_ID.match(k) or FOOT_ID.match(k)):
            raise Refused('outlines: %r is not a hold id' % k)
        out['outlines'][k] = _pts(v, k)
    for a in added:
        if not isinstance(a, dict) or not isinstance(a.get('id'), str) or not FOOT_ID.match(a['id']):
            raise Refused('added: each new foothold is {id: footN, pts}')
        if any(x['id'] == a['id'] for x in out['added']):
            raise Refused('added: %s twice' % a['id'])
        out['added'].append({'id': a['id'], 'pts': _pts(a.get('pts'), a['id'])})
    for r in removed:
        if not isinstance(r, str) or not FOOT_ID.match(r):
            raise Refused('removed: only footholds (footN) can be deleted')
        if r not in out['removed']:
            out['removed'].append(r)
    for k, v in pairs.items():
        if not FOOT_ID.match(k) or not (v is None or (isinstance(v, str) and FOOT_ID.match(v))):
            raise Refused('pairs: foothold -> foothold or null (never a hand hold)')
        out['pairs'][k] = v
    for k, v in names.items():
        if not FOOT_ID.match(k) or not isinstance(v, str) or not FOOT_NAME.match(v):
            raise Refused('names: foothold -> FTn')
        out['names'][k] = v
    return out


def centre(pts):
    """tracePolyCentre (app/trace.js): the area centroid, or the mean for a flat polygon."""
    a = cx = cy = 0.0
    n = len(pts)
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        c = p[0] * q[1] - q[0] * p[1]
        a += c
        cx += (p[0] + q[0]) * c
        cy += (p[1] + q[1]) * c
    if abs(a) < 1e-9:
        return [sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n]
    return [cx / (3 * a), cy / (3 * a)]


def _xy(pts):
    c = centre(pts)
    return round(min(100.0, max(0.0, c[0])), 2), round(min(100.0, max(0.0, c[1])), 2)


def apply_edits(rows, edits, used=None):
    """Lay the edits over the live rows. -> (payload for admin_publish_board, change lines).
    rows: the holds table's rows (any kind; only hand and foot are published). Refused when
    the edits don't fit the board as it is (a hold that isn't there, a foothold in use, a pair
    that wouldn't point back, two footholds with one name)."""
    e = check_edits(edits)
    used = used or {}
    live = {h['id']: h for h in rows if h.get('kind') in ('hand', 'foot')}
    hold = {}
    for h in sorted(live.values(), key=lambda h: h['id']):
        if not isinstance(h.get('outline'), list) or len(h['outline']) < OUTLINE_MIN:
            if h['id'] not in e['outlines']:
                raise Refused('%s has no outline: draw one first' % h.get('name'))
        hold[h['id']] = {'id': h['id'], 'kind': h['kind'], 'name': h.get('name'), 'x': h.get('x'), 'y': h.get('y'),
                         'outline': h.get('outline'), 'mirror': h.get('mirror')}
    lines = []
    for r in e['removed']:
        h = live.get(r)
        if not h or h['kind'] != 'foot':
            raise Refused('%s is not a foothold of the board' % r)
        if used.get(r):
            raise Refused('%s is in %d problem(s)\' Specific feet, so it can\'t be deleted' % (h.get('name'), used[r]))
        del hold[r]
        lines.append('%s: deleted' % h.get('name'))
    for a in e['added']:
        if a['id'] in live:
            raise Refused('%s is already a hold of the board' % a['id'])
        x, y = _xy(a['pts'])
        hold[a['id']] = {'id': a['id'], 'kind': 'foot', 'name': None, 'x': x, 'y': y, 'outline': a['pts'], 'mirror': None}
    for k, pts in e['outlines'].items():
        h = hold.get(k)
        if not h:
            raise Refused('%s: no such hold (or it\'s being deleted)' % k)
        old = live[k].get('outline') or []
        h['outline'] = pts
        if h['kind'] == 'foot':
            h['x'], h['y'] = _xy(pts)
        elif h['x'] is None or h['y'] is None:
            h['x'], h['y'] = _xy(pts)
        if old != pts:
            lines.append('%s: outline %d -> %d points' % (h['name'], len(old), len(pts)))
    # footholds' names: the page's FTn (left to right, bottom row up: bsFootNameList)
    for k, n in e['names'].items():
        if k in hold and hold[k]['kind'] == 'foot':
            hold[k]['name'] = n
    feet = [h for h in hold.values() if h['kind'] == 'foot']
    if len(feet) > FOOT_MAX:
        raise Refused('at most %d footholds' % FOOT_MAX)
    for h in feet:
        if not h['name'] or not FOOT_NAME.match(h['name']):
            raise Refused('%s needs a name (FTn)' % h['id'])
    names = [h['name'] for h in feet]
    if len(set(names)) != len(names):
        raise Refused('two footholds would share a name')
    hand_names = {h['name'] for h in hold.values() if h['kind'] == 'hand'}
    if hand_names & set(names):
        raise Refused('a foothold would share a hand hold\'s name')
    # pairs: foot <-> foot only, set both ways by the page; a partner that's gone is cleared
    for k, v in e['pairs'].items():
        if k not in hold or hold[k]['kind'] != 'foot':
            raise Refused('pairs: %s is not a foothold of the board' % k)
        if v is not None and (v not in hold or hold[v]['kind'] != 'foot'):
            raise Refused('pairs: %s can only pair with a foothold' % hold[k]['name'])
        hold[k]['mirror'] = v
    for h in hold.values():
        if h['mirror'] and h['mirror'] != h['id'] and h['mirror'] not in hold:
            h['mirror'] = None
    for h in hold.values():
        m = h['mirror']
        if m and m != h['id']:
            p = hold[m]
            if p['kind'] != h['kind'] or p['mirror'] != h['id']:
                raise Refused('%s: its mirror partner %s must be the same kind and pair back' % (h['name'], p['name']))
    # what changed, footholds by name
    for h in sorted(feet, key=lambda h: int(h['name'][2:])):
        old = live.get(h['id'])
        nm = lambda i: hold[i]['name'] if i in hold else (live[i]['name'] if i in live else i)  # noqa: E731
        if not old:
            lines.append('%s: new foothold (%d points)%s' % (h['name'], len(h['outline']),
                                                             ', paired with %s' % nm(h['mirror']) if h['mirror'] else ''))
            continue
        if old.get('name') != h['name']:
            lines.append('%s: renamed %s (left to right, bottom row up; its id stays %s)' % (old.get('name'), h['name'], h['id']))
        om, nmv = old.get('mirror') or None, h['mirror'] or None
        if om == old['id']:
            om = None
        if nmv == h['id']:
            nmv = None
        if om != nmv:
            lines.append('%s: %s' % (h['name'], ('paired with %s' % nm(nmv)) if nmv else 'unpaired (was %s)' % nm(om)))
    payload = []
    for h in sorted(hold.values(), key=lambda h: (h['kind'] != 'hand', h['id'])):
        o = {'id': h['id'], 'kind': h['kind'], 'x': round(float(h['x']), 2), 'y': round(float(h['y']), 2),
             'outline': h['outline'], 'mirror': h['mirror'] or None}
        if h['kind'] == 'foot':
            o['name'] = h['name']
        payload.append(o)
    return payload, lines


def preview(edits, env=None):
    """(change lines, the live board version) from the live rows, for the confirm."""
    data = board(env)
    _, lines = apply_edits(data['holds'], edits, data['feet_used'])
    return lines, data['board']['version']


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


def publish(edits, version, out=print):
    """One transaction: lock the board, refuse if its version isn't `version`, rebuild the
    payload from the rows now, keep the old rows, then admin_publish_board() as the super
    admin. Returns the new board version."""
    conn = _conn()
    try:
        conn.run('begin')
        bc = conn.run('select updated_at, image_path, photo_path, corners from public.board_config '
                      'where wall = :w for update', w=WALL)
        if not bc:
            raise Refused('no board_config row')
        cur, image_path, photo_path, corners = bc[0]
        if not same_version(cur.isoformat() if hasattr(cur, 'isoformat') else cur, version):
            raise Refused('the board changed since this page loaded it (a publish from the phone?): '
                          'Reload, check your draft, and publish again')
        rows = [dict(zip(('id', 'name', 'kind', 'led', 'x', 'y', 'outline', 'mirror'), r)) for r in conn.run(
            'select id, name, kind, led, x, y, outline, mirror from public.holds where wall = :w', w=WALL)]
        for r in rows:
            r['x'], r['y'] = _num(r['x']), _num(r['y'])
        used = {}
        for (f,) in conn.run('select unnest(feet_holds) from public.problems where feet_holds is not null'):
            used[f] = used.get(f, 0) + 1
        payload, lines = apply_edits(rows, edits, used)
        undo = _undo_file('holds', {'table': 'holds', 'wall': WALL, 'board_version': str(cur), 'old': rows})
        out('%d change(s):' % len(lines))
        for line in lines:
            out('  ' + line)
        out('publishing %d holds through admin_publish_board(), as the super admin, over direct Postgres (db/.env)'
            % len(payload))
        _as_super_admin(conn)
        # corners null = kept as they are (BRD-13); the expected version is the page's (db/45)
        res = conn.run('select public.admin_publish_board(:w, :img, :photo, null::jsonb, cast(:h as jsonb), '
                       'null::numeric, cast(:v as timestamptz))',
                       w=WALL, img=image_path, photo=photo_path, h=json.dumps(payload), v=str(version))
        conn.run('reset role')
        conn.run('commit')
        out('published: board version %s (old rows: %s)' % (res[0][0], os.path.relpath(undo, REPO)))
        return res[0][0]
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    finally:
        conn.close()


def undo_last(out=print):
    """The app's Undo the last publish: admin_undo_board() as the super admin."""
    conn = _conn()
    try:
        conn.run('begin')
        n = conn.run('select count(*) from public.board_versions where wall = :w', w=WALL)[0][0]
        if not n:
            raise Refused('there is no earlier board version to go back to')
        _as_super_admin(conn)
        conn.run('select public.admin_undo_board(:w)', w=WALL)
        conn.run('reset role')
        ver = conn.run('select updated_at from public.board_config where wall = :w', w=WALL)[0][0]
        conn.run('commit')
        out('undone: the board is back to version %s' % ver)
        return ver
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    finally:
        conn.close()


# -- the bundled snapshot -------------------------------------------------------------

def run_tool(argv, out):
    """A repo tool (python), its output streamed to out. -> exit code."""
    import procs
    p = subprocess.run([sys.executable] + argv, cwd=REPO, capture_output=True, timeout=300,
                       creationflags=procs.NO_WINDOW)
    out((p.stdout + p.stderr).decode('utf-8', 'replace').rstrip())
    return p.returncode
