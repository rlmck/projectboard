"""Laptop tests for circuit runs (circuit.py) and the renderer's circuit state.

    python -m unittest discover -s pi/tests      (from the repo root)

The "map and next hold" look (5 Nov 2026, contract 8.3): the countdown blink's
values, the blue map and the red finish (on the final lap of a set number of
laps only, never endless), the hold to go to (green, solid), a match's two
blinks, laps (the move count for 1, 3 and endless, the wrap from lap 2), the
top (three red blinks, the map fading out), mirroring and ids off the grid;
the config options; then the renderer: a run animates and finishes into idle,
stop tokens, a problem cast cutting in, the time limit, night. Then the
listener's cast_circuit parsing (laps, every backward-compatibility case,
trace_s ignored) and the laps the run gets from the circuit's loops. Circuit
tracks: check_track still checks (PB Console saves through it), though the Pi
no longer draws them.
"""
import asyncio
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import circuit  # noqa: E402
import renderer  # noqa: E402
from circuit import BLUE, COUNTDOWN, GREEN, RED  # noqa: E402

# Like the live Pat Burner: two starts, a match at positions 5-6, twelve holds.
SEQ = ['hold3', 'hold1', 'hold80', 'hold120', 'hold160', 'hold200', 'hold200', 'hold180', 'hold140',
       'hold100', 'hold60', 'hold40']
CFG = {'IDLE_AFTER_S': '60', 'IDLE_ANIMATION': 'on', 'IDLE_FPS': '30', 'IDLE_MAX_AMPS': '2.0',
       'IDLE_BRIGHTNESS': '1.0', 'MA_PER_CHANNEL': '20', 'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000'}

MAP = tuple(v * 0.2 for v in BLUE)          # the default map level
FIN = tuple(v * 0.6 for v in RED)           # the default finish level
OFF = (0.0, 0.0, 0.0)


def at(run, move, into=0.5):
    """t for `into` seconds into move `move` (0 = the first move after the countdown)."""
    return COUNTDOWN + move * run.interval + into


def close(a, b):
    return all(abs(x - y) < 1e-6 for x, y in zip(a, b))


def greens(holds):
    return sorted(h for h, rgb in holds.items() if rgb[1] > 0)


class Blink(unittest.TestCase):
    def test_blink_values(self):
        self.assertEqual(circuit.blink(0.0), 1.0)
        self.assertEqual(circuit.blink(0.079), 1.0)                 # full for 0.08 s
        self.assertAlmostEqual(circuit.blink(0.08), 1.0)
        self.assertAlmostEqual(circuit.blink(0.48), 0.5)            # half-way through the 0.8 s fade
        self.assertAlmostEqual(circuit.blink(0.88), 0.0)            # off from 0.88 s
        self.assertEqual(circuit.blink(0.95), 0.0)
        self.assertEqual(circuit.blink(1.02), 1.0)                  # once a second
        self.assertAlmostEqual(circuit.blink(3.28), 0.75)

    def test_match_blink_windows(self):
        for x, on in ((0.0, 0), (0.14, 0), (0.15, 1), (0.29, 1), (0.30, 0), (0.44, 0), (0.45, 1), (2.9, 1)):
            self.assertEqual(circuit.match_on(x), on, x)


