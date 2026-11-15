"""Laptop tests for the code review's PB Console fixes (session 8, 15 Nov 2026; review CON-15).

    python -m unittest discover -s console/tests      (from the repo root)

No Pi, no database, no GitHub: a fake pg8000 connection records every statement, Ship the
snapshot runs in a throwaway git repo with a bare "origin" in a temp folder, and the Pi is a
fake that answers the drift listing.

- holds.publish / preview / undo_last (CON-07, CON-03, db/48): admin_edit_holds() with the
  page's version, the claims and role set then reset, the server's 'stale' refusal rolled back
  and said in words, rollback on an RPC error, exactly one super admin, a cancel only before
  the RPC, the undo record only after the commit, a preview always rolled back.
- Ship the snapshot (CON-02, CON-03): only its own commit is pushed; refused when main is ahead
  or the tree is dirty; the gate failing or the hook refusing pushes nothing; a commit whose
  push never happened is pushed by the next ship; a cancel after the commit still pushes.
- pull-file (CON-01): pull_target refuses `..` and anything not straight in the three folders;
  the action refuses a tracked target and a path the drift check doesn't list; has_secret
  catches private keys and raw tokens.
- FuncProc (CON-03): out() never raises; a func stops only where it checks.
- The one-time code (CON-09) and the busy step (CON-08) through the real server.
- The database dump (CON-04): every table, counts checked, a short read refused, the newest 8 kept.
- castlog reads in one `begin read only` transaction (CON-06).
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
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
import backups  # noqa: E402
import castlog  # noqa: E402
import drift  # noqa: E402
import gitops  # noqa: E402
import holds  # noqa: E402
import procs  # noqa: E402
import reports  # noqa: E402
import security  # noqa: E402
from test_console import TOKEN, ServerBase  # noqa: E402
from test_holds import SQ, V, rows  # noqa: E402

V_DT = datetime.datetime.fromisoformat(V)
COLS = ('id', 'name', 'kind', 'led', 'x', 'y', 'outline', 'mirror')


class Out:
    """An out() that keeps the lines and can say it was cancelled (as FuncProc's does)."""

    def __init__(self):
        self.lines, self.flag = [], False

    def __call__(self, text):
        self.lines.append(text)

    def cancelled(self):
        return self.flag

    def text(self):
        return '\n'.join(self.lines)


# -- a fake pg8000 connection ------------------------------------------------------------------------

class FakeConn:
    def __init__(self, version=V_DT, supers=1, fail_on=None, undo_dir=None, versions=1):
        self.calls, self.closed = [], False
        self.version, self.supers, self.fail_on, self.undo_dir, self.versions = version, supers, fail_on, undo_dir, versions
        self.undo_at_commit = None

    def run(self, sql, **kw):
        self.calls.append((sql, kw))
        s = ' '.join(sql.split()).lower()
        if self.fail_on and self.fail_on in s:
            raise RuntimeError('the server refused it')
        if s == 'commit' and self.undo_dir is not None:
            self.undo_at_commit = os.listdir(self.undo_dir) if os.path.isdir(self.undo_dir) else []
        if 'from public.board_config' in s and 'image_path' in s:
            return [[self.version, 'board/board.jpg', None, None]]
        if s.startswith('select id, name, kind'):
            return [[r[c] for c in COLS] for r in rows()]
        if 'unnest(feet_holds)' in s:
            return []
        if 'from public.profiles where is_super_admin' in s:
            return [['00000000-0000-0000-0000-000000000001']] * self.supers
        if 'admin_edit_holds' in s:
            if not holds.same_version(kw.get('v'), self.version.isoformat()):
                raise Exception({'S': 'ERROR', 'C': 'P0001', 'M': 'stale', 'D': 'The board changed since this was loaded'})
            return [[{'version': '2026-11-15T10:00:00+00:00', 'changes': ['A1: outline 80 -> 4 points']}]]
        if 'count(*) from public.board_versions' in s:
            return [[self.versions]]
        if s.startswith('select updated_at from public.board_config'):
            return [[self.version]]
        return []

    def close(self):
        self.closed = True

    def sqls(self):
        return [' '.join(c[0].split()).lower() for c in self.calls]


class Publish(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._undo = holds.UNDO
        holds.UNDO = os.path.join(self.tmp, 'undo')

    def tearDown(self):
        holds.UNDO = self._undo
        shutil.rmtree(self.tmp, ignore_errors=True)

    def publish(self, conn, out=None, version=V):
        with mock.patch.object(holds, '_conn', return_value=conn):
            return holds.publish([{'op': 'outline', 'id': 'hold1', 'outline': SQ}], version, out or Out())

    def undo_files(self):
        return os.listdir(holds.UNDO) if os.path.isdir(holds.UNDO) else []

    def test_a_good_publish(self):
        c = FakeConn(undo_dir=holds.UNDO)
        out = Out()
        self.assertEqual(self.publish(c, out), '2026-11-15T10:00:00+00:00')
        q = c.sqls()
        self.assertEqual(q[0], 'begin')
        i_claims = next(i for i, s in enumerate(q) if 'set_config' in s)
        i_role = q.index('set local role authenticated')
        i_rpc = next(i for i, s in enumerate(q) if 'admin_edit_holds' in s)
        self.assertLess(i_claims, i_role)
        self.assertLess(i_role, i_rpc)
        self.assertEqual(q[i_rpc + 1:], ['reset role', 'commit'])
        claims = json.loads(c.calls[i_claims][1]['c'])
        self.assertEqual(claims['role'], 'authenticated')
        self.assertEqual(c.calls[i_rpc][1]['v'], V)                 # the page's version (db/45, db/48)
        self.assertEqual(json.loads(c.calls[i_rpc][1]['e'])[0]['op'], 'outline')
        self.assertIn('A1: outline 80 -> 4 points', out.text())
        self.assertTrue(c.closed)
        self.assertEqual(c.undo_at_commit, [])                      # no record before the commit (CON-07)
        self.assertEqual(len(self.undo_files()), 1)                 # one after it
        with open(os.path.join(holds.UNDO, self.undo_files()[0]), encoding='utf-8') as f:
            rec = json.load(f)
        self.assertEqual(rec['published_version'], '2026-11-15T10:00:00+00:00')
        self.assertEqual(len(rec['old']), len(rows()))

    def test_a_moved_version_is_refused_and_rolled_back(self):
        c = FakeConn(version=datetime.datetime(2026, 11, 14, tzinfo=datetime.timezone.utc))
        with self.assertRaises(holds.Refused) as cm:
            self.publish(c)
        self.assertIn('the board changed', str(cm.exception))      # the server's 'stale', in words
        q = c.sqls()
        self.assertIn('rollback', q)
        self.assertNotIn('commit', q)
        self.assertEqual(self.undo_files(), [])

    def test_an_rpc_error_rolls_back_and_leaves_no_record(self):
        c = FakeConn(fail_on='admin_edit_holds')
        with self.assertRaises(RuntimeError):
            self.publish(c)
        self.assertIn('rollback', c.sqls())
        self.assertNotIn('commit', c.sqls())
        self.assertEqual(self.undo_files(), [])
        self.assertTrue(c.closed)

    def test_exactly_one_super_admin(self):
        for n in (0, 2):
            c = FakeConn(supers=n)
            with self.assertRaises(holds.Refused):
                self.publish(c)
            self.assertFalse(any('admin_edit_holds' in s for s in c.sqls()))
            self.assertFalse(any('set local role' in s for s in c.sqls()))
            self.assertIn('rollback', c.sqls())

    def test_a_closed_tab_stops_before_the_rpc_only(self):
        c = FakeConn()
        out = Out()
        out.flag = True
        with self.assertRaises(procs.Cancelled):
            self.publish(c, out)
        self.assertFalse(any('admin_edit_holds' in s for s in c.sqls()))
        self.assertIn('rollback', c.sqls())
        self.assertEqual(self.undo_files(), [])

    def test_a_preview_is_always_rolled_back(self):
        c = FakeConn(undo_dir=holds.UNDO)
        with mock.patch.object(holds, '_conn', return_value=c):
            lines = holds.preview([{'op': 'outline', 'id': 'hold1', 'outline': SQ}], V)
        self.assertEqual(lines, ['A1: outline 80 -> 4 points'])
        q = c.sqls()
        self.assertNotIn('commit', q)
        self.assertIn('rollback', q)
        self.assertEqual(self.undo_files(), [])
        self.assertTrue(c.closed)

    def test_undo_last_records_after_its_commit(self):
        c = FakeConn(undo_dir=holds.UNDO)
        with mock.patch.object(holds, '_conn', return_value=c):
            holds.undo_last(Out())
        q = c.sqls()
        self.assertIn('select public.admin_undo_board(:w)', q)
        self.assertEqual(q[-1], 'commit')
        self.assertEqual(c.undo_at_commit, [])
        self.assertEqual(len(self.undo_files()), 1)
        self.assertTrue(self.undo_files()[0].endswith('-undo.json'))

    def test_undo_with_nothing_to_go_back_to(self):
        c = FakeConn(versions=0)
        with mock.patch.object(holds, '_conn', return_value=c):
            with self.assertRaises(holds.Refused):
                holds.undo_last(Out())
        self.assertFalse(any('admin_undo_board' in s for s in c.sqls()))
        self.assertEqual(self.undo_files(), [])


# -- Ship the snapshot in a throwaway repo -----------------------------------------------------------

@unittest.skipUnless(shutil.which('git'), 'needs git')
class Ship(unittest.TestCase):
    def git(self, *args, cwd=None):
        p = subprocess.run(['git', *args], cwd=cwd or self.work, capture_output=True, text=True)
        if p.returncode:
            raise AssertionError('git %s: %s' % (' '.join(args), p.stderr))
        return p.stdout.strip()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.origin = os.path.join(self.tmp, 'origin.git')
        self.work = os.path.join(self.tmp, 'work')
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', self.origin], check=True)
        subprocess.run(['git', 'clone', '-q', self.origin, self.work], check=True, capture_output=True)
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'core.hooksPath', os.path.join(self.tmp, 'no-hooks'))
        self.git('config', 'core.autocrlf', 'false')
        os.makedirs(os.path.join(self.work, 'app'))
        for f in holds.SNAPSHOT_FILES + ['app/index.html']:
            with open(os.path.join(self.work, f), 'w', newline='\n') as fh:
                fh.write('v1\n')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'start')
        self.git('push', '-q', 'origin', 'HEAD:main')
        self.patches = [mock.patch.object(gitops, 'REPO', self.work), mock.patch.object(actions, 'REPO', self.work),
                        mock.patch.object(gitops, 'build_check', side_effect=lambda: (self.gate, 'gate output')),
                        mock.patch.object(holds, 'run_tool', side_effect=self.fake_tool),
                        mock.patch('autodeploy.start_background')]
        for p in self.patches:
            p.start()
        self.gate = 0
        self.snapshot = 'v2\n'

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake_tool(self, argv, out):
        if argv[0].endswith('snapshot_board.py'):
            with open(os.path.join(self.work, 'app', 'hold_map.json'), 'w', newline='\n') as f:
                f.write(self.snapshot)
        return 0

    def remote_head(self):
        return self.git('rev-parse', 'main', cwd=self.origin)

    def write(self, rel, text):
        with open(os.path.join(self.work, *rel.split('/')), 'w', newline='\n') as f:
            f.write(text)

    def test_ships_its_own_commit(self):
        out = Out()
        self.assertEqual(actions.ship_snapshot(out), 0, out.text())
        self.assertEqual(self.remote_head(), self.git('rev-parse', 'HEAD'))
        self.assertEqual(self.git('log', '-1', '--format=%s'), actions.SNAPSHOT_SUBJECT)
        self.assertEqual(self.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'app/hold_map.json')

    def test_refuses_when_main_is_ahead(self):
        self.write('app/index.html', 'local work\n')
        self.git('commit', '-q', '-am', 'unpushed work')
        before = self.remote_head()
        out = Out()
        self.assertEqual(actions.ship_snapshot(out), 1)
        self.assertIn('not on GitHub', out.text())
        self.assertEqual(self.remote_head(), before)
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'unpushed work')       # no snapshot commit either

    def test_refuses_a_dirty_tree(self):
        self.write('app/index.html', 'uncommitted\n')
        self.write('notes.txt', 'untracked\n')
        out = Out()
        self.assertEqual(actions.ship_snapshot(out), 1)
        self.assertIn('app/index.html', out.text())
        self.assertIn('notes.txt', out.text())
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'start')

    def test_the_gate_failing_pushes_nothing(self):
        self.gate = 1
        before = self.remote_head()
        self.assertEqual(actions.ship_snapshot(Out()), 1)
        self.assertEqual(self.remote_head(), before)
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'start')

    def test_the_hook_refusing_pushes_nothing(self):
        hooks = os.path.join(self.tmp, 'hooks')
        os.makedirs(hooks)
        with open(os.path.join(hooks, 'pre-commit'), 'w', newline='\n') as f:
            f.write('#!/bin/sh\necho refused by the test hook\nexit 1\n')
        os.chmod(os.path.join(hooks, 'pre-commit'), 0o755)
        self.git('config', 'core.hooksPath', hooks)
        before = self.remote_head()
        self.assertEqual(actions.ship_snapshot(Out()), 1)
        self.assertEqual(self.remote_head(), before)

    def test_a_commit_left_unpushed_is_pushed_next_time(self):
        out = Out()
        with mock.patch.object(actions, '_push_snapshot', return_value=1):       # the push "fails" once
            self.assertEqual(actions.ship_snapshot(out), 1)
        self.assertNotEqual(self.remote_head(), self.git('rev-parse', 'HEAD'))
        out = Out()
        self.assertEqual(actions.ship_snapshot(out), 0, out.text())             # nothing new to snapshot
        self.assertIn('never pushed it', out.text())
        self.assertEqual(self.remote_head(), self.git('rev-parse', 'HEAD'))

    def test_a_closed_tab_before_the_commit_stops(self):
        out = Out()
        out.flag = True
        with self.assertRaises(procs.Cancelled):
            actions.ship_snapshot(out)
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'start')

    def test_a_closed_tab_after_the_commit_still_pushes(self):
        out = Out()
        real = actions._commit

        def commit_then_close(*a):
            code = real(*a)
            out.flag = True                     # the tab goes away right after the commit
            return code
        with mock.patch.object(actions, '_commit', side_effect=commit_then_close):
            self.assertEqual(actions.ship_snapshot(out), 0, out.text())
        self.assertEqual(self.remote_head(), self.git('rev-parse', 'HEAD'))


