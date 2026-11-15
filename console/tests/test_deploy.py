"""pi/deploy.sh, the one script every Pi deploy runs (autodeploy, /pi-deploy, PB Console),
with a fake ssh on the PATH: no Pi, no network (review PI-03, PI-04, PI-08).

  - the laptop's deploy lock: a second deploy exits 75 before any ssh, and autodeploy waits;
  - the fingerprint: deploy.sh --fingerprint is what autodeploy compares, and every path
    (by-hand, console, autodeploy) records the same one, also in the signed MANIFEST;
  - config.env: a laptop copy that differs from the Pi's is refused (exit 3) unless
    --push-config, and the Pi's hash goes in the MANIFEST for pb-install's check.

    python -m unittest discover -s console/tests      (from the repo root)
"""
import importlib.machinery
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
REPO = os.path.dirname(CONSOLE)
sys.path.insert(0, CONSOLE)
sys.dont_write_bytecode = True
import autodeploy  # noqa: E402
import procs  # noqa: E402

KEYGEN = shutil.which('ssh-keygen')
BASH = procs.find_bash()

# The fake ssh: answers deploy.sh's questions from env vars, keeps what pb-install was sent.
FAKE_SSH = r'''#!/bin/bash
for a in "$@"; do last="$a"; done
echo "$last" >> "$FAKE/calls"
case "$last" in
    *"sha256sum /etc/projectboard/config.env"*) echo "$FAKE_PI_CFG" ;;
    *"test -x /usr/local/sbin/pb-install"*) exit 0 ;;
    *pb-install*) cat > "$FAKE/stream"; exit "${FAKE_RC:-0}" ;;
    *) exit 0 ;;
esac
'''


