"""Laptop tests for circuit runs (circuit.py) and the renderer's circuit state.

    python -m unittest discover -s pi/tests      (from the repo root)

The look (direction 4, "Pulse and fade") at each phase: the countdown, the
moving holds, a match, a later lap, the finish; then the renderer: a run
animates, a stop with the wrong run token is ignored, the right one, the finish
and the time limit go idle, a problem cast cuts in, and night wins. Then circuit
tracks (contract 8.6): check_track (stale and bad moves skipped), the trace's
path with and without a track, its timing and step clamp, no LED twice a lap,
the ghost and track layers under Pulse and fade, trace_s absent changing
nothing, the config options and the listener's cast parsing.
"""
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

    def test_ended_line(self):
        run = circuit.Run("Pat's", SEQ, 2, 3, True, 'abc', tag=' [phone, member]')
        self.assertEqual(run.ended_line('stopped', COUNTDOWN + 3 * 7 + 1),
                         "circuit ended: \"Pat's\" stopped after 7 moves (27 s), 3 s a move, loop, run abc [phone, member]")
        once = circuit.Run('Test', SEQ, 2, 2.5, False)
        self.assertEqual(once.ended_line('finished', 100), 'circuit ended: \'Test\' finished after 10 moves (100 s), '
                                                            '2.5 s a move, once, run -')

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
        self.assertTrue(any(m.startswith("circuit ended: 'Test' finished after 10 moves") for m in self.logs))

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
        self.assertTrue(any(m.startswith("circuit ended: 'Test' replaced after 1 moves") for m in self.logs))
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


# -- circuit tracks (contract 8.6) ---------------------------------------------------------

# The live Pat Burner (a loop, a match at positions 5-6) and its track as Ross edited it.
PB_SEQ = ['hold47', 'hold24', 'hold98', 'hold119', 'hold213', 'hold235', 'hold235', 'hold206', 'hold148',
          'hold112', 'hold53', 'hold49']


def pb_track():
    with open(os.path.join(ROOT, 'tools', 'circuit-tracks-pat-burner.json'), encoding='utf-8') as f:
        moves = json.load(f)['circuits']['Pat Burner']['moves']
    return {'version': 1, 'moves': [{k: m[k] for k in ('move', 'from', 'to', 'cells')} for m in moves]}


def led(h):
    return board.led_index(board.hold_number(h))


