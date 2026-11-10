"""Laptop tests for PB Console phases 5-15 (no Pi, no network).

    python -m unittest discover -s console/tests      (from the repo root)

The helper's config checks and its new commands' refusals, secret stripping,
the drift map against install.sh, the removed release actions, the new actions' argument
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
import shutil
import subprocess
import time
import unittest
from unittest import mock

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
import probe  # noqa: E402  (the script the console runs on the Pi)
from test_console import ServerBase  # noqa: E402

GOOD = ('SUPABASE_URL=https://uqirowyfqwiceyjznosl.supabase.co\nSUPABASE_ANON_KEY=eyJa.eyJb.c_d-e\n'
        '# a comment\nBRIGHTNESS=0.5\nIDLE_PATTERN=wave\nHOURS_MON=15:30-22:00\nHOURS_FRI=closed\nNIGHT_FORCE=\n')


class HelperConfig(unittest.TestCase):
    def setUp(self):
        self.h = actions.helper()

    def test_values_checked(self):
        for k, v in (('BRIGHTNESS', '0.5'), ('IDLE_PATTERN', 'cycle'), ('IDLE_CYCLE', 'lava, wave'), ('NIGHT_FORCE', ''),
                     ('RELAY_PINS', '23,24'), ('IDLE_FPS', '30'), ('SUPABASE_URL', 'https://abc.supabase.co')):
            self.h.check_value(k, v)
        for k, v in (('BRIGHTNESS', '2'), ('BRIGHTNESS', 'x'), ('IDLE_PATTERN', 'disco'), ('IDLE_CYCLE', 'lava strobe'),
                     ('HOURS_MON', '25:00-26:00'), ('NIGHT_START', '23:00'), ('RELAY_PINS', '40'), ('EVIL', '1'), ('IDLE_FPS', '30; reboot'),
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
        self.assertFalse(self.h.needs_restart('HOURS_MON'))
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
        text = '%s  %s\nsha256sum: /etc/sudoers.d/pb-console: Permission denied\n@@extra\n/usr/local/sbin/pb-old.sh\n' \
               '/etc/systemd/system/pb-old.service\n@@nm\npb-rescue:/etc/NetworkManager/system-connections/pb-rescue.nmconnection\n' \
               'lo:/run/NetworkManager/system-connections/lo.nmconnection\n' % (drift.sha(rel), dest)
        c = drift.compare(text)
        states = {r['pi']: r['state'] for r in c['files']}
        self.assertEqual(states[dest], 'same')
        self.assertEqual(states['/etc/sudoers.d/pb-console'], 'unreadable')
        self.assertEqual({x['pull_to'] for x in c['extra']}, {'pi/ops/pb-old.sh', 'pi/systemd/pb-old.service'})
        self.assertEqual([n['name'] for n in c['nm']], ['pb-rescue'])

    def test_pull_targets(self):
        self.assertIsNone(drift.pull_target('/etc/passwd'))
        self.assertIsNone(drift.pull_target('/usr/local/sbin/../../etc/shadow x'))
        self.assertEqual(drift.nm_target('pb rescue/x'), 'pi/conf/pb-rescue-x.nmconnection')


class OldActionsGone(unittest.TestCase):
    """Release (Ship, Staging, Rollback, Build check, Pull) and Circuit tracks left the console on
    10 Nov 2026: Claude Code ships, and the Pi doesn't light tracks. Their actions are refused."""

    def test_gone(self):
        for kind in ('git-commit', 'push-dev', 'ff-main', 'cache-bump', 'syntax-check', 'ship', 'staging', 'rollback',
                     'build-check', 'git-pull', 'circuit-track-save', 'circuit-track-remove', 'circuit-test-cast',
                     'circuit-test-stop'):
            with self.assertRaises(actions.Invalid, msg=kind):
                actions.build(kind, {'circuit': 'x', 'commit': 'abc1234'})

    def test_backup_actions(self):
        for kind in ('backup-now', 'backup-pi', 'backup-supabase'):
            a = actions.build(kind, {})
            self.assertFalse(a.confirm)
            self.assertIn('backups/', a.describe)


