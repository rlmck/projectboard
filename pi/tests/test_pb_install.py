"""pb-install (pi/ops/pb-install, review PI-03, PI-04, PI-08): the only thing pi may run as
root without a password. These run on the laptop against temp folders, never the Pi:
the signature (a key made here), every refused path, the manifest and replay checks,
the config.env check and backup, the deploy lock and the fingerprint record.

    python -m unittest discover -s pi/tests
"""
import hashlib
import importlib.machinery
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'ops', 'pb-install')
sys.dont_write_bytecode = True


def load():
    loader = importlib.machinery.SourceFileLoader('pb_install', SCRIPT)
    spec = importlib.util.spec_from_loader('pb_install', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


pbi = load()
KEYGEN = shutil.which('ssh-keygen')


def make_tar(files, extra=None):
    """files: {name: bytes}; extra(tarfile) adds odd entries."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
        if extra:
            extra(t)
    return buf.getvalue()


def manifest(**kw):
    m = {'format': '1', 'created': str(int(time.time())), 'mode': 'install', 'fingerprint': 'ab' * 8,
         'commit': 'e66bd12', 'source': 'by-hand'}
    m.update(kw)
    return ''.join('%s=%s\n' % (k, v) for k, v in m.items() if v is not None).encode()


def base_files(**kw):
    return {'MANIFEST': manifest(**kw), 'install.sh': b'#!/bin/bash\necho hi\n',
            'listener/board.py': b'x = 1\n', 'ops/pb-status': b'#!/bin/sh\n'}


class Paths(unittest.TestCase):
    def test_the_normal_layout_passes(self):
        files = base_files()
        files.update({'config.env.example': b'', 'listener/patterns/wave.py': b'', 'ledmap/board.jpg': b'\xff',
                      'systemd/pb-listener.service': b'', 'systemd/pb-mode.timer': b'',
                      'systemd/kiosk.service.d/cursor.conf': b'', 'conf/pb-deploy.sudoers': b'',
                      'ops/pb-netwatch.sh': b''})
        got = pbi.members(make_tar(files))
        self.assertEqual(set(got), set(files))

    def test_dot_slash_names_and_folders_pass(self):
        def dirs(t):
            for d in ('./listener', './ops/'):
                info = tarfile.TarInfo(d)
                info.type = tarfile.DIRTYPE
                t.addfile(info)
        files = {'./' + k: v for k, v in base_files().items()}
        self.assertIn('install.sh', pbi.members(make_tar(files, dirs)))

    def test_paths_outside_the_allowed_set_are_refused(self):
        for bad in ('../evil', '/etc/sudoers.d/x', 'ops/../../root/.ssh/authorized_keys', 'listener/x.sh',
                    'listener/../install.sh', 'ledmap/other.html', 'systemd/x.conf', 'evil/x', '.hidden',
                    'ops/.x', 'conf/a/b', 'listener/patterns/sub/x.py'):
            files = base_files()
            files[bad] = b'boom'
            with self.assertRaises(pbi.Refused, msg=bad):
                pbi.members(make_tar(files))

    def test_links_devices_and_odd_folders_are_refused(self):
        def link(t):
            info = tarfile.TarInfo('ops/pb-health')
            info.type = tarfile.SYMTYPE
            info.linkname = '/etc/shadow'
            t.addfile(info)

        def hard(t):
            info = tarfile.TarInfo('ops/pb-mode')
            info.type = tarfile.LNKTYPE
            info.linkname = 'install.sh'
            t.addfile(info)

        def dev(t):
            info = tarfile.TarInfo('ops/pb-idle')
            info.type = tarfile.CHRTYPE
            t.addfile(info)

        def folder(t):
            info = tarfile.TarInfo('etc')
            info.type = tarfile.DIRTYPE
            t.addfile(info)
        for extra in (link, hard, dev, folder):
            with self.assertRaises(pbi.Refused, msg=extra.__name__):
                pbi.members(make_tar(base_files(), extra))

    def test_missing_install_or_manifest_and_junk_are_refused(self):
        for drop in ('MANIFEST', 'install.sh'):
            files = base_files()
            del files[drop]
            with self.assertRaises(pbi.Refused):
                pbi.members(make_tar(files))
        with self.assertRaises(pbi.Refused):
            pbi.members(b'not a tar at all' * 100)


class Manifest(unittest.TestCase):
    def test_good(self):
        m = pbi.manifest(manifest(config_base='0' * 64))
        self.assertEqual(m['source'], 'by-hand')

    def test_bad_values(self):
        for kw in ({'mode': 'root'}, {'source': 'evil'}, {'fingerprint': 'XYZ'}, {'commit': 'abc; rm'},
                   {'created': 'soon'}, {'config_base': 'abc'}, {'format': '2'}, {'mode': None}):
            with self.assertRaises(pbi.Refused, msg=kw):
                pbi.manifest(manifest(**kw))
        with self.assertRaises(pbi.Refused):
            pbi.manifest(b'format=1\nsurprise=1\n')

    def test_stream_header(self):
        for bad in (b'', b'HELLO 1 1\n', b'PBDEPLOY1 0 10\nx', b'PBDEPLOY1 3 5\nabc12', b'PBDEPLOY1 1 1\nab!'):
            with self.assertRaises(pbi.Refused, msg=bad):
                pbi.read_stream(io.BytesIO(bad))
        self.assertEqual(pbi.read_stream(io.BytesIO(b'PBDEPLOY1 1 2\nsab')), (b's', b'ab'))


class Lock(unittest.TestCase):
    def test_a_second_deploy_cannot_take_the_lock(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, 'deploy.lock')
        holder = subprocess.Popen([sys.executable, '-c', (
            'import importlib.machinery,importlib.util,sys,time\n'
            'l=importlib.machinery.SourceFileLoader("p",sys.argv[1]);s=importlib.util.spec_from_loader("p",l)\n'
            'm=importlib.util.module_from_spec(s);l.exec_module(m)\n'
            'fd=m.take_lock(sys.argv[2]);print("held" if fd is not None else "no",flush=True);time.sleep(30)'),
            SCRIPT, path], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'held')
            self.assertIsNone(pbi.take_lock(path))           # another deploy: refused at once
        finally:
            holder.kill()
            holder.wait()
            holder.stdout.close()
        fd = pbi.take_lock(path)                              # the holder died: the lock is free again
        self.assertIsNotNone(fd)
        os.close(fd)
        shutil.rmtree(tmp, ignore_errors=True)

    def test_main_exits_75_while_another_deploy_runs(self):
        tmp = tempfile.mkdtemp()
        old = pbi.LOCK, pbi.LIB
        pbi.LIB, pbi.LOCK = tmp, os.path.join(tmp, 'deploy.lock')
        fd = pbi.take_lock()
        try:
            if hasattr(os, 'geteuid') and os.geteuid() != 0:
                self.skipTest('main() refuses a non-root user before the lock')
            self.assertEqual(pbi.main([]), pbi.EXIT_BUSY)
        finally:
            os.close(fd)
            pbi.LOCK, pbi.LIB = old
            shutil.rmtree(tmp, ignore_errors=True)

    def test_arguments_are_refused(self):
        self.assertEqual(pbi.main(['--anything']), 2)


@unittest.skipUnless(KEYGEN, 'needs ssh-keygen')
class Deploy(unittest.TestCase):
    """deploy() end to end on temp folders, with a key made here; install.sh isn't run."""

    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.mkdtemp()
        for name in ('laptop', 'intruder'):
            subprocess.run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', name, '-f',
                            os.path.join(cls.keys, name)], check=True, capture_output=True)
        with open(os.path.join(cls.keys, 'laptop.pub')) as f:
            pub = ' '.join(f.read().split()[:2])
        cls.signers = os.path.join(cls.keys, 'signers')
        with open(cls.signers, 'w', newline='\n') as f:
            f.write('pb-deploy namespaces="pb-deploy" %s\n' % pub)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys, ignore_errors=True)

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = {k: getattr(pbi, k) for k in ('LIB', 'INCOMING', 'STAGE', 'RECORD', 'BACKUPS', 'CONFIG',
                                                    'SIGNERS', 'SSH_KEYGEN', 'CHECK_OWNERS', 'run_install', 'log')}
        pbi.LIB = self.tmp
        pbi.INCOMING = os.path.join(self.tmp, 'deploy-in')
        pbi.STAGE = os.path.join(self.tmp, 'stage')
        pbi.RECORD = os.path.join(self.tmp, 'deployed')
        pbi.BACKUPS = os.path.join(self.tmp, 'config-backups')
        pbi.CONFIG = os.path.join(self.tmp, 'config.env')
        pbi.SIGNERS = self.signers
        pbi.SSH_KEYGEN = KEYGEN
        pbi.CHECK_OWNERS = False
        pbi.log = lambda msg: None
        self.installs = []

        def fake_install(stage, dry):
            with open(os.path.join(stage, 'install.sh'), 'rb') as f:
                self.installs.append((f.read(), dry))
            return 0
        pbi.run_install = fake_install
        with open(pbi.CONFIG, 'w', newline='\n') as f:
            f.write('HOURS_SAT=09:30-15:00\n')

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(pbi, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sign(self, tar, key='laptop'):
        p = os.path.join(self.tmp, 'b.tar')
        with open(p, 'wb') as f:
            f.write(tar)
        subprocess.run([KEYGEN, '-Y', 'sign', '-f', os.path.join(self.keys, key), '-n', 'pb-deploy', p],
                       check=True, capture_output=True)
        with open(p + '.sig', 'rb') as f:
            sig = f.read()
        os.remove(p + '.sig')
        return sig

    def stream(self, files, key='laptop', tamper=None):
        tar = make_tar(files)
        sig = self.sign(tar, key)
        if tamper:
            tar = tamper(tar)
        return io.BytesIO(b'PBDEPLOY1 %d %d\n' % (len(sig), len(tar)) + sig + tar)

    def config_hash(self):
        with open(pbi.CONFIG, 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()

    def record(self):
        return pbi.read_record()

    def test_a_signed_bundle_installs_and_records_its_fingerprint(self):
        self.assertEqual(pbi.deploy(self.stream(base_files(fingerprint='1234567890abcdef', source='console'))), 0)
        self.assertEqual(self.installs, [(b'#!/bin/bash\necho hi\n', False)])
        self.assertEqual(self.record()['fingerprint'], '1234567890abcdef')
        self.assertEqual(self.record()['source'], 'console')

    def test_files_changed_after_signing_are_refused(self):
        evil = lambda tar: tar.replace(b'echo hi', b'echo HI')  # noqa: E731
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(base_files(), tamper=evil))
        self.assertEqual(self.installs, [])
        self.assertEqual(self.record(), {})

    def test_another_key_is_refused(self):
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(base_files(), key='intruder'))
        self.assertEqual(self.installs, [])

    def test_a_signed_bundle_with_a_bad_path_is_still_refused(self):
        files = base_files()
        files['../../etc/sudoers.d/evil'] = b'pi ALL=(ALL) NOPASSWD: ALL\n'
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(files))
        self.assertEqual(self.installs, [])

    def test_replays_and_old_bundles_are_refused(self):
        files = base_files()
        self.assertEqual(pbi.deploy(self.stream(files)), 0)
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(files))                      # the same bundle again
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(base_files(created=str(int(time.time()) - 7200))))
        self.assertEqual(len(self.installs), 1)

    def test_a_dry_run_records_nothing(self):
        self.assertEqual(pbi.deploy(self.stream(base_files(mode='dry-run'))), 0)
        self.assertEqual(self.installs[0][1], True)
        self.assertEqual(self.record(), {})

    def test_config_env_backed_up_before_it_changes(self):
        files = base_files(config_base=self.config_hash())
        files['config.env'] = b'HOURS_SAT=09:30-16:00\n'
        self.assertEqual(pbi.deploy(self.stream(files)), 0)
        backups = os.listdir(pbi.BACKUPS)
        self.assertEqual(len(backups), 1)
        self.assertTrue(backups[0].startswith('config.env.') and backups[0].endswith('-deploy'))
        with open(os.path.join(pbi.BACKUPS, backups[0])) as f:
            self.assertEqual(f.read(), 'HOURS_SAT=09:30-15:00\n')

    def test_an_unchanged_config_env_makes_no_backup(self):
        files = base_files(config_base=self.config_hash())
        with open(pbi.CONFIG, 'rb') as f:
            files['config.env'] = f.read()
        self.assertEqual(pbi.deploy(self.stream(files)), 0)
        self.assertFalse(os.path.exists(pbi.BACKUPS))

    def test_config_env_edited_on_the_pi_since_the_check_is_never_overwritten(self):
        files = base_files(config_base=self.config_hash())
        files['config.env'] = b'HOURS_SAT=closed\n'
        with open(pbi.CONFIG, 'w', newline='\n') as f:      # PB Console edits the Pi's copy meanwhile
            f.write('HOURS_SAT=09:30-18:00\n')
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(files))
        self.assertEqual(self.installs, [])
        with open(pbi.CONFIG) as f:
            self.assertEqual(f.read(), 'HOURS_SAT=09:30-18:00\n')

    def test_config_env_without_a_base_is_refused(self):
        files = base_files()
        files['config.env'] = b'A=1\n'
        with self.assertRaises(pbi.Refused):
            pbi.deploy(self.stream(files))


