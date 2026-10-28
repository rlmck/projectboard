"""Laptop tests for every idle pattern, the crossfade, the fallback and pb-idle's commands.

    python -m unittest discover -s pi/tests      (from the repo root)

Each pattern: its frame time, the 2 A cap, pixel 0 dark, nothing off the
board, no large-area flashes, and a brightness near Glisten's. Then Idle (the
cycle's crossfade, a failing pattern falling back to Glisten), the config
settings, and the renderer taking pb-idle's commands without touching a cast
or the night.
"""
import os
import re
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import patterns  # noqa: E402
import renderer  # noqa: E402
from patterns import common, teaser  # noqa: E402

FPS = 30
SLACK = 247 * 3 * 20 / 255          # the cap's rounding: half a step per channel
BENCH = teaser.from_rows([{'name': 'Test problem', 'finish_hold': 'hold238',
                           'intermediate_holds': ['hold180', 'hold121', 'hold62'],
                           'start_holds': ['hold29', 'hold31']}])
CFG = {'IDLE_AFTER_S': '60', 'IDLE_ANIMATION': 'on', 'IDLE_FPS': '30', 'IDLE_MAX_AMPS': '2.0',
       'IDLE_BRIGHTNESS': '1.0', 'MA_PER_CHANNEL': '20'}
CAST = {54: (0, 127, 0), 1: (0, 127, 0), 200: (0, 0, 127), 247: (127, 0, 0)}


def ma(frame, per_channel=20.0):
    return sum(c / 255 * per_channel for rgb in frame.values() for c in rgb)


def make(name, **kw):
    return patterns.PATTERNS[name](seed=3, ctx={'benchmarks': BENCH}, **kw)


class Solid(common.Pattern):
    """One colour everywhere (for the crossfade test)."""
    rgb = (0.5, 0.0, 0.0)

    def levels(self, t):
        return [list(self.rgb) for _ in range(common.CELLS)]


class Red(Solid):
    name, rgb = 'red', (0.5, 0.0, 0.0)


class Blue(Solid):
    name, rgb = 'blue', (0.0, 0.0, 0.5)


class Breaks(common.Pattern):
    """Fine for 2 s, then throws."""
    name = 'breaks'

    def levels(self, t):
        if t > 2:
            raise ZeroDivisionError('test')
        return [[0.3, 0.3, 0.3] for _ in range(common.CELLS)]


class Short(common.Pattern):
    name = 'short'

    def levels(self, t):
        return [[0.3, 0.3, 0.3]] * 10


class NotANumber(common.Pattern):
    name = 'nan'

    def levels(self, t):
        return [[float('nan'), 0, 0] for _ in range(common.CELLS)]


class Registered:
    """Add test patterns to the registry for one test."""

    def __init__(self, *classes):
        self.classes = classes

    def __enter__(self):
        for c in self.classes:
            patterns.PATTERNS[c.name] = c

    def __exit__(self, *a):
        for c in self.classes:
            patterns.PATTERNS.pop(c.name, None)


