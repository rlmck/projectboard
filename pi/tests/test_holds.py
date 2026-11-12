"""The holds table on the Pi (db/41, contract 6.4): each hold's LED read from the
database instead of the formula, with the same LEDs lit for every hold.

    python -m unittest discover -s pi/tests      (from the repo root)

Builds the rows db/41 seeds (the bundled snapshot of the live board: app/hold_map.json
and app/mirror_map.json, the formula's LED, the two feet signs) and checks that every
problem shape, mirrored or not, every feet rule, a preview and a circuit light exactly
what the formula lit. The live table is checked against the formula by
tools/check_holds.py.
"""
import asyncio
import json
import os
import random
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import circuit  # noqa: E402
import supa  # noqa: E402


def load(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return json.load(f)


HOLD_MAP = {k: v for k, v in load('app', 'hold_map.json').items() if k != '__meta'}
MIRROR = load('app', 'mirror_map.json')
HANDS = sorted(HOLD_MAP, key=board.hold_number)


def seed_rows(feet=()):
    """What db/41 seeds: the hand holds and the two feet signs (plus any footholds given)."""
    rows = [{'id': h, 'name': h, 'kind': 'hand', 'led': board.led_index(board.hold_number(h)),
             'mirror': MIRROR.get(h)} for h in HANDS]
    rows += [{'id': 'hold2', 'name': 'B1', 'kind': 'feet_sign', 'led': 26, 'mirror': None},
             {'id': 'hold21', 'name': 'B2', 'kind': 'feet_sign', 'led': 25, 'mirror': None}]
    rows += [{'id': f, 'name': f, 'kind': 'foot', 'led': None, 'mirror': None} for f in feet]
    return rows


class WithTable(unittest.TestCase):
    def tearDown(self):
        board.set_holds(None)

    def frames(self, fn):
        """fn() under the formula, then under the seeded table."""
        board.set_holds(None)
        a = fn()
        board.set_holds(board.check_holds(seed_rows(('F1', 'F2')))[0])
        b = fn()
        board.set_holds(None)
        return a, b


class Seed(WithTable):
    def test_snapshot_is_the_live_board(self):
        self.assertEqual(len(HANDS), 188)
        self.assertEqual(set(MIRROR), set(HANDS))
        self.assertTrue(set(MIRROR.values()) <= set(HANDS))

    def test_every_hold_same_led(self):
        leds, mm = board.check_holds(seed_rows())
        board.set_holds(leds)
        for h in HANDS + ['hold2', 'hold21']:
            self.assertEqual(board.hold_led(h), board.led_index(board.hold_number(h)), h)
        self.assertEqual(board.hold_led('hold2'), 26)
        self.assertEqual(board.hold_led('hold21'), 25)
        self.assertEqual(mm, MIRROR)

    def test_led_map_json_agrees(self):
        m = load('tools', 'led_map.json')
        board.set_holds(board.check_holds(seed_rows())[0])
        for h in HANDS + ['hold2', 'hold21']:
            self.assertEqual(board.hold_led(h), m[h], h)

    def test_unloaded_is_the_formula(self):
        board.set_holds(None)
        self.assertFalse(board.holds_loaded())
        self.assertEqual(board.hold_led('hold24'), 54)
        self.assertIsNone(board.hold_led('F1'))
        self.assertIsNone(board.hold_led('hold999'))

    def test_loaded_lights_only_table_holds(self):
        board.set_holds(board.check_holds(seed_rows(('F1',)))[0])
        self.assertTrue(board.holds_loaded())
        self.assertIsNone(board.hold_led('F1'))           # a foothold: no LED
        self.assertIsNone(board.hold_led('hold218'))      # I12: on the grid, not a hold
        self.assertIsNone(board.hold_led(None))


class CheckHolds(unittest.TestCase):
    def bad(self, rows):
        with self.assertRaises(ValueError):
            board.check_holds(rows)

    def test_refuses(self):
        ok = [{'id': 'hold1', 'kind': 'hand', 'led': 1, 'mirror': 'hold19'},
              {'id': 'hold19', 'kind': 'hand', 'led': 235, 'mirror': 'hold1'}]
        board.check_holds(ok)
        self.bad(None)
        self.bad([])
        self.bad('nope')
        self.bad(ok + [ok[0]])                                                    # repeated id
        self.bad([{'id': 'hold1', 'kind': 'wood', 'led': 1}])
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': None}])                  # a hand hold with no LED
        self.bad([{'id': 'hold1', 'kind': 'feet_sign', 'led': None}])
        self.bad([{'id': 'F1', 'kind': 'foot', 'led': 3}])                        # a foothold with one
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': True}])
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': 1200}])
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': 1}, {'id': 'hold3', 'kind': 'hand', 'led': 1}])
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': 1, 'mirror': 'hold5'}])  # partner not a hold
        self.bad([{'id': 'hold1', 'kind': 'hand', 'led': 1, 'mirror': 7}])
        self.bad([{'id': '', 'kind': 'hand', 'led': 1}])

    def test_no_mirror_not_in_map(self):
        _, mm = board.check_holds([{'id': 'F1', 'kind': 'foot', 'led': None, 'mirror': None}])
        self.assertEqual(mm, {})


class SameLeds(WithTable):
    def test_random_problems_both_ways_every_feet_rule(self):
        rng = random.Random(41)
        for i in range(400):
            holds = rng.sample(HANDS, rng.randint(3, 14))
            row = {'finish_hold': holds[0], 'intermediate_holds': holds[1:-2], 'start_holds': holds[-2:],
                   'feet_mode': ('any', 'orange', 'black', 'specific')[i % 4]}
            for mirror in (False, True):
                a, b = self.frames(lambda: board.frame(row, mirror, MIRROR))
                self.assertEqual(a, b, (row, mirror))
                self.assertEqual(a[1], [])

    def test_feet_rules(self):
        base = {'finish_hold': 'hold243', 'intermediate_holds': ['hold100'], 'start_holds': ['hold41', 'hold43']}
        for mode, sign in (('any', None), ('orange', 25), ('black', 26), ('specific', None)):
            for mirror in (False, True):
                a, b = self.frames(lambda: board.frame(dict(base, feet_mode=mode), mirror, MIRROR))
                self.assertEqual(a, b, mode)
                signs = {i for i in b[0] if i in (25, 26)}
                self.assertEqual(signs, {sign} if sign else set(), (mode, mirror))

    def test_specific_feet_lights_no_foothold(self):
        board.set_holds(board.check_holds(seed_rows(('F1',)))[0])
        leds, dropped = board.frame({'finish_hold': 'hold243', 'intermediate_holds': ['hold100', 'F1'],
                                     'start_holds': ['hold41', 'hold43'], 'feet_mode': 'specific',
                                     'feet_holds': ['F1']})
        self.assertEqual(len(leds), 4)                    # the four hand holds, no sign
        self.assertEqual(dropped, ['F1'])                 # a foothold in a hand list lights nothing

    def test_specific_feet_as_the_app_saves_it(self):
        # Session 3 (10 Nov 2026): the app saves Specific feet as feet_mode 'specific'
        # plus feet_holds (footholds, foot <-> foot partners); the hand lists never
        # hold a foothold. Cast either way, it lights exactly the hand holds an Any
        # feet problem lights (mirrored: the mirrored hand holds), and no sign.
        board.set_holds(board.check_holds(seed_rows(('foot1', 'foot2', 'foot3')))[0])
        base = {'finish_hold': 'hold243', 'intermediate_holds': ['hold100', 'hold120'],
                'start_holds': ['hold41', 'hold43']}
        mm = dict(MIRROR, foot1='foot2', foot2='foot1')
        for mirror in (False, True):
            want, _ = board.frame(dict(base, feet_mode='any'), mirror, mm)
            got, dropped = board.frame(dict(base, feet_mode='specific', feet_holds=['foot1', 'foot2', 'foot3']), mirror, mm)
            self.assertEqual(got, want, mirror)
            self.assertEqual(dropped, [])
            self.assertFalse({25, 26} & set(got))
            hands = {board.hold_led(MIRROR.get(h, h) if mirror else h) for h in
                     ['hold243', 'hold100', 'hold120', 'hold41', 'hold43']}
            self.assertEqual(set(got), hands)
        # The live preview while setting: feet 'specific' lights the same as 'any'.
        sel = (['hold41', 'hold43'], ['hold100'], ['hold243'])
        self.assertEqual(board.preview_frame(*sel, 'specific'), board.preview_frame(*sel, 'any'))

    def test_preview(self):
        sel = (['hold41', 'hold43'], ['hold100', 'hold120'], ['hold243'])
        for feet in board.FEET_MODES:
            a, b = self.frames(lambda: board.preview_frame(*sel, feet))
            self.assertEqual(a, b, feet)
        self.assertEqual(board.check_preview({'start': [], 'feet': 'specific'})[3], 'specific')

    def test_circuits(self):
        seq = ['hold41', 'hold43', 'hold100', 'hold120', 'hold41', 'hold243']
        a, b = self.frames(lambda: circuit.static_frame(seq, 2))
        self.assertEqual(a, b)
        a, b = self.frames(lambda: circuit.Run('x', seq, 2, 3, 1, mirror_map=MIRROR).led)
        self.assertEqual(a, b)


class SeedCheckTool(unittest.TestCase):
    """tools/check_holds.py's check() (the live run: python tools/check_holds.py)."""

    def setUp(self):
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import check_holds
        self.ch = check_holds
        shapes = load('app', 'hold_shapes.json')
        # the board version the outlines name (check() ties them since db/45, 12 Nov 2026)
        self.bc = {'hold_map': HOLD_MAP, 'mirror_map': MIRROR, 'hold_shapes': shapes,
                   'updated_at': (shapes.get('__meta') or {}).get('board_updated_at')}
        self.holds = []
        for r in seed_rows():
            h = dict(r)
            n = board.hold_number(h['id'])
            if h['kind'] == 'hand':
                h.update(name=check_holds.grid_name(n), x=HOLD_MAP[h['id']]['x'], y=HOLD_MAP[h['id']]['y'],
                         outline=shapes.get(h['id']))
            self.holds.append(h)
        self.args = (load('tools', 'led_map.json'), load('app', 'hold_map.json'), MIRROR)

    def test_seed_passes(self):
        self.assertEqual(self.ch.check(self.holds, self.bc, *self.args), [])

    def test_catches(self):
        for change in ({'led': 999}, {'mirror': 'hold1'}, {'name': 'Z9'}, {'x': 1}):
            holds = [dict(h) for h in self.holds]
            holds[5].update(change)
            self.assertTrue(self.ch.check(holds, self.bc, *self.args), change)
        holds = [dict(h) for h in self.holds]
        next(h for h in holds if h['id'] == 'hold2')['led'] = 25
        self.assertTrue(self.ch.check(holds, self.bc, *self.args))


class Cache(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'holds.json')
            self.assertIsNone(supa.load_cache(p))
            supa.save_cache(p, seed_rows())
            self.assertEqual(supa.load_cache(p), seed_rows())
            with open(p, 'w') as f:
                f.write('{not json')
            self.assertIsNone(supa.load_cache(p))


class Listener(unittest.TestCase):
    """pb_listener.holds_loop with Supabase and the cache file faked."""

    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:
            self.skipTest('pb_listener not importable: %s' % e)
        self.pb = pb_listener
        self.tmp = tempfile.TemporaryDirectory()
        L = pb_listener.Listener.__new__(pb_listener.Listener)
        L.cfg, L.status, L.status_path = {}, {'error_count': 0, 'last_error': None}, None
        L.mirror_map, L.holds_source = None, None
        L.holds_cache = os.path.join(self.tmp.name, 'holds.json')
        L.holds_wanted = asyncio.Event()
        self.L = L
        self.real_fetch = supa.fetch_holds
        self.logs = []
        self.real = (pb_listener.log, pb_listener.err, pb_listener.warn)
        pb_listener.log = pb_listener.err = pb_listener.warn = lambda m, *a: self.logs.append(m)

    def tearDown(self):
        supa.fetch_holds = self.real_fetch
        self.pb.log, self.pb.err, self.pb.warn = self.real
        board.set_holds(None)
        self.tmp.cleanup()

    def run_loop(self, wanted=True):
        async def go():
            if wanted:
                self.L.holds_wanted.set()
            t = asyncio.create_task(self.L.holds_loop())
            await asyncio.sleep(0.2)
            t.cancel()
            await asyncio.gather(t, return_exceptions=True)
        asyncio.run(go())

    def test_supabase_then_cached(self):
        supa.fetch_holds = lambda cfg: seed_rows()
        self.run_loop()
        self.assertEqual(self.L.holds_source, 'supabase')
        self.assertEqual(self.L.mirror_map, MIRROR)
        self.assertEqual(board.hold_led('hold2'), 26)
        self.assertEqual(supa.load_cache(self.L.holds_cache), seed_rows())
        # A boot with no network: the cached copy at once.
        board.set_holds(None)
        self.L.mirror_map, self.L.holds_source = None, None

        def down(cfg):
            raise OSError('no network')
        supa.fetch_holds = down
        self.run_loop()
        self.assertEqual(self.L.holds_source, 'cache')
        self.assertEqual(self.L.mirror_map, MIRROR)
        self.assertTrue(board.holds_loaded())

    def test_nothing_at_all_is_the_formula(self):
        def down(cfg):
            raise OSError('no network')
        supa.fetch_holds = down
        self.run_loop()
        self.assertIsNone(self.L.holds_source)
        self.assertEqual(self.L.status['holds_source'], 'formula')
        self.assertIsNone(self.L.mirror_map)               # mirrored casts skipped, as before
        self.assertFalse(board.holds_loaded())
        self.assertEqual(board.hold_led('hold24'), 54)

    def test_bad_rows_keep_the_last(self):
        supa.fetch_holds = lambda cfg: seed_rows()
        self.run_loop()
        supa.fetch_holds = lambda cfg: [{'id': 'hold1', 'kind': 'hand', 'led': None}]
        self.run_loop()                                    # (a restart: the cached copy first)
        self.assertEqual(self.L.holds_source, 'cache')
        self.assertTrue(any('holds not loaded' in m for m in self.logs))
        self.assertEqual(board.hold_led('hold24'), 54)
        self.assertEqual(supa.load_cache(self.L.holds_cache), seed_rows())   # the bad copy isn't cached


if __name__ == '__main__':
    unittest.main()