class InstallUnit(unittest.TestCase):
    """PI-06: install.sh runs in its own systemd unit, so an ssh drop can't stop it halfway."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = {k: getattr(pbi, k) for k in ('STAGE', 'RECORD', 'RESULT', 'log')}
        pbi.STAGE = os.path.join(self.tmp, 'stage')
        pbi.RECORD = os.path.join(self.tmp, 'deployed')
        pbi.RESULT = os.path.join(self.tmp, 'deploy-result')
        pbi.log = lambda msg: None
        os.makedirs(pbi.STAGE)
        with open(os.path.join(pbi.STAGE, 'MANIFEST'), 'wb') as f:
            f.write(manifest(fingerprint='1234567890abcdef', source='autodeploy'))

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(pbi, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_unit_is_started_by_systemd_not_the_ssh_session(self):
        argv = pbi.unit_argv(False)
        self.assertEqual(argv[0], pbi.SYSTEMD_RUN)
        self.assertIn('--collect', argv)
        self.assertEqual(argv[argv.index('--unit') + 1], 'pb-install-run')
        self.assertIn('StandardOutput=truncate:/var/log/pb-install.log', argv)
        self.assertEqual(argv[-2:], [pbi.SELF, '--run-stage'])
        self.assertEqual(pbi.unit_argv(True)[-3:], [pbi.SELF, '--run-stage', '--dry-run'])
        self.assertNotIn('--pipe', argv)          # its output never depends on the ssh session

    def test_the_unit_records_the_deploy_itself(self):
        ran = []

        class P:
            returncode = 0

        def fake_run(argv, **kw):
            ran.append((argv, kw['env']))
            return P()
        self.assertEqual(pbi.run_stage(False, run=fake_run), 0)
        self.assertEqual(ran[0][0][-1], os.path.join(pbi.STAGE, 'install.sh'))
        self.assertEqual(ran[0][1]['PB_CONFIG_BACKED_UP'], '1')
        self.assertEqual(pbi.read_record()['fingerprint'], '1234567890abcdef')   # even if the laptop is gone
        with open(pbi.RESULT) as f:
            self.assertEqual(f.read().strip(), '0')

    def test_a_failed_or_dry_install_writes_its_result_but_no_record(self):
        class P:
            returncode = 3
        self.assertEqual(pbi.run_stage(False, run=lambda *a, **k: P()), 3)
        self.assertEqual(pbi.read_record(), {})
        with open(pbi.RESULT) as f:
            self.assertEqual(f.read().strip(), '3')
        P.returncode = 0
        self.assertEqual(pbi.run_stage(True, run=lambda argv, **k: P()), 0)
        self.assertEqual(pbi.read_record(), {})

    def test_follow_streams_the_log_and_returns_the_result(self):
        logf = os.path.join(self.tmp, 'pb-install.log')
        nl = chr(10)
        steps = iter([('== Files' + nl).encode(), ('   updated x' + nl).encode(), None])
        out = []

        def tick(_):
            chunk = next(steps)
            if chunk is None:
                with open(pbi.RESULT, 'w') as f:
                    f.write('0' + nl)
            else:
                with open(logf, 'ab') as f:
                    f.write(chunk)
        old_say = pbi.say
        pbi.say = lambda text, end=nl: out.append(text + end)
        try:
            self.assertEqual(pbi.follow(logf, pbi.RESULT, lambda: True, sleep=tick), 0)
        finally:
            pbi.say = old_say
        self.assertEqual(''.join(out), '== Files' + nl + '   updated x' + nl)

    def test_a_unit_that_died_without_a_result_is_a_failure(self):
        logf = os.path.join(self.tmp, 'pb-install.log')
        self.assertEqual(pbi.follow(logf, pbi.RESULT, lambda: False, sleep=lambda _: None, grace=3), 1)

    def test_a_deploy_waits_while_an_earlier_install_still_runs(self):
        tmp = tempfile.mkdtemp()
        old = pbi.LOCK, pbi.LIB, pbi.unit_running
        pbi.LIB, pbi.LOCK = tmp, os.path.join(tmp, 'deploy.lock')
        pbi.unit_running = lambda: True        # the ssh session that started it dropped; the unit runs on
        try:
            if hasattr(os, 'geteuid') and os.geteuid() != 0:
                self.skipTest('main() refuses a non-root user')
            self.assertEqual(pbi.main([]), pbi.EXIT_BUSY)
        finally:
            pbi.LOCK, pbi.LIB, pbi.unit_running = old
            shutil.rmtree(tmp, ignore_errors=True)

    def test_run_stage_takes_only_its_own_arguments(self):
        self.assertEqual(pbi.main(['--run-stage', '--evil']), 2)
        self.assertEqual(pbi.main(['--run-stage', '--dry-run', 'x']), 2)


class Rule(unittest.TestCase):
    def test_sudoers_allows_only_pb_install_without_arguments(self):
        with open(os.path.join(os.path.dirname(HERE), 'conf', 'pb-deploy.sudoers'), encoding='utf-8') as f:
            rules = [l for l in f if l.strip() and not l.startswith('#')]
        self.assertEqual(rules, ['pi ALL=(root) NOPASSWD: /usr/local/sbin/pb-install ""\n'])

    def test_install_sh_places_the_installer_before_the_rule(self):
        with open(os.path.join(os.path.dirname(HERE), 'install.sh'), encoding='utf-8') as f:
            s = f.read()
        self.assertLess(s.index('put ops/pb-install /usr/local/sbin/pb-install 0755'),
                        s.index('put conf/pb-deploy.sudoers /etc/sudoers.d/pb-deploy'))
        self.assertLess(s.index('put conf/pb-deploy.signers /etc/projectboard/deploy-signers 0644'),
                        s.index('put conf/pb-deploy.sudoers /etc/sudoers.d/pb-deploy'))


if __name__ == '__main__':
    unittest.main()