# -- pull-file and the secret check ---------------------------------------------------------------------

class FakePi:
    def __init__(self, extra):
        self.extra, self.cmds = extra, []

    def run(self, cmd, stdin=None, timeout=60):
        self.cmds.append(cmd)
        if cmd.startswith('cat '):
            return 0, '[Unit]\nDescription=x\n', ''
        return 0, '@@extra\n%s\n@@nm\n' % '\n'.join(self.extra), ''


class PullFile(unittest.TestCase):
    def test_pull_target(self):
        self.assertEqual(drift.pull_target('/usr/local/bin/pb-new'), 'pi/ops/pb-new')
        self.assertEqual(drift.pull_target('/usr/local/sbin/pb-x.sh'), 'pi/ops/pb-x.sh')
        self.assertEqual(drift.pull_target('/etc/systemd/system/pb-new.service'), 'pi/systemd/pb-new.service')
        for bad in ('/usr/local/bin/../../../home/pi/.ssh/id_ed25519', '/usr/local/bin/../../../etc/projectboard/wall-key',
                    '/usr/local/bin/./pb-x', '/usr/local/bin//pb-x', '/usr/local/bin/sub/pb-x', '/home/pi/pb-x',
                    'usr/local/bin/pb-x', '/etc/systemd/system/pb-x.conf', '/usr/local/bin/.hidden', '/usr/local/bin/',
                    '/usr/local/bin/..', None, 3):
            self.assertIsNone(drift.pull_target(bad), bad)

    def test_build_refuses_a_tracked_target(self):
        # pi/ops/pb-health is tracked: a Pi file of that name never overwrites it.
        with self.assertRaises(actions.Invalid):
            actions.build('pull-file', {'path': '/usr/local/bin/pb-health'})
        with self.assertRaises(actions.Invalid):
            actions.build('pull-file', {'path': '/usr/local/bin/../../../home/pi/.ssh/id_ed25519'})

    def test_only_a_path_the_drift_check_lists(self):
        a = actions.build('pull-file', {'path': '/usr/local/bin/pb-not-in-repo-test'})
        app = mock.Mock()
        app.remote = FakePi(['/usr/local/bin/pb-something-else'])
        out = Out()
        fn = _func_of(a)
        with mock.patch.object(actions, '_write_repo') as w:
            self.assertEqual(fn(app, out), 1)
            w.assert_not_called()
        self.assertIn('not in the drift check', out.text())
        self.assertFalse(any(c.startswith('cat ') for c in app.remote.cmds))
        app.remote = FakePi(['/usr/local/bin/pb-not-in-repo-test'])
        with mock.patch.object(actions, '_write_repo') as w:
            self.assertEqual(fn(app, Out()), 0)
            w.assert_called_once()
            self.assertEqual(w.call_args[0][0], 'pi/ops/pb-not-in-repo-test')

    def test_has_secret(self):
        self.assertTrue(drift.has_secret('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n'))
        self.assertTrue(drift.has_secret('-----BEGIN RSA ' + 'PRIVATE KEY-----\n'))
        self.assertTrue(drift.has_secret('x=1\n  9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n'))
        self.assertTrue(drift.has_secret('"eyJhbGciOiJIUzI1NiJ9abcdefghijklmnopqrstuvwxyz0123"\n'))
        self.assertTrue(drift.has_secret('psk=hunter22\n'))
        self.assertFalse(drift.has_secret('[Unit]\nDescription=Board listener\nExecStart=/usr/local/bin/pb-health\n'))
        self.assertFalse(drift.has_secret('# ------------------------------------------------\n'))
        self.assertFalse(drift.has_secret('    /opt/projectboard/listener/pb_listener_with_a_long_name.py\n'))

    def test_the_repo_pi_scripts_pass_the_secret_check(self):
        for d in ('ops', 'systemd'):
            root = os.path.join(REPO, 'pi', d)
            for n in os.listdir(root):
                p = os.path.join(root, n)
                if os.path.isfile(p):
                    with open(p, encoding='utf-8', errors='replace') as f:
                        text = f.read()
                    # the two checks added for CON-01 (the older key= check flags pb-console-helper's own regex)
                    self.assertFalse(drift.PRIVATE_KEY.search(text) or any(drift.RAW_TOKEN.match(l) for l in text.splitlines()),
                                     'false alarm on pi/%s/%s' % (d, n))