class Look(unittest.TestCase):
    def setUp(self):
        self.run = circuit.Run('Test', SEQ, 2, 3, 1, 'r1')         # one lap

    def test_countdown_blinks_the_starts_over_the_map(self):
        h, done = self.run.layers(0.02)
        self.assertFalse(done)
        self.assertEqual(h['hold3'], GREEN)                         # full
        self.assertEqual(h['hold1'], GREEN)
        self.assertTrue(close(h['hold80'], MAP))                    # the map, steady
        self.assertTrue(close(h['hold40'], FIN))                    # a 1-lap run: the finish from the countdown on
        self.assertEqual(len(h), len(set(SEQ)))
        half = self.run.layers(2.48)[0]['hold3']                    # half-way through a fade: green over blue
        self.assertTrue(close(half, (0, 127.5, 25.5)))
        self.assertTrue(close(self.run.layers(1.9)[0]['hold3'], MAP))     # off: the map underneath
        self.assertTrue(close(self.run.layers(4.9)[0]['hold1'], MAP))
        for t in (0.5, 1.5, 3.95):
            self.assertTrue(close(self.run.layers(t)[0]['hold80'], MAP), t)   # the map never blinks
            self.assertTrue(close(self.run.layers(t)[0]['hold40'], FIN), t)
        self.assertEqual(self.run.phase(4.99), 'count')

    def test_one_start(self):
        run = circuit.Run('Test', SEQ, 1, 3, 1)
        h = run.layers(0.0)[0]
        self.assertEqual(greens(h), ['hold3'])
        self.assertEqual(run.moves, len(SEQ) - 1)
        self.assertEqual(greens(run.layers(at(run, 0))[0]), ['hold1'])     # the first move is to position 1
        self.assertFalse(run.is_match(0))                          # no c-1 before the start

    def test_the_run_lights_only_the_hold_to_go_to(self):
        for move, target in ((0, 'hold80'), (1, 'hold120'), (2, 'hold160'), (3, 'hold200'), (5, 'hold180')):
            for into in (0.0, 1.0, 2.99):
                h, _ = self.run.layers(at(self.run, move, into))
                self.assertEqual(greens(h), [target], (move, into))
                self.assertEqual(h[target], GREEN)                  # full and solid
                self.assertTrue(close(h['hold3'], MAP))             # starts are blue in the run
                self.assertTrue(close(h['hold1'], MAP))
                self.assertTrue(close(h['hold40'], FIN))            # the one lap is the final lap
        self.assertEqual(self.run.phase(at(self.run, 0)), 'run')

    def test_a_match_blinks_twice(self):
        # move 4: on hold200 (position 5), going to hold200 again (position 6)
        self.assertTrue(self.run.is_match(4))
        self.assertFalse(self.run.is_match(3))
        self.assertFalse(self.run.is_match(5))
        for into, on in ((0.05, False), (0.2, True), (0.35, False), (0.5, True), (1.5, True), (2.99, True)):
            h, _ = self.run.layers(at(self.run, 4, into))
            self.assertEqual(h['hold200'], GREEN if on else MAP, into)
            self.assertEqual(greens(h), ['hold200'] if on else [], into)    # the next hold waits for its beat
        self.assertEqual(greens(self.run.layers(at(self.run, 5, 0.05))[0]), ['hold180'])
        # a move that isn't a match is solid from the start of its beat
        self.assertEqual(self.run.layers(at(self.run, 3, 0.05))[0]['hold200'], GREEN)

    def test_a_match_on_c_minus_1(self):
        seq = ['hold3', 'hold1', 'hold80', 'hold1', 'hold120']         # back to the other hand's hold
        run = circuit.Run('Test', seq, 2, 3, 1)
        self.assertEqual([run.is_match(k) for k in range(run.moves)], [False, True, False])
        self.assertEqual(run.layers(at(run, 1, 0.05))[0]['hold1'], MAP)
        self.assertEqual(run.layers(at(run, 1, 0.2))[0]['hold1'], GREEN)

    def test_the_top(self):
        top = COUNTDOWN + self.run.moves * self.run.interval
        self.assertEqual(greens(self.run.layers(top - 0.01)[0]), ['hold40'])   # the last move: to the finish, green
        for n in range(3):                                              # three red blinks, one a second
            h, done = self.run.layers(top + n + 0.02)
            self.assertFalse(done)
            self.assertEqual(self.run.phase(top + n + 0.02), 'top')
            self.assertEqual(h['hold40'], RED)
            self.assertTrue(close(h['hold80'], MAP))
            self.assertEqual(greens(h), [])
            self.assertTrue(close(self.run.layers(top + n + 0.48)[0]['hold40'], (127.5, 0, 0)))
            self.assertEqual(self.run.layers(top + n + 0.95)[0]['hold40'], OFF)
        leds, _ = self.run.frame(top + 0.95)
        self.assertNotIn(board.led_index(40), leds)                     # off between blinks
        h, _ = self.run.layers(top + 3.5)                               # then the map fades out over 1 s
        self.assertTrue(close(h['hold80'], tuple(v * 0.5 for v in MAP)))
        self.assertEqual(h['hold40'], OFF)
        self.assertEqual(self.run.layers(top + 3.99)[1], False)
        self.assertEqual(self.run.layers(top + 4.0), ({}, True))
        self.assertEqual(self.run.phase(top + 4.0), 'done')
        self.assertEqual(self.run.top_length(), 4.0)