OPTS = dict(ghost=0.12, track_run='move', track_level=0.2)


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
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, track='{oops', trace_s=3, **OPTS)
        self.assertEqual(run.track_problems, ['led_track is not JSON'])
        self.assertEqual(run.path, [led(h) for h in dict.fromkeys(PB_SEQ)])

    def test_path_without_a_track_is_the_holds(self):
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3)
        self.assertEqual(run.path, [led(h) for h in dict.fromkeys(PB_SEQ)])      # hold235 once
        once = circuit.Run('T', SEQ, 2, 3, False, trace_s=3)
        self.assertEqual(once.path, [led(h) for h in dict.fromkeys(SEQ)])

    def test_path_with_a_track(self):
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3, track=pb_track(), **OPTS)
        want = []
        for h in ('hold47', 'hold24', 'hold43', 'hold61', 'hold98', 'hold117', 'hold119', 'hold176', 'hold195',
                  'hold213', 'hold214', 'hold177', 'hold178', 'hold235', 'hold203', 'hold185', 'hold206',
                  'hold205', 'hold186', 'hold148', 'hold131', 'hold112', 'hold93', 'hold72', 'hold53', 'hold49'):
            want.append(led(h))
        self.assertEqual(run.path, want)
        self.assertEqual(len(run.path), len(set(run.path)))              # every LED once a lap
        self.assertNotIn(led('hold2'), run.path)
        self.assertNotIn(led('hold21'), run.path)
        # A run done once doesn't use the wrap move (none here: move 12's cells are empty), and ends on the last hold.
        once = circuit.Run('PB', PB_SEQ, 2, 3, False, trace_s=3, track=pb_track(), **OPTS)
        self.assertEqual(once.path[-1], led('hold49'))
        self.assertNotIn(12, once.move_leds)

    def test_track_cells_never_on_a_circuit_hold(self):
        t = pb_track()
        t['moves'][1]['cells'] = ['hold43', 'hold98', 'hold61']     # hold98 is in the circuit
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3, track=t, **OPTS)
        self.assertEqual(run.track_problems, [])
        self.assertEqual(run.move_leds[2], [led('hold43'), led('hold61')])
        self.assertEqual(len(run.path), len(set(run.path)))

    def test_trace_step_clamp_and_timing(self):
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3, track=pb_track(), **OPTS)
        self.assertAlmostEqual(run.step, 2.8 / 26)
        short = circuit.Run('T', ['hold3', 'hold80', 'hold120'], 1, 3, False, trace_s=3)
        self.assertEqual(short.step, circuit.TRACE_STEP_MAX)                 # 3 LEDs: 0.93 s clamped to 0.15
        long_seq = ['hold%d' % n for n in range(22, 230, 1) if n not in (21, 2)][:150]
        long = circuit.Run('T', long_seq, 2, 3, False, trace_s=3)
        self.assertEqual(long.step, circuit.TRACE_STEP_MIN)                  # 150 LEDs: 0.019 s clamped to 0.034
        self.assertGreaterEqual(circuit.TRACE_STEP_MIN, 1 / 30)              # at least one frame at 30 fps
        # The countdown starts after trace_s: the start holds flash red at trace_s + 0.2, not before.
        self.assertEqual(run.phase(2.9), 'trace')
        self.assertEqual(run.phase(3.2), 'count')
        self.assertEqual(run.phase(3 + COUNTDOWN + 0.1), 'run')
        leds, _ = run.frame(3.2)
        self.assertEqual(leds[led('hold47')], RED)
        self.assertEqual(run.moves_at(3 + COUNTDOWN + 3 * 4 + 0.5), 4)
        self.assertEqual(run.move_at(3 + COUNTDOWN + 0.1), 2)               # on the starts, going to hold98
        once = circuit.Run('T', SEQ, 2, 2, False, trace_s=3)
        top = 3 + COUNTDOWN + once.moves * 2
        self.assertFalse(once.frame(top + once.finish_length() - 0.01)[1])
        self.assertTrue(once.frame(top + once.finish_length() + 0.01)[1])

    def test_trace_frame(self):
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3, track=pb_track(), **OPTS)
        f0 = run.trace_frame(0.0)
        self.assertEqual(f0[run.path[0]], circuit.WHITE)                    # the spot's head at the start
        self.assertEqual(sum(1 for v in f0.values() if v == (0.0, 0.0, 0.0)), len(f0) - 1)   # the rest faded out
        f = run.trace_frame(1.0)
        k = int(1.0 // run.step)
        n = len(run.path)
        self.assertEqual(f[run.path[k % n]], circuit.WHITE)
        self.assertEqual(f[run.path[(k - 1) % n]], tuple(v * 0.45 for v in circuit.WHITE))
        self.assertEqual(f[run.path[(k - 2) % n]], tuple(v * 0.15 for v in circuit.WHITE))
        dim_hold = [i for i in run.hold_leds if i not in [run.path[(k - b) % n] for b in range(3)]][0]
        self.assertEqual(f[dim_hold], tuple(v * 0.12 for v in circuit.WHITE))
        dim_track = [i for i in run.track_leds if i not in [run.path[(k - b) % n] for b in range(3)]][0]
        self.assertEqual(f[dim_track], tuple(v * 0.2 for v in circuit.PINK))
        self.assertEqual(set(f), run.hold_leds | set(run.track_leds))

    def test_no_led_lights_twice_in_a_lap(self):
        """Frame by frame at 30 fps through one lap: each LED is the head in one unbroken stretch."""
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, trace_s=3, track=pb_track(), **OPTS)
        lap = run.step * len(run.path)
        heads, t = [], 0.0
        while t < lap - 1e-9:
            f = run.trace_frame(t)
            heads.append([i for i, v in f.items() if v == circuit.WHITE][0])
            t += 1 / 30
        runs = [h for j, h in enumerate(heads) if j == 0 or heads[j - 1] != h]
        self.assertEqual(len(runs), len(set(runs)))
        self.assertEqual(set(runs), set(run.path))                          # and none is skipped at 30 fps

    def test_ghost_and_track_under_pulse_and_fade(self):
        plain = circuit.Run('PB', PB_SEQ, 2, 3, True)
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, track=pb_track(), **OPTS)
        ghost = tuple(v * 0.12 for v in circuit.WHITE)
        pink = tuple(v * 0.2 for v in circuit.PINK)
        for t in [x / 10 for x in range(0, 600, 3)]:
            base, _ = plain.frame(t)
            leds, _ = run.frame(t)
            for i, rgb in base.items():                                     # Pulse and fade unchanged where it lights
                self.assertEqual(leds[i], rgb, t)
            for i, rgb in leds.items():
                if i not in base:
                    self.assertIn(rgb, (ghost, pink), t)
                    self.assertEqual(rgb == ghost, i in run.hold_leds, t)   # ghost only on holds, track never
        # The countdown: the ghost, but no track.
        leds, _ = run.frame(1.7)                                            # the flash's off half
        self.assertEqual({leds[i] for i in run.hold_leds}, {ghost})
        self.assertFalse(set(leds) & set(run.track_leds))
        # In the run, move mode: only the current move's cells. Move 2 (hold24 -> hold98): hold43, hold61.
        leds, _ = run.frame(COUNTDOWN + 0.5)
        self.assertEqual({i for i, v in leds.items() if v == pink}, {led('hold43'), led('hold61')})
        # The match (move 6, hold235 -> hold235) has no cells.
        leds, _ = run.frame(COUNTDOWN + 4 * 3 + 0.5)
        self.assertEqual(run.move_at(COUNTDOWN + 4 * 3 + 0.5), 6)
        self.assertNotIn(pink, leds.values())
        allrun = circuit.Run('PB', PB_SEQ, 2, 3, True, track=pb_track(), ghost=0.12, track_run='all', track_level=0.2)
        leds, _ = allrun.frame(COUNTDOWN + 0.5)
        self.assertEqual({i for i, v in leds.items() if v == pink}, set(allrun.track_leds))
        off = circuit.Run('PB', PB_SEQ, 2, 3, True, track=pb_track(), ghost=0, track_run='off')
        self.assertEqual(off.frame(COUNTDOWN + 0.5)[0], plain.frame(COUNTDOWN + 0.5)[0])

    def test_no_ghost_at_the_finish(self):
        run = circuit.Run('T', SEQ, 2, 2, False, ghost=0.12, track_run='all')
        plain = circuit.Run('T', SEQ, 2, 2, False)
        top = COUNTDOWN + run.moves * 2
        for dt in (0.5, 1.3, 2.0):
            self.assertEqual(run.frame(top + dt)[0], plain.frame(top + dt)[0])

    def test_no_trace_changes_nothing(self):
        plain = circuit.Run('T', SEQ, 2, 3, False)
        zero = circuit.Run('T', SEQ, 2, 3, False, trace_s=0, track=None)
        for t in [x / 7 for x in range(0, 400)]:
            self.assertEqual(plain.holds_at(t), zero.holds_at(t))
            self.assertEqual(plain.frame(t), zero.frame(t))
            self.assertEqual(plain.moves_at(t), zero.moves_at(t))
        late = circuit.Run('T', SEQ, 2, 3, False, trace_s=3)
        for t in [x / 8 for x in range(0, 300)]:          # eighths: t + 3 is exact, so no rounding differs
            self.assertEqual(late.holds_at(t + 3), plain.holds_at(t))       # the same run, 3 s later
            self.assertEqual(late.moves_at(t + 3), plain.moves_at(t))

    def test_mirrored_runs_have_no_track(self):
        run = circuit.Run('PB', PB_SEQ, 2, 3, True, mirror_map={'hold47': 'hold49'}, track=pb_track(), trace_s=3, **OPTS)
        self.assertEqual(run.move_leds, {})
        self.assertEqual(run.track_problems, ['mirrored: the track is not used'])

    def test_options(self):
        warned = []
        self.assertEqual(circuit.options({}), circuit.OPTION_DEFAULTS)
        self.assertEqual(circuit.options({'CIRCUIT_GHOST': '0', 'CIRCUIT_TRACK_RUN': 'ALL', 'CIRCUIT_TRACK_LEVEL': '0.5'}),
                         {'ghost': 0.0, 'track_run': 'all', 'track_level': 0.5})
        self.assertEqual(circuit.options({'CIRCUIT_GHOST': '0.9', 'CIRCUIT_TRACK_RUN': 'some', 'CIRCUIT_TRACK_LEVEL': 'x'},
                                         warned.append), circuit.OPTION_DEFAULTS)
        self.assertEqual(len(warned), 3)

    def test_renderer_runs_a_trace_at_cast_brightness(self):
        clock, logs, strip = Clock(), [], Strip()
        r = renderer.Renderer(strip, dict(CFG), False, logs.append, logs.append, logs.append, clock=clock, seed=3)
        r.step(clock.t)
        run = circuit.Run('PB', PB_SEQ, 2, 3, False, 'r1', trace_s=3, track=pb_track(), **OPTS)
        r.circuit(run)
        end = clock.t + 1.5
        while clock.t < end:
            r.step(clock.t)
            clock.t += 1 / 30
        self.assertEqual(r.state, renderer.RUN)
        frame = strip.writes[-1][0]
        self.assertEqual(max(max(rgb) for rgb in frame.values()), 128)     # the spot, at BRIGHTNESS 0.5
        self.assertTrue(set(frame) <= run.hold_leds | set(run.track_leds))


