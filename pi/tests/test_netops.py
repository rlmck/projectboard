"""The Pi's install and network pieces from review fix session 7 (15 Nov 2026), on the
laptop, with temp folders in place of the Pi's paths:

  PI-06  install.sh builds the listener in a version folder and swaps it in with one
         rename (/opt/projectboard/listener becomes a symlink); its rollback note is true;
  PI-13  setup.sh moves secrets.env off the FAT partition first and passes the Tailscale
         key by file; firstboot stages the code root-only;
  PI-14  pb-netwatch logs to /var/log and copies to the boot partition at most once per
         boot; pb-netlog writes to /var/log;
  TODO 5 the pb-rescue profile in the repo (no password) and install.sh's merge, which
         keeps the Pi's own psk line.

    python -m unittest discover -s pi/tests
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PI = os.path.dirname(HERE)


def find_bash():
    if os.name != 'nt':
        return shutil.which('bash')
    for p in (r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files\Git\usr\bin\bash.exe'):
        if os.path.exists(p):
            return p
    return None


BASH = find_bash()


def read(*parts):
    with open(os.path.join(PI, *parts), encoding='utf-8') as f:
        return f.read()


def fwd(p):
    return p.replace('\\', '/')


def bash(script, env=None, cwd=None):
    p = subprocess.run([BASH, '-c', script], env=dict(os.environ, **(env or {})), cwd=cwd,
                       capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout + p.stderr


def symlinks_work(tmp):
    code, out = bash('cd "$T" && mkdir d && ln -s d l && [ -L l ] && [ "$(readlink -f l)" = "$(cd d && pwd -P)" ]',
                     {'T': fwd(tmp), 'MSYS': 'winsymlinks:nativestrict'})
    return code == 0


# -- PI-14 --------------------------------------------------------------------------------

@unittest.skipUnless(BASH, 'needs bash')
class Netwatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='pb-netwatch-test-')
        self.env = {'PB_NETWATCH_LIB': '1', 'PB_NETWATCH_LOG': fwd(os.path.join(self.tmp, 'log', 'pb-netwatch.log')),
                    'PB_NETWATCH_FAT': fwd(os.path.join(self.tmp, 'boot', 'netwatch.txt')),
                    'PB_NETWATCH_STATE': fwd(os.path.join(self.tmp, 'state')),
                    'PB_NETWATCH_COPIED': fwd(os.path.join(self.tmp, 'run-copied')),
                    'SCRIPT': fwd(os.path.join(PI, 'ops', 'pb-netwatch.sh'))}
        os.makedirs(os.path.join(self.tmp, 'boot'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sh(self, body):
        code, out = bash('. "$SCRIPT"; ' + body, self.env)
        self.assertEqual(code, 0, out)
        return out

    def test_the_log_is_not_on_the_boot_partition(self):
        self.run_sh('log "no network (1)"; log "no network (2)"')
        with open(self.env['PB_NETWATCH_LOG']) as f:
            self.assertEqual(len(f.read().splitlines()), 2)
        self.assertEqual(os.listdir(os.path.join(self.tmp, 'boot')), [])

    def test_the_card_copy_happens_once_per_boot(self):
        self.run_sh('log "no network (8)"; card_copy; log "later"; card_copy; card_copy')
        with open(self.env['PB_NETWATCH_FAT']) as f:
            text = f.read()
        self.assertIn('no network (8)', text)
        self.assertNotIn('later', text)                       # the second and third calls did nothing
        os.remove(self.env['PB_NETWATCH_COPIED'])             # a reboot clears /run
        self.run_sh('card_copy')
        with open(self.env['PB_NETWATCH_FAT']) as f:
            self.assertIn('later', f.read())

    def test_the_reboot_counter_is_written_only_when_it_changes(self):
        self.run_sh('set_reboots 0')
        path = os.path.join(self.tmp, 'state', 'reboots')
        t = os.path.getmtime(path) - 100
        os.utime(path, (t, t))
        self.run_sh('set_reboots 0; set_reboots 0')
        self.assertEqual(os.path.getmtime(path), t)
        self.run_sh('set_reboots 1')
        with open(path) as f:
            self.assertEqual(f.read().strip(), '1')

    def test_no_sync_per_line_and_no_fat_log(self):
        s = read('ops', 'pb-netwatch.sh')
        log_fn = s[s.index('log() {'):s.index('}', s.index('log() {'))]
        self.assertNotIn('sync', log_fn)
        self.assertNotIn('/boot/firmware', log_fn)
        self.assertIn('LOG=${PB_NETWATCH_LOG:-/var/log/pb-netwatch.log}', s)


class Netlog(unittest.TestCase):
    def test_netlog_writes_to_var_log(self):
        unit = read('systemd', 'pb-netlog.service')
        self.assertIn('> /var/log/pb-netlog.txt', unit)
        self.assertNotIn('/boot/firmware', unit)

    def test_setup_sh_writes_the_same_unit(self):
        setup = read('setup.sh')
        a = setup.index("cat > /etc/systemd/system/pb-netlog.service <<'EOF'\n") + len(
            "cat > /etc/systemd/system/pb-netlog.service <<'EOF'\n")
        self.assertEqual(setup[a:setup.index('EOF\n', a)], read('systemd', 'pb-netlog.service'))


# -- PI-13 --------------------------------------------------------------------------------

class Secrets(unittest.TestCase):
    def test_secrets_leave_the_card_first(self):
        setup = read('setup.sh')
        self.assertIn('SECRETS=/var/lib/projectboard/secrets.env', setup)
        step1 = setup[setup.index('step "1/13  Secrets"'):setup.index('step "2/13')]
        move = step1.index('mv -f "$SECRETS.new" "$SECRETS"')
        self.assertLess(move, step1.index('read_secret TS_AUTHKEY'))      # moved before anything reads it
        self.assertIn('chmod 0600 "$SECRETS.new"', step1)
        self.assertIn('rm -f "$CARD_SECRETS"', step1)
        self.assertLess(step1.index('umask 077'), move)

    def test_the_tailscale_key_is_never_on_a_command_line(self):
        setup = read('setup.sh')
        self.assertNotIn('--authkey=', setup)
        self.assertNotIn('--auth-key="$TS_AUTHKEY"', setup)
        self.assertIn('--auth-key="file:$TS_KEYFILE"', setup)
        self.assertIn('rm -f "$TS_KEYFILE"', setup)

    def test_firstboot_stages_root_only(self):
        fb = read('firstboot', 'firstboot.sh')
        self.assertIn('STAGE=/var/lib/projectboard/stage', fb)
        self.assertIn('install -d -m 0700 "$STAGE"', fb)
        self.assertNotIn('chown -R pi:pi "$STAGE"', fb)
        self.assertNotIn('/home/pi/pb-deploy', fb)


# -- PI-06 --------------------------------------------------------------------------------

def swap_block():
    """install.sh's listener part, from '== Files' to the first line after the swap."""
    s = read('install.sh')
    a = s.index('echo "== Files"')
    b = s.index('put ops/board-cam.sh')
    return s[a:b]


