"""Laptop tests for Glisten and the LED thread (no SPI, no network, no real clock).

    python -m unittest discover -s pi/tests      (from the repo root)

The LED thread's step() is driven by hand with a fake clock and a fake strip:
a cast interrupts idle, idle starts after IDLE_AFTER_S, night wins, the idle
current cap holds, pixel 0 stays off, and a failing animation can't take the
casts down with it.
"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
from patterns import glisten  # noqa: E402
import renderer  # noqa: E402

CAST = {54: (0, 127, 0), 1: (0, 127, 0), 200: (0, 0, 127), 247: (127, 0, 0)}
CFG = {'IDLE_AFTER_S': '60', 'IDLE_ANIMATION': 'on', 'IDLE_FPS': '30', 'IDLE_MAX_AMPS': '2.0',
       'IDLE_BRIGHTNESS': '1.0', 'MA_PER_CHANNEL': '20'}


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Strip:
    def __init__(self):
        self.writes = []            # (frame, pixels)

    def write(self, leds, pixels=None):
        self.writes.append((dict(leds), pixels))

    @property
    def last(self):
        return self.writes[-1][0]


def make(cfg=None, night=False):
    clock, strip, logs = Clock(), Strip(), []
    r = renderer.Renderer(strip, dict(CFG, **(cfg or {})), night, logs.append, logs.append, logs.append,
                          clock=clock, seed=7)
    return r, clock, strip, logs


def run_for(r, clock, seconds, dt=1 / 30):
    end = clock.t + seconds
    while clock.t < end:
        r.step(clock.t)
        clock.t += dt


def ma(frame, per_channel=20.0):
    return sum(c / 255 * per_channel for rgb in frame.values() for c in rgb)


class States(unittest.TestCase):
    def test_start_in_the_day_goes_idle_with_a_fade_in(self):
        r, clock, strip, _ = make()
        run_for(r, clock, 0.5)
        self.assertEqual(r.state, renderer.IDLE)
        early = ma(strip.last)
        run_for(r, clock, 2)
        self.assertIsNone(r.fade)
        self.assertGreater(ma(strip.last), early)      # still brightening at 0.5 s

    def test_a_cast_cuts_straight_into_idle(self):
        r, clock, strip, _ = make()
        run_for(r, clock, 5)
        r.cast(CAST)
        r.step(clock.t)                                 # the very next round
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(strip.writes[-1], (CAST, None))   # whole strip, exactly the cast, no fade

    def test_idle_starts_after_the_timeout_not_before(self):
        r, clock, strip, _ = make()
        r.cast(CAST)
        r.step(clock.t)
        n = len(strip.writes)
        run_for(r, clock, 59.5, dt=0.25)
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(len(strip.writes), n)          # nothing written while the problem is up
        run_for(r, clock, 1.0)
        self.assertEqual(r.state, renderer.IDLE)
        run_for(r, clock, 0.6)
        mid = strip.last
        self.assertTrue(any(mid.get(i) != CAST.get(i) for i in set(mid) | set(CAST)))
        self.assertIn(247, mid)                         # the finish is still fading out at 0.6 s
        run_for(r, clock, 1.5)
        self.assertIsNone(r.fade)

    def test_a_new_cast_restarts_the_timeout(self):
        r, clock, _, _ = make()
        r.cast(CAST)
        run_for(r, clock, 40, dt=0.5)
        r.cast(CAST)
        run_for(r, clock, 40, dt=0.5)
        self.assertEqual(r.state, renderer.CAST)

    def test_idle_now(self):
        r, clock, _, _ = make()
        r.cast(CAST)
        r.step(clock.t)
        r.idle_now()
        r.step(clock.t)
        self.assertEqual(r.state, renderer.IDLE)

    def test_night_wins(self):
        r, clock, strip, _ = make()
        run_for(r, clock, 5)
        r.set_night(True)
        run_for(r, clock, 1.5)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertTrue(strip.last)                     # still fading
        run_for(r, clock, 2)
        self.assertEqual(strip.writes[-1], ({}, None))  # then the whole strip cleared
        n = len(strip.writes)
        r.cast(CAST)
        r.idle_now()
        run_for(r, clock, 120, dt=0.5)                  # past IDLE_AFTER_S too
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(len(strip.writes), n)          # nothing lit at night

    def test_night_at_start_then_morning(self):
        r, clock, strip, _ = make(night=True)
        run_for(r, clock, 5)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(strip.writes, [])
        r.set_night(False)
        run_for(r, clock, 2)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertTrue(strip.last)

    def test_night_fades_a_lit_problem(self):
        r, clock, strip, _ = make()
        r.cast(CAST)
        r.step(clock.t)
        r.set_night(True)
        run_for(r, clock, 1.5)
        self.assertTrue(0 < ma(strip.last) < ma(CAST))
        run_for(r, clock, 2)
        self.assertEqual(strip.last, {})

    def test_animation_off_just_clears(self):
        r, clock, strip, _ = make({'IDLE_ANIMATION': 'off'})
        r.cast(CAST)
        r.step(clock.t)
        run_for(r, clock, 61, dt=0.5)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertEqual(strip.writes[-1], ({}, None))
        n = len(strip.writes)
        run_for(r, clock, 10)
        self.assertEqual(len(strip.writes), n)          # and stays quiet

    def test_a_failing_animation_is_logged_once_and_casts_still_work(self):
        r, clock, strip, logs = make()
        r.step(clock.t)

        def boom(t):
            raise ZeroDivisionError('test')
        r.anim.frame = boom
        run_for(r, clock, 3)
        self.assertEqual(sum('Glisten failed' in m for m in logs), 1)
        self.assertEqual(strip.last, {})
        r.cast(CAST)
        r.step(clock.t)
        self.assertEqual(strip.last, CAST)
        run_for(r, clock, 61, dt=0.5)
        self.assertEqual(strip.last, {})                # idle is dark from now on

    def test_frames_are_frame_time_based(self):
        r, clock, _, _ = make()
        r.step(clock.t)
        clock.t += 0.5                                  # a very late frame
        r.step(clock.t)
        self.assertAlmostEqual(r.anim.t, 0.5)           # the animation follows the clock
        self.assertLessEqual(r.next_frame - clock.t, 1 / 30 + 1e-9)   # and doesn't try to catch up

    def test_idle_frames_write_only_the_board(self):
        r, clock, strip, _ = make()
        run_for(r, clock, 2)
        self.assertEqual(strip.writes[-1][1], renderer.BOARD_PIXELS)


class Frames(unittest.TestCase):
    def frames(self, seconds=90, **kw):
        g = glisten.Glisten(seed=3, **kw)
        return g, [g.frame(k / 30) for k in range(int(seconds * 30))]

    def test_pixel_0_off_and_only_board_leds(self):
        _, fs = self.frames(30)
        for f in fs:
            self.assertNotIn(0, f)
            self.assertTrue(all(1 <= i <= board.MAX_HOLD for i in f))
            self.assertTrue(all(0 <= c <= 255 for rgb in f.values() for c in rgb))

    def test_pixel_0_off_through_the_strip(self):
        sent = []

        class Spi:
            def open(self, *a):
                pass

            def writebytes2(self, buf):
                sent.append(bytes(buf))

            def close(self):
                pass
        sys.modules['spidev'] = type(sys)('spidev')
        sys.modules['spidev'].SpiDev = Spi
        try:
            import leds
            s = leds.Strip(1200)
            s.write({0: (255, 255, 255), 1: (1, 2, 3)})                  # even if asked for
            s.write(glisten.Glisten(seed=1).frame(0.0), renderer.BOARD_PIXELS)
        finally:
            del sys.modules['spidev']
        self.assertEqual(len(sent[0]), 3600)
        self.assertEqual(sent[0][:6], bytes([0, 0, 0, 1, 2, 3]))
        self.assertEqual(len(sent[1]), 3 * 248)                          # an idle frame: the board only
        self.assertEqual(sent[1][:3], bytes(3))

    def test_the_cap_holds(self):
        g, fs = self.frames(60, max_ma=300)              # far under what Glisten wants
        self.assertGreater(g.capped_frames, 0)
        for f in fs:
            self.assertLessEqual(ma(f), 300 + 247 * 3 * 20 / 255)    # rounding: half a step per channel

    def test_default_cap(self):
        g, fs = self.frames(90)
        self.assertLessEqual(max(ma(f) for f in fs), 2000 + 247 * 3 * 20 / 255)

    def test_cap_is_logged_once(self):
        r, clock, _, logs = make({'IDLE_MAX_AMPS': '0.3'})
        run_for(r, clock, 5)
        self.assertEqual(sum('IDLE_MAX_AMPS' in m for m in logs), 1)

    def test_sparkles_are_safe(self):
        g, _ = self.frames(240)
        starts = g.started
        self.assertGreater(len(starts), 100)
        last = {}
        for c, t in starts:
            if c in last:
                self.assertGreaterEqual(t - last[c], 1 / 3)  # never 3 a second in one cell
            last[c] = t
        for (c1, t1) in starts:
            for (c2, t2) in starts:
                if c1 != c2 and abs(t1 - t2) < 0.1:
                    self.assertNotIn(c2, glisten.NEIGHBOURS[c1])

    def test_no_large_area_flashes(self):
        g = glisten.Glisten(seed=5)
        prev = None
        for k in range(30 * 120):
            lv = g.levels(k / 30)
            if prev:
                jumps = sum(1 for a, b in zip(lv, prev) if abs(sum(a) - sum(b)) > 0.3)
                self.assertLessEqual(jumps, 3)            # only single sparkles jump frame to frame
            prev = [list(p) for p in lv]

    def test_a_glint_happens(self):
        g, _ = self.frames(60)
        self.assertGreater(g.next_glint, glisten.GLINT_FIRST[1])   # the first one has been and gone


if __name__ == '__main__':
    unittest.main()
