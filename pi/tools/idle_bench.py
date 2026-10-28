#!/usr/bin/env python3
"""Time every idle pattern, and estimate its current. Never touches the strip.

    python3 idle_bench.py [--seconds 60] [--fps 30] [pattern ...]

Runs each pattern the way the renderer does (patterns.Idle: levels, brightness,
gamma, the 2 A cap) at a fake 30 fps for --seconds of pattern time, as fast as
it can, and prints the milliseconds a frame (mean, 95th percentile, worst) and
the estimated current (mean, peak, frames the cap scaled down). The 'cycle'
row times a crossfade (two patterns at once) for each pair in the tour order.

On the laptop: python pi/tools/idle_bench.py. On the Pi (the listener keeps
running; this only uses CPU), from the laptop at the repo root:
    ssh pi@projectboard 'mkdir -p ~/pb-bench' && scp -rq pi/listener pi/tools/idle_bench.py pi@projectboard:pb-bench/
    ssh pi@projectboard 'python3 ~/pb-bench/idle_bench.py; rm -rf ~/pb-bench'
"""
import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
for p in (os.path.join(HERE, 'listener'), os.path.join(HERE, '..', 'listener')):
    if os.path.isdir(os.path.join(p, 'patterns')):
        sys.path.insert(0, p)
        break
sys.dont_write_bytecode = True
import patterns  # noqa: E402

BENCHMARKS = [('made-up', {28: 'start', 30: 'start', 61: 'int', 85: 'int', 120: 'int', 144: 'int', 179: 'int',
                           237: 'finish'})]


def ma(frame, per=20.0):
    return sum(c for rgb in frame.values() for c in rgb) / 255 * per


def run(plan, seconds, fps):
    idle = patterns.Idle(plan, 0.0, {'benchmarks': BENCHMARKS}, log=lambda m: None, err=print, seed=1)
    times, mas = [], []
    for k in range(int(seconds * fps)):
        t = k / fps
        a = time.perf_counter()
        f = idle.frame(t)
        times.append(time.perf_counter() - a)
        mas.append(ma(f))
    times.sort()
    n = len(times)
    return (sum(times) / n * 1000, times[int(n * 0.95)] * 1000, times[-1] * 1000,
            sum(mas) / n, max(mas), idle.capped_frames)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=float, default=60)
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('names', nargs='*')
    a = ap.parse_args(argv)
    names = a.names or patterns.NAMES
    print('%s, %g s of each at %g fps' % (sys.version.split()[0], a.seconds, a.fps))
    print('%-10s %7s %7s %7s %8s %8s %7s' % ('pattern', 'mean ms', 'p95 ms', 'max ms', 'mean mA', 'peak mA',
                                              'capped'))
    for n in names:
        print('%-10s %7.2f %7.2f %7.2f %8.0f %8.0f %7d' % ((n,) + run(patterns.Plan([n]), a.seconds, a.fps)),
              flush=True)
    if not a.names:
        # Every pattern for CROSSFADE + 1 s: the frames inside a crossfade run two patterns.
        slot = patterns.CROSSFADE + 1
        plan = patterns.Plan(patterns.NAMES, slot, 0.0, 'cycle')
        print('%-10s %7.2f %7.2f %7.2f %8.0f %8.0f %7d' % (('cycle',) + run(plan, slot * len(names), a.fps)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