@unittest.skipUnless(BASH, 'needs bash')
class ListenerSwap(unittest.TestCase):
    PUT = r'''
put() { local src="$SRC/$1" dest="$2"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then return; fi
  CHANGED+=("$dest"); mkdir -p "$(dirname "$dest")"; cp "$src" "$dest"; }
'''

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='pb-swap-test-')
        if not symlinks_work(self.tmp):
            self.skipTest('this bash makes no real symlinks (Windows without developer mode): runs on the Pi')
        self.opt = os.path.join(self.tmp, 'opt')
        self.src = os.path.join(self.tmp, 'src')
        shutil.copytree(os.path.join(PI, 'listener'), os.path.join(self.src, 'listener'),
                        ignore=shutil.ignore_patterns('__pycache__'))
        os.makedirs(self.opt)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def install(self):
        block = swap_block().replace('/opt/projectboard', '$OPT')
        script = 'set -euo pipefail; DRY=0; CHANGED=(); %s\n%s\nprintf "%%s\\n" "${CHANGED[@]+"${CHANGED[@]}"}" > "$OPT/../changed"' % (
            self.PUT, block)
        code, out = bash(script, {'OPT': fwd(self.opt), 'SRC': fwd(self.src), 'MSYS': 'winsymlinks:nativestrict'})
        self.assertEqual(code, 0, out)
        with open(os.path.join(self.tmp, 'changed')) as f:
            return [l for l in f.read().splitlines() if l]

    def live(self):
        return os.path.join(self.opt, 'listener')

    def test_a_real_folder_becomes_a_version_and_changes_swap_in(self):
        # A Pi from before 15 Nov 2026: a plain folder with the current code.
        shutil.copytree(os.path.join(self.src, 'listener'), self.live())
        changed = self.install()
        self.assertTrue(os.path.islink(self.live()))
        self.assertFalse(any(c.endswith('/board.py') for c in changed))       # nothing changed: no restart
        self.assertEqual(len([d for d in os.listdir(self.opt) if d.startswith('listener-before-')]), 1)
        # A change: a new version beside the live one, then one rename.
        first = os.path.realpath(self.live())
        with open(os.path.join(self.src, 'listener', 'board.py'), 'a') as f:
            f.write('\n# new\n')
        import time
        time.sleep(1.1)
        changed = self.install()
        self.assertIn(fwd(self.opt) + '/listener/board.py', changed)          # pb-listener restarts
        self.assertNotEqual(os.path.realpath(self.live()), first)
        self.assertTrue(os.path.isdir(first))                                 # the old version stays
        with open(os.path.join(self.live(), 'board.py')) as f:
            self.assertTrue(f.read().endswith('# new\n'))
        self.assertTrue(os.path.isfile(os.path.join(self.live(), 'patterns', 'wave.py')))

    def test_old_versions_are_pruned_to_two(self):
        for i in range(4):
            with open(os.path.join(self.src, 'listener', 'board.py'), 'a') as f:
                f.write('\n# %d\n' % i)
            import time
            time.sleep(1.1)
            self.install()
        versions = [d for d in os.listdir(self.opt) if d.startswith('listener-')]
        self.assertEqual(len(versions), 3)                                    # live + the two before it
        self.assertIn(os.path.basename(os.path.realpath(self.live())), versions)

    def test_a_fresh_card(self):
        self.install()
        self.assertTrue(os.path.islink(self.live()))
        self.assertTrue(os.path.isfile(os.path.join(self.live(), 'pb_listener.py')))