def _func_of(action):
    """The (app, out) function inside a func_action (its start() wraps it in procs.func)."""
    captured = {}
    with mock.patch.object(procs, 'func', side_effect=lambda fn: captured.setdefault('fn', fn)):
        action.start('APP')
    return lambda app, out: _call(captured['fn'], app, out)


def _call(fn_out, app, out):
    # func_action's lambda closes over the app passed to start(); call the inner fn with ours.
    inner = fn_out.__closure__
    for cell in inner or ():
        v = cell.cell_contents
        if callable(v) and getattr(v, '__name__', '') == 'pull_file':
            return v(app, out)
    raise AssertionError('no pull_file inside the action')


# -- FuncProc: a closed tab never cuts a func in half ------------------------------------------------------

class Cancel(unittest.TestCase):
    def test_out_never_raises_and_only_safe_points_stop(self):
        go, steps = threading.Event(), []

        def fn(out):
            out('one')
            go.wait(5)
            out('after the tab closed: still written, never raised')
            steps.append('irreversible step done')
            procs.check_cancelled(out)            # a safe point
            steps.append('never reached')
            return 0
        p = procs.func(fn)
        self.assertEqual(p.stdout.readline(), b'one\n')
        p.kill()
        go.set()
        self.assertEqual(p.wait(5), 130)
        self.assertEqual(steps, ['irreversible step done'])

    def test_a_func_that_finishes_returns_its_code(self):
        go = threading.Event()

        def fn(out):
            go.wait(5)
            out('done anyway')
            return 0
        p = procs.func(fn)
        p.kill()
        go.set()
        self.assertEqual(p.wait(5), 0)