class Laps(unittest.TestCase):
    def test_move_counts(self):
        L, s = len(SEQ), 2
        self.assertEqual(circuit.Run('T', SEQ, 2, 3, 1).moves, L - s)                    # 10
        self.assertEqual(circuit.Run('T', SEQ, 2, 3, 3).moves, (L - s) + 2 * L)          # 34
        self.assertEqual(circuit.Run('T', SEQ, 1, 3, 3).moves, (L - 1) + 2 * L)          # 35
        endless = circuit.Run('T', SEQ, 2, 2, 0)
        self.assertIsNone(endless.moves)
        self.assertTrue(endless.endless)
        self.assertEqual(endless.phase(at(endless, 5000)), 'run')
        self.assertFalse(endless.layers(at(endless, 5000))[1])
        self.assertEqual(endless.moves_at(at(endless, 30)), 30)

    def test_three_laps_end_on_the_last_hold(self):
        run = circuit.Run('T', SEQ, 2, 3, 3)
        last = run.moves - 1
        self.assertEqual(run.target(last) % run.L, run.L - 1)
        self.assertEqual(run.lap_of(last), 3)
        self.assertEqual(greens(run.layers(at(run, last))[0]), ['hold40'])
        self.assertEqual(run.phase(at(run, last, 2.99)), 'run')
        self.assertEqual(run.phase(at(run, run.moves, 0.01)), 'top')
        self.assertEqual(run.moves_at(10_000), 34)

    def test_wrap_from_lap_2(self):
        run = circuit.Run('T', SEQ, 2, 3, 2)
        k = run.L - run.s                                   # the first move of lap 2: the wrap move
        self.assertEqual((run.lap_of(k - 1), run.lap_of(k)), (1, 2))
        self.assertEqual(greens(run.layers(at(run, k - 1))[0]), ['hold40'])   # the end of lap 1
        h = run.layers(at(run, k))[0]
        self.assertEqual(greens(h), ['hold3'])              # all the way round: position 0
        self.assertEqual(greens(run.layers(at(run, k + 1))[0]), ['hold1'])    # then position 1
        self.assertTrue(close(h['hold1'], MAP))              # a start is blue in the run
        self.assertEqual(run.moves, 10 + 12)

    def test_finish_only_on_the_final_lap(self):
        run = circuit.Run('T', SEQ, 2, 3, 3)
        self.assertTrue(close(run.layers(1.0)[0]['hold40'], MAP))          # not in the countdown of 3 laps
        for k in (0, 5, 8, 10, 15, 20):                                     # laps 1 and 2 (not their last moves: to the finish, green)
            self.assertTrue(close(run.layers(at(run, k))[0]['hold40'], MAP), k)
        for k in (22, 25, 32):                                              # lap 3, from its wrap move on
            self.assertTrue(close(run.layers(at(run, k))[0]['hold40'], FIN), k)
        self.assertEqual(run.layers(at(run, 33))[0]['hold40'], GREEN)       # the last move: to the finish

    def test_endless_never_shows_red(self):
        run = circuit.Run('T', SEQ, 2, 2, 0)
        t = 0.0
        while t < COUNTDOWN + 60 * run.interval:
            h, done = run.layers(t)
            self.assertFalse(done)
            self.assertFalse(any(rgb[0] > 0 for rgb in h.values()), t)
            t += 0.37

    def test_resolve_laps(self):
        r = circuit.resolve_laps
        self.assertEqual(r(3, None, True), 3)
        self.assertEqual(r(0, None, True), 0)
        self.assertEqual(r(None, True, True), 0)             # old apps: loop true = endless
        self.assertEqual(r(None, False, True), 1)            # loop false = 1 lap
        self.assertEqual(r(None, None, True), 0)             # loop absent: the circuit's loops
        self.assertEqual(r(None, None, False), 1)
        for laps, loop in ((0, None), (5, None), (None, True), (None, False), (None, None), (0, True)):
            self.assertEqual(r(laps, loop, False), 1, (laps, loop))   # loops false: always 1 lap
        self.assertEqual(circuit.laps_text(0), 'endless')
        self.assertEqual(circuit.laps_text(1), '1 lap')
        self.assertEqual(circuit.laps_text(4), '4 laps')

    def test_bad_laps_and_sequence(self):
        for bad in (-1, 11, True, 2.0, None, '3'):
            with self.assertRaises(ValueError):
                circuit.Run('T', SEQ, 2, 3, bad)
        with self.assertRaises(ValueError):
            circuit.Run('Test', [], 2, 3, 1)
        with self.assertRaises(ValueError):
            circuit.Run('Test', None, 2, 3, 1)