class InstallText(unittest.TestCase):
    def test_the_rollback_note_is_true(self):
        s = read('install.sh')
        self.assertNotIn('enable --now cast-listener', s)                     # the stopgap is long gone
        self.assertIn('sudo mv -T /opt/projectboard/listener.swap /opt/projectboard/listener', s)
        self.assertIn('mv -T "$LIVE.swap" "$LIVE"', s)

    def test_the_readme_rollback_matches(self):
        readme = read('README.md')
        self.assertIn('sudo mv -T /opt/projectboard/listener.swap /opt/projectboard/listener', readme)
        self.assertIn('`git revert` and a deploy', readme)
        self.assertNotIn('enable --now cast-listener', readme)


# -- TODO 5: the rescue profile -----------------------------------------------------------

def merge_script():
    s = read('install.sh')
    a = s.index("<<'PY'\n", s.index('RESCUE=/etc/NetworkManager')) + len("<<'PY'\n")
    return s[a:s.index('\nPY\n', a)]


class RescueProfile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tpl = os.path.join(PI, 'conf', 'pb-rescue.nmconnection')
        self.live = os.path.join(self.tmp, 'pb-rescue.nmconnection')
        self.code = os.path.join(self.tmp, 'merge.py')
        with open(self.code, 'w') as f:
            f.write(merge_script())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def merge(self, dry=False):
        import sys
        p = subprocess.run([sys.executable, self.code, self.tpl, self.live, '1' if dry else '0'],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def setup_sh_profile(self, psk):
        """What setup.sh writes for a fresh card."""
        s = read('setup.sh')
        a = s.index('    cat > "$RESCUE_KEYFILE" <<EOF\n') + len('    cat > "$RESCUE_KEYFILE" <<EOF\n')
        return s[a:s.index('EOF\n', a)].replace('$RESCUE_PSK', psk)

    def test_the_repo_copy_has_no_password(self):
        tpl = read('conf', 'pb-rescue.nmconnection')
        self.assertFalse(re.search(r'(?im)^\s*(psk|password|wep-key\d*)\s*=', tpl))
        self.assertIn('ssid=projectboard-rescue', tpl)

    def test_setup_sh_and_the_repo_agree(self):
        with open(self.live, 'w', newline='\n') as f:
            f.write(self.setup_sh_profile('not-a-real-psk'))
        self.assertEqual(self.merge(), 'same')

    def test_a_changed_setting_is_updated_and_the_psk_kept(self):
        with open(self.live, 'w', newline='\n') as f:
            f.write(self.setup_sh_profile('not-a-real-psk').replace('band=bg', 'band=a'))
        self.assertEqual(self.merge(dry=True), 'updated')
        with open(self.live) as f:
            self.assertIn('band=a', f.read())                                   # a dry run writes nothing
        self.assertEqual(self.merge(), 'updated')
        with open(self.live) as f:
            text = f.read()
        self.assertIn('band=bg', text)
        self.assertIn('psk=not-a-real-psk', text)
        self.assertEqual(text, self.setup_sh_profile('not-a-real-psk'))
        self.assertEqual(self.merge(), 'same')

    def test_a_profile_without_a_psk_is_left_alone(self):
        with open(self.live, 'w', newline='\n') as f:
            f.write(read('conf', 'pb-rescue.nmconnection').replace('band=bg', 'band=a'))
        self.assertEqual(self.merge(), 'nopsk')
        with open(self.live) as f:
            self.assertIn('band=a', f.read())


if __name__ == '__main__':
    unittest.main()
