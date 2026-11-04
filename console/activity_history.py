"""The Activity dashboard's data (phase 10): the console's own history of casts, kept
because the Pi's journal expires (a month, 100 MB), plus ticks and accounts read
live from the database.

- Casts come from the listener's journal (probe.py `history SINCE`): problem casts,
  circuit runs (the "circuit ended" line) and circuit views, each with where it was
  sent from, signed in or not, mirrored, and whether night mode ignored it. They're
  parsed into events and merged into console/data/activity-history.json (gitignored),
  keyed on the line's microsecond timestamp, kind and name, so a refresh never counts a
  line twice and nothing is lost when the journal rolls over.
- Members' nicknames, ticks and new accounts come from Postgres (castlog.history(),
  db/.env, read-only). Nicknames are matched to casts each time (reports._nicknames:
  a circuit by its run token, a problem by name within 2 minutes) and never cached.
- Every time is turned into UK local time (Europe/London: GMT, or BST from 01:00 UTC on
  the last Sunday of March to 01:00 UTC on the last Sunday of October) here, so the
  browser buckets by the day, weekday and hour it's given. Python's zoneinfo has no
  time zone data on Windows without the tzdata package, hence the rule written out.

The browser does the counting and the cross-filtering (static/activity.js).
"""
import datetime
import os
import threading

import reports

CACHE = 'activity-history.json'
OVERLAP_S = 3600            # each refresh re-reads the last hour of the journal (the merge drops repeats)
UTC = datetime.timezone.utc
_LOCK = threading.Lock()      # one refresh at a time (the server is threaded)


# -- UK time ----------------------------------------------------------------------------

def _last_sunday(year, month):
    d = datetime.date(year, month, 31)
    return d - datetime.timedelta(days=(d.weekday() + 1) % 7)


def uk(t):
    """An aware datetime -> the naive UK local time it was (GMT or BST)."""
    u = t.astimezone(UTC).replace(tzinfo=None)
    start = datetime.datetime.combine(_last_sunday(u.year, 3), datetime.time(1))
    end = datetime.datetime.combine(_last_sunday(u.year, 10), datetime.time(1))
    return u + datetime.timedelta(hours=1) if start <= u < end else u


def parse_time(iso):
    """An ISO time with an offset (the journal's short-iso-precise, Postgres) -> aware datetime, or None."""
    if not iso:
        return None
    s = iso.strip()
    if len(s) > 5 and s[-5] in '+-' and s[-3] != ':':     # +0000 -> +00:00
        s = s[:-2] + ':' + s[-2:]
    try:
        t = datetime.datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def stamp(t):
    """{'t': ms since 1970, 'd': UK date, 'h': UK hour, 'w': UK weekday (0 = Monday)}."""
    l = uk(t)
    return {'t': int(t.timestamp() * 1000), 'd': l.date().isoformat(), 'h': l.hour, 'w': l.weekday()}


# -- the journal's lines -> cached events ------------------------------------------------

def is_test(name):
    return str(name or '').startswith('~cast-test')


def events_from_probe(raw):
    """The probe's lists -> [{key, kind, at, start, name, source, who, mirror, night, ...}].
    at: the line's time; start: when it began (a circuit run's line is written when it ends,
    so start = at minus its seconds). The cast-test bench's names are dropped."""
    out = []

    def add(kind, at, name, **kw):
        t = parse_time(at)
        if t is None or is_test(name):
            return
        start = t - datetime.timedelta(seconds=kw.pop('secs_back', 0) or 0)
        ev = {'key': '%s|%s|%s' % (kind, t.astimezone(UTC).isoformat(), name), 'kind': kind,
              'at': t.astimezone(UTC).isoformat(), 'start': start.astimezone(UTC).isoformat(), 'name': name}
        ev.update(kw)
        out.append(ev)

    for row in raw.get('casts') or []:
        at, name, mirror, shown = row[:4]
        source, who = (list(row[4:6]) + [None, None])[:2]
        add('problem', at, name, mirror=bool(mirror), night=not shown, source=source, who=who)
    for row in raw.get('circuits') or []:
        at, name, how, moves, secs, interval, loop, run, source, who = (list(row) + [None] * 10)[:10]
        night = how == 'night mode'
        add('circuit', at, name, mirror=False, night=night, source=source, who=who, how=None if night else how,
            moves=moves, secs=secs, interval=interval, loop=loop, run=run, secs_back=secs)
    for row in raw.get('views') or []:
        at, name, shown, source, who = (list(row) + [None] * 5)[:5]
        add('view', at, name, mirror=False, night=not shown, source=source, who=who)
    return out


def merge(cache, events):
    """Adds the events the cache hasn't got (by key); returns how many were new."""
    have = cache.setdefault('events', {})
    n = 0
    for ev in events:
        if ev['key'] not in have:
            have[ev['key']] = ev
            n += 1
    return n


def newest(cache):
    ts = [parse_time(e['at']) for e in (cache.get('events') or {}).values()]
    ts = [t for t in ts if t]
    return max(ts) if ts else None


