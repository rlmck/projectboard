"""Laptop tests for a circuit's static view (show_circuit, contract 8.7, 2 Nov 2026).

    python -m unittest discover -s pi/tests      (from the repo root)

circuit.static_frame(): every distinct hold lit once in its strongest role
(finish > start > move), start_count clamped to 1-2, a hold that's both a start
and the last hold red, feet signs and ids off the grid dropped; then the
listener: on_show_circuit's payload checks and night, and show_circuit_view
lighting the frame as a problem cast (the renderer's CAST state, so latest wins
and the idle timer applies), an unknown circuit leaving the board alone, and a
newer cast superseding it.
"""
import asyncio
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
from circuit import BLUE, GREEN, RED  # noqa: E402
from test_circuit import CFG, SEQ, Clock, Strip  # noqa: E402


def led(h):
    return board.led_index(board.hold_number(h))


class StaticFrame(unittest.TestCase):
    def test_roles_like_the_wall_screen(self):
        leds, dropped = circuit.static_frame(SEQ, 2)
        self.assertEqual(dropped, [])
        self.assertEqual(len(leds), len(set(SEQ)))                 # the match (hold200 twice) lit once
        self.assertEqual(leds[led('hold3')], GREEN)
        self.assertEqual(leds[led('hold1')], GREEN)
        self.assertEqual(leds[led('hold40')], RED)                  # the last hold
        for h in set(SEQ) - {'hold3', 'hold1', 'hold40'}:
            self.assertEqual(leds[led(h)], BLUE, h)

    def test_start_count(self):
        leds, _ = circuit.static_frame(SEQ, 1)
        self.assertEqual(leds[led('hold3')], GREEN)
        self.assertEqual(leds[led('hold1')], BLUE)
        for sc in (None, 0, 'x'):                                     # as a run: at least one start
            self.assertEqual(circuit.static_frame(SEQ, sc)[0][led('hold1')], BLUE, sc)
        self.assertEqual(circuit.static_frame(SEQ, 5)[0], circuit.static_frame(SEQ, 2)[0])   # at most two

    def test_finish_beats_start(self):
        # Ends where it started (a loop back to the start hold): the last hold is red.
        leds, _ = circuit.static_frame(['hold3', 'hold1', 'hold80', 'hold3'], 2)
        self.assertEqual(leds[led('hold3')], RED)
        self.assertEqual(leds[led('hold1')], GREEN)
        self.assertEqual(leds[led('hold80')], BLUE)
        self.assertEqual(circuit.static_frame(['hold5'], 2)[0], {led('hold5'): RED})

    def test_a_start_repeated_later_stays_green(self):
        leds, _ = circuit.static_frame(['hold3', 'hold1', 'hold80', 'hold3', 'hold120'], 2)
        self.assertEqual(leds[led('hold3')], GREEN)
        self.assertEqual(leds[led('hold120')], RED)

    def test_feet_signs_and_bad_ids_light_nothing(self):
        leds, dropped = circuit.static_frame(['hold3', 'hold2', 'hold80', 'hold21', 'hold999', 'hold40'], 2)
        self.assertEqual(sorted(dropped), ['hold2', 'hold21', 'hold999'])
        self.assertNotIn(led('hold2'), leds)
        self.assertNotIn(led('hold21'), leds)
        self.assertEqual(leds[led('hold3')], GREEN)                 # hold2 still took the second start's place
        self.assertEqual(leds[led('hold40')], RED)

    def test_bad_sequence(self):
        for bad in (None, [], ['hold1', 7], 'hold1'):
            with self.assertRaises(ValueError):
                circuit.static_frame(bad, 2)


class Listener(unittest.TestCase):
    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:                 # websockets isn't installed on this machine
            self.skipTest('pb_listener not importable: %s' % e)
        self.pb = pb_listener
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.cfg = {'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000', 'MA_PER_CHANNEL': '20'}
        self.L.mode, self.L.pending, self.L.status_path = 'day', None, None
        self.L.status = {'casts_shown': 0, 'casts_ignored_night': 0}
        self.cast = []

        class Ready:
            def set(_):
                pass

        class Leds:
            def cast(_, frame):
                self.cast.append(frame)
        self.L.cast_ready, self.L.leds = Ready(), Leds()

    def test_payload(self):
        self.L.on_show_circuit({'circuit_name': 'Pat Burner', 'source': 'wall', 'signed_in': False})
        self.assertEqual(self.L.pending[:2], ('view', 'Pat Burner'))
        for bad in ({'circuit_name': ''}, {'circuit_name': 'x' * 61}, {'circuit_name': 7}, {}, 'nope'):
            self.L.pending = None
            self.L.on_show_circuit(bad)
            self.assertIsNone(self.L.pending, bad)

    def test_night(self):
        self.L.mode = 'night'
        self.L.on_show_circuit({'circuit_name': 'Pat Burner'})
        self.assertIsNone(self.L.pending)
        self.assertEqual(self.L.status['casts_ignored_night'], 1)

    def run_view(self, row, pending=None):
        old = self.pb.supa.fetch_circuit

        def fetch(cfg, name):
            self.L.pending = pending         # a newer cast arriving while the circuit is read
            return row
        self.pb.supa.fetch_circuit = fetch
        try:
            asyncio.run(self.L.show_circuit_view('Pat Burner', 0))
        finally:
            self.pb.supa.fetch_circuit = old

    def test_lights_as_a_problem_cast(self):
        self.run_view({'name': 'Pat Burner', 'hold_sequence': SEQ, 'start_count': 2, 'loops': True})
        self.assertEqual(len(self.cast), 1)
        frame = self.cast[0]
        self.assertEqual(frame[led('hold3')], (0, 128, 0))          # BRIGHTNESS 0.5
        self.assertEqual(frame[led('hold40')], (128, 0, 0))
        self.assertEqual(self.L.status['last_cast_name'], 'circuit: Pat Burner')
        self.assertEqual(self.L.status['casts_shown'], 1)

    def test_unknown_or_superseded_leaves_the_board(self):
        self.run_view(None)
        self.run_view({'hold_sequence': SEQ, 'start_count': 2}, pending=('problem', 'Crimp', False, 0))
        self.assertEqual(self.cast, [])


class Renderer(unittest.TestCase):
    """The view goes in as a cast: it replaces a circuit run, and idles after IDLE_AFTER_S."""

    def test_replaces_a_run_and_idles(self):
        clock, strip, logs = Clock(), Strip(), []
        r = renderer.Renderer(strip, CFG, False, logs.append, logs.append, logs.append, clock=clock, seed=3)
        r.step(clock.t)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        r.step(clock.t)
        self.assertEqual(r.state, renderer.RUN)
        frame, _, _ = board.scale(circuit.static_frame(SEQ, 2)[0], 0.5, 8000, 20)
        r.cast(frame)
        clock.t += 0.1
        r.step(clock.t)
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(strip.writes[-1][0], frame)
        self.assertTrue(any(m.startswith("circuit ended: 'Test' replaced") for m in logs))
        clock.t += float(CFG['IDLE_AFTER_S']) + 0.1
        r.step(clock.t)
        self.assertEqual(r.state, renderer.IDLE)


if __name__ == '__main__':
    unittest.main()
