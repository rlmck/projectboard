"""Talking to the Pi: the system ssh (key login over Tailscale), one process per
call. Commands are built from fixed parts plus shlex-quoted arguments that the
caller has already checked against a list; nothing typed in the page reaches a
remote shell unquoted.
"""
import json
import os
import shlex
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, 'probe.py')
HELPER = '/usr/local/sbin/pb-console-helper'
SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10',
            '-o', 'ServerAliveCountMax=3']
# Windows: no console window flashing up for each ssh
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


class Remote:
    def __init__(self, host='pi@projectboard', ssh=None):
        self.host = host
        self.ssh = ssh or shutil.which('ssh') or 'ssh'

    def argv(self, remote_cmd):
        return [self.ssh, *SSH_OPTS, self.host, remote_cmd]

    def run(self, remote_cmd, stdin=None, timeout=60):
        """(exit code, stdout text, stderr text). 255 = ssh itself failed (the Pi unreachable)."""
        try:
            p = subprocess.run(self.argv(remote_cmd), input=stdin, capture_output=True, timeout=timeout,
                               creationflags=NO_WINDOW)
        except subprocess.TimeoutExpired:
            return 124, '', 'timed out after %d s' % timeout
        except OSError as e:
            return 255, '', 'ssh could not start: %s' % e
        return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')

    def start(self, remote_cmd):
        """A running ssh with stdout and stderr together on .stdout, for streaming.
        Killing it ends the remote command too (its output pipe closes)."""
        return subprocess.Popen(self.argv(remote_cmd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, creationflags=NO_WINDOW)

    # -- the probe (read-only) ---------------------------------------------------

    def probe(self, mode=''):
        with open(PROBE, 'rb') as f:
            script = f.read()
        t0 = time.monotonic()
        code, out, err = self.run('python3 - %s' % shlex.quote(mode) if mode else 'python3 -', stdin=script,
                                  timeout=60)
        ms = int((time.monotonic() - t0) * 1000)
        if code != 0:
            return {'ok': False, 'code': code, 'error': (err or out).strip()[-500:], 'ms': ms}
        try:
            data = json.loads(out)
        except ValueError:
            return {'ok': False, 'code': code, 'error': 'the probe sent no JSON: %s' % (out + err)[-300:], 'ms': ms}
        data['ok'], data['ms'] = True, ms
        return data

    def busy(self):
        """The busy guard: casts in the last 5 minutes. None if the Pi can't be asked."""
        b = self.probe('busy')
        return b if b.get('ok') else None


def helper_cmd(*args):
    """The remote command for one pb-console-helper call (arguments already checked)."""
    return 'sudo -n %s %s' % (HELPER, ' '.join(shlex.quote(a) for a in args))
