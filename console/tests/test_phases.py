"""Laptop tests for PB Console phases 5-15 (no Pi, no network).

    python -m unittest discover -s console/tests      (from the repo root)

The helper's config checks and its new commands' refusals, secret stripping,
the drift map against install.sh, the release checks, the new actions' argument
checks (the deploy password never shown or logged), the test-cast receipt,
activity, last night's check, the acceptance notes, and the new routes behind
the token.
"""
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
REPO = os.path.dirname(CONSOLE)
sys.path.insert(0, CONSOLE)
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import actions  # noqa: E402
import drift  # noqa: E402
import gitops  # noqa: E402
import reports  # noqa: E402
import supabase_api as supa  # noqa: E402
from test_console import ServerBase  # noqa: E402

GOOD = ('SUPABASE_URL=https://uqirowyfqwiceyjznosl.supabase.co\nSUPABASE_ANON_KEY=eyJa.eyJb.c_d-e\n'
        '# a comment\nBRIGHTNESS=0.5\nIDLE_PATTERN=wave\nNIGHT_START=23:00\nNIGHT_END=08:00\nNIGHT_FORCE=\n')


class HelperConfig(unittest.TestCase):
    def setUp(self):
        self.h = actions.helper()

    def test_values_checked(self):
        for k, v in (('BRIGHTNESS', '0.5'), ('IDLE_PATTERN', 'cycle'), ('IDLE_CYCLE', 'lava, wave'), ('NIGHT_FORCE', ''),
                     ('RELAY_PINS', '23,24'), ('IDLE_FPS', '30'), ('SUPABASE_URL', 'https://abc.supabase.co')):
            self.h.check_value(k, v)
        for k, v in (('BRIGHTNESS', '2'), ('BRIGHTNESS', 'x'), ('IDLE_PATTERN', 'disco'), ('IDLE_CYCLE', 'lava strobe'),
                     ('NIGHT_START', '25:00'), ('RELAY_PINS', '40'), ('EVIL', '1'), ('IDLE_FPS', '30; reboot'),
                     ('SUPABASE_URL', 'https://evil.example')):
            with self.assertRaises(self.h.Refused, msg='%s=%s' % (k, v)):
                self.h.check_value(k, v)

    def test_whole_file_checked(self):
        self.h.check_text(GOOD)
        for bad in (GOOD + 'EVIL=1\n', GOOD + 'just words\n', GOOD.replace('0.5', '9'),
                    GOOD.replace('SUPABASE_URL=https://uqirowyfqwiceyjznosl.supabase.co', 'SUPABASE_URL=')):
            with self.assertRaises(self.h.Refused):
                self.h.check_text(bad)

    def test_restart_only_for_start_keys(self):
        self.assertTrue(self.h.needs_restart('IDLE_PATTERN'))
        self.assertFalse(self.h.needs_restart('NIGHT_START'))
        self.assertFalse(self.h.needs_restart('WIFI_IFACE'))

    def test_secrets_stripped(self):
        text = '[wifi-security]\nkey-mgmt=wpa-psk\npsk=hunter2\n[802-1x]\npassword=x\nprivate-key-password=y\nssid=Hangout\n'
        out = self.h.strip_secrets(text)
        self.assertNotIn('hunter2', out)
        self.assertNotIn('password', out)
        self.assertIn('key-mgmt=wpa-psk', out)
        self.assertIn('ssid=Hangout', out)
        self.assertFalse(drift.has_secret(out))
        self.assertTrue(drift.has_secret(text))

    def test_new_commands_refuse_first(self):
        ran = []
        self.h.run = lambda *a, **k: ran.append(a) or (0, '')
        self.h.replace_config = lambda *a, **k: ran.append(a)
        for cmd, args in (('config-set', ['EVIL=1']), ('config-set', ['BRIGHTNESS=7']), ('config-set', []),
                          ('config-restore', ['../../etc/shadow']), ('ledmap', ['restart']), ('hashes', ['x']),
                          ('test', ['rm-rf']), ('test', ['clock', '25:00:00']), ('test', ['kill-listener', 'x']),
                          ('backup', ['x'])):
            with self.assertRaises(self.h.Refused, msg='%s %s' % (cmd, args)):
                self.h.COMMANDS[cmd](args)
        with self.assertRaises(self.h.Refused):
            self.h.cmd_config_put([], stdin=io.StringIO(GOOD + 'EVIL=1\n'))
        self.assertEqual(ran, [])

    def test_r8_buttons_are_helper_tests(self):
        for args in reports.R8_TESTS:
            self.assertIn(args[0], self.h.TESTS)


