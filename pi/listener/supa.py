"""Supabase REST reads with the public anon key (what a listener may read: contract section 5)."""
import json
import os
import time
import urllib.parse
import urllib.request

TIMEOUT = 10
HOLDS_CACHE = '/var/lib/projectboard/cache/holds.json'   # the listener's copy of the holds table


def _get(cfg, table, params):
    q = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    url = '%s/rest/v1/%s?%s' % (cfg['SUPABASE_URL'].rstrip('/'), table, q)
    key = cfg['SUPABASE_ANON_KEY']
    req = urllib.request.Request(url, headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _retry_once(fn):
    try:
        return fn()
    except Exception:
        time.sleep(1)
        return fn()


def fetch_problem(cfg, name):
    """The problem row by exact name (contract 3), or None if there's no such problem."""
    rows = _retry_once(lambda: _get(cfg, 'problems', {
        'select': 'name,start_holds,intermediate_holds,finish_hold,feet_mode',
        'name': 'eq.' + name}))
    if not isinstance(rows, list):
        raise ValueError('problems lookup returned %s' % type(rows).__name__)
    return rows[0] if rows else None


def fetch_holds(cfg):
    """This wall's holds (db/41, contract 6.4): id, name, kind, LED, mirror partner."""
    rows = _retry_once(lambda: _get(cfg, 'holds', {
        'select': 'id,name,kind,led,mirror', 'wall': 'eq.' + cfg['BOARD_WALL'], 'order': 'id', 'limit': '2000'}))
    if not isinstance(rows, list):
        raise ValueError('holds lookup returned %s' % type(rows).__name__)
    return rows


def load_cache(path):
    """The rows save_cache() wrote, or None if there's no readable copy."""
    try:
        with open(path, encoding='utf-8') as f:
            v = json.load(f)
    except (OSError, ValueError):
        return None
    return v.get('rows') if isinstance(v, dict) else None


def save_cache(path, rows):
    """Write rows to path atomically (a temp file, then a rename), with the time."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'saved_at': time.time(), 'rows': rows}, f)
    os.replace(tmp, path)


def fetch_mirror_map(cfg):
    """board_config.mirror_map for this wall (contract 6.3). The listener reads the
    mirror partners from the holds table now (fetch_holds); kept for pb-ledmap."""
    rows = _retry_once(lambda: _get(cfg, 'board_config', {
        'select': 'mirror_map', 'wall': 'eq.' + cfg['BOARD_WALL']}))
    if not rows:
        raise ValueError('no board_config row for %s' % cfg['BOARD_WALL'])
    mm = rows[0].get('mirror_map')
    if isinstance(mm, str):
        mm = json.loads(mm)
    return mm or {}


def fetch_benchmarks(cfg):
    """Every benchmark problem's name and holds (for the teaser idle pattern): one small read."""
    rows = _retry_once(lambda: _get(cfg, 'problems', {
        'select': 'name,start_holds,intermediate_holds,finish_hold,feet_mode',
        'is_benchmark': 'eq.true', 'order': 'name', 'limit': '500'}))
    if not isinstance(rows, list):
        raise ValueError('benchmarks lookup returned %s' % type(rows).__name__)
    return rows


def fetch_circuit(cfg, name):
    """The circuit row by exact name (contract 8), or None. (led_track, 8.6, isn't drawn any more.)"""
    rows = _retry_once(lambda: _get(cfg, 'circuits', {
        'select': 'name,hold_sequence,start_count,loops',
        'name': 'eq.' + name}))
    if not isinstance(rows, list):
        raise ValueError('circuits lookup returned %s' % type(rows).__name__)
    return rows[0] if rows else None
