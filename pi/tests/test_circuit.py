"""Laptop tests for circuit runs (circuit.py) and the renderer's circuit state.

    python -m unittest discover -s pi/tests      (from the repo root)

The look (direction 4, "Pulse and fade") at each phase: the countdown, the
moving holds, a match, a later lap, the finish; then the renderer: a run
animates, a stop with the wrong run token is ignored, the right one, the finish
and the time limit go idle, a problem cast cuts in, and night wins.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import circuit  # noqa: E402
import renderer  # noqa: E402
from circuit import AMBER, BLUE, COUNTDOWN, GREEN, RED  # noqa: E402

# Like the live Pat Burner: two starts, a match at positions 5-6, twelve holds.
SEQ = ['hold3', 'hold1', 'hold80', 'hold120', 'hold160', 'hold200', 'hold200', 'hold180', 'hold140',
       'hold100', 'hold60', 'hold40']
CFG = {'IDLE_AFTER_S': '60', 'IDLE_ANIMATION': 'on', 'IDLE_FPS': '30', 'IDLE_MAX_AMPS': '2.0',
       'IDLE_BRIGHTNESS': '1.0', 'MA_PER_CHANNEL': '20', 'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000'}


def at(run, move, into=0.5):
    """t for `into` seconds into move `move` (0 = the first move after the countdown)."""
    return COUNTDOWN + move * run.interval + into


class Look(unittest.TestCase):
    def setUp(self):
        self.run = circuit.Run('Test', SEQ, 2, 3, False, 'r1')

    def test_countdown_flashes(self):
        on, _ = self.run.holds_at(1.2)
        self.assertEqual(on['hold3'], (RED, 1))
        self.assertEqual(on['hold1'], (RED, 1))
        self.assertEqual(on['hold80'], (BLUE, 1))
        self.assertEqual(on['hold120'], (BLUE, 1))
        self.assertEqual(len(on), 4)
        off, _ = self.run.holds_at(1.7)
        self.assertEqual(off, {})

    def test_first_move(self):
        h, done = self.run.holds_at(at(self.run, 0, 0.4))
        self.assertFalse(done)
        self.assertEqual(h['hold3'], (GREEN, 1))           # on the starts
        self.assertEqual(h['hold1'], (GREEN, 1))
        self.assertEqual(h['hold80'], (BLUE, 1))           # the hold to go to: solid
        self.assertEqual(h['hold120'][0], AMBER)           # the hold after: amber
        self.assertEqual(len(h), 4)                        # nothing let go of yet

    def test_amber_swells_and_red_fades(self):
        early = self.run.holds_at(at(self.run, 2, 0.5))[0]
        late = self.run.holds_at(at(self.run, 2, 2.5))[0]
        # move 2: on hold120/hold80, let go of hold1, after next is hold200
        self.assertEqual(early['hold1'][0], RED)
        self.assertGreater(early['hold1'][1], late['hold1'][1])            # the red fades over the move
        self.assertGreater(late['hold200'][1], early['hold200'][1])        # each swell peaks brighter
        self.assertLess(self.run.holds_at(at(self.run, 2, 0.0))[0].get('hold1', (RED, 0))[1], 0.01)  # soft start

    def test_a_match_stays_solid(self):
        # move 4: on hold200 (position 5), going to hold200 again (position 6)
        for into in (0.0, 0.2, 0.4, 0.6, 1.0, 2.9):
            h, _ = self.run.holds_at(at(self.run, 4, into))
            self.assertEqual(h['hold200'], (BLUE, 1), into)

    def test_finish_then_done(self):
        t_top = COUNTDOWN + self.run.moves * self.run.interval
        h, done = self.run.holds_at(t_top + 0.5)
        self.assertFalse(done)
        self.assertEqual(h['hold40'], (RED, 1))
        self.assertTrue(self.run.holds_at(t_top + self.run.finish_length() + 0.01)[1])
        # the hold to go to on the last move is the red finish
        self.assertEqual(self.run.holds_at(t_top - 1)[0]['hold40'], (RED, 1))

    def test_loop_has_no_finish_and_starts_go_blue(self):
        run = circuit.Run('Test', SEQ, 2, 2, True)
        t = at(run, len(SEQ) + 3, 0.3)              # well into lap 2
        h, done = run.holds_at(t)
        self.assertFalse(done)
        self.assertNotIn(GREEN, [rgb for rgb, _ in h.values()])
        self.assertFalse(run.holds_at(at(run, 500))[1])
        self.assertNotIn(RED, [rgb for rgb, a in run.holds_at(at(run, 9, 0.5))[0].values() if a == 1])

    def test_one_start(self):
        run = circuit.Run('Test', SEQ, 1, 3, False)
        h, _ = run.holds_at(at(run, 0, 0.4))
        self.assertEqual(h['hold3'], (GREEN, 1))
        self.assertEqual(h['hold1'], (BLUE, 1))     # the hold to go to
        self.assertEqual(run.moves, len(SEQ) - 1)

    def test_moves_at(self):
        self.assertEqual(self.run.moves_at(3), 0)
        self.assertEqual(self.run.moves_at(at(self.run, 4)), 4)
        self.assertEqual(self.run.moves_at(10_000), self.run.moves)
        loop = circuit.Run('Test', SEQ, 2, 2, True)
        self.assertEqual(loop.moves_at(at(loop, 30)), 30)

    def test_frame_leds_and_mirror(self):
        leds, _ = self.run.frame(at(self.run, 0, 0.4))
        self.assertEqual(set(leds), {board.led_index(n) for n in (3, 1, 80, 120)})
        mm = {'hold3': 'hold17', 'hold17': 'hold3'}
        mirrored = circuit.Run('Test', SEQ, 2, 3, False, mirror_map=mm)
        leds, _ = mirrored.frame(at(mirrored, 0, 0.4))
        self.assertIn(board.led_index(17), leds)
        self.assertNotIn(board.led_index(3), leds)

    def test_off_grid_and_feet_ids_light_nothing(self):
        run = circuit.Run('Test', ['hold3', 'hold999', 'hold21', 'hold80', 'hold120'], 2, 3, False)
        self.assertEqual(sorted(run.dropped), ['hold21', 'hold999'])
        for t in (1.0, at(run, 0, 0.4), at(run, 1, 0.4)):
            leds, _ = run.frame(t)
            self.assertTrue(all(1 <= i <= board.MAX_HOLD for i in leds))
            self.assertNotIn(board.led_index(21), leds)

    def test_bad_sequence(self):
        with self.assertRaises(ValueError):
            circuit.Run('Test', [], 2, 3, False)
        with self.assertRaises(ValueError):
            circuit.Run('Test', None, 2, 3, False)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Strip:
    def __init__(self):
        self.writes = []

    def write(self, leds, pixels=None):
        self.writes.append((dict(leds), pixels))


class Renderer(unittest.TestCase):
    def make(self, night=False, **cfg):
        self.clock, self.logs = Clock(), []
        self.strip = Strip()
        self.r = renderer.Renderer(self.strip, dict(CFG, **cfg), night, self.logs.append, self.logs.append,
                                   self.logs.append, clock=self.clock, seed=3)
        self.r.step(self.clock.t)          # goes idle at start
        return self.r

    def go(self, seconds, dt=1 / 30):
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.r.step(self.clock.t)
            self.clock.t += dt

    def test_runs_then_finishes_into_idle(self):
        r = self.make()
        run = circuit.Run('Test', SEQ, 2, 2, False, 'r1')
        r.circuit(run)
        r.step(self.clock.t)
        self.assertEqual(r.state, renderer.RUN)
        self.assertIsNone(self.strip.writes[-1][1])       # the first frame clears the whole strip
        self.go(COUNTDOWN + 1)
        self.assertEqual(r.state, renderer.RUN)
        self.assertEqual(self.strip.writes[-1][1], renderer.BOARD_PIXELS)
        self.assertLessEqual(max(max(rgb) for rgb in self.strip.writes[-1][0].values()), 128)   # cast brightness 0.5
        self.go(run.moves * run.interval + run.finish_length())
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any('finished' in m for m in self.logs))

    def test_stop_needs_the_right_token(self):
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(7)
        r.stop_circuit('other')
        self.go(0.1)
        self.assertEqual(r.state, renderer.RUN)
        r.stop_circuit('r1')
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)

    def test_stop_without_token_stops_any_and_is_harmless_when_idle(self):
        r = self.make()
        r.stop_circuit(None)
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(2)
        r.stop_circuit(None)
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)

    def test_a_problem_cast_cuts_in(self):
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(8)
        r.cast({54: (0, 127, 0)})
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(self.strip.writes[-1][0], {54: (0, 127, 0)})
        r.stop_circuit('r1')                       # a late stop leaves the problem alone
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)

    def test_time_limit(self):
        r = self.make(CIRCUIT_MAX_S='30')
        r.circuit(circuit.Run('Test', SEQ, 2, 2, True, 'r1'))
        self.go(31, dt=0.25)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any('the limit' in m for m in self.logs))

    def test_night_wins(self):
        r = self.make(night=True)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(0.1)
        self.assertEqual(r.state, renderer.NIGHT)
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, True, 'r1'))
        self.go(6)
        r.set_night(True)
        self.go(4)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(self.strip.writes[-1][0], {})


if __name__ == '__main__':
    unittest.main()
