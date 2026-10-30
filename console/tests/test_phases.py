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


def git_state(**kw):
    """A gitops.status() as the release actions see it: on main, level with GitHub, clean."""
    st = {'branch': 'main', 'files': [], 'head': 'aaaaaaa', 'ahead_main': 0, 'behind_main': 0, 'dev_behind': 1,
          'staging_ff': True, 'log': [], 'unpushed': [],
          'recent_main': [{'hash': 'abc1234', 'date': '29 Oct 10:00', 'subject': 'x'}],
          'checks': {'stamp_main': 'pb-0000000000', 'stamp_head': 'pb-0000000000'}}
    st.update(kw)
    return st


class Release(unittest.TestCase):
    """Ship (commit + push main), Staging (push dev), Rollback (revert + push): the refusals.
    Nothing here runs git for real: each action is only built, never started."""

    def build(self, kind, args, **state):
        with mock.patch.object(gitops, 'status', return_value=git_state(**state)), \
                mock.patch.object(gitops, 'diff', return_value=''), mock.patch.object(gitops, 'out', return_value=''):
            return actions.build(kind, args)

    def test_old_actions_are_gone(self):
        for kind in ('git-commit', 'push-dev', 'ff-main', 'cache-bump', 'syntax-check'):
            with self.assertRaises(actions.Invalid):
                self.build(kind, {})

    def test_ship(self):
        changed = [{'xy': ' M', 'path': 'app/core.js'}]
        a = self.build('ship', {'message': 'Fix it', 'files': ['app/core.js']}, files=changed)
        self.assertTrue(a.confirm)
        self.assertIn('REAL USERS', a.describe)
        self.assertIn('git push origin HEAD:main', a.shown)
        self.assertIn('(new) Fix it', a.preview['log'])
        a = self.build('ship', {}, unpushed=['abc1234 a commit'])          # nothing to commit: push only
        self.assertIn('Push main', a.describe)

    def test_ship_refusals(self):
        changed = [{'xy': ' M', 'path': 'app/core.js'}]
        with self.assertRaises(actions.Invalid):                       # not on main
            self.build('ship', {'message': 'x', 'files': ['app/core.js']}, files=changed, branch='dev')
        with self.assertRaises(actions.Invalid):                       # a file git status doesn't list
            self.build('ship', {'message': 'x', 'files': ['../outside.txt']}, files=changed)
        with self.assertRaises(actions.Invalid):                       # files but no message
            self.build('ship', {'message': ' ', 'files': ['app/core.js']}, files=changed)
        with self.assertRaises(actions.Invalid):                       # nothing at all
            self.build('ship', {})

    def test_staging(self):
        a = self.build('staging', {})
        self.assertIn('HEAD:dev', a.shown)
        self.assertIn('Live is untouched', a.describe)
        a = self.build('staging', {}, files=[{'xy': ' M', 'path': 'x'}])
        self.assertIn('NOT included', a.describe)
        with self.assertRaises(actions.Invalid):                       # dev diverged: a force push, refused
            self.build('staging', {}, staging_ff=False)
        with self.assertRaises(actions.Invalid):                       # dev has it all already
            self.build('staging', {}, dev_behind=0)

    def test_rollback(self):
        a = self.build('rollback', {'commit': 'abc1234'})
        self.assertIn('git revert --no-edit abc1234', a.shown)
        self.assertTrue(a.confirm)
        for args, state in (({'commit': 'def5678'}, {}),                # not one of the listed commits
                            ({'commit': 'abc1234; rm -rf /'}, {}),
                            ({}, {}),
                            ({'commit': 'abc1234'}, {'branch': 'dev'}),
                            ({'commit': 'abc1234'}, {'files': [{'xy': ' M', 'path': 'x'}]}),
                            ({'commit': 'abc1234'}, {'ahead_main': 1}),
                            ({'commit': 'abc1234'}, {'behind_main': 2})):
            with self.assertRaises(actions.Invalid, msg=repr((args, state))):
                self.build('rollback', args, **state)


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
    def test_deploy_password_never_shown(self):
        a = actions.build('deploy', {'password': 's3cret-pw', 'dry_run': True})
        self.assertNotIn('s3cret', a.name + a.shown + a.describe + json.dumps(a.preview))
        self.assertTrue(a.confirm and not a.busy)
        self.assertTrue(actions.build('deploy', {'password': 'p'}).busy)
        self.assertIn('--sudo-stdin', actions.build('deploy', {'password': 'p'}).shown)
        for none in ({}, {'password': ''}, {'password': None}):     # passwordless deploys (30 Oct 2026)
            a = actions.build('deploy', none)
            self.assertNotIn('--sudo-stdin', a.shown)
            self.assertTrue(a.busy)
        for bad in ('a\nb', 'x' * 300, 5):
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