class EveryPattern(unittest.TestCase):
    def frames(self, name, seconds=60, **kw):
        p = make(name, **kw)
        return p, [p.frame(k / FPS) for k in range(int(seconds * FPS))]

    def test_registry(self):
        self.assertEqual(patterns.NAMES, ['glisten', 'chase', 'lava', 'breathe', 'aurora', 'rain', 'ripples',
                                          'fireflies', 'teaser', 'wave'])
        for n, cls in patterns.PATTERNS.items():
            self.assertEqual(cls.name, n)
            self.assertTrue(cls.about)

    def test_frame_time(self):
        # The Pi 4 is about 3.5x slower than a laptop (Glisten: 0.9 ms here, 3 ms there); every
        # pattern must stay within ~5 ms there. pi/tools/idle_bench.py measures it on the Pi.
        glisten_ms = None
        for n in patterns.NAMES:
            p = make(n)
            for k in range(30):
                p.frame(k / FPS)                         # warm up
            a = time.perf_counter()
            for k in range(30, 330):
                p.frame(k / FPS)
            ms = (time.perf_counter() - a) / 300 * 1000
            if n == 'glisten':
                glisten_ms = ms
            with self.subTest(pattern=n):
                self.assertLess(ms, 5.0)
                self.assertLess(ms, glisten_ms * 5 / 3 + 0.2)   # Glisten's 3 ms on the Pi -> 5 ms

    def test_pixel_0_dark_and_only_the_board(self):
        for n in patterns.NAMES:
            _, fs = self.frames(n, 30)
            with self.subTest(pattern=n):
                for f in fs:
                    self.assertNotIn(0, f)
                    self.assertTrue(all(1 <= i <= board.MAX_HOLD for i in f))
                    self.assertTrue(all(0 <= c <= 255 and isinstance(c, int) for rgb in f.values() for c in rgb))

    def test_the_2a_cap(self):
        for n in patterns.NAMES:
            _, fs = self.frames(n, 60)
            with self.subTest(pattern=n):
                self.assertLessEqual(max(ma(f) for f in fs), 2000 + SLACK)

    def test_a_low_cap_holds(self):
        for n in patterns.NAMES:
            p, fs = self.frames(n, 10, max_ma=150)
            with self.subTest(pattern=n):
                self.assertGreater(p.capped_frames, 0)
                self.assertLessEqual(max(ma(f) for f in fs), 150 + SLACK)

    def test_brightness_near_glisten(self):
        def mean(n):
            _, fs = self.frames(n, 60)
            return sum(ma(f) for f in fs) / len(fs)
        g = mean('glisten')
        for n in patterns.NAMES[1:]:
            with self.subTest(pattern=n):
                low = 0.15 if getattr(patterns.PATTERNS[n], 'dark', False) else 0.4   # dark: lit only in places
                self.assertTrue(low * g < mean(n) < 1.4 * g)

    def test_no_large_area_flashes(self):
        for n in patterns.NAMES:
            p = make(n)
            prev = None
            worst = 0
            for k in range(FPS * 60):
                lv = [sum(min(1.0, max(0.0, v)) for v in c) for c in p.levels(k / FPS)]
                if prev:
                    worst = max(worst, sum(1 for a, b in zip(lv, prev) if abs(a - b) > 0.3))
                prev = lv
            with self.subTest(pattern=n):
                self.assertLessEqual(worst, 3)          # at most a few single cells jump frame to frame

    def test_palette_matches_the_app(self):
        with open(os.path.join(ROOT, 'app', 'tokens.css'), encoding='utf-8') as f:
            css = f.read()
        for k, v in common.TOKENS.items():
            m = re.search(r'--%s:\s*(#[0-9a-fA-F]{6})' % k, css)
            self.assertIsNotNone(m, k)
            self.assertEqual(m.group(1).lower(), v)


class Teaser(unittest.TestCase):
    def test_shows_a_benchmark_in_its_cast_colours(self):
        p = make('teaser')
        seen = False
        for k in range(FPS * 40):
            lv = p.levels(k / FPS)
            if p.showing and teaser.FADE < k / FPS - p.showing[2] < teaser.FADE + teaser.HOLD:
                # Stored inverted (CLAUDE.md): finish_hold hold238 is really a start, start hold31 the finish.
                finish = lv[30]
                start = lv[237]
                self.assertGreater(finish[0], 0.5)
                self.assertLess(finish[1] + finish[2], 0.2)
                self.assertGreater(start[1], 0.5)
                seen = True
        self.assertTrue(seen)
        self.assertEqual(p.shown[0], 'Test problem')

    def test_no_benchmarks_just_the_shimmer(self):
        p = patterns.PATTERNS['teaser'](seed=1, ctx={})
        for k in range(FPS * 30):
            p.levels(k / FPS)
        self.assertEqual(p.shown, [])

    def test_from_rows_skips_bad_ones(self):
        rows = [{'name': 'ok', 'finish_hold': 'hold5', 'intermediate_holds': ['hold6'], 'start_holds': ['hold7']},
                {'name': 'bad', 'finish_hold': 5}, {'name': 'empty'}, {'name': 'off grid', 'finish_hold': 'hold999'}]
        out = teaser.from_rows(rows)
        self.assertEqual([n for n, _ in out], ['ok'])
        self.assertEqual(out[0][1], {4: 'start', 5: 'start', 6: 'finish'})