class Drift(unittest.TestCase):
    def test_every_target_is_in_install_sh(self):
        with open(os.path.join(REPO, 'pi', 'install.sh'), encoding='utf-8') as f:
            install = f.read()
        for rel, dest in drift.installed():
            self.assertTrue(os.path.exists(os.path.join(REPO, rel)), rel)
            base = os.path.dirname(dest)
            self.assertTrue(dest in install or base in install, dest)

    def test_compare(self):
        rel, dest = drift.installed()[0]
        text = '%s  %s\nsha256sum: /etc/sudoers.d/pb-console: Permission denied\n@@extra\n/usr/local/sbin/pb-netwatch.sh\n' \
               '/etc/systemd/system/pb-netwatch.service\n@@nm\npb-rescue:/etc/NetworkManager/system-connections/pb-rescue.nmconnection\n' \
               'lo:/run/NetworkManager/system-connections/lo.nmconnection\n' % (drift.sha(rel), dest)
        c = drift.compare(text)
        states = {r['pi']: r['state'] for r in c['files']}
        self.assertEqual(states[dest], 'same')
        self.assertEqual(states['/etc/sudoers.d/pb-console'], 'unreadable')
        self.assertEqual({x['pull_to'] for x in c['extra']}, {'pi/ops/pb-netwatch.sh', 'pi/systemd/pb-netwatch.service'})
        self.assertEqual([n['name'] for n in c['nm']], ['pb-rescue'])

    def test_pull_targets(self):
        self.assertIsNone(drift.pull_target('/etc/passwd'))
        self.assertIsNone(drift.pull_target('/usr/local/sbin/../../etc/shadow x'))
        self.assertEqual(drift.nm_target('pb rescue/x'), 'pi/conf/pb-rescue-x.nmconnection')


class Release(unittest.TestCase):
    def test_bump(self):
        self.assertIn("const CACHE = 'pb-v120';", gitops.bumped("x\nconst CACHE = 'pb-v119';\ny"))
        with self.assertRaises(ValueError):
            gitops.bumped('no cache here')

    def test_commit_takes_only_listed_files(self):
        with self.assertRaises(actions.Invalid):
            actions.build('git-commit', {'message': 'x', 'files': ['../outside.txt']})
        with self.assertRaises(actions.Invalid):
            actions.build('git-commit', {'message': '', 'files': []})


class NewActions(unittest.TestCase):
    def test_deploy_password_never_shown(self):
        a = actions.build('deploy', {'password': 's3cret-pw', 'dry_run': True})
        self.assertNotIn('s3cret', a.name + a.shown + a.describe + json.dumps(a.preview))
        self.assertTrue(a.confirm and not a.busy)
        self.assertTrue(actions.build('deploy', {'password': 'p'}).busy)
        for bad in ('', 'a\nb', None, 'x' * 300):
            with self.assertRaises(actions.Invalid):
                actions.build('deploy', {'password': bad})

    def test_test_steps_whitelisted(self):
        a = actions.build('test-step', {'args': ['clock', '22:59:30']})
        self.assertEqual(a.shown, 'sudo -n /usr/local/sbin/pb-console-helper test clock 22:59:30')
        self.assertTrue(a.confirm and a.busy)
        for bad in (['clock', '12:00:00'], ['reboot'], 'kill-listener', ['kill-listener', 'x']):
            with self.assertRaises(actions.Invalid):
                actions.build('test-step', {'args': bad})

    def test_config_set(self):
        a = actions.build('config-set', {'values': {'NIGHT_START': '22:30'}})
        self.assertFalse(a.busy)
        self.assertEqual(a.config, 'keep')
        self.assertTrue(actions.build('config-set', {'values': {'IDLE_PATTERN': 'lava'}}).busy)
        for bad in ({'EVIL': '1'}, {'BRIGHTNESS': '3'}, {'BRIGHTNESS': 1}, {}):
            with self.assertRaises(actions.Invalid):
                actions.build('config-set', {'values': bad})
        with self.assertRaises(actions.Invalid):
            actions.build('config-restore', {'name': '../config.env'})

    def test_other_checks(self):
        with self.assertRaises(actions.Invalid):
            actions.build('pull-file', {'path': '/etc/shadow'})
        with self.assertRaises(actions.Invalid):
            actions.build('pull-nm', {'name': 'x; reboot'})
        with self.assertRaises(actions.Invalid):
            actions.build('ledmap', {'state': 'restart'})
        with self.assertRaises(actions.Invalid):
            actions.build('test-cast', {'name': ''})
        self.assertTrue(actions.build('test-cast', {'name': 'Good Bug'}).busy)
        self.assertTrue(actions.build('ledmap', {'state': 'start'}).busy)

    def test_receipt(self):
        sent = 1000.0
        lines = '\n'.join(json.dumps(r) for r in (
            {'MESSAGE': "cast received: 'Good Bug' mirrored", '__REALTIME_TIMESTAMP': str(int(1000.3e6))},
            {'MESSAGE': "lit 'Good Bug' mirrored: 9 LEDs, ~90 mA in 300 ms", '__REALTIME_TIMESTAMP': str(int(1000.6e6))}))
        got = actions._receipt(lines, 'Good Bug', sent)
        self.assertIn('+300 ms', got['received'])
        self.assertIn('9 LEDs', got['lit'])


