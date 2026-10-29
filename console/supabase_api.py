"""Supabase from the laptop with the public anon key (the same access the app and
the Pi have): the problem list and board data for the test cast (phase 9), the
cast itself, and the public-table export for backups (phase 12). Nothing here
writes to the database; the cast is a Realtime broadcast, which stores nothing.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from checks import supabase_settings

TOPIC = 'board:HangoutPortland'
EVENT = 'cast_problem'
UA = 'pb-console (laptop)'
COLS = 'ABCDEFGHIJKLMNOPQRS'
# Public tables (RLS public read) exported by the backup, with the columns to take.
EXPORT = {
    'problems': '*',
    'circuits': '*',
    'board_config': '*',
    'challenges': '*',
}


def _req(url, key, method='GET', body=None, timeout=20, extra=None):
    headers = {'apikey': key, 'Authorization': 'Bearer ' + key, 'User-Agent': UA}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    headers.update(extra or {})
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def rest(table, query, env=None):
    url, key = supabase_settings(env)
    status, body = _req('%s/rest/v1/%s?%s' % (url, table, query), key)
    if status != 200:
        raise RuntimeError('%s: HTTP %s %s' % (table, status, body[:200].decode('utf-8', 'replace')))
    return json.loads(body)


def problems(env=None):
    """[{name, grade, is_benchmark}] sorted by name, for the picker."""
    rows = rest('problems', 'select=name,grade,is_benchmark&order=name.asc', env)
    return [{'name': r['name'], 'grade': r.get('grade'), 'benchmark': bool(r.get('is_benchmark'))} for r in rows]


def problem(name, env=None):
    rows = rest('problems', 'select=name,grade,start_holds,intermediate_holds,finish_hold&name=eq.%s'
                % urllib.parse.quote(name, safe=''), env)
    return rows[0] if rows else None


def board(env=None):
    rows = rest('board_config', 'select=mirror_map,updated_at&wall=eq.HangoutPortland', env)
    return rows[0] if rows else {}


def cell(hold):
    """'hold24' -> 'E2' (row 1 at the bottom, contract 6.1)."""
    try:
        n = int(str(hold)[4:])
    except ValueError:
        return '?'
    return '%s%d' % (COLS[(n - 1) % 19], (n - 1) // 19 + 1) if 1 <= n <= 247 else '?'


def holds_with_mirror(row, mirror_map):
    """The problem's holds in cast order with roles (contract 6.2) and each one's mirror partner (6.3)."""
    starts = list(row.get('start_holds') or [])
    order = [row.get('finish_hold')] + list(row.get('intermediate_holds') or []) + starts
    order = [h for h in order if h]
    out = []
    for i, h in enumerate(order):
        role = 'start' if i < 2 else 'finish' if i == len(order) - 1 else 'hold'
        m = (mirror_map or {}).get(h, h)
        out.append({'hold': h, 'cell': cell(h), 'role': role, 'mirror': m, 'mirror_cell': cell(m)})
    return out


def cast(name, mirror=False, env=None):
    """The app's cast exactly (contract 3): HTTPS POST to Realtime's broadcast endpoint,
    {problem_name, mirror: true only when mirrored}, plus source 'console' so Activity can tell
    a test cast from a climber's. Returns (http status, ms, sent at)."""
    if not isinstance(name, str) or not 1 <= len(name) <= 60:
        raise ValueError('problem_name: 1-60 characters')
    url, key = supabase_settings(env)
    payload = {'problem_name': name, 'source': 'console'}   # contract 3: shows as the console in Activity
    if mirror:
        payload['mirror'] = True
    endpoint = '%s/realtime/v1/api/broadcast/%s/events/%s' % (url, urllib.parse.quote(TOPIC, safe=''), EVENT)
    t0 = time.time()
    status, body = _req(endpoint, key, 'POST', payload, timeout=10)
    return status, int((time.time() - t0) * 1000), t0, body[:200].decode('utf-8', 'replace')


def export(env=None):
    """{table: rows} for the public tables."""
    return {t: rest(t, 'select=%s' % cols, env) for t, cols in EXPORT.items()}
