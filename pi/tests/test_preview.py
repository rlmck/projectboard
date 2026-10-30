"""Laptop tests for the live preview while setting (contract 9).

    python -m unittest discover -s pi/tests      (from the repo root)

board.check_preview / preview_frame (the payload and the colours), the
renderer's preview state against cast, circuit, idle and night, and the
listener's preview_holds handler.
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

GREEN, BLUE, RED = board.COLOURS[board.START], board.COLOURS[board.INT], board.COLOURS[board.FINISH]
A = {54: (0, 127, 0), 60: (0, 0, 127)}
B = {100: (127, 0, 0)}


class Payload(unittest.TestCase):
    def test_check(self):
        sel = board.check_preview({'start': ['hold1'], 'hold': ['hold40'], 'finish': ['hold230'], 'feet': 'black'})
        self.assertEqual(sel, (['hold1'], ['hold40'], ['hold230'], 'black'))
        self.assertEqual(board.check_preview({}), ([], [], [], 'any'))     # an empty selection is fine

    def test_refused(self):
        for body in ({'start': 'hold1'}, {'start': ['hold1', 'hold2', 'hold3']}, {'finish': ['hold1', 'hold2']},
                     {'hold': [1]}, {'hold': ['hold1'] * 101}, {'feet': 'red'}, {'hold': ['x' * 11]}):
            with self.assertRaises(ValueError, msg=body):
                board.check_preview(body)

    def test_frame_colours_feet_and_dropped(self):
        leds, dropped = board.preview_frame(['hold1', 'hold3'], ['hold40', 'hold999', 'hold2'], ['hold230'], 'orange')
        self.assertEqual(leds[board.led_index(1)], GREEN)
        self.assertEqual(leds[board.led_index(40)], BLUE)
        self.assertEqual(leds[board.led_index(230)], RED)
        self.assertEqual(leds[25], BLUE)                    # Orange only: the B2 sign
        self.assertNotIn(26, leds)                          # hold2 (B1) is never a hold
        self.assertEqual(dropped, ['hold999'])
        self.assertEqual(len(leds), 5)

    def test_the_stronger_role_wins(self):
        leds, _ = board.preview_frame(['hold40'], ['hold40'], ['hold40'], 'any')
        self.assertEqual(leds, {board.led_index(40): RED})

    def test_same_colours_as_a_cast(self):
        # Set as start a, b; hold c; finish d = stored inverted as a cast reads it (contract 6.2).
        row = {'finish_hold': 'hold1', 'intermediate_holds': ['hold3'], 'start_holds': ['hold40', 'hold230']}
        cast, _ = board.frame(row)
        prev, _ = board.preview_frame(['hold1', 'hold3'], ['hold40'], ['hold230'])
        self.assertEqual(cast, prev)


class Renderer(unittest.TestCase):
    def make(self, night=False, **cfg):
        self.clock, self.logs = Clock(), []
        self.strip = Strip()
        self.r = renderer.Renderer(self.strip, dict(CFG, **cfg), night, self.logs.append, self.logs.append,
                                   self.logs.append, clock=self.clock, seed=3)
        self.r.step(self.clock.t)
        return self.r

    def go(self, seconds, dt=1 / 30):
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.r.step(self.clock.t)
            self.clock.t += dt

    def shown(self):
        return self.strip.writes[-1][0]

    def test_cuts_in_follows_changes_and_ends_into_idle(self):
        r = self.make()
        r.preview('s1', A)
        self.go(0.05)
        self.assertEqual(r.state, renderer.PREVIEW)
        self.assertEqual(self.shown(), A)
        self.assertIsNone(self.strip.writes[-1][1])          # a full write: nothing left over
        r.preview('s1', B)
        self.go(0.05)
        self.assertEqual(self.shown(), B)
        r.preview_end('s1')
        self.go(0.05)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertEqual(r.stats()['leds'] != 'preview', True)

    def test_times_out_without_messages(self):
        r = self.make(PREVIEW_TIMEOUT_S='60')
        r.preview('s1', A)
        self.go(40, dt=0.5)
        r.preview('s1', A)                                    # the keep-alive
        self.go(40, dt=0.5)
        self.assertEqual(r.state, renderer.PREVIEW)
        self.go(25, dt=0.5)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any('no message for 60 s' in m for m in self.logs))

    def test_a_cast_takes_over_until_show(self):
        r = self.make()
        r.preview('s1', A)
        self.go(0.1)
        r.cast(B)
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)
        r.preview('s1', A)                                    # a tap or a keep-alive: ignored
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(self.shown(), B)
        r.preview('s1', A, show=True)                         # Show on board
        self.go(0.1)
        self.assertEqual(r.state, renderer.PREVIEW)
        self.assertEqual(self.shown(), A)

    def test_latest_preview_wins(self):
        r = self.make()
        r.preview('s1', A)
        self.go(0.1)
        r.preview('s2', B)
        self.go(0.1)
        self.assertEqual(self.shown(), B)
        r.preview('s1', A)                                    # s1 was taken over
        self.go(0.1)
        self.assertEqual(self.shown(), B)
        r.preview_end('s1')                                   # its end changes nothing
        self.go(0.1)
        self.assertEqual(r.state, renderer.PREVIEW)
        r.preview('s1', A, show=True)
        self.go(0.1)
        self.assertEqual(self.shown(), A)
        self.assertTrue(any('s2 taken over by another preview' in m for m in self.logs))

    def test_a_circuit_wins_and_the_preview_comes_back(self):
        r = self.make()
        r.preview('s1', A)
        self.go(0.1)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(1)
        self.assertEqual(r.state, renderer.RUN)
        r.preview('s1', B)                                    # a tap during the run: kept, not shown
        self.go(1)
        self.assertEqual(r.state, renderer.RUN)
        r.stop_circuit('r1')
        self.go(0.1)
        self.assertEqual(r.state, renderer.PREVIEW)
        self.assertEqual(self.shown(), B)

    def test_after_a_circuit_a_stale_preview_goes_idle(self):
        r = self.make(PREVIEW_TIMEOUT_S='5')
        r.preview('s1', A)
        self.go(0.1)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(10, dt=0.25)
        r.stop_circuit('r1')
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)

    def test_night_blocks_and_ends_it(self):
        r = self.make(night=True)
        r.preview('s1', A)
        r.preview('s1', A)
        self.go(0.1)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(sum('not shown, night' in m for m in self.logs), 1)
        r = self.make()
        r.preview('s1', A)
        self.go(0.1)
        r.set_night(True)
        self.go(4)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(self.shown(), {})
        self.assertIsNone(r.pv)

    def test_idle_now_ends_it(self):
        r = self.make()
        r.preview('s1', A)
        self.go(0.1)
        r.idle_now()
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertIsNone(r.pv)

    def test_brightness_rewrites_it(self):
        r = self.make()
        r.preview('s1', {54: (0, 200, 0)})
        self.go(0.1)
        r.set_pattern('brightness 0.5')
        self.go(0.1)
        self.assertLess(self.shown()[54][1], 200)               # rewritten, dimmed at the strip
        self.assertEqual(r.shown, {54: (0, 200, 0)})            # kept undimmed
        self.assertEqual(r.scale, 0.5)


class Listener(unittest.TestCase):
    """pb_listener.on_preview, with the LED thread replaced by a recorder."""

    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:                 # websockets isn't installed on this machine
            self.skipTest('pb_listener not importable: %s' % e)
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.cfg = {'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000', 'MA_PER_CHANNEL': '20'}
        self.L.mode = 'day'
        self.L.status = {}
        self.calls = []

        class Leds:
            def preview(_, token, frame, show=False):
                self.calls.append(('preview', token, frame, show))

            def preview_end(_, token):
                self.calls.append(('end', token))
        self.L.leds = Leds()

    def test_handles(self):
        self.L.on_preview({'session': 'ab12', 'start': ['hold1'], 'hold': [], 'finish': [], 'feet': 'any'})
        self.L.on_preview({'session': 'ab12', 'start': ['hold1'], 'show': True})
        self.L.on_preview({'session': 'ab12', 'end': True})
        self.L.on_preview({'session': '', 'start': []})                   # bad session
        self.L.on_preview({'session': 'ab12', 'start': ['hold1'] * 3})     # too many starts
        self.L.on_preview('nope')
        self.assertEqual(self.calls[0], ('preview', 'ab12', {board.led_index(1): (0, 128, 0)}, False))
        self.assertEqual(self.calls[1][3], True)
        self.assertEqual(self.calls[2], ('end', 'ab12'))
        self.assertEqual(len(self.calls), 3)


if __name__ == '__main__':
    unittest.main()
