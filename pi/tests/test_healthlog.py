"""Laptop tests for the health log (pi/ops/pb-healthlog) and its reader (console/probe.py healthlog).

    python -m unittest discover -s pi/tests      (from the repo root)

The 5-minute window (the highest temperature, under-voltage and throttling counted from
the get_throttled bits), the day files, keeping 7 days, and the console's reader:
only the last N days, oldest first, a bad line skipped.
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.dont_write_bytecode = True


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


hl = load('pb_healthlog', os.path.join(ROOT, 'pi', 'ops', 'pb-healthlog'))
probe = load('pb_probe', os.path.join(ROOT, 'console', 'probe.py'))


class Window(unittest.TestCase):
    def test_counts(self):
        w = hl.Window()
        w.add(50.0, 0x0)
        w.add(61.5, 0x1)          # under-voltage now
        w.add(55.0, 0x50005)      # under-voltage now and throttled now (+ the since-boot bits, ignored)
        w.add(None, None)         # vcgencmd and the sensor didn't answer: nothing counted
        row = w.line(1000.9, 55.0, 70, 41.2)
        self.assertEqual(row, {'t': 1000, 'temp': 55.0, 'tmax': 61.5, 'uv': 2, 'thr': 1, 'wifi': 70, 'disk': 41.2})

    def test_since_boot_bits_alone_count_nothing(self):
        w = hl.Window()
        w.add(50.0, 0x50000)
        row = w.line(1, 50.0, None, None)
        self.assertEqual((row['uv'], row['thr']), (0, 0))


class Files(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_append_prune_and_read(self):
        now = time.time()
        for days_ago in (9, 8, 6, 1, 0):
            t = now - days_ago * 86400
            hl.append({'t': int(t), 'temp': 50 + days_ago, 'tmax': 51, 'uv': 0, 'thr': 0, 'wifi': 60, 'disk': 40}, self.dir)
        with open(hl.day_file(now, self.dir), 'a', encoding='utf-8') as f:
            f.write('not json\n')
        gone = hl.prune(now, self.dir)
        self.assertEqual(len(gone), 2)                       # 9 and 8 days ago
        self.assertEqual(len(os.listdir(self.dir)), 3)
        out = probe.healthlog(7, folder=self.dir, now=now)
        self.assertEqual(out['cols'], ['t', 'temp', 'tmax', 'uv', 'thr', 'wifi', 'disk'])
        self.assertEqual([r[1] for r in out['rows']], [56, 51, 50])     # oldest first, the bad line skipped
        self.assertEqual(len(probe.healthlog(2, folder=self.dir, now=now)['rows']), 2)
        json.dumps(out)                                       # it goes back to the laptop as JSON

    def test_missing_folder(self):
        self.assertEqual(probe.healthlog(7, folder=os.path.join(self.dir, 'nope'))['rows'], [])
        self.assertEqual(hl.prune(time.time(), os.path.join(self.dir, 'nope')), [])


if __name__ == '__main__':
    unittest.main()