class IdleTests(unittest.TestCase):
    def test_crossfade(self):
        with Registered(Red, Blue):
            logs = []
            i = patterns.Idle(patterns.Plan(['red', 'blue'], 10, 0.0, 'cycle'), 0.0, log=logs.append)
            self.assertEqual(i.levels(9.9)[0], [0.5, 0.0, 0.0])
            self.assertEqual(i.name, 'red')
            i.levels(10.0)
            self.assertEqual(i.name, 'blue')
            mid = i.levels(10 + patterns.CROSSFADE / 2)[0]
            self.assertAlmostEqual(mid[0], 0.25)
            self.assertAlmostEqual(mid[2], 0.25)
            self.assertEqual(i.levels(10 + patterns.CROSSFADE + 0.01)[0], [0.0, 0.0, 0.5])
            self.assertIsNone(i.prev)
            i.levels(20.0)
            self.assertEqual(i.name, 'red')              # round again
            self.assertTrue(any('idle pattern blue (cycle 2/2' in m for m in logs))

    def test_cycle_position_follows_the_clock(self):
        plan = patterns.Plan(['glisten', 'lava', 'rain'], 60, 1000.0, 'cycle')
        i = patterns.Idle(plan, 1000.0 + 130, log=lambda m: None)   # started after a cast, 130 s in
        self.assertEqual(i.name, 'rain')                 # not back to the first

    def test_a_failing_pattern_falls_back_to_glisten(self):
        for broken in (Breaks, Short, NotANumber):
            with self.subTest(pattern=broken.name), Registered(broken):
                errs = []
                i = patterns.Idle(patterns.Plan([broken.name]), 0.0, err=errs.append, log=lambda m: None)
                fs = [i.frame(k / FPS) for k in range(FPS * 4)]
                self.assertEqual(i.name, 'glisten')
                self.assertEqual(len(errs), 1)
                self.assertIn('Glisten instead', errs[0])
                self.assertTrue(fs[-1])
                self.assertNotIn(0, fs[-1])

    def test_a_failing_pattern_is_skipped_in_a_cycle(self):
        with Registered(Breaks, Red):
            i = patterns.Idle(patterns.Plan(['breaks', 'red'], 10, 0.0, 'cycle'), 0.0, err=lambda m: None,
                              log=lambda m: None)
            for k in range(FPS * 25):
                i.levels(k / FPS)
            self.assertEqual(i.name, 'glisten')          # 20-30 s is breaks' slot again: Glisten instead

    def test_glisten_failing_reaches_the_renderer(self):
        clock = Clock()
        logs = []
        r = renderer.Renderer(Strip(), dict(CFG), False, logs.append, logs.append, logs.append, clock=clock, seed=1)
        r.step(clock.t)
        r.anim.cur[1].levels = boom
        run_for(r, clock, 2)
        self.assertTrue(r.broken)
        self.assertEqual(sum('Glisten failed' in m for m in logs), 1)
        r.cast(CAST)
        r.step(clock.t)
        self.assertEqual(r.strip.last, CAST)

    def test_a_failing_pattern_keeps_the_renderer_going(self):
        with Registered(Breaks):
            clock = Clock()
            logs = []
            r = renderer.Renderer(Strip(), dict(CFG, IDLE_PATTERN='breaks'), False, logs.append, logs.append,
                                  logs.append, clock=clock, seed=1)
            run_for(r, clock, 5)
            self.assertFalse(r.broken)
            self.assertEqual(r.anim.name, 'glisten')
            self.assertTrue(r.strip.last)
            self.assertEqual(r.stats()['leds'], 'glisten')


def boom(t):
    raise ZeroDivisionError('test')