@unittest.skipUnless(shutil.which('git') and os.path.isdir(os.path.join(REPO, '.git')), 'needs the git repo')
class Stamp(unittest.TestCase):
    """The CACHE stamp comes from build.sh alone; the console asks it (build.sh --stamp)."""

    def test_stamp_shape_and_same_as_build_sh(self):
        s = gitops.stamp('HEAD')
        self.assertRegex(s, r'^pb-[0-9a-f]{10}$')
        p = subprocess.run([actions.procs.find_bash(), 'build.sh', '--stamp', 'HEAD'], cwd=REPO, capture_output=True)
        self.assertEqual(p.stdout.decode().strip(), s)
        self.assertIsNone(gitops.stamp('no-such-ref-here'))

    def test_stamp_is_the_shipped_blobs(self):
        """pb- + sha1 of `git ls-tree` for the allowlisted files: line endings don't matter, and a
        commit that ships nothing new keeps the stamp."""
        with open(os.path.join(REPO, 'build.sh'), encoding='utf-8') as f:
            block = f.read().split('\nFILES=(\n', 1)[1].split('\n)\n', 1)[0]
        files = [l.strip() for l in block.splitlines() if l.strip() and not l.strip().startswith('#')]
        import hashlib
        listing = subprocess.run(['git', 'ls-tree', 'HEAD', '--'] + ['app/' + f for f in files], cwd=REPO,
                                 capture_output=True).stdout.decode().rstrip('\n') + '\n'
        self.assertEqual(gitops.stamp('HEAD'), 'pb-' + hashlib.sha1(listing.encode()).hexdigest()[:10])

    def test_build_check_passes(self):
        code, text = gitops.build_check()
        self.assertEqual(code, 0, text)
        self.assertIn('checks passed', text)

    def test_sw_holds_the_placeholder(self):
        with open(os.path.join(REPO, 'app', 'sw.js'), encoding='utf-8') as f:
            self.assertEqual(f.read().count("const CACHE = 'pb-local';"), 1)