def cache_path():
    return reports.data_path(CACHE)


def load():
    c = reports.load_json(cache_path(), {})
    return c if isinstance(c.get('events'), dict) else {'events': {}}


def refresh(remote, path=None):
    """Reads the journal since the newest cached line (less an hour; all of it the first time),
    merges and saves. {'ok', 'added', 'error', 'journal_from'}; the cache is kept either way."""
    with _LOCK:
        return _refresh(remote, path or cache_path())


def _refresh(remote, path):
    cache = reports.load_json(path, {})
    if not isinstance(cache.get('events'), dict):
        cache = {'events': {}}
    last = newest(cache)
    since = max(0, int(last.timestamp()) - OVERLAP_S) if last else 0
    raw = remote.probe('history %d' % since)
    if not raw.get('ok'):
        return cache, {'ok': False, 'added': 0, 'error': raw.get('error') or 'the Pi did not answer',
                       'journal_from': cache.get('journal_from')}
    added = merge(cache, events_from_probe(raw))
    cache['journal_from'] = raw.get('journal_from')
    cache['read_at'] = datetime.datetime.now(UTC).isoformat(timespec='seconds')
    if added or not os.path.exists(path):
        reports.save_json(path, cache)
    return cache, {'ok': True, 'added': added, 'error': None, 'journal_from': cache['journal_from']}


# -- the page's event list ---------------------------------------------------------------

def is_cast(ev):
    """A cast: a problem cast or a circuit run start the Pi received in the daytime. Not a
    circuit view (holds lit), not a night-ignored one, not a cast-test name. (preview_holds never
    reach the journal's activity lines.) Console test casts count, source console."""
    return ev['kind'] in ('problem', 'circuit') and not ev.get('night') and not is_test(ev.get('name'))


def build(cache, db=None, grades=None, today=None, days=0):
    """The compact lists the browser aggregates. db: castlog.history() (or None: no names,
    ticks or accounts; member/guest then comes from the broadcast's signed-in flag)."""
    grades = grades or {}
    names_ok = bool(db) and not db.get('error')
    evs = [dict(e) for e in (cache.get('events') or {}).values()]
    if names_ok:
        reports._nicknames(evs, [dict(r) for r in db.get('rows') or []])
    today = today or uk(datetime.datetime.now(UTC)).date()
    cut = (today - datetime.timedelta(days=2 * days - 1)).isoformat() if days else ''
    casts = []
    for e in evs:
        t = parse_time(e['start'] if e['kind'] == 'circuit' else e['at'])
        if t is None:
            continue
        s = stamp(t)
        if s['d'] < cut:
            continue
        nick = e.get('nickname') if names_ok else None
        c = dict(s, k={'problem': 'p', 'circuit': 'c', 'view': 'v'}[e['kind']], n=e['name'], s=e.get('source'),
                 m=bool(e.get('mirror')), x=bool(e.get('night')), who=nick,
                 mem=bool(nick) if names_ok else e.get('who') == 'member', sg=e.get('who'))
        g = grades.get(('c' if e['kind'] != 'problem' else 'p', e['name']))
        if g:
            c['g'] = g
        if e['kind'] == 'circuit' and not e.get('night'):
            c.update(how=e.get('how'), mv=e.get('moves'), sec=e.get('secs'), iv=e.get('interval'), loop=e.get('loop'))
        casts.append(c)
    casts.sort(key=lambda c: c['t'])
    ticks, accounts = [], []
    if names_ok:
        for r in db.get('ticks') or []:
            t = parse_time(r['at'])
            if t is None:
                continue
            s = stamp(t)
            if s['d'] >= cut:
                ticks.append(dict(s, who=r['nickname'], n=r['name'], g=r.get('grade'), m=bool(r.get('mirrored'))))
        for r in db.get('accounts') or []:
            t = parse_time(r['at'])
            if t is not None and r.get('nickname'):
                accounts.append(dict(stamp(t), who=r['nickname']))      # all of them: the "new" badge needs joins
    return {'today': today.isoformat(), 'now': int(datetime.datetime.now(UTC).timestamp() * 1000),
            'casts': casts, 'ticks': ticks, 'accounts': accounts,
            'names': 'ok' if names_ok else ((db or {}).get('error') or 'not read'),
            'journal_from': cache.get('journal_from'), 'read_at': cache.get('read_at'),
            'cached': len(cache.get('events') or {})}


def grade_map(supa, env=None):
    """{('p', name): grade, ('c', name): grade} from the public tables (the anon key); {} on failure."""
    out = {}
    try:
        for p in supa.problems(env):
            if p.get('grade'):
                out[('p', p['name'])] = p['grade']
    except Exception:                       # noqa: BLE001
        pass
    try:
        for c in supa.rest('circuits', 'select=name,grade', env):
            if c.get('grade'):
                out[('c', c['name'])] = c['grade']
    except Exception:                       # noqa: BLE001
        pass
    return out
