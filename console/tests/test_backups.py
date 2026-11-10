"""Laptop tests for the weekly backups (console/backups.py) and their Home warning (tiles.backup_tile).

    python -m unittest discover -s console/tests      (from the repo root)

When one is due (7 days since the last good one, retried hourly after a failure), the state a
run leaves (a part failing marks it failed; one part alone never counts as the weekly backup),
and the warning: only a failed try or a good backup over 8 days old.
"""
import datetime
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
sys.path.insert(0, CONSOLE)
sys.dont_write_bytecode = True
import backups  # noqa: E402
import reports  # noqa: E402
import tiles  # noqa: E402


def iso(seconds_ago):
    return datetime.datetime.fromtimestamp(time.time() - seconds_ago).isoformat(timespec='seconds')


class Backups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._state, self._dir = backups.STATE, reports.BACKUPS
        backups.STATE = os.path.join(self.tmp, 'backups.json')
        reports.BACKUPS = os.path.join(self.tmp, 'backups')

    def tearDown(self):
        backups.STATE, reports.BACKUPS = self._state, self._dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_due(self):
        self.assertTrue(backups.due({}))                                         # never
        self.assertFalse(backups.due({'ok_at': iso(6 * 86400)}))
        self.assertTrue(backups.due({'ok_at': iso(7 * 86400 + 60)}))
        self.assertFalse(backups.due({'ok_at': iso(9 * 86400), 'tried_at': iso(600)}))     # failed 10 min ago: wait
        self.assertTrue(backups.due({'ok_at': iso(9 * 86400), 'tried_at': iso(3700)}))

    def test_run_records_ok_and_failed(self):
        with mock.patch.object(backups, 'backup_pi', return_value=None), \
                mock.patch.object(backups, 'backup_supabase', return_value=None):
            self.assertEqual(backups.run(remote=object(), out=lambda *_: None, how='automatic'), 0)
        s = backups.load_state()
        self.assertEqual((s['result'], s['how']), ('ok', 'automatic'))
        self.assertEqual(s['ok_at'], s['tried_at'])
        self.assertFalse(backups.due())
        with mock.patch.object(backups, 'backup_pi', return_value='the Pi: timed out'), \
                mock.patch.object(backups, 'backup_supabase', return_value=None):
            self.assertEqual(backups.run(remote=object(), out=lambda *_: None), 1)
        s = backups.load_state()
        self.assertEqual(s['result'], 'failed')
        self.assertIn('timed out', s['error'])
        self.assertEqual(tiles.backup_tile(backups.summary())['level'], tiles.BAD)

    def test_one_part_is_not_the_weekly_backup(self):
        with mock.patch.object(backups, 'backup_supabase', return_value=None):
            backups.run(remote=object(), out=lambda *_: None, parts=('supabase',))
        self.assertIsNone(backups.load_state().get('ok_at'))

    def test_warning(self):
        now = time.time()
        self.assertEqual(tiles.backup_tile({'ok_at': now - 3 * 86400}, now)['level'], tiles.OK)
        self.assertEqual(tiles.backup_tile({'ok_at': now - 8.5 * 86400}, now)['level'], tiles.WARN)
        self.assertEqual(tiles.backup_tile({}, now)['level'], tiles.WARN)
        self.assertEqual(tiles.backup_tile({'ok_at': now, 'result': 'failed', 'error': 'x'}, now)['level'], tiles.BAD)


if __name__ == '__main__':
    unittest.main()