def load_pb_install():
    path = os.path.join(REPO, 'pi', 'ops', 'pb-install')
    loader = importlib.machinery.SourceFileLoader('pb_install_c', path)
    spec = importlib.util.spec_from_loader('pb_install_c', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def sha(text):
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()


@unittest.skipUnless(BASH and KEYGEN, 'needs Git Bash and ssh-keygen')
class DeploySh(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # A copy of what deploy.sh sends (never secrets.env or the real config.env), and a key.
        cls.root = tempfile.mkdtemp(prefix='pb-deploy-test-')
        skip = shutil.ignore_patterns('config.env', 'secrets.env', '_old', '__pycache__', 'firstboot', 'tests')
        shutil.copytree(os.path.join(REPO, 'pi'), os.path.join(cls.root, 'pi'), ignore=skip)
        os.makedirs(os.path.join(cls.root, 'app'))
        for f in ('hold_map.json', 'board-fallback.jpg'):
            shutil.copy(os.path.join(REPO, 'app', f), os.path.join(cls.root, 'app', f))
        cls.key = os.path.join(cls.root, 'key')
        subprocess.run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 't', '-f', cls.key], check=True,
                       capture_output=True)
        cls.bin = os.path.join(cls.root, 'bin')
        os.makedirs(cls.bin)
        with open(os.path.join(cls.bin, 'ssh'), 'w', newline='\n') as f:
            f.write(FAKE_SSH)
        cls.pbi = load_pb_install()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self):
        self.fake = tempfile.mkdtemp(prefix='pb-fake-pi-')
        self.data = os.path.join(self.fake, 'data')
        self.write_config('HOURS_SAT=09:30-15:00\n')

    def tearDown(self):
        shutil.rmtree(self.fake, ignore_errors=True)

    def write_config(self, text):
        with open(os.path.join(self.root, 'pi', 'config.env'), 'w', newline='\n') as f:
            f.write(text)

    def deploy(self, *args, pi_cfg=None, rc=0, source=None):
        env = dict(os.environ, FAKE=self.fake.replace('\\', '/'), FAKE_RC=str(rc),
                   FAKE_PI_CFG=pi_cfg if pi_cfg is not None else sha('HOURS_SAT=09:30-15:00\n'),
                   PB_SIGN_KEY=self.key.replace('\\', '/'), PB_DEPLOY_DATA=self.data.replace('\\', '/'),
                   PB_DEPLOY_COMMIT='e66bd12', FAKEBIN=self.bin,
                   PB_HOST='pi@pb-deploy-test.invalid')   # never the real Pi, even if the fake ssh were missed
        if source:
            env['PB_DEPLOY_SOURCE'] = source
        # PATH needs the MSYS form (/c/...): a "C:/..." entry splits at the colon and the real ssh
        # runs (it did once, 14 Nov 2026). Refuse to run at all unless the fake ssh comes first.
        cmd = ('B="$FAKEBIN"; command -v cygpath >/dev/null && B=$(cygpath -u "$B"); '
               '[ "$(PATH="$B:$PATH" command -v ssh)" = "$B/ssh" ] || { echo "fake ssh not first on PATH"; exit 99; }; '
               'PATH="$B:$PATH" bash pi/deploy.sh %s' % ' '.join(args))
        p = subprocess.run([BASH, '-c', cmd], cwd=self.root, env=env, capture_output=True, text=True, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def calls(self):
        try:
            with open(os.path.join(self.fake, 'calls')) as f:
                return f.read()
        except OSError:
            return ''

    def sent(self):
        """The MANIFEST pb-install was sent (read with pb-install's own parsers)."""
        with open(os.path.join(self.fake, 'stream'), 'rb') as f:
            _sig, tar = self.pbi.read_stream(io.BytesIO(f.read()))
        files = self.pbi.members(tar)
        return self.pbi.manifest(files['MANIFEST']), files

    def record(self):
        autodeploy_deployed = os.path.join(self.data, 'pi-deployed')
        with mock.patch.object(autodeploy, 'DEPLOYED', autodeploy_deployed):
            return autodeploy.read_deployed()

    def fingerprint(self):
        code, out = self.deploy('--fingerprint')
        self.assertEqual(code, 0, out)
        return out.strip().splitlines()[-1]

    # -- the lock (PI-04) --
    def test_a_second_deploy_waits_for_the_first(self):
        os.makedirs(os.path.join(self.data, 'pi-deploy.lock'))
        code, out = self.deploy()
        self.assertEqual(code, 75, out)
        self.assertEqual(self.calls(), '')                     # never reached the Pi
        self.assertTrue(os.path.isdir(os.path.join(self.data, 'pi-deploy.lock')))   # not someone else's to drop

    def test_a_stale_lock_is_taken_over_and_the_lock_is_dropped_after(self):
        lock = os.path.join(self.data, 'pi-deploy.lock')
        os.makedirs(lock)
        old = time.time() - 50 * 60
        os.utime(lock, (old, old))
        code, out = self.deploy()
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.exists(lock))

    def test_autodeploy_waits_while_deploy_sh_holds_the_lock(self):
        lock = os.path.join(self.data, 'pi-deploy.lock')
        os.makedirs(lock)
        with open(os.path.join(lock, 'who'), 'w') as f:
            f.write('console 123 2026-11-14 15:01:00')
        with mock.patch.object(autodeploy, 'DEPLOY_LOCK', lock):
            self.assertEqual(autodeploy.deploy_running(), 'console 123 2026-11-14 15:01:00')
            old = time.time() - 50 * 60
            os.utime(lock, (old, old))
            self.assertIsNone(autodeploy.deploy_running())

    # -- the fingerprint (PI-04) --
    def test_every_path_records_the_same_fingerprint(self):
        fp = self.fingerprint()
        self.assertEqual(fp, autodeploy.tree_fingerprint(self.root))
        for source in ('by-hand', 'console', 'autodeploy'):
            code, out = self.deploy(source=None if source == 'by-hand' else source)
            self.assertEqual(code, 0, out)
            rec = self.record()
            self.assertEqual((rec['fingerprint'], rec['source'], rec['commit']), (fp, source, 'e66bd12'))
            m, files = self.sent()
            self.assertEqual((m['fingerprint'], m['source'], m['mode']), (fp, source, 'install'))
            self.assertIn('install.sh', files)
            self.assertIn('ops/pb-install', files)

    def test_the_fingerprint_follows_the_files_and_the_config(self):
        fp = self.fingerprint()
        self.assertEqual(self.fingerprint(), fp)
        self.write_config('HOURS_SAT=closed\n')
        self.assertNotEqual(self.fingerprint(), fp)

    def test_a_failed_or_dry_deploy_records_nothing(self):
        for args, rc in ((('--dry-run',), 0), ((), 1), ((), 75), ((), 77)):
            code, out = self.deploy(*args, rc=rc)
            self.assertEqual(code, rc, out)
            self.assertEqual(self.record(), {}, args)
        self.assertEqual(self.sent()[0]['mode'], 'install')
        code, _ = self.deploy('--dry-run')
        self.assertEqual(self.sent()[0]['mode'], 'dry-run')

    # -- config.env (PI-08) --
    def test_a_laptop_config_that_differs_is_refused(self):
        code, out = self.deploy(pi_cfg=sha('HOURS_SAT=09:30-18:00\n'))     # PB Console changed the Pi's
        self.assertEqual(code, 3, out)
        self.assertIn('differs', out)
        self.assertFalse(os.path.exists(os.path.join(self.fake, 'stream')))
        self.assertEqual(self.record(), {})

    def test_push_config_sends_the_pis_hash_for_the_backup_check(self):
        pi = sha('HOURS_SAT=09:30-18:00\n')
        code, out = self.deploy('--push-config', pi_cfg=pi)
        self.assertEqual(code, 0, out)
        m, files = self.sent()
        self.assertEqual(m['config_base'], pi)
        self.assertEqual(files['config.env'], b'HOURS_SAT=09:30-15:00\n')

    def test_same_config_goes_with_its_hash(self):
        code, out = self.deploy()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.sent()[0]['config_base'], sha('HOURS_SAT=09:30-15:00\n'))

    def test_a_pi_without_config_env_gets_the_laptops(self):
        code, out = self.deploy(pi_cfg='')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.sent()[0]['config_base'], 'none')


class AutodeployRecord(unittest.TestCase):
    def test_up_to_date_comes_from_deploy_sh_record(self):
        tmp = tempfile.mkdtemp()
        try:
            with mock.patch.object(autodeploy, 'DEPLOYED', os.path.join(tmp, 'pi-deployed')):
                self.assertEqual(autodeploy.read_deployed(), {})
                with open(autodeploy.DEPLOYED, 'w') as f:
                    f.write('fingerprint=0123456789abcdef\ncommit=abc-dirty\nsource=by-hand\nat=2026-11-14T15:00:00\n')
                self.assertEqual(autodeploy.read_deployed()['fingerprint'], '0123456789abcdef')
                self.assertEqual(autodeploy.read_deployed()['commit'], 'abc-dirty')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