# -- the one-time code, through the real server ---------------------------------------------------------

class OneTimeCode(ServerBase):
    def test_a_code_works_once(self):
        code = self.app.mint_code()
        st, body, _ = self.req('POST', '/api/session', {'code': code}, token=None)
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)['token'], TOKEN)
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None)[0], 403)      # used
        self.assertEqual(self.req('POST', '/api/session', {'code': 'x' * 32}, token=None)[0], 403)  # unknown

    def test_a_code_expires(self):
        code = self.app.mint_code()
        with mock.patch('server.time.monotonic', return_value=time.monotonic() + 1000):
            self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None)[0], 403)

    def test_the_session_route_keeps_the_other_checks(self):
        code = self.app.mint_code()
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None, origin='http://evil.example')[0], 403)
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None, origin=None)[0], 403)
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None,
                                  extra={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.req('GET', '/api/session', token=None)[0], 401)
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None)[0], 200)      # still unused till now

    def test_bootstrap_needs_the_token(self):
        self.assertEqual(self.req('POST', '/api/bootstrap', {}, token=None)[0], 401)
        st, body, _ = self.req('POST', '/api/bootstrap', {})
        self.assertEqual(st, 200)
        code = json.loads(body)['code']
        self.assertEqual(self.req('POST', '/api/session', {'code': code}, token=None)[0], 200)

    def test_gate_exempts_only_the_session_route(self):
        g = security.Gate(TOKEN, 8765)
        base = {'Host': '127.0.0.1:8765', 'Origin': 'http://127.0.0.1:8765', 'Content-Type': 'application/json'}
        self.assertIsNone(g.check('POST', '/api/session', base))
        self.assertEqual(g.check('POST', '/api/action', base)[0], 401)
        self.assertEqual(g.check('POST', '/api/bootstrap', base)[0], 401)

    def test_the_page_never_reads_a_token_from_the_address(self):
        with open(os.path.join(CONSOLE, 'static', 'console.js'), encoding='utf-8') as f:
            js = f.read()
        self.assertNotIn('t=([A-Za-z0-9_-]', js)
        self.assertIn('/api/session', js)
        with open(os.path.join(CONSOLE, 'server.py'), encoding='utf-8') as f:
            self.assertNotIn('#t=', f.read())

    def test_busy_needs_the_second_step(self):
        with open(os.path.join(CONSOLE, 'static', 'console.js'), encoding='utf-8') as f:
            js = f.read()
        self.assertIn('busyDialog(label, go.warning)', js)
        self.remote.busy_result = {'ok': True, 'busy': True, 'casts': []}
        st, _, _ = self.req('POST', '/api/action', {'action': 'reboot', 'args': {}, 'confirm': True})
        self.assertEqual(st, 409)                              # the server refuses without override_busy

    def test_the_ledmap_frame_is_sandboxed(self):
        with open(os.path.join(CONSOLE, 'static', 'index.html'), encoding='utf-8') as f:
            html = f.read()
        self.assertRegex(html, r'<iframe id="ledmap-frame"[^>]* sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"')


