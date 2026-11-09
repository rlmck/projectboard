#!/usr/bin/env python3
"""The holds table's seed check (db/41): repeatable, read-only, public data only.

    python tools/check_holds.py          # exit 0 = every check passed, 1 = a mismatch

Reads the live holds table and board_config with the public anon key (from
app/state.js) and checks, for every hold:
  - its LED is what the formula gives (pi/listener/board.py led_index, contract
    6.4) and what tools/led_map.json says: so the Pi lights exactly the LEDs it lit
    before the table (until a hold is deliberately re-mapped in session 2);
  - its mirror partner, position and outline are board_config's (since db/42 the
    table is the source and board_config's hold_map / mirror_map / hold_shapes are
    copies made from it by the holds_sync_board_config trigger), and its name is
    the grid name;
  - footholds (the board setup, db/42): id footN, name FTn, no LED, a position and
    an outline, and a mirror partner (if any) that is a foothold; every partner pairs
    back, and never a hand hold with a foothold;
  - the 188 hand holds are exactly the live hold map's, the feet signs are B1 =
    hold2 = LED 26 and B2 = hold21 = LED 25, footholds have no LED, no LED is used
    twice, every partner is a hold;
  - the bundled snapshot (app/hold_map.json, app/mirror_map.json) still matches
    live (re-run tools/snapshot_board.py when it doesn't).
Prints counts and the first few mismatches, never anything about users.
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402

WALL = 'HangoutPortland'
URL = 'https://uqirowyfqwiceyjznosl.supabase.co'
FEET_SIGNS = {'hold2': ('B1', 26), 'hold21': ('B2', 25)}


def anon_key():
    with open(os.path.join(ROOT, 'app', 'state.js'), encoding='utf-8') as f:
        m = re.search(r"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", f.read())
    if not m:
        raise SystemExit('anon key not found in app/state.js')
    return m.group(0)


def get(path, key):
    req = urllib.request.Request(URL + '/rest/v1/' + path, headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def load(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return json.load(f)


def grid_name(n):
    return chr(65 + (n - 1) % 19) + str((n - 1) // 19 + 1)


def num(v):
    return None if v is None else round(float(v), 6)


def check(holds, bc, led_map, snap_map, snap_mirror):
    """-> list of mismatch strings (empty = all good)."""
    bad = []
    hold_map = bc.get('hold_map') or {}
    mirror_map = bc.get('mirror_map') or {}
    shapes = bc.get('hold_shapes') or {}
    by_id = {h['id']: h for h in holds}
    if len(by_id) != len(holds):
        bad.append('a hold id appears twice')
    try:
        board.check_holds([{k: h.get(k) for k in ('id', 'kind', 'led', 'mirror')} for h in holds])
    except ValueError as e:
        bad.append('the Pi would refuse the table: %s' % e)
    leds = [h['led'] for h in holds if h.get('led') is not None]
    if len(leds) != len(set(leds)):
        bad.append('an LED is on two holds')
    names = [h['name'] for h in holds]
    if len(names) != len(set(names)):
        bad.append('a name is used twice')

    hands = {h['id'] for h in holds if h['kind'] == 'hand'}
    if hands != set(hold_map):
        bad.append('hand holds differ from the live hold map: %d only in the table, %d only in the map'
                   % (len(hands - set(hold_map)), len(set(hold_map) - hands)))
    for h in holds:
        i, kind = h['id'], h['kind']
        m = h.get('mirror')
        if m is not None and m != i:
            p = by_id.get(m)
            if not p or p.get('kind') != kind:
                bad.append('%s: mirror partner %s is not a %s hold' % (i, m, kind))
            elif p.get('mirror') != i:
                bad.append('%s: mirror partner %s does not pair back' % (i, m))
        if kind == 'foot':
            if h.get('led') is not None:
                bad.append('%s: a foothold with LED %s' % (i, h['led']))
            if not re.match(r'^foot[0-9]{1,4}$', i) or not re.match(r'^FT[0-9]{1,3}$', h.get('name') or ''):
                bad.append('%s: a foothold named %s (ids footN, names FTn)' % (i, h.get('name')))
            if h.get('x') is None or h.get('y') is None or not h.get('outline'):
                bad.append('%s: a foothold with no position or outline' % i)
            continue
        n = board.hold_number(i)
        if n is None:
            bad.append('%s: not on the grid, so the formula has no LED for it' % i)
            continue
        if h['led'] != board.led_index(n):
            bad.append('%s: LED %s, the formula gives %s' % (i, h['led'], board.led_index(n)))
        if h['led'] != led_map.get(i):
            bad.append('%s: LED %s, tools/led_map.json says %s' % (i, h['led'], led_map.get(i)))
        if kind == 'feet_sign':
            want = FEET_SIGNS.get(i)
            if not want or (h['name'], h['led']) != want or h.get('mirror') is not None:
                bad.append('%s: feet sign %s / LED %s / mirror %s' % (i, h['name'], h['led'], h.get('mirror')))
            continue
        if h['name'] != grid_name(n):
            bad.append('%s: named %s, the grid says %s' % (i, h['name'], grid_name(n)))
        if h.get('mirror') != mirror_map.get(i):
            bad.append('%s: mirror %s, board_config says %s' % (i, h.get('mirror'), mirror_map.get(i)))
        p = hold_map.get(i) or {}
        if (num(h.get('x')), num(h.get('y'))) != (num(p.get('x')), num(p.get('y'))):
            bad.append('%s: at %s,%s, board_config says %s,%s' % (i, h.get('x'), h.get('y'), p.get('x'), p.get('y')))
        if h.get('outline') != shapes.get(i):
            bad.append('%s: outline differs from board_config' % i)
    for i in FEET_SIGNS:
        if by_id.get(i, {}).get('kind') != 'feet_sign':
            bad.append('%s: missing or not a feet sign' % i)
    if {k: v for k, v in snap_map.items() if k != '__meta'} != hold_map:
        bad.append('app/hold_map.json differs from live: run tools/snapshot_board.py')
    if snap_mirror != mirror_map:
        bad.append('app/mirror_map.json differs from live: run tools/snapshot_board.py')
    return bad


def main():
    key = anon_key()
    holds = get('holds?select=id,name,kind,led,x,y,outline,mirror&wall=eq.%s&order=id&limit=2000' % WALL, key)
    rows = get('board_config?select=hold_map,mirror_map,hold_shapes&wall=eq.%s' % WALL, key)
    if not rows:
        raise SystemExit('no board_config row')
    bad = check(holds, rows[0], load('tools', 'led_map.json'), load('app', 'hold_map.json'),
                load('app', 'mirror_map.json'))
    kinds = {}
    for h in holds:
        kinds[h['kind']] = kinds.get(h['kind'], 0) + 1
    print('holds: %d (%s)' % (len(holds), ', '.join('%s %d' % kv for kv in sorted(kinds.items()))))
    if bad:
        print('FAILED: %d mismatch%s' % (len(bad), '' if len(bad) == 1 else 'es'))
        for b in bad[:25]:
            print('  ' + b)
        return 1
    print('OK: every LED is the formula\'s (and led_map.json\'s), every partner, position and outline is '
          'board_config\'s, the feet signs are B1/26 and B2/25, the snapshot matches live')
    return 0


if __name__ == '__main__':
    sys.exit(main())