class Leds(unittest.TestCase):
    def test_frame_leds_and_mirror(self):
        run = circuit.Run('Test', SEQ, 2, 3, 1)
        leds, _ = run.frame(at(run, 0, 0.4))
        self.assertEqual(set(leds), {board.led_index(board.hold_number(h)) for h in SEQ})
        self.assertEqual(leds[board.led_index(80)], GREEN)
        mm = {'hold3': 'hold17', 'hold17': 'hold3'}
        mirrored = circuit.Run('Test', SEQ, 2, 3, 1, mirror_map=mm)
        leds, _ = mirrored.frame(0.0)
        self.assertEqual(leds[board.led_index(17)], GREEN)            # the mirrored start blinks
        self.assertNotIn(board.led_index(3), leds)

    def test_off_grid_and_feet_ids_light_nothing(self):
        run = circuit.Run('Test', ['hold3', 'hold999', 'hold21', 'hold80', 'hold120'], 2, 3, 1)
        self.assertEqual(sorted(run.dropped), ['hold21', 'hold999'])
        self.assertEqual(run.moves, 3)                                  # they keep their place in the timing
        for t in (0.0, at(run, 0, 0.4), at(run, 1, 0.4)):
            leds, _ = run.frame(t)
            self.assertTrue(all(1 <= i <= board.MAX_HOLD for i in leds))
            self.assertNotIn(board.led_index(21), leds)

    def test_levels(self):
        run = circuit.Run('Test', SEQ, 2, 3, 1, map_level=0.05, finish_level=1.0)
        h = run.layers(at(run, 0))[0]
        self.assertTrue(close(h['hold120'], (0, 0, 12.75)))
        self.assertEqual(h['hold40'], RED)

    def test_ended_line(self):
        run = circuit.Run("Pat's", SEQ, 2, 3, 0, 'abc', tag=' [phone, member]')
        self.assertEqual(run.ended_line('stopped', COUNTDOWN + 3 * 7 + 1),
                         "circuit ended: \"Pat's\" stopped after 7 moves (27 s), 3 s a move, endless, run abc [phone, member]")
        once = circuit.Run('Test', SEQ, 2, 2.5, 1)
        self.assertEqual(once.ended_line('finished', 100), "circuit ended: 'Test' finished after 10 moves (100 s), "
                                                           "2.5 s a move, 1 lap, run -")
        three = circuit.Run('Test', SEQ, 2, 2, 3)
        self.assertIn('after 34 moves', three.ended_line('finished', 1000))
        self.assertIn(', 3 laps, ', three.ended_line('finished', 1000))


