"""pb-health (pi/ops/pb-health) run on the laptop under bash with fake system commands on
the PATH (ip, ping, nmcli, systemctl, timedatectl, tailscale, logger): nothing real is
restarted or rebooted. Review fix session 7 (15 Nov 2026):

  PI-02  while the rescue hotspot is up, pb-health leaves the network alone (no
         `nmcli connection up`, no NetworkManager restart, no reboot);
  PI-07  NTP off with no clock test running is turned back on; during the test it isn't;
  PI-11  a listener that hasn't joined for 5 min is restarted only if Supabase answers a
         TCP connect; a stale status file (a frozen listener) is restarted regardless.

    python -m unittest discover -s pi/tests
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'ops', 'pb-health')


def find_bash():
    if os.name != 'nt':
        return shutil.which('bash')
    for p in (r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files\Git\usr\bin\bash.exe'):
        if os.path.exists(p):
            return p
    b = shutil.which('bash')
    return b if b and 'windowsapps' not in b.lower() and 'system32' not in b.lower() else None


BASH = find_bash()

# Each fake appends its arguments to $FAKE/calls and answers from env vars.
FAKES = {
    'ip': r'''
case "$*" in
  *"addr show dev"*) case "$FAKE_NET" in up) echo "3: wlan0 inet 192.168.1.20/24 brd x";; rescue) echo "3: wlan0 inet 10.42.0.1/24 brd x";; esac ;;
  *"route show default"*) [ "$FAKE_NET" = up ] && echo "default via 192.168.1.1 dev wlan0" ;;
esac
exit 0''',
    'ping': r'''[ "$FAKE_NET" = up ]''',
    'nmcli': r'''
case "$*" in
  "radio wifi") echo enabled ;;
  *"connection show --active"*) [ "$FAKE_NET" = rescue ] && echo pb-rescue || echo hangout-fixed ;;
esac
exit 0''',
    'systemctl': r'''
case "$1" in
  is-active) for u in $FAKE_ACTIVE; do [ "$u" = "$2" ] && { echo active; exit 0; }; done; echo inactive; exit 3 ;;
  is-enabled) [ "$2" = pb-listener ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  show) echo "" ;;
esac
exit 0''',
    'timedatectl': r'''
case "$*" in
  "show -p NTP --value") echo "${FAKE_NTP:-yes}" ;;
esac
exit 0''',
    'tailscale': r'''echo '{"BackendState": "Running"}' ''',
    'logger': r'''exit 0''',
    'vcgencmd': r'''echo throttled=0x0''',
}


@unittest.skipUnless(BASH, 'needs bash (Git Bash on Windows)')
class PbHealth(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='pb-health-test-')
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.bin)
        py = sys.executable.replace('\\', '/')
        fakes = dict(FAKES, python3='exec "%s" "$@"' % py)
        for name, body in fakes.items():
            with open(os.path.join(self.bin, name), 'w', newline='\n') as f:
                f.write('#!/bin/bash\necho "%s $*" >> "$FAKE/calls"\n%s\n' % (name, body.strip()))
            os.chmod(os.path.join(self.bin, name), 0o755)
        self.status = os.path.join(self.tmp, 'listener.json')
        self.config = os.path.join(self.tmp, 'config.env')
        self.server = None

    def tearDown(self):
        if self.server:
            self.server.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_config(self, url):
        with open(self.config, 'w', newline='\n') as f:
            f.write('SUPABASE_URL=%s\nSUPABASE_ANON_KEY=x\n' % url)

    def write_status(self, state='joined', disconnected_for=None, age=0):
        s = {'state': state, 'pid': 1, 'led_write_errors': 0}
        if disconnected_for is not None:
            s['disconnected_since'] = time.time() - disconnected_for
        with open(self.status, 'w') as f:
            json.dump(s, f)
        if age:
            t = time.time() - age
            os.utime(self.status, (t, t))

    def listening_port(self):
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(5)
        return self.server.getsockname()[1]

    def closed_port(self):
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        return port

    def run_health(self, net='up', active='pb-listener', ntp='yes', down_since=None):
        fwd = lambda p: p.replace('\\', '/')            # noqa: E731
        run = os.path.join(self.tmp, 'run')
        os.makedirs(run, exist_ok=True)
        if down_since is not None:
            with open(os.path.join(run, 'net_down_since'), 'w') as f:
                f.write('%d\n' % down_since)
        env = dict(os.environ, FAKE=fwd(self.tmp), FAKE_NET=net, FAKE_ACTIVE=active, FAKE_NTP=ntp,
                   FAKEBIN=fwd(self.bin), PB_HEALTH_CONFIG=fwd(self.config), PB_HEALTH_RUN=fwd(run),
                   PB_HEALTH_LEDGER=fwd(os.path.join(self.tmp, 'reboots')), PB_HEALTH_STATUS=fwd(self.status),
                   SCRIPT=fwd(SCRIPT))
        # The fakes must come first on the PATH (MSYS form), or nothing runs at all.
        cmd = ('B="$FAKEBIN"; command -v cygpath >/dev/null && B=$(cygpath -u "$B"); export PATH="$B:$PATH"; '
               '[ "$(command -v systemctl)" = "$B/systemctl" ] || { echo "fakes not first on PATH"; exit 99; }; '
               'bash "$SCRIPT"')
        p = subprocess.run([BASH, '-c', cmd], env=env, capture_output=True, text=True, timeout=120)
        self.assertNotEqual(p.returncode, 99, p.stdout + p.stderr)
        try:
            with open(os.path.join(self.tmp, 'calls')) as f:
                return f.read().splitlines()
        except OSError:
            return []

    @staticmethod
    def did(calls, prefix):
        return [c for c in calls if c.startswith(prefix)]

    # -- PI-02 ---------------------------------------------------------------------------
    def test_the_rescue_hotspot_is_left_alone(self):
        self.write_config('https://127.0.0.1:%d' % self.closed_port())
        calls = self.run_health(net='rescue', down_since=int(time.time()) - 3600)   # down an hour
        self.assertEqual(self.did(calls, 'nmcli --wait'), [])                        # no connection up
        self.assertEqual(self.did(calls, 'systemctl restart'), [])                   # no NetworkManager restart
        self.assertEqual(self.did(calls, 'systemctl reboot'), [])
        with open(os.path.join(self.tmp, 'run', 'net_down_since')) as f:
            self.assertGreater(int(f.read()), time.time() - 60)                      # the clock starts again

    def test_without_the_hotspot_it_still_brings_the_wifi_back(self):
        self.write_config('https://127.0.0.1:%d' % self.closed_port())
        calls = self.run_health(net='down')
        self.assertTrue(self.did(calls, 'nmcli --wait 30 connection up hangout-fixed'), calls)

    # -- PI-07 ---------------------------------------------------------------------------
    def test_ntp_left_off_is_turned_back_on(self):
        self.write_config('https://127.0.0.1:%d' % self.listening_port())
        self.write_status()
        calls = self.run_health(ntp='no')
        self.assertIn('timedatectl set-ntp true', calls)

    def test_ntp_off_during_the_clock_test_is_left_off(self):
        self.write_config('https://127.0.0.1:%d' % self.listening_port())
        self.write_status()
        calls = self.run_health(ntp='no', active='pb-listener pb-test-ntp.timer')
        self.assertNotIn('timedatectl set-ntp true', calls)

    def test_ntp_on_is_left_alone(self):
        self.write_config('https://127.0.0.1:%d' % self.listening_port())
        self.write_status()
        self.assertNotIn('timedatectl set-ntp true', self.run_health())

    # -- PI-11 ---------------------------------------------------------------------------
    def test_not_joined_with_supabase_unreachable_is_not_restarted(self):
        self.write_config('https://127.0.0.1:%d' % self.closed_port())
        self.write_status(state='connecting', disconnected_for=400)
        calls = self.run_health()
        self.assertNotIn('systemctl restart pb-listener', calls)

    def test_not_joined_with_supabase_reachable_is_restarted(self):
        self.write_config('https://127.0.0.1:%d' % self.listening_port())
        self.write_status(state='connecting', disconnected_for=400)
        self.assertIn('systemctl restart pb-listener', self.run_health())

    def test_a_frozen_listener_is_restarted_even_with_supabase_down(self):
        self.write_config('https://127.0.0.1:%d' % self.closed_port())
        self.write_status(age=200)
        self.assertIn('systemctl restart pb-listener', self.run_health())

    def test_a_joined_listener_is_left_alone(self):
        self.write_config('https://127.0.0.1:%d' % self.closed_port())
        self.write_status()
        self.assertNotIn('systemctl restart pb-listener', self.run_health())


if __name__ == '__main__':
    unittest.main()
