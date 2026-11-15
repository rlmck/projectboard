"""Supabase from the laptop with the public anon key (the same access the app and
the Pi have): the problem list for Light a problem (phase 9) and the cast itself.
Nothing here writes to the database; the cast is a Realtime broadcast, which stores
nothing. The weekly backup reads the database over db/.env instead (backups.py).
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
