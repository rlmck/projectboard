"""Laptop tests for the automatic Pi deploy (console/autodeploy.py) and the busy guard's
rules (console/probe.py busy), with a fake Pi: no network, no ssh, nothing deployed.

    python -m unittest discover -s console/tests      (from the repo root)
"""
import datetime
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
sys.path.insert(0, CONSOLE)
sys.dont_write_bytecode = True
import autodeploy  # noqa: E402
import probe  # noqa: E402


class FakeRemote:
    def __init__(self, busy=None, config='A=1\n'):
        self._busy = busy
        self.config = config
        self.calls = []

    def busy(self):
        self.calls.append('busy')
        return self._busy

    def probe(self, mode=''):
        self.calls.append('probe ' + mode)
        return {'ok': True, 'current': self.config}


class Attention(unittest.TestCase):
    def test_nothing_when_all_is_well(self):
        self.assertEqual(autodeploy.attention({'result': 'up to date'}, None, True), [])

    def test_waiting_for_a_busy_board_is_not_a_problem(self):
        s = {'result': 'waiting', 'waiting': 'the board was used at 20:10', 'pending_since': datetime.datetime.now().isoformat()}
        self.assertEqual(autodeploy.attention(s, None, True), [])

    def test_config_drift_comes_from_the_live_check_only(self):
        s = {'problem': autodeploy.problem('config')}
        self.assertEqual(autodeploy.attention(s, None, True), [])          # fixed since: no banner
        items = autodeploy.attention({}, '--- diff', True)
        self.assertEqual([i['kind'] for i in items], ['config'])
        self.assertEqual(items[0]['tab'], 'config')

    def test_late_after_a_day(self):
        since = (datetime.datetime.now() - datetime.timedelta(hours=25)).isoformat(timespec='seconds')
        items = autodeploy.attention({'pending_since': since, 'waiting': 'the Pi is not answering'}, None, True)
        self.assertEqual([i['kind'] for i in items], ['late'])
        self.assertIn('not answering', items[0]['todo'])

    def test_task_missing(self):
        self.assertEqual([i['kind'] for i in autodeploy.attention({}, None, False)], ['task'])
        self.assertEqual(autodeploy.attention({}, None, None), [])           # can't tell: say nothing

    def test_every_problem_is_plain_text_with_a_todo(self):
        for k in ('config', 'tests', 'password', 'failed', 'late', 'task'):
            p = autodeploy.problem(k)
            self.assertTrue(p['title'] and p['todo'] and p['tab'])
            self.assertNotIn('<', p['title'] + p['todo'])


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.patches = [mock.patch.object(autodeploy, n, os.path.join(self.tmp, n.lower()))
                        for n in ('STATE', 'LOG', 'LAST', 'LOCK')] + [
            mock.patch.object(autodeploy, 'DATA', self.tmp),
            mock.patch.object(autodeploy, 'git', lambda *a, **k: b''),
            mock.patch.object(autodeploy, 'fingerprint', lambda ref='origin/main': ('c0ffee1' + '0' * 33, 'fp1')),
            mock.patch.object(autodeploy.actions, 'laptop_config', lambda: 'A=1\n'),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_up_to_date_never_asks_the_pi(self):
        autodeploy.save_state({'deployed': 'fp1'})
        r = FakeRemote()
        self.assertEqual(autodeploy.run(remote=r, say=lambda *_: None), 'up to date')
        self.assertEqual(r.calls, [])

    def test_busy_waits(self):
        b = {'ok': True, 'busy': True, 'last_use_at': time.time() - 60, 'quiet_at': time.time() + 840,
             'mode_reason': 'open Tue 15:30-22:00'}
        self.assertEqual(autodeploy.run(remote=FakeRemote(busy=b), say=lambda *_: None), 'waiting')
        s = autodeploy.load_state()
        self.assertIn('15 quiet minutes', s['waiting'])
        self.assertIsNone(s['problem'])
        self.assertTrue(s['pending_since'])

    def test_pi_offline_waits(self):
        self.assertEqual(autodeploy.run(remote=FakeRemote(busy=None), say=lambda *_: None), 'waiting')

    def test_config_drift_blocks(self):
        r = FakeRemote(busy={'ok': True, 'busy': False}, config='A=2\n')
        self.assertEqual(autodeploy.run(remote=r, say=lambda *_: None), 'blocked')
        self.assertEqual(autodeploy.load_state()['problem']['kind'], 'config')

    def test_lock(self):
        self.assertTrue(autodeploy.take_lock())
        self.assertFalse(autodeploy.take_lock())
        autodeploy.drop_lock()
        self.assertTrue(autodeploy.take_lock())
        autodeploy.drop_lock()


class ServerAttention(unittest.TestCase):
    """server.Console.attention with a state file from a real run (a missing import broke the overview once)."""

    def test_attention_reads_the_state(self):
        import server
        tmp = tempfile.mkdtemp()
        state = os.path.join(tmp, 'state.json')
        with open(state, 'w') as f:
            json.dump({'checked_at': datetime.datetime.now().isoformat(timespec='seconds'), 'result': 'deployed'}, f)
        fake = type('A', (), {'_task_ok': None, '_task_at': 0.0, '_kick_at': 0.0})()
        with mock.patch.object(autodeploy, 'STATE', state), mock.patch.object(autodeploy, 'task_installed', lambda: True),                 mock.patch.object(autodeploy, 'start_background') as kick:
            self.assertEqual(server.Console.attention(fake, None), [])
            self.assertEqual(server.Console.attention(fake, 'diff')[0]['kind'], 'config')
            kick.assert_not_called()                     # checked just now: no extra run


class BusyRules(unittest.TestCase):
    """probe.busy: 15 quiet minutes in opening hours, never busy at night, LED mapping always busy."""

    def check(self, status, mode, touch=None, messages=0, ledmap='inactive'):
        with mock.patch.object(probe, 'read', lambda p: json.dumps(status) if p == probe.STATUS else None), \
             mock.patch.object(probe, 'last_touch', lambda: touch), \
             mock.patch.object(probe, 'used_since', lambda s: messages), \
             mock.patch.object(probe, 'casts_since', lambda s: []), \
             mock.patch.object(probe, 'board_mode', lambda: (mode, 'test')), \
             mock.patch.object(probe, 'sh', lambda *a, **k: ledmap):
            return probe.busy()

    def test_quiet(self):
        self.assertFalse(self.check({'last_cast_at': time.time() - 16 * 60}, 'day')['busy'])

    def test_cast_14_minutes_ago(self):
        self.assertTrue(self.check({'last_cast_at': time.time() - 14 * 60}, 'day')['busy'])

    def test_wall_touch(self):
        b = self.check({}, 'day', touch=time.time() - 120)
        self.assertTrue(b['busy'])
        self.assertEqual(b['last_use_at'], b['last_touch_at'])

    def test_journal_survives_a_restart(self):
        self.assertTrue(self.check({}, 'day', messages=1)['busy'])

    def test_preview_and_circuit(self):
        self.assertTrue(self.check({'leds': 'preview'}, 'day')['busy'])
        self.assertTrue(self.check({'leds': 'circuit'}, 'day')['busy'])

    def test_night_is_never_busy(self):
        b = self.check({'last_cast_at': time.time() - 30}, 'night', touch=time.time())
        self.assertFalse(b['busy'])
        self.assertTrue(b['used_recently'])

    def test_ledmap_is_busy_at_night(self):
        self.assertTrue(self.check({}, 'night', ledmap='active')['busy'])


if __name__ == '__main__':
    unittest.main()