class Config(unittest.TestCase):
    def test_default_is_glisten(self):
        plan, cycle = patterns.config_plans({}, 0.0, warn=self.fail)
        self.assertEqual((plan.kind, plan.names), ('one', ['glisten']))
        self.assertEqual(cycle.names, patterns.NAMES)
        self.assertEqual(cycle.slot, 600)

    def test_one_pattern(self):
        plan, _ = patterns.config_plans({'IDLE_PATTERN': ' Lava '}, 0.0, warn=self.fail)
        self.assertEqual(plan.names, ['lava'])

    def test_cycle(self):
        plan, cycle = patterns.config_plans({'IDLE_PATTERN': 'cycle', 'IDLE_CYCLE': 'lava, aurora rain',
                                             'IDLE_CYCLE_MIN': '2.5'}, 5.0, warn=self.fail)
        self.assertIs(plan, cycle)
        self.assertEqual((plan.kind, plan.names, plan.slot, plan.epoch),
                         ('cycle', ['lava', 'aurora', 'rain'], 150, 5.0))

    def test_bad_settings_warn_and_fall_back(self):
        warns = []
        plan, cycle = patterns.config_plans({'IDLE_PATTERN': 'disco', 'IDLE_CYCLE': 'lava, strobe',
                                             'IDLE_CYCLE_MIN': 'soon'}, 0.0, warn=warns.append)
        self.assertEqual(plan.names, ['glisten'])
        self.assertEqual(cycle.names, ['lava'])
        self.assertEqual(cycle.slot, 600)
        self.assertEqual(len(warns), 3)


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

    @property
    def last(self):
        return self.writes[-1][0]


def run_for(r, clock, seconds, dt=1 / FPS):
    end = clock.t + seconds
    while clock.t < end:
        r.step(clock.t)
        clock.t += dt