# -- the database dump ------------------------------------------------------------------------------------

class DumpConn:
    """A fake connection holding three tables; short=a table whose read comes back one row short."""
    TABLES = {'profiles': [{'id': 1}, {'id': 2}], 'ticks': [{'id': n} for n in range(5)], 'wall_keys': []}

    def __init__(self, short=None):
        self.short, self.calls, self.closed = short, [], False

    def run(self, sql, **kw):
        self.calls.append(sql)
        s = ' '.join(sql.split()).lower()
        if 'from pg_catalog.pg_class' in s:
            return [[t] for t in sorted(self.TABLES)]
        if 'information_schema.columns' in s:
            return [['id', 'bigint']]
        for t, rows_ in self.TABLES.items():
            if s == 'select count(*) from public."%s"' % t:
                return [[len(rows_)]]
            if s == 'select to_jsonb(x) from public."%s" x' % t:
                out = [[r] for r in rows_]
                return out[:-1] if t == self.short else out
        return []

    def close(self):
        self.closed = True


class Dump(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._state, self._dir = backups.STATE, reports.BACKUPS
        backups.STATE = os.path.join(self.tmp, 'backups.json')
        reports.BACKUPS = os.path.join(self.tmp, 'backups')

    def tearDown(self):
        backups.STATE, reports.BACKUPS = self._state, self._dir
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_every_table_with_counts(self):
        c = DumpConn()
        out = Out()
        self.assertIsNone(backups.backup_db(out, connect=lambda: c))
        self.assertEqual(c.calls[0].lower(), 'begin isolation level repeatable read read only')
        self.assertIn('commit', [x.lower() for x in c.calls])
        self.assertTrue(c.closed)
        d = backups.dumps()
        self.assertEqual(len(d), 1)
        with open(os.path.join(d[0], 'manifest.json'), encoding='utf-8') as f:
            m = json.load(f)
        self.assertEqual({t: v['rows'] for t, v in m['tables'].items()}, {'profiles': 2, 'ticks': 5, 'wall_keys': 0})
        self.assertEqual(m['total_rows'], 7)
        with open(os.path.join(d[0], 'ticks.json'), encoding='utf-8') as f:
            self.assertEqual(len(json.load(f)), 5)
        self.assertEqual(backups.load_state()['db']['rows'], 7)
        self.assertNotIn('"id"', out.text())                   # counts only, never a row

    def test_a_short_read_fails(self):
        out = Out()
        err = backups.backup_db(out, connect=lambda: DumpConn(short='ticks'))
        self.assertIn('ticks: read 4 rows but count(*) says 5', err)
        self.assertEqual(backups.dumps(), [])
        self.assertEqual(glob_all(reports.BACKUPS, '.partial'), [])

    def test_the_newest_eight_are_kept(self):
        for i in range(10):
            os.makedirs(os.path.join(reports.BACKUPS, '2026-10-%02d' % (i + 1), 'db-120000'))
        os.makedirs(os.path.join(reports.BACKUPS, '2026-10-01', 'pi-120000'))      # the Pi's: never pruned here
        out = Out()
        self.assertEqual(backups.prune(out), 2)
        left = [os.path.basename(os.path.dirname(p)) for p in backups.dumps()]
        self.assertEqual(left, ['2026-10-%02d' % d for d in range(3, 11)])
        self.assertTrue(os.path.isdir(os.path.join(reports.BACKUPS, '2026-10-01', 'pi-120000')))
        self.assertFalse(os.path.exists(os.path.join(reports.BACKUPS, '2026-10-02')))  # emptied: gone

    def test_no_db_env(self):
        with mock.patch.object(castlog, '_db_url', return_value=None):
            self.assertIn('no db/.env', backups.backup_db(Out()))

    def test_backups_are_ignored_and_refused(self):
        with open(os.path.join(REPO, '.gitignore'), encoding='utf-8') as f:
            self.assertIn('backups/', f.read().splitlines())
        with open(os.path.join(REPO, '.githooks', 'pre-commit'), encoding='utf-8') as f:
            self.assertIn('backups/*', f.read())


def glob_all(root, suffix):
    found = []
    for r, ds, _ in os.walk(root):
        found += [d for d in ds if d.endswith(suffix)]
    return found


class ReadOnly(unittest.TestCase):
    def test_castlog_reads_in_one_read_only_transaction(self):
        calls = []

        class C:
            def run(self, sql, **kw):
                calls.append(sql)
                return []

            def close(self):
                pass
        with mock.patch.object(castlog, '_db_url', return_value='fake-db-url-for-the-test'), \
                mock.patch.object(castlog, '_connect', return_value=C()):
            self.assertIsNone(castlog.history()['error'])
        self.assertEqual(calls[0], 'begin read only')
        self.assertEqual(calls[-1], 'commit')
        self.assertFalse(any('session characteristics' in c for c in calls))


if __name__ == '__main__':
    unittest.main()
