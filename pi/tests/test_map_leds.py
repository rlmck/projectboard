"""Laptop tests for board setup's LED mapping event (contract 11).

    python -m unittest discover -s pi/tests      (from the repo root)

board.check_map / map_frame / strip_leds (the payload), the renderer's mapping
session (a preview with a sequence number: lit, taken over by a cast or another
session, waiting for a circuit and back, night, time-out, end, idle) and what it
says back through on_map, and the listener's map_leds and holds_changed handlers
and its map_state replies.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
import board  # noqa: E402
import circuit  # noqa: E402
import renderer  # noqa: E402
from test_circuit import CFG, SEQ, Clock, Strip  # noqa: E402

W = {57: (255, 255, 255)}
W2 = {58: (255, 255, 255)}
CAST = {100: (127, 0, 0)}


class Payload(unittest.TestCase):
    def test_check(self):
        self.assertEqual(board.check_map({'seq': 0, 'leds': [57]}, 248), (0, [57]))
        self.assertEqual(board.check_map({'seq': 7, 'leds': []}, 248), (7, []))          # dark, still held
        self.assertEqual(board.check_map({'seq': 7}, 248), (7, []))
        self.assertEqual(board.check_map({'seq': 9, 'leds': list(range(1, 17))}, 248)[1], list(range(1, 17)))
        self.assertEqual(board.check_map({'seq': 1, 'leds': [247]}, 248), (1, [247]))

    def test_refused(self):
        for body in ({'leds': [5]}, {'seq': -1, 'leds': [5]}, {'seq': True, 'leds': [5]}, {'seq': 1.0, 'leds': [5]},
                     {'seq': 2 ** 31, 'leds': [5]}, {'seq': 1, 'leds': 5}, {'seq': 1, 'leds': ['5']},
                     {'seq': 1, 'leds': [True]}, {'seq': 1, 'leds': [0]}, {'seq': 1, 'leds': [248]},
                     {'seq': 1, 'leds': [5, 5]}, {'seq': 1, 'leds': list(range(1, 18))}, {'seq': 1, 'leds': [5.0]}):
            with self.assertRaises(ValueError, msg=body):
                board.check_map(body, 248)

    def test_frame_is_white(self):
        self.assertEqual(board.map_frame([3, 9]), {3: (255, 255, 255), 9: (255, 255, 255)})
        out, cap, _ = board.scale(board.map_frame([3]), 1.0, 8000, 20)
        self.assertEqual((out, cap), ({3: (255, 255, 255)}, 1.0))

    def test_strip_leds(self):
        self.assertEqual(board.strip_leds({}), 248)
        self.assertEqual(board.strip_leds({'STRIP_LEDS': '300'}), 300)
        self.assertEqual(board.strip_leds({'STRIP_LEDS': '5000', 'STRIP_PIXELS': '1200'}), 1200)
        self.assertEqual(board.strip_leds({'STRIP_LEDS': '1'}), 2)
        self.assertEqual(board.strip_leds({'STRIP_LEDS': 'x'}), 248)


class Renderer(unittest.TestCase):
    def make(self, night=False, **cfg):
        self.clock, self.logs, self.said = Clock(), [], []
        self.strip = Strip()
        self.r = renderer.Renderer(self.strip, dict(CFG, **cfg), night, self.logs.append, self.logs.append,
                                   self.logs.append, clock=self.clock, seed=3)
        self.r.on_map = lambda token, seq, state: self.said.append((token, seq, state))
        self.r.step(self.clock.t)
        return self.r

    def go(self, seconds, dt=1 / 30):
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.r.step(self.clock.t)
            self.clock.t += dt

    def shown(self):
        return self.strip.writes[-1][0]

    def test_lights_each_led_says_so_and_ends_into_idle(self):
        r = self.make()
        r.preview('m1', W, seq=1)
        self.go(0.05)
        self.assertEqual((r.state, self.shown()), (renderer.PREVIEW, W))
        self.assertIsNone(self.strip.writes[-1][1])              # a full write: nothing else lit
        r.preview('m1', W2, seq=2)
        self.go(0.05)
        self.assertEqual(self.shown(), W2)
        r.preview('m1', {}, seq=3)                                # clear: dark, still held
        self.go(0.05)
        self.assertEqual((r.state, self.shown()), (renderer.PREVIEW, {}))
        self.assertEqual(self.said, [('m1', 1, 'lit'), ('m1', 2, 'lit'), ('m1', 3, 'lit')])
        r.preview_end('m1')
        self.go(0.05)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any('LEDs: LED mapping m1: 1 LEDs' in m for m in self.logs))
        self.assertTrue(any('LEDs: LED mapping m1 ended' in m for m in self.logs))

    def test_a_cast_takes_over_until_show(self):
        r = self.make()
        r.preview('m1', W, seq=1)
        self.go(0.1)
        r.cast(CAST)
        self.go(0.1)
        self.assertEqual((r.state, self.said[-1]), (renderer.CAST, ('m1', 1, 'taken')))
        r.preview('m1', W2, seq=2)                                # ignored, and it says so
        self.go(0.1)
        self.assertEqual((self.shown(), self.said[-1]), (CAST, ('m1', 2, 'taken')))
        r.preview('m1', W2, show=True, seq=3)                     # Take the board back
        self.go(0.1)
        self.assertEqual((r.state, self.shown(), self.said[-1]), (renderer.PREVIEW, W2, ('m1', 3, 'lit')))

    def test_another_session_takes_it(self):
        r = self.make()
        r.preview('m1', W, seq=1)
        self.go(0.1)
        r.preview('p2', CAST)                                     # someone setting a problem (no seq)
        self.go(0.1)
        self.assertEqual((self.shown(), self.said[-1]), (CAST, ('m1', 1, 'taken')))
        r.preview('m2', W2, seq=1)                                # and another phone mapping
        self.go(0.1)
        self.assertEqual(self.shown(), W2)
        self.assertEqual(self.said[-1], ('m2', 1, 'lit'))
        self.assertTrue(any('p2 taken over by another LED mapping' in m for m in self.logs))

    def test_a_circuit_wins_then_it_comes_back(self):
        r = self.make()
        r.preview('m1', W, seq=1)
        self.go(0.1)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        self.go(0.5)
        self.assertEqual((r.state, self.said[-1]), (renderer.RUN, ('m1', 1, 'waiting')))
        r.preview('m1', W2, seq=2)
        self.go(0.5)
        self.assertEqual((r.state, self.said[-1]), (renderer.RUN, ('m1', 2, 'waiting')))
        r.stop_circuit('r1')
        self.go(0.1)
        self.assertEqual((r.state, self.shown(), self.said[-1]), (renderer.PREVIEW, W2, ('m1', 2, 'lit')))

    def test_night(self):
        r = self.make(night=True)
        r.preview('m1', {}, seq=1)
        r.preview('m1', {}, seq=2)
        self.go(0.1)
        self.assertEqual((r.state, self.said), (renderer.NIGHT, [('m1', 1, 'night'), ('m1', 2, 'night')]))
        self.assertEqual(sum('LED mapping m1 not shown, night' in m for m in self.logs), 1)
        r = self.make()
        r.preview('m1', W, seq=5)
        self.go(0.1)
        r.set_night(True)
        self.go(4)
        self.assertEqual((r.state, self.shown(), self.said[-1]), (renderer.NIGHT, {}, ('m1', 5, 'night')))

    def test_times_out_and_idle_now(self):
        r = self.make(PREVIEW_TIMEOUT_S='60')
        r.preview('m1', W, seq=1)
        self.go(61, dt=0.5)
        self.assertEqual((r.state, self.said[-1]), (renderer.IDLE, ('m1', 1, 'ended')))
        r.preview('m1', W2, seq=2)                                # the phone carries on: it shows again
        self.go(0.1)
        self.assertEqual((r.state, self.said[-1]), (renderer.PREVIEW, ('m1', 2, 'lit')))
        r.idle_now()
        self.go(0.1)
        self.assertEqual((r.state, self.said[-1]), (renderer.IDLE, ('m1', 2, 'ended')))

    def test_previews_say_nothing(self):
        r = self.make()
        r.preview('p1', CAST)
        self.go(0.1)
        r.cast(W)
        self.go(0.1)
        self.assertEqual(self.said, [])
        self.assertTrue(any('LEDs: preview p1 taken over by a problem cast' in m for m in self.logs))

    def test_a_failing_reply_never_stops_the_board(self):
        r = self.make()

        def boom(*a):
            raise RuntimeError('socket gone')
        r.on_map = boom
        r.preview('m1', W, seq=1)
        self.go(0.1)
        self.assertEqual(self.shown(), W)
        self.assertTrue(any('LED mapping reply failed' in m for m in self.logs))


class Listener(unittest.TestCase):
    """pb_listener.on_map / on_holds_changed / map_reply, with the LED thread replaced by a recorder."""

    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:                 # websockets isn't installed on this machine
            self.skipTest('pb_listener not importable: %s' % e)
        import collections
        self.pb = pb_listener
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.cfg = {'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000', 'MA_PER_CHANNEL': '20',
                      'BOARD_WALL': 'HangoutPortland'}
        self.L.mode = 'day'
        self.L.status = {}
        self.L.strip_leds = 248
        self.L.outbox = collections.deque(maxlen=pb_listener.OUTBOX_MAX)

        class Ev:
            def __init__(s):
                s.n = 0

            def set(s):
                s.n += 1
        self.L.out_ready = Ev()
        self.L.holds_wanted = Ev()
        self.L.holds_asked_at = -100
        self.calls = []

        class Leds:
            def preview(_, token, frame, show=False, seq=None):
                self.calls.append(('preview', token, frame, show, seq))

            def preview_end(_, token):
                self.calls.append(('end', token))
        self.L.leds = Leds()

    def test_handles(self):
        self.L.on_map({'session': 'ab12', 'seq': 1, 'leds': [57], 'first': True})
        self.L.on_map({'session': 'ab12', 'seq': 2, 'leds': [], 'show': True})
        self.L.on_map({'session': 'ab12', 'end': True})
        self.assertEqual(self.calls, [('preview', 'ab12', {57: (255, 255, 255)}, False, 1),
                                      ('preview', 'ab12', {}, True, 2), ('end', 'ab12')])

    def test_bad_messages(self):
        self.L.on_map({'session': 'ab12', 'seq': 3, 'leds': [0]})          # LED 0: refused, said back
        self.L.on_map({'session': 'ab12', 'seq': 4, 'leds': [300]})        # past the strip
        self.L.on_map({'session': 'ab12', 'leds': [5]})                    # no seq: nothing to say it to
        self.L.on_map({'session': '', 'seq': 1, 'leds': [5]})
        self.L.on_map('nope')
        self.assertEqual(self.calls, [])
        said = [p for e, p in self.L.outbox]
        self.assertEqual([(p['seq'], p['state'], p['count']) for p in said], [(3, 'bad', 248), (4, 'bad', 248)])
        self.assertIn('LED 300 is not 1-247', said[1]['error'])

    def test_night_goes_to_the_led_thread(self):
        self.L.mode = 'night'
        self.L.on_map({'session': 'ab12', 'seq': 1, 'leds': [57]})
        self.assertEqual(self.calls, [('preview', 'ab12', {}, False, 1)])

    def test_reply_goes_through_the_loop(self):
        queued = []

        class Loop:
            def call_soon_threadsafe(_, fn, *a):
                queued.append(a)
                fn(*a)
        self.L.loop = Loop()
        self.L.map_reply('ab12', 7, 'lit')
        self.assertEqual(list(self.L.outbox), [('map_state', {'session': 'ab12', 'seq': 7, 'state': 'lit',
                                                              'count': 248})])
        self.assertEqual(self.L.out_ready.n, 1)
        self.L.loop = None
        self.L.map_reply('ab12', 8, 'lit')                                 # not running yet: dropped
        self.assertEqual(len(self.L.outbox), 1)

    def test_holds_changed(self):
        self.L.on_holds_changed({'wall': 'HangoutPortland', 'source': 'phone', 'signed_in': True})
        self.L.on_holds_changed({})                                        # within 5 s: once is enough
        self.L.on_holds_changed({'wall': 'Elsewhere'})
        self.assertEqual(self.L.holds_wanted.n, 1)
        self.L.holds_asked_at -= self.pb.HOLDS_ASK_MIN
        self.L.on_holds_changed(None)
        self.assertEqual(self.L.holds_wanted.n, 2)

    def test_events_registered(self):
        self.assertIs(self.pb.Listener.EVENTS['map_leds'], self.pb.Listener.on_map)
        self.assertIs(self.pb.Listener.EVENTS['holds_changed'], self.pb.Listener.on_holds_changed)


if __name__ == '__main__':
    unittest.main()