class Options(unittest.TestCase):
    def test_options(self):
        warned = []
        self.assertEqual(circuit.options({}), {'map_level': 0.2, 'finish_level': 0.6})
        self.assertEqual(circuit.options({'CIRCUIT_MAP_LEVEL': '0.05', 'CIRCUIT_FINISH_LEVEL': '1.0'}),
                         {'map_level': 0.05, 'finish_level': 1.0})
        self.assertEqual(circuit.options({'CIRCUIT_MAP_LEVEL': '0.6', 'CIRCUIT_FINISH_LEVEL': '0.1'}),
                         {'map_level': 0.6, 'finish_level': 0.1})
        for cfg in ({'CIRCUIT_MAP_LEVEL': '0.04'}, {'CIRCUIT_MAP_LEVEL': '0.61'}, {'CIRCUIT_MAP_LEVEL': 'x'},
                    {'CIRCUIT_FINISH_LEVEL': '0.09'}, {'CIRCUIT_FINISH_LEVEL': '1.1'}):
            self.assertEqual(circuit.options(cfg, warned.append), circuit.OPTION_DEFAULTS, cfg)
        self.assertEqual(len(warned), 5)
        # the old keys mean nothing now
        self.assertEqual(circuit.options({'CIRCUIT_GHOST': '0.12', 'CIRCUIT_TRACK_RUN': 'move'}, warned.append),
                         circuit.OPTION_DEFAULTS)
        self.assertEqual(len(warned), 5)

    def test_mode_defaults(self):
        import mode
        self.assertEqual(mode.DEFAULTS['CIRCUIT_MAP_LEVEL'], '0.2')
        self.assertEqual(mode.DEFAULTS['CIRCUIT_FINISH_LEVEL'], '0.6')
        for k in ('CIRCUIT_GHOST', 'CIRCUIT_TRACK_RUN', 'CIRCUIT_TRACK_LEVEL'):
            self.assertNotIn(k, mode.DEFAULTS)
        with open(os.path.join(ROOT, 'pi', 'config.env.example'), encoding='utf-8') as f:
            example = f.read()
        self.assertIn('CIRCUIT_MAP_LEVEL=0.2', example)
        self.assertIn('CIRCUIT_FINISH_LEVEL=0.6', example)
        self.assertNotIn('CIRCUIT_GHOST', example)


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
        run = circuit.Run('Test', SEQ, 2, 2, 1, 'r1')
        r.circuit(run)
        r.step(self.clock.t)
        self.assertEqual(r.state, renderer.RUN)
        self.assertIsNone(self.strip.writes[-1][1])       # the first frame clears the whole strip
        self.go(COUNTDOWN + 1)
        self.assertEqual(r.state, renderer.RUN)
        self.assertEqual(self.strip.writes[-1][1], renderer.BOARD_PIXELS)
        frame = self.strip.writes[-1][0]
        self.assertEqual(max(max(rgb) for rgb in frame.values()), 128)      # the green, at cast brightness 0.5
        self.assertEqual(len(frame), len(set(SEQ)))                        # the whole map
        self.go(run.moves * run.interval + run.top_length())
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any(m.startswith("circuit ended: 'Test' finished after 10 moves") for m in self.logs))

    def test_stop_needs_the_right_token(self):
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
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
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        self.go(2)
        r.stop_circuit(None)
        self.go(0.1)
        self.assertEqual(r.state, renderer.IDLE)

    def test_a_problem_cast_cuts_in(self):
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        self.go(8)
        r.cast({54: (0, 127, 0)})
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)
        self.assertTrue(any(m.startswith("circuit ended: 'Test' replaced after 1 moves") for m in self.logs))
        self.assertEqual(self.strip.writes[-1][0], {54: (0, 127, 0)})
        r.stop_circuit('r1')                       # a late stop leaves the problem alone
        self.go(0.1)
        self.assertEqual(r.state, renderer.CAST)

    def test_time_limit(self):
        r = self.make(CIRCUIT_MAX_S='30')
        r.circuit(circuit.Run('Test', SEQ, 2, 2, 0, 'r1'))
        self.go(31, dt=0.25)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(any('the limit' in m for m in self.logs))

    def test_night_wins(self):
        r = self.make(night=True)
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        self.go(0.1)
        self.assertEqual(r.state, renderer.NIGHT)
        r = self.make()
        r.circuit(circuit.Run('Test', SEQ, 2, 3, 0, 'r1'))
        self.go(6)
        r.set_night(True)
        self.go(4)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(self.strip.writes[-1][0], {})


# -- circuit tracks (contract 8.6): checked, not drawn -------------------------------------