class ListenerCast(unittest.TestCase):
    """pb_listener.on_circuit: trace_s parsed (absent = 0, 0-5, else the cast is ignored)."""

    def setUp(self):
        try:
            import pb_listener
        except ImportError as e:
            self.skipTest('pb_listener not importable: %s' % e)
        self.L = pb_listener.Listener.__new__(pb_listener.Listener)
        self.L.mode, self.L.status, self.L.pending = 'day', {}, None

        class Ready:
            def set(_):
                pass
        self.L.cast_ready = Ready()

    def cast(self, **extra):
        self.L.pending = None
        self.L.on_circuit(dict({'circuit_name': 'Pat Burner', 'interval': 3, 'loop': True, 'run': 'ab'}, **extra))
        return self.L.pending

    def test_trace_s(self):
        self.assertEqual(self.cast()[7], 0.0)                     # absent: no trace, timing as before
        self.assertEqual(self.cast(trace_s=3)[7], 3.0)
        self.assertEqual(self.cast(trace_s=0)[7], 0.0)
        self.assertEqual(self.cast(trace_s=5)[7], 5.0)
        self.assertEqual(self.cast(trace_s=2.5)[5], 'ab')         # the run token keeps its place (stop reads it)
        for bad in (-1, 5.1, '3', True, None):
            self.assertIsNone(self.cast(trace_s=bad), bad)


if __name__ == '__main__':
    unittest.main()
