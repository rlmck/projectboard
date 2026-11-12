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
  - every hand hold has an outline, and there are HAND_HOLDS of them; the outlines'
    version tie (hold_shapes.__meta.board_updated_at = board_config.updated_at, or the
    app draws dots); footholds are named FT1..FTn with no gaps; board_config.foot_id_max
    (db/45) is at least every foothold's number;
  - every problem's Specific feet are footholds of the board, and every problem and
    circuit hold is a hand hold (never a feet sign, a foothold or an unknown id);
  - the bundled snapshot (app/hold_map.json, app/mirror_map.json, app/hold_shapes.json,
    their __meta.board_updated_at) still matches live. A snapshot behind live is a
    WARNING, not a failure (the exit code stays 0): a publish hasn't been snapshotted
    yet (re-run tools/snapshot_board.py and ship, or PB Console -> Holds -> Ship the
    snapshot).
Not checked: the footholds' FTn order (left to right, bottom row up) needs the board
image's corners and size (bsFootNameList in app/setup.js); the publish tools set it.
Prints counts and the first few mismatches, never anything about users.
"""
import datetime
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
HAND_HOLDS = 188


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
    # every hand hold outlined, the right count, the outlines' version tie
    hand_rows = [h for h in holds if h['kind'] == 'hand']
    if len(hand_rows) != HAND_HOLDS:
        bad.append('%d hand holds, expected %d' % (len(hand_rows), HAND_HOLDS))
    for h in hand_rows:
        if not isinstance(h.get('outline'), list) or len(h['outline']) < 3:
            bad.append('%s (%s): a hand hold with no outline (every publish is refused until it has one)'
                       % (h['name'], h['id']))
    meta = shapes.get('__meta') or {}
    if not same_version(meta.get('board_updated_at'), bc.get('updated_at')):
        bad.append('hold_shapes.__meta.board_updated_at (%s) is not the board version (%s): the app draws dots'
                   % (meta.get('board_updated_at'), bc.get('updated_at')))
    # footholds: FT1..FTn with no gaps, numbers within foot_id_max
    feet = [h for h in holds if h['kind'] == 'foot']
    nums = sorted(int(h['name'][2:]) for h in feet if re.match(r'^FT[0-9]{1,3}$', h.get('name') or ''))
    if nums != list(range(1, len(feet) + 1)):
        bad.append('footholds are not named FT1..FT%d with no gaps' % len(feet))
    top = max([int(h['id'][4:]) for h in feet if re.match(r'^foot[0-9]{1,4}$', h['id'])] or [0])
    if bc.get('foot_id_max') is not None and top > int(bc['foot_id_max']):
        bad.append('foothold number %d is above board_config.foot_id_max (%s)' % (top, bc['foot_id_max']))
    return bad


def check_uses(holds, problems, circuits):
    """Problems' and circuits' hold lists against the table. -> mismatch strings."""
    bad = []
    kind = {h['id']: h['kind'] for h in holds}
    for p in problems:
        ids = list(p.get('start_holds') or []) + list(p.get('intermediate_holds') or []) + [p.get('finish_hold')]
        wrong = sorted({i for i in ids if i and kind.get(i) != 'hand'})
        if wrong:
            bad.append('problem %s: holds that are not hand holds: %s' % (p.get('id'), ', '.join(wrong)))
        wrong = sorted({f for f in p.get('feet_holds') or [] if kind.get(f) != 'foot'})
        if wrong:
            bad.append('problem %s: Specific feet that are not footholds: %s' % (p.get('id'), ', '.join(wrong)))
    for c in circuits:
        wrong = sorted({i for i in c.get('hold_sequence') or [] if kind.get(i) != 'hand'})
        if wrong:
            bad.append('circuit %s: holds that are not hand holds: %s' % (c.get('id'), ', '.join(wrong)))
    return bad


def check_snapshot(bc, snap_map, snap_mirror, snap_shapes):
    """The bundled snapshot against live. -> warning strings (a snapshot behind live is
    expected right after a publish, until it's shipped)."""
    warn = []
    shapes = {k: v for k, v in (bc.get('hold_shapes') or {}).items() if k != '__meta'}
    ver = (snap_map.get('__meta') or {}).get('board_updated_at')
    if not same_version(ver, bc.get('updated_at')):
        warn.append('the snapshot is of board %s, live is %s' % (ver, bc.get('updated_at')))
    if {k: v for k, v in snap_map.items() if k != '__meta'} != (bc.get('hold_map') or {}):
        warn.append('app/hold_map.json differs from live')
    if snap_mirror != (bc.get('mirror_map') or {}):
        warn.append('app/mirror_map.json differs from live')
    if {k: v for k, v in snap_shapes.items() if k != '__meta'} != shapes:
        warn.append('app/hold_shapes.json differs from live')
    if not same_version((snap_shapes.get('__meta') or {}).get('board_updated_at'), ver):
        warn.append('app/hold_shapes.json and app/hold_map.json are of different boards')
    return warn


def same_version(a, b):
    """Two board versions (timestamps as text) the same instant? '...089+00:00' == '...089Z'."""
    def t(v):
        try:
            return datetime.datetime.fromisoformat(str(v).replace('Z', '+00:00'))
        except ValueError:
            return None
    ta, tb = t(a), t(b)
    return ta is not None and ta == tb


def main():
    key = anon_key()
    holds = get('holds?select=id,name,kind,led,x,y,outline,mirror&wall=eq.%s&order=id&limit=2000' % WALL, key)
    rows = get('board_config?select=*&wall=eq.%s' % WALL, key)
    if not rows:
        raise SystemExit('no board_config row')
    problems = get('problems?select=id,start_holds,intermediate_holds,finish_hold,feet_holds&limit=10000', key)
    circuits = get('circuits?select=id,hold_sequence&limit=10000', key)
    snap_map = load('app', 'hold_map.json')
    bad = check(holds, rows[0], load('tools', 'led_map.json'), snap_map, load('app', 'mirror_map.json'))
    bad += check_uses(holds, problems, circuits)
    warn = check_snapshot(rows[0], snap_map, load('app', 'mirror_map.json'), load('app', 'hold_shapes.json'))
    kinds = {}
    for h in holds:
        kinds[h['kind']] = kinds.get(h['kind'], 0) + 1
    print('holds: %d (%s); %d problems, %d circuits checked' % (
        len(holds), ', '.join('%s %d' % kv for kv in sorted(kinds.items())), len(problems), len(circuits)))
    for w in warn:
        print('WARNING (the snapshot is behind live: run tools/snapshot_board.py and ship): ' + w)
    if bad:
        print('FAILED: %d mismatch%s' % (len(bad), '' if len(bad) == 1 else 'es'))
        for b in bad[:25]:
            print('  ' + b)
        return 1
    print('OK: every LED is the formula\'s (and led_map.json\'s), every partner, position and outline is '
          'board_config\'s, every hand hold is outlined, the feet signs are B1/26 and B2/25, the footholds are '
          'FT1..FTn, every problem and circuit uses hand holds only%s'
          % (', the snapshot matches live' if not warn else ' (the snapshot is behind: see above)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
