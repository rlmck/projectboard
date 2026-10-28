"""Laptop tests for the LED mapping tool, pi/ledmap/pb_ledmap.py (no SPI, no network).

    python -m unittest discover -s pi/tests      (from the repo root)

Checks the board map against tools/led_map.json and app/hold_map.json, the
request checks, the column check, a problem lit exactly as the listener's
board.frame() lights it, the brightness, the idle clock (only POSTs count),
and the HTTP server end to end on 127.0.0.1 with a recording strip.
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'ledmap'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import leds  # noqa: E402
import pb_ledmap  # noqa: E402

CFG = {'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000', 'MA_PER_CHANNEL': '20', 'NIGHT_MODE': 'off'}
ROW = {'name': 'Test', 'finish_hold': 'hold200', 'intermediate_holds': ['hold100', 'hold2'],
       'start_holds': ['hold10', 'hold11']}


def load(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return json.load(f)


class Recorder(leds.Strip):
    """A strip that remembers each write instead of touching SPI."""
    def __init__(self, pixels=1200):
        super().__init__(pixels)
        self.writes = []

    def write(self, frame, pixels=None):
        self.writes.append(dict(frame))


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


pb_ledmap.log = lambda msg: None      # quiet: the server logs each POST


def make(**kw):
    clock = Clock()
    app = pb_ledmap.LedMap(Recorder(), CFG, 0.3, 1800, clock,
                           fetch_problem=lambda cfg, name: ROW if name == 'Test' else None,
                           fetch_mirror_map=lambda cfg: {'hold200': 'hold210', 'hold10': 'hold18'},
                           fetch_names=lambda cfg: ['Good Bug', 'Test'], **kw)
    return app, clock


class BoardMap(unittest.TestCase):
    def test_every_cell_matches_led_map_json(self):
        app, _ = make()
        m = load('tools', 'led_map.json')
        self.assertEqual(len(app.cells), 247)
        for c in app.cells:
            self.assertEqual(c['led'], m[c['hold']], c['hold'])

    def test_real_holds_are_the_apps(self):
        app, _ = make()
        real = {k for k in load('app', 'hold_map.json') if k.startswith('hold')}
        self.assertEqual({c['hold'] for c in app.cells if c['real']}, real)
        self.assertEqual(len(real), 188)
        # The feet-indicator cells have no hold, nor I12 (db/32: its LED is behind the board)
        for h in ('hold2', 'hold21', 'hold218'):
            self.assertFalse(next(c for c in app.cells if c['hold'] == h)['real'])

    def test_no_two_holds_share_a_position(self):
        # db/32: hold242's dot sat exactly on hold243's, one sign of the shifted labels
        m = load('app', 'hold_map.json')
        seen = {}
        for k, v in m.items():
            if k.startswith('hold'):
                p = (v['x'], v['y'])
                self.assertNotIn(p, seen, '%s and %s share a position' % (seen.get(p), k))
                seen[p] = k

    def test_cell_refs(self):
        self.assertEqual(pb_ledmap.cell_ref(1), 'A1')
        self.assertEqual(pb_ledmap.cell_ref(19), 'S1')
        self.assertEqual(pb_ledmap.cell_ref(20), 'A2')
        self.assertEqual(pb_ledmap.cell_ref(247), 'S13')


class Requests(unittest.TestCase):
    def test_hold_lights_one_led_scaled(self):
        app, _ = make()
        r = app.hold('hold24')
        self.assertEqual(r['led'], 54)
        self.assertEqual(app.strip.writes[-1], {54: (76, 76, 76)})     # white x 0.3
        app.hold(1, [255, 0, 0])
        self.assertEqual(app.strip.writes[-1], {1: (76, 0, 0)})          # the last one is off again

    def test_bad_input(self):
        app, _ = make()
        for bad in ('hold0', 'hold248', 'x', None, True, 0, 248):
            self.assertRaises(ValueError, app.hold, bad)
        for bad in (0, 1200, -1, '5', 2.5, True):
            self.assertRaises(ValueError, app.led, bad)
        for bad in ([256, 0, 0], [1, 2], '#12345', 'red', [1.0, 0, 0]):
            self.assertRaises(ValueError, app.hold, 'hold1', bad)
        self.assertEqual(app.strip.writes, [])

    def test_raw_led_and_hex_colour(self):
        app, _ = make()
        app.led(1199, '#00ff00')
        self.assertEqual(app.strip.writes[-1], {1199: (0, 76, 0)})

    def test_light_a_list(self):
        app, _ = make()
        app.light({'5': [255, 0, 0]}, {'hold24': [0, 0, 255]})
        self.assertEqual(app.strip.writes[-1], {5: (76, 0, 0), 54: (0, 0, 76)})

    def test_columns(self):
        frame = pb_ledmap.column_frame()
        self.assertEqual(len(frame), 38)
        self.assertEqual(frame[1], pb_ledmap.GREEN)      # A1, the bottom of column A
        self.assertEqual(frame[13], pb_ledmap.RED)       # A13
        self.assertEqual(frame[26], pb_ledmap.GREEN)     # B1: column B runs down, so LED 26 is its bottom
        self.assertEqual(frame[14], pb_ledmap.RED)       # B13

    def test_problem_is_lit_as_the_listener_lights_it(self):
        app, _ = make()
        for mirror in (False, True):
            r = app.problem('Test', mirror)
            mm = {'hold200': 'hold210', 'hold10': 'hold18'} if mirror else None
            want, _ = board.frame(ROW, mirror, mm)
            out, _, _ = board.scale(want, 0.5, 8000, 20)       # the listener's BRIGHTNESS, not the slider
            self.assertEqual(app.strip.writes[-1], out)
            b1 = next(h for h in r['holds'] if h['hold'] == 'hold2')
            self.assertEqual((b1['cell'], b1['led'], b1['real']), ('B1', 26, False))
        self.assertRaises(LookupError, app.problem, 'Nope')

    def test_brightness(self):
        app, _ = make()
        app.hold('hold1')
        app.set_brightness(0.6)
        self.assertEqual(app.strip.writes[-1], {1: (153, 153, 153)})      # re-shown at the new level
        app.problem('Test')
        n = len(app.strip.writes)
        app.set_brightness(0.1)
        self.assertEqual(len(app.strip.writes), n)                        # a problem keeps the cast brightness
        for bad in (0, 1.5, 'x', True):
            self.assertRaises(ValueError, app.set_brightness, bad)

    def test_clear_and_status(self):
        app, _ = make()
        app.hold('hold1')
        app.clear()
        self.assertEqual(app.strip.writes[-1], {})
        s = app.status()
        self.assertEqual((s['what'], s['lit'], s['pixels']), ('nothing', {}, 1200))

    def test_idle_clock(self):
        app, clock = make()
        clock.t += 1000
        self.assertEqual(app.idle_left(), 800)
        app.touch()
        self.assertEqual(app.idle_left(), 1800)
        clock.t += 1801
        self.assertEqual(app.idle_left(), 0)


class Http(unittest.TestCase):
    def setUp(self):
        self.app, self.clock = make()
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), pb_ledmap.make_handler(self.app))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = 'http://127.0.0.1:%d' % self.httpd.server_port

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def req(self, path, body=None, ctype='application/json'):
        data = None if body is None else json.dumps(body).encode()
        r = urllib.request.Request(self.base + path, data=data, headers={'Content-Type': ctype} if data else {})
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read()

    def test_page_and_data_files(self):
        for path in ('/', '/board.jpg', '/hold_map.json'):
            code, body = self.req(path)
            self.assertEqual(code, 200, path)
            self.assertTrue(body)
        self.assertEqual(self.req('/../config.env')[0], 404)

    def test_map_and_names(self):
        code, body = self.req('/api/map')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['real_count'], 188)
        self.assertEqual(json.loads(self.req('/api/problems')[1])['names'], ['Good Bug', 'Test'])

    def test_post_lights_and_counts_as_activity(self):
        self.clock.t += 600
        code, body = self.req('/api/hold', {'hold': 'hold24'})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['led'], 54)
        self.assertEqual(self.app.idle_left(), 1800)
        self.clock.t += 600
        self.req('/api/status')                        # polling isn't activity
        self.assertEqual(self.app.idle_left(), 1200)

    def test_json_only(self):
        self.assertEqual(self.req('/api/clear', {}, 'text/plain')[0], 415)
        self.assertEqual(self.req('/api/hold', {'hold': 'hold999'})[0], 400)
        self.assertEqual(self.req('/api/problem', {'name': 'Nope'})[0], 404)
        self.assertEqual(self.req('/api/nothing', {})[0], 404)
        self.assertEqual(self.app.strip.writes, [])

    def test_finish(self):
        code, _ = self.req('/api/finish', {})
        self.assertEqual(code, 200)
        self.assertTrue(self.app.stop.is_set())
        self.assertEqual(self.app.stop_reason, 'Finish on the page')


if __name__ == '__main__':
    unittest.main()