class PbIdle(unittest.TestCase):
    def make(self, night=False, **cfg):
        self.clock, self.logs = Clock(), []
        self.r = renderer.Renderer(Strip(), dict(CFG, **cfg), night, self.logs.append, self.logs.append,
                                   self.logs.append, clock=self.clock, seed=2)
        return self.r

    def test_switch_now_crossfades(self):
        r = self.make()
        run_for(r, self.clock, 3)
        r.set_pattern('lava')
        r.step(self.clock.t)
        self.assertEqual(r.anim.name, 'lava')
        self.assertIsNotNone(r.anim.prev)                # Glisten fading out
        run_for(r, self.clock, patterns.CROSSFADE + 0.1)
        self.assertIsNone(r.anim.prev)
        self.assertEqual(r.stats()['idle_override'], 'lava')

    def test_a_lit_problem_stays_lit(self):
        r = self.make()
        r.cast(CAST)
        r.step(self.clock.t)
        n = len(r.strip.writes)
        r.set_pattern('rain')
        run_for(r, self.clock, 10)
        self.assertEqual(r.state, renderer.CAST)
        self.assertEqual(len(r.strip.writes), n)        # nothing written over the problem
        run_for(r, self.clock, 51)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertEqual(r.anim.name, 'rain')            # and it shows at the next idle

    def test_night_still_wins(self):
        r = self.make(night=True)
        run_for(r, self.clock, 2)
        r.set_pattern('tour')
        run_for(r, self.clock, 5)
        self.assertEqual(r.state, renderer.NIGHT)
        self.assertEqual(r.strip.writes, [])
        r.set_night(False)
        run_for(r, self.clock, 1)
        self.assertEqual(r.anim.name, 'glisten')         # the tour starts when it first shows
        self.assertIn('tour 1/', r.anim.label)

    def test_tour_then_back_to_the_default(self):
        r = self.make(IDLE_PATTERN='aurora')
        run_for(r, self.clock, 1, dt=0.25)
        r.set_pattern('tour')
        seen = []
        for _ in range(int(len(patterns.NAMES) * patterns.TOUR_S / 2) + 4):
            run_for(r, self.clock, 2, dt=0.5)
            if not seen or seen[-1] != r.anim.name:
                seen.append(r.anim.name)
        self.assertEqual(seen[:len(patterns.NAMES)], patterns.NAMES)
        self.assertEqual(r.anim.name, 'aurora')
        self.assertIsNone(r.override)
        self.assertEqual(sum('idle pattern %s (tour' % n in m for n in patterns.NAMES for m in self.logs),
                         len(patterns.NAMES))           # each one named in the journal
        self.assertTrue(any('tour is over' in m for m in self.logs))

    def test_default_and_unknown(self):
        r = self.make()
        run_for(r, self.clock, 1)
        r.set_pattern('fireflies')
        r.step(self.clock.t)
        r.set_pattern('strobe')
        r.step(self.clock.t)
        self.assertEqual(r.anim.name, 'fireflies')
        self.assertTrue(any("no pattern called 'strobe'" in m for m in self.logs))
        r.set_pattern('default')
        r.step(self.clock.t)
        self.assertEqual(r.anim.name, 'glisten')
        self.assertIsNone(r.stats()['idle_override'])

    def test_benchmarks_reach_the_teaser(self):
        r = self.make(IDLE_PATTERN='teaser')
        r.set_benchmarks(BENCH)
        run_for(r, self.clock, 30, dt=0.1)
        self.assertEqual(r.anim.cur[1].shown[0], 'Test problem')

    def test_off_takes_a_lit_problem_dark_and_casts_still_light(self):
        r = self.make()
        r.cast(CAST)
        r.step(self.clock.t)
        r.set_pattern('off')
        run_for(r, self.clock, 2)
        self.assertEqual(r.state, renderer.IDLE)
        self.assertEqual(r.strip.last, {})               # faded out, then cleared
        self.assertEqual(r.stats()['leds'], 'off')
        self.assertEqual(r.stats()['idle_override'], 'off')
        r.cast(CAST)
        r.step(self.clock.t)
        self.assertEqual(r.strip.last, CAST)             # a cast still lights
        run_for(r, self.clock, 62)
        self.assertEqual(r.strip.last, {})               # and idle is dark again after it
        n = len(r.strip.writes)
        run_for(r, self.clock, 5)
        self.assertEqual(len(r.strip.writes), n)         # nothing drawn while off

    def test_default_or_a_pattern_ends_off(self):
        r = self.make()
        run_for(r, self.clock, 1)
        r.set_pattern('off')
        run_for(r, self.clock, 2)
        r.set_pattern('default')
        run_for(r, self.clock, 2)
        self.assertEqual(r.stats()['leds'], 'glisten')
        self.assertTrue(r.strip.last)
        r.set_pattern('off')
        run_for(r, self.clock, 2)
        r.set_pattern('rain')
        run_for(r, self.clock, 1)
        self.assertEqual(r.anim.name, 'rain')
        self.assertEqual(r.stats()['idle_override'], 'rain')

    def test_off_at_night_stays_dark_in_the_morning(self):
        r = self.make(night=True)
        run_for(r, self.clock, 1)
        r.set_pattern('off')
        run_for(r, self.clock, 1)
        r.set_night(False)
        run_for(r, self.clock, 3)
        self.assertEqual(r.stats()['leds'], 'off')
        self.assertFalse(any(f for f, _ in r.strip.writes))

    def test_brightness_dims_casts_and_idle(self):
        r = self.make()
        r.cast(CAST)
        r.step(self.clock.t)
        full = sum(sum(v) for v in r.strip.last.values())
        r.set_pattern('brightness 0.5')
        r.step(self.clock.t)
        half = sum(sum(v) for v in r.strip.last.values())
        self.assertLess(half, full)                      # the lit problem rewritten, dimmer
        self.assertEqual(r.shown, CAST)                  # kept undimmed
        self.assertEqual(r.stats()['brightness_scale'], 0.5)
        r.set_pattern('brightness 1')
        r.step(self.clock.t)
        self.assertEqual(r.strip.last, CAST)

    def test_brightness_out_of_range_is_ignored(self):
        r = self.make()
        for bad in ('brightness 1.5', 'brightness 0', 'brightness', 'brightness x'):
            r.set_pattern(bad)
            r.step(self.clock.t)
        self.assertEqual(r.scale, 1.0)
        self.assertEqual(sum('ignored' in m for m in self.logs), 4)


if __name__ == '__main__':
    unittest.main()