# The live Pat Burner (a loop, a match at positions 5-6) and its track as Ross edited it.
PB_SEQ = ['hold47', 'hold24', 'hold98', 'hold119', 'hold213', 'hold235', 'hold235', 'hold206', 'hold148',
          'hold112', 'hold53', 'hold49']


def pb_track():
    with open(os.path.join(ROOT, 'tools', 'circuit-tracks-pat-burner.json'), encoding='utf-8') as f:
        moves = json.load(f)['circuits']['Pat Burner']['moves']
    return {'version': 1, 'moves': [{k: m[k] for k in ('move', 'from', 'to', 'cells')} for m in moves]}


class Tracks(unittest.TestCase):
    def test_pat_burner_checks_clean(self):
        moves, problems = circuit.check_track(pb_track(), PB_SEQ)
        self.assertEqual(problems, [])
        self.assertEqual(sorted(moves), [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12])     # 6 is the match
        self.assertEqual(moves[5], ['hold214', 'hold177', 'hold178'])

    def test_stale_and_bad_moves_skipped(self):
        t = pb_track()
        seq = list(PB_SEQ)
        seq[3] = 'hold120'                       # the circuit edited: moves 3 and 4 go stale
        moves, problems = circuit.check_track(t, seq)
        self.assertNotIn(3, moves)
        self.assertNotIn(4, moves)
        self.assertIn(5, moves)
        self.assertEqual(sum('stale' in p for p in problems), 2)
        bad = {'version': 1, 'moves': [
            {'move': 2, 'from': 'hold24', 'to': 'hold98', 'cells': ['hold21']},                 # a feet sign
            {'move': 3, 'from': 'hold98', 'to': 'hold119', 'cells': ['hold117', 'hold117']},    # twice
            {'move': 4, 'from': 'hold119', 'to': 'hold213', 'cells': ['hold999']},              # off the grid
            {'move': 6, 'from': 'hold235', 'to': 'hold235', 'cells': []},                       # a match
            {'move': 13, 'from': 'hold49', 'to': 'hold47', 'cells': []},                        # out of range
            {'move': 8, 'from': 'hold206', 'to': 'hold148', 'cells': ['hold2']},                # the other sign
            {'move': 9, 'from': 'hold148', 'to': 'hold112', 'cells': ['hold131']},              # fine
            {'move': 9, 'from': 'hold148', 'to': 'hold112', 'cells': []},                       # twice
            'nonsense', {'move': True, 'from': 'hold47', 'to': 'hold24', 'cells': []}]}
        moves, problems = circuit.check_track(bad, PB_SEQ)
        self.assertEqual(moves, {9: ['hold131']})
        self.assertEqual(len(problems), 9)

    def test_never_raises_on_bad_json(self):
        for junk in ('{not json', '[]', 5, [], {'version': 2, 'moves': []}, {'version': True, 'moves': []},
                     {'version': 1}, {'version': 1, 'moves': 'x'}, {'version': 1, 'moves': [{}] * 201}):
            moves, problems = circuit.check_track(junk, PB_SEQ)
            self.assertEqual(moves, {})
            self.assertEqual(len(problems), 1, junk)
        self.assertEqual(circuit.check_track(json.dumps(pb_track()), PB_SEQ)[1], [])     # a JSON string is fine
        self.assertEqual(circuit.check_track(None, PB_SEQ), ({}, []))


# -- the listener: cast_circuit (contract 8.1) ---------------------------------------------

