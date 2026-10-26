"""Laptop tests for the pure parts of the listener (no SPI, no network).

    python -m unittest discover -s pi/tests      (from the repo root)

Checks the LED map against tools/led_map.json, the hold order and roles
against the app's rules, mirroring against app/mirror_map.json, the current
cap, and day/night.
"""
import datetime
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import mode  # noqa: E402


def load(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return json.load(f)


class LedMap(unittest.TestCase):
    def test_all_247_match_led_map_json(self):
        m = load('tools', 'led_map.json')
        for n in range(1, 248):
            self.assertEqual(board.led_index(n), m['hold%d' % n], 'hold%d' % n)

    def test_known_points(self):
        self.assertEqual(board.led_index(1), 1)     # A1, bottom of column A
        self.assertEqual(board.led_index(20), 2)    # A2: column A runs up
        self.assertEqual(board.led_index(2), 26)    # B1: column B runs down
        self.assertEqual(board.led_index(24), 54)

    def test_hold_number(self):
        self.assertEqual(board.hold_number('hold1'), 1)
        self.assertEqual(board.hold_number('hold247'), 247)
        for bad in ('hold0', 'hold248', 'hold999', 'Hold1', 'hold', 'hold1 ', 'x', None, 5):
            self.assertIsNone(board.hold_number(bad), bad)


class OrderAndRoles(unittest.TestCase):
    def test_order_is_inverted(self):
        row = {'finish_hold': 'hold200', 'intermediate_holds': ['hold100', 'hold60'],
               'start_holds': ['hold10', 'hold11']}
        self.assertEqual(board.problem_order(row), ['hold200', 'hold100', 'hold60', 'hold10', 'hold11'])

    def test_classify_like_the_app(self):
        # order[0], order[1] = starts; order[-1] = finish; finish wins a clash.
        c = board.classify(['hold200', 'hold100', 'hold60', 'hold10', 'hold11'])
        self.assertEqual(c, {'hold200': 'start', 'hold100': 'start', 'hold60': 'int',
                             'hold10': 'int', 'hold11': 'finish'})
        self.assertEqual(board.classify([]), {})
        self.assertEqual(board.classify(['hold5']), {'hold5': 'finish'})
        self.assertEqual(board.classify(['hold5', 'hold5', 'hold9']), {'hold5': 'start', 'hold9': 'finish'})

    def test_frame_classifies_before_dropping(self):
        # A bad id in a start slot stays a start (and is dropped); roles don't shift.
        row = {'finish_hold': 'hold999', 'intermediate_holds': ['hold100', 'hold60'], 'start_holds': ['hold10']}
        leds, dropped = board.frame(row)
        self.assertEqual(dropped, ['hold999'])
        self.assertEqual(leds[board.led_index(100)], board.COLOURS['start'])
        self.assertEqual(leds[board.led_index(60)], board.COLOURS['int'])
        self.assertEqual(leds[board.led_index(10)], board.COLOURS['finish'])

    def test_bad_rows(self):
        with self.assertRaises(ValueError):
            board.problem_order({'start_holds': [1, 2]})
        with self.assertRaises(ValueError):
            board.problem_order({'start_holds': {'a': 1}})
        self.assertEqual(board.frame({}), ({}, []))


class Mirror(unittest.TestCase):
    def test_mirror_moves_holds_keeps_roles(self):
        mm = load('app', 'mirror_map.json')
        board.check_mirror_map(mm)
        row = {'finish_hold': 'hold1', 'intermediate_holds': ['hold3'], 'start_holds': ['hold4', 'hold5']}
        plain, _ = board.frame(row)
        mirrored, _ = board.frame(row, True, mm)
        for h, role in board.classify(board.problem_order(row)).items():
            self.assertEqual(mirrored[board.led_index(board.hold_number(mm.get(h, h)))], board.COLOURS[role])
        self.assertEqual(len(plain), len(mirrored))

    def test_absent_and_self_stay(self):
        row = {'finish_hold': 'hold10', 'start_holds': ['hold200']}
        leds, _ = board.frame(row, True, {'hold10': 'hold10'})
        self.assertIn(board.led_index(10), leds)
        self.assertIn(board.led_index(200), leds)

    def test_bad_map(self):
        with self.assertRaises(ValueError):
            board.check_mirror_map(['hold1'])


class Cap(unittest.TestCase):
    def test_brightness_and_cap(self):
        leds = {i: (255, 255, 255) for i in range(1, 101)}          # 100 white pixels
        out, cap, ma = board.scale(leds, 1.0, 0, 20)
        self.assertEqual(cap, 1.0)
        self.assertEqual(out[1], (255, 255, 255))
        self.assertAlmostEqual(ma, 6000)
        out, cap, ma = board.scale(leds, 0.5, 2000, 20)              # 3000 mA asked, 2000 allowed
        self.assertAlmostEqual(cap, 2 / 3)
        self.assertAlmostEqual(ma, 2000)
        self.assertEqual(out[1], (85, 85, 85))
        out, _, _ = board.scale({1: (0, 255, 0)}, '0.5', 8000, 20)   # string from config
        self.assertEqual(out[1], (0, 128, 0))


class DayNight(unittest.TestCase):
    cfg = dict(mode.DEFAULTS)

    def at(self, hh, mm, synced=True, **over):
        cfg = dict(self.cfg, **over)
        return mode.current_mode(datetime.datetime(2026, 10, 26, hh, mm), synced, cfg)[0]

    def test_window_wraps_midnight(self):
        self.assertEqual(self.at(22, 59), 'day')
        self.assertEqual(self.at(23, 0), 'night')
        self.assertEqual(self.at(2, 0), 'night')
        self.assertEqual(self.at(7, 59), 'night')
        self.assertEqual(self.at(8, 0), 'day')
        self.assertEqual(self.at(12, 0), 'day')

    def test_window_same_day(self):
        self.assertEqual(self.at(1, 0, NIGHT_START='00:30', NIGHT_END='06:00'), 'night')
        self.assertEqual(self.at(6, 0, NIGHT_START='00:30', NIGHT_END='06:00'), 'day')
        self.assertEqual(self.at(23, 30, NIGHT_START='00:30', NIGHT_END='06:00'), 'day')

    def test_fail_open(self):
        self.assertEqual(self.at(2, 0, synced=False), 'day')
        self.assertEqual(self.at(2, 0, NIGHT_START='25:00'), 'day')
        self.assertEqual(self.at(2, 0, NIGHT_START='nope'), 'day')
        self.assertEqual(self.at(2, 0, NIGHT_START='08:00'), 'day')     # empty window
        self.assertEqual(self.at(2, 0, NIGHT_MODE='off'), 'day')

    def test_force(self):
        self.assertEqual(self.at(12, 0, NIGHT_FORCE='night'), 'night')
        self.assertEqual(self.at(2, 0, NIGHT_FORCE='day', synced=False), 'day')
        self.assertEqual(self.at(12, 0, NIGHT_FORCE='night', synced=False), 'night')

    def test_config_file(self):
        p = os.path.join(ROOT, 'pi', 'config.env.example')
        cfg = mode.load_config(p)
        self.assertEqual(cfg['NIGHT_START'], '23:00')
        self.assertEqual(cfg['SUPABASE_URL'], '')
        self.assertEqual(cfg['BOARD_WALL'], 'HangoutPortland')


if __name__ == '__main__':
    unittest.main()