class NewActions(unittest.TestCase):
    def test_deploy_needs_no_password(self):
        # Passwordless since 30 Oct 2026 (pi/conf/pb-deploy.sudoers): no password
        # is taken, and one sent anyway goes nowhere.
        a = actions.build('deploy', {'dry_run': True})
        self.assertEqual(a.shown, 'bash pi/deploy.sh --dry-run')
        self.assertTrue(a.confirm and not a.busy)
        b = actions.build('deploy', {'password': 's3cret-pw'})
        self.assertEqual(b.shown, 'bash pi/deploy.sh')
        self.assertTrue(b.busy)
        self.assertNotIn('s3cret', b.name + b.shown + b.describe + json.dumps(b.preview))

    def test_test_steps_whitelisted(self):
        a = actions.build('test-step', {'args': ['clock', '21:59:30']})
        self.assertEqual(a.shown, 'sudo -n /usr/local/sbin/pb-console-helper test clock 21:59:30')
        self.assertTrue(a.confirm and a.busy)
        for bad in (['clock', '12:00:00'], ['reboot'], 'kill-listener', ['kill-listener', 'x']):
            with self.assertRaises(actions.Invalid):
                actions.build('test-step', {'args': bad})

    def test_config_set(self):
        a = actions.build('config-set', {'values': {'HOURS_FRI': '10:00-12:00'}})
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

    def test_activity_latest_casts(self):
        raw = {'days': 2, 'casts': [
            ['2026-10-29T18:00:00+00:00', 'Old app', False, True],                    # before source/who
            ['2026-10-29T19:42:05+00:00', 'Good Bug', True, True, 'wall', 'guest'],
            ['2026-10-29T19:30:00+00:00', 'Crimp', False, True, 'phone', 'member'],
            ['2026-10-29T23:10:00+00:00', 'Late', False, False, 'phone', 'guest'],
            ['2026-10-29T19:45:00+00:00', '~cast-test-A', False, True, 'console', None]]}
        a = reports.activity(raw)
        self.assertEqual(a['last']['name'], 'Late')                                   # newest first, night too
        self.assertFalse(a['last']['shown'])
        self.assertEqual([r['name'] for r in a['recent']], ['Late', 'Good Bug', 'Crimp', 'Old app'])
        self.assertEqual((a['recent'][1]['source'], a['recent'][1]['who'], a['recent'][1]['mirror']), ('wall', 'guest', True))
        self.assertIsNone(a['recent'][3]['source'])
        self.assertEqual(a['sources'], {'wall': 1, 'phone': 1, 'unknown': 1})
        self.assertEqual(a['who'], {'guest': 1, 'member': 1, 'unknown': 1})

    def test_activity_circuits_and_member_names(self):
        raw = {'days': 2, 'casts': [
            ['2026-10-30T19:30:00+00:00', 'Crimp', False, True, 'phone', 'member'],
            ['2026-10-30T19:31:00+00:00', 'Crimp', False, True, 'phone', 'member'],
            ['2026-10-30T19:32:00+00:00', 'Crimp', False, True, 'wall', 'guest']],
            'circuits': [
            ['2026-10-30T19:40:00+00:00', 'Pat Burner', 'stopped', 23, 74, 3.0, True, 'abc', 'phone', 'member'],
            ['2026-10-30T19:50:00+00:00', 'Long one', 'finished', 40, 128, 3.0, False, 'def', 'wall', 'guest'],
            ['2026-10-30T23:05:00+00:00', 'Pat Burner', 'night mode', None, None, None, None, None, 'phone', 'guest']]}
        members = {'error': None, 'rows': [
            {'at': '2026-10-30T19:30:02+00:00', 'kind': 'problem', 'name': 'Crimp', 'mirror': False, 'source': 'phone', 'run': None, 'nickname': 'ann'},
            {'at': '2026-10-30T19:31:01+00:00', 'kind': 'problem', 'name': 'Crimp', 'mirror': False, 'source': 'phone', 'run': None, 'nickname': 'bob'},
            {'at': '2026-10-30T19:35:00+00:00', 'kind': 'circuit', 'name': 'Pat Burner', 'mirror': False, 'source': 'phone', 'run': 'abc', 'nickname': 'cat'}]}
        a = reports.activity(raw, members)
        by = {(r['name'], r['at'][11:16]): r for r in a['recent']}
        self.assertEqual(a['names'], 'ok')
        self.assertEqual(a['total'], 3)                                     # problem casts
        self.assertEqual((a['circuit_runs'], a['circuit_moves']), (2, 63))
        self.assertEqual(a['ignored_night'], 1)
        self.assertEqual(a['top_circuits'], [('Pat Burner', 1), ('Long one', 1)])
        names = [r.get('nickname') for r in a['recent']]
        self.assertEqual(sorted(n for n in names if n), ['ann', 'bob', 'cat'])
        self.assertIsNone(a['recent'][0].get('nickname'))                  # the night-ignored run, a guest
        self.assertEqual(a['last']['kind'], 'circuit')
        self.assertEqual(reports.activity(raw, {'error': 'no db/.env on this laptop', 'rows': []})['names'],
                         'no db/.env on this laptop')
        self.assertEqual(reports.activity(raw)['names'], 'not read')

    def test_activity_circuit_views(self):
        raw = {'days': 2, 'casts': [['2026-11-02T19:30:00+00:00', 'Crimp', False, True, 'wall', 'guest']],
               'views': [['2026-11-02T19:31:00+00:00', 'Pat Burner', True, 'wall', 'guest'],
                         ['2026-11-02T23:05:00+00:00', 'Pat Burner', False, 'wall', 'guest']]}
        members = {'error': None, 'rows': [
            {'at': '2026-11-02T19:31:00+00:00', 'kind': 'problem', 'name': 'Pat Burner', 'mirror': False,
             'source': 'phone', 'run': None, 'nickname': 'ann'}]}
        a = reports.activity(raw, members)
        self.assertEqual(a['circuit_views'], 1)
        self.assertEqual(a['total'], 1)                                     # problem casts only
        self.assertEqual(a['ignored_night'], 1)
        self.assertEqual([r['kind'] for r in a['recent']], ['view', 'view', 'problem'])
        self.assertFalse(a['recent'][0]['shown'])
        self.assertTrue(all('nickname' not in r for r in a['recent']))     # a view never takes a problem's name
        self.assertEqual(a['top'], [('Crimp', 1)])

    def test_probe_reads_circuit_view_lines(self):
        m = probe.VIEW_LINE.match
        r = m("2026-11-02T19:42:05+00:00 projectboard python3[812]: circuit view received: 'Pat Burner' [wall, guest]")
        self.assertEqual(r.group(3, 4, 5, 6), ('Pat Burner', None, 'wall', 'guest'))
        r = m("2026-11-02T23:42:05+00:00 projectboard python3[812]: circuit view 'Pat Burner' ignored: night mode [wall, guest]")
        self.assertEqual(r.group(3, 4), ('Pat Burner', ' ignored: night mode'))
        line = "2026-11-02T19:42:05+00:00 projectboard python3[812]: circuit view received: 'Pat Burner' [wall, guest]"
        self.assertIsNone(probe.CAST_LINE.match(line))
        self.assertIsNone(probe.CIRCUIT_NIGHT.match(line.replace('view received: ', '')
                                                    .replace("' [", "' ignored: night mode [").replace('circuit ', 'circuit view ')))

    def test_probe_reads_circuit_ended_lines_old_and_new(self):
        m = probe.CIRCUIT_LINE.match
        pre = "2026-11-05T19:42:05+00:00 projectboard python3[812]: circuit ended: 'Pat Burner' "
        for how, looped in (('loop', True), ('once', False), ('endless', True), ('1 lap', False), ('3 laps', False),
                            ('10 laps', False)):
            r = m(pre + 'stopped after 23 moves (74 s), 3 s a move, %s, run ab [phone, member]' % how)
            self.assertIsNotNone(r, how)
            self.assertEqual((r.group(3), r.group(4), r.group(8)), ('Pat Burner', 'stopped', how))
            self.assertEqual(r.group(8) in ('loop', 'endless'), looped)
        # the Pi's own line (pi/listener/circuit.py ended_line) matches
        sys.path.insert(0, os.path.join(REPO, 'pi', 'listener'))
        import circuit
        run = circuit.Run('Pat Burner', ['hold3', 'hold1', 'hold80', 'hold120'], 2, 3, 3, 'ab', tag=' [phone, member]')
        r = m('2026-11-05T19:42:05+00:00 projectboard python3[812]: ' + run.ended_line('finished', 40))
        self.assertEqual((r.group(5), r.group(8), r.group(9)), ('10', '3 laps', 'ab'))

    def test_probe_reads_every_cast_line(self):
        m = probe.CAST_LINE.match
        r = m("2026-10-29T19:42:05+00:00 projectboard python3[812]: cast received: 'Good Bug' mirrored [wall, guest]")
        self.assertEqual(r.group(3, 4, 5, 6, 7), ('Good Bug', ' mirrored', None, 'wall', 'guest'))
        r = m("2026-10-29T19:42:05+00:00 projectboard python3[812]: cast received: 'Good Bug'")       # an older line
        self.assertEqual(r.group(3, 6), ('Good Bug', None))
        r = m('2026-10-29T23:42:05+00:00 projectboard python3[812]: cast "Pat\'s" ignored: night mode [phone, member]')
        self.assertEqual(r.group(3, 5, 6, 7), ("Pat's", ' ignored: night mode', 'phone', 'member'))

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
        for path in ('/api/config', '/api/drift', '/api/health-history', '/api/activity', '/api/acceptance', '/api/backups',
                     '/api/runbook', '/api/problems', '/api/last-night', '/api/ledmap', '/api/activity-history'):
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