class ListenerCast(unittest.TestCase):
    """pb_listener.on_circuit and show_circuit: laps, the backward-compatible loop, trace_s ignored."""

    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:                 # websockets isn't installed on this machine
            self.skipTest('pb_listener not importable: %s' % e)
        self.pb = pb_listener
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.cfg = {'BRIGHTNESS': '0.5', 'POWER_BUDGET_MA': '8000', 'MA_PER_CHANNEL': '20'}
        self.L.mode, self.L.status, self.L.pending, self.L.status_path = 'day', {'circuits_shown': 0}, None, None
        self.L.mirror_map = None
        self.L.circuit_opts = circuit.options({})
        self.runs = []

        class Ready:
            def set(_):
                pass

        class LedThread:
            def circuit(_, run):
                self.runs.append(run)
        self.L.cast_ready, self.L.leds = Ready(), LedThread()
        self.warned, self.logged = [], []
        self._warn, self._log = pb_listener.warn, pb_listener.log
        pb_listener.warn = self.warned.append
        pb_listener.log = lambda msg, level=6: self.logged.append(msg)

    def tearDown(self):
        self.pb.warn, self.pb.log = self._warn, self._log

    def cast(self, **fields):
        self.L.pending = None
        body = dict({'circuit_name': 'Pat Burner', 'interval': 3, 'run': 'ab'}, **fields)
        self.L.on_circuit({k: v for k, v in body.items() if v is not ...})
        return self.L.pending

    def test_laps(self):
        p = self.cast(laps=3)
        self.assertEqual((p[0], p[1], p[3]), ('circuit', 'Pat Burner', 3))
        self.assertEqual(p[6], 'ab')                              # the run token (on_stop reads pending[6])
        self.assertEqual(self.cast(laps=0)[3], 0)
        self.assertEqual(self.cast(laps=10)[3], 10)
        self.assertEqual(self.cast(laps=1, loop=True)[3], 1)      # laps wins over loop
        self.assertIn("circuit received: 'Pat Burner', 3 s a move, 3 laps", self.logged[0])
        self.assertTrue(any(', endless' in m for m in self.logged))

    def test_bad_laps_ignore_the_cast(self):
        for bad in (-1, 11, 2.5, 3.0, '3', True, False, [1]):
            self.warned.clear()
            self.assertIsNone(self.cast(laps=bad), bad)
            self.assertEqual(len(self.warned), 1, bad)
            self.assertIn('bad laps', self.warned[0])

    def test_backward_compatible(self):
        self.assertEqual(self.cast(loop=True)[3], 0)              # no laps: loop true = endless
        self.assertEqual(self.cast(loop=False)[3], 1)             # loop false = 1 lap
        self.assertIsNone(self.cast()[3])                         # no loop either: the circuit's loops, later
        self.assertTrue(any("the circuit's loop setting" in m for m in self.logged))
        self.warned.clear()
        for trace in (3, 0, 9, 'junk', None):                     # trace_s: ignored, never warned about
            self.assertIsNotNone(self.cast(loop=True, trace_s=trace), trace)
        self.assertEqual(self.warned, [])

    def start(self, row, **fields):
        """on_circuit, then show_circuit with the circuit row the fetch returns -> the Run started."""
        self.runs.clear()
        p = self.cast(**fields)
        self.assertIsNotNone(p)
        self.L.pending = None
        old = self.pb.supa.fetch_circuit
        self.pb.supa.fetch_circuit = lambda cfg, name: row
        try:
            asyncio.run(self.L.show_circuit(*p[1:]))
        finally:
            self.pb.supa.fetch_circuit = old
        return self.runs[-1] if self.runs else None

    def test_the_run_gets_its_laps_from_the_circuit(self):
        looping = {'name': 'Pat Burner', 'hold_sequence': SEQ, 'start_count': 2, 'loops': True}
        once = dict(looping, loops=False)
        cases = [  # (row, fields, laps)
            (looping, dict(laps=3), 3), (looping, dict(laps=0), 0), (looping, dict(loop=True), 0),
            (looping, dict(loop=False), 1), (looping, dict(), 0),
            (once, dict(laps=0), 1), (once, dict(laps=5), 1), (once, dict(loop=True), 1),
            (once, dict(loop=False), 1), (once, dict(), 1)]
        for row, fields, laps in cases:
            run = self.start(row, **fields)
            self.assertEqual(run.laps, laps, (row['loops'], fields))
        self.assertTrue(any("circuit started 'Pat Burner': 12 holds, 10 moves, 3 s a move, 1 lap, run ab" in m
                            for m in self.logged))
        self.assertTrue(any('moves until stopped, 3 s a move, endless' in m for m in self.logged))

    def test_unknown_circuit_leaves_the_board(self):
        self.assertIsNone(self.start(None, laps=1))
        self.assertTrue(any('unknown circuit' in m for m in self.warned))


if __name__ == '__main__':
    unittest.main()