class Reports(unittest.TestCase):
    def test_activity(self):
        today = time.strftime('%Y-%m-%d')
        raw = {'days': 3, 'casts': [[today + 'T19:10:00+00:00', 'A', False, True], [today + 'T19:20:00+00:00', 'A', True, True],
                                    [today + 'T23:30:00+00:00', 'B', False, False], [today + 'T19:00:00+00:00', '~cast-test-A', False, True]]}
        a = reports.activity(raw)
        self.assertEqual(a['total'], 2)
        self.assertEqual(a['mirrored'], 1)
        self.assertEqual(a['ignored_night'], 1)
        self.assertEqual(a['top'], [('A', 2)])
        self.assertEqual(len(a['per_day']), 3)

    def test_night_report(self):
        raw = {'start': 's', 'end': 'e', 'ignored': ['x'],
               'at_start': ['2026-10-27T23:00:16+00:00 projectboard python3[1]: mode day -> night (clock)',
                            '2026-10-27T23:00:56+00:00 projectboard pb-mode[2]: mode night (clock), was day',
                            '2026-10-27T23:00:57+00:00 projectboard pb-mode[2]: night: screen off'],
               'at_end': ['2026-10-28T08:00:24+00:00 projectboard pb-mode[3]: day: starting kiosk.service (was inactive)']}
        r = reports.night_report(raw)
        ok = {c['check']: c['ok'] for c in r['checks']}
        self.assertTrue(ok['listener switched to night'] and ok['screen off'] and ok['kiosk started'])
        self.assertFalse(ok['LEDs faded out'])
        self.assertEqual(r['ignored_casts'], 1)

    def test_notes(self):
        tmp = tempfile.mkdtemp()
        old = reports.DATA
        reports.DATA = tmp
        try:
            reports.save_note('kill', 'pass', 'back in 5 s')
            t = {x['id']: x for x in reports.acceptance()}
            self.assertEqual((t['kill']['result'], t['kill']['note']), ('pass', 'back in 5 s'))
            with self.assertRaises(ValueError):
                reports.save_note('nope', 'pass', '')
            with self.assertRaises(ValueError):
                reports.save_note('kill', 'maybe', '')
        finally:
            reports.DATA = old

    def test_runbook_from_the_readme(self):
        titles = [s['title'] for s in reports.runbook()]
        self.assertIn('Deploying', titles)

    def test_holds_with_mirror(self):
        row = {'finish_hold': 'hold41', 'intermediate_holds': ['hold102'], 'start_holds': ['hold240']}
        h = supa.holds_with_mirror(row, {'hold41': 'hold55'})
        self.assertEqual([x['role'] for x in h], ['start', 'start', 'finish'])
        self.assertEqual(h[0]['mirror_cell'], 'Q3')
        self.assertEqual(supa.cell('hold1'), 'A1')
        self.assertEqual(supa.cell('hold247'), 'S13')


class NewRoutes(ServerBase):
    """The new routes go through the same gate."""

    def test_new_routes_need_the_token(self):
        for path in ('/api/config', '/api/drift', '/api/git', '/api/activity', '/api/acceptance', '/api/backups',
                     '/api/runbook', '/api/problems', '/api/last-night', '/api/ledmap'):
            self.assertEqual(self.req('GET', path, token=None)[0], 401, path)
        self.assertEqual(self.req('POST', '/api/acceptance-note', {'id': 'kill'}, token=None)[0], 401)
        self.assertEqual(self.req('POST', '/api/ledmap-results', {'results': {}}, origin='http://evil.example')[0], 403)

    def test_runbook_and_acceptance_answer(self):
        status, body, _ = self.req('GET', '/api/runbook')
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['sections'])
        self.assertEqual(self.req('GET', '/api/acceptance')[0], 200)
        self.assertEqual(self.req('POST', '/api/acceptance-note', {'id': 'nope', 'result': 'pass'})[0], 400)


if __name__ == '__main__':
    unittest.main()
