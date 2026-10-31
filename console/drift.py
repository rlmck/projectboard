"""Pi deploy drift (phase 6): every file install.sh places, its copy in the repo,
and whether the Pi's matches; plus files on the Pi that the repo doesn't have.

INSTALLED mirrors install.sh's put lines (a test checks every target here is in
install.sh). The hashes are read as pi with sha256sum; the few root-only files
come from `pb-console-helper hashes`.
"""
import glob
import hashlib
import os
import re
import shlex

from procs import REPO

PI = os.path.join(REPO, 'pi')
# Files on the Pi that belong to the board but that install.sh doesn't place: shown as "not in the repo".
EXTRA_GLOBS = ['/etc/systemd/system/pb-*', '/usr/local/bin/pb-*', '/usr/local/sbin/*', '/opt/projectboard/*/*',
               '/opt/projectboard/*/*/*']


def installed():
    """[(repo path relative to the repo, Pi path)] as install.sh places them."""
    m = []

    def add(rel, dest):
        m.append((rel.replace('\\', '/'), dest))
    for f in sorted(glob.glob(os.path.join(PI, 'listener', '*.py'))):
        add(os.path.relpath(f, REPO), '/opt/projectboard/listener/' + os.path.basename(f))
    for f in sorted(glob.glob(os.path.join(PI, 'listener', 'patterns', '*.py'))):
        add(os.path.relpath(f, REPO), '/opt/projectboard/listener/patterns/' + os.path.basename(f))
    add('pi/ops/board-cam.sh', '/opt/projectboard/ops/board-cam.sh')
    for n in ('pb-health', 'pb-mode', 'pb-status', 'pb-idle', 'pb-ledmap', 'pb-bootcheck', 'pb-weekly-reboot'):
        add('pi/ops/' + n, '/usr/local/bin/' + n)
    add('pi/ops/pb-console-helper', '/usr/local/sbin/pb-console-helper')
    add('pi/ops/pb-netwatch.sh', '/usr/local/sbin/pb-netwatch.sh')
    add('pi/conf/pb-console.sudoers', '/etc/sudoers.d/pb-console')
    for f in sorted(glob.glob(os.path.join(PI, 'systemd', '*.service')) + glob.glob(os.path.join(PI, 'systemd', '*.timer'))):
        add(os.path.relpath(f, REPO), '/etc/systemd/system/' + os.path.basename(f))
    add('pi/systemd/kiosk.service.d/cursor.conf', '/etc/systemd/system/kiosk.service.d/cursor.conf')
    add('pi/ledmap/pb_ledmap.py', '/opt/projectboard/ledmap/pb_ledmap.py')
    add('pi/ledmap/index.html', '/opt/projectboard/ledmap/index.html')
    add('app/hold_map.json', '/opt/projectboard/ledmap/hold_map.json')
    add('app/board-fallback.jpg', '/opt/projectboard/ledmap/board.jpg')
    add('pi/conf/pb-journal.conf', '/etc/systemd/journald.conf.d/pb-journal.conf')
    add('pi/conf/pb-watchdog.conf', '/etc/systemd/system.conf.d/pb-watchdog.conf')
    add('pi/conf/projectboard.tmpfiles', '/etc/tmpfiles.d/projectboard.conf')
    add('pi/conf/98-projectboard-no-rand-mac.conf', '/etc/NetworkManager/conf.d/98-projectboard-no-rand-mac.conf')
    add('pi/conf/kiosk.pam', '/etc/pam.d/kiosk')
    add('pi/config.env.example', '/etc/projectboard/config.env.example')
    if os.path.exists(os.path.join(PI, 'config.env')):
        add('pi/config.env', '/etc/projectboard/config.env')
    return m


def sha(path):
    with open(os.path.join(REPO, path), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def remote_script():
    """A shell line for the Pi (run as pi): sha256 of every installed file, then the extra files' names."""
    paths = ' '.join(shlex.quote(d) for _, d in installed())
    globs = ' '.join(EXTRA_GLOBS)
    return ('sha256sum %s 2>&1; echo @@extra; ls -1d %s 2>/dev/null; echo @@nm; '
            'nmcli -t -f NAME,FILENAME connection show 2>/dev/null' % (paths, globs))


def compare(text, root_hashes=''):
    """Parse the Pi's answer: rows for the repo's files, extra files, NetworkManager profiles."""
    have, extra, nm = {}, [], []
    part = 'hash'
    for line in (text + '\n' + root_hashes).splitlines():
        if line == '@@extra':
            part = 'extra'
            continue
        if line == '@@nm':
            part = 'nm'
            continue
        if part == 'hash' or re.match(r'^[0-9a-f]{64}  /', line):
            m = re.match(r'^([0-9a-f]{64})  (/\S+)$', line)
            if m:
                have[m.group(2)] = m.group(1)
            else:
                m = re.match(r'^sha256sum: (/\S+): (.*)$', line)
                if m and m.group(1) not in have:
                    have[m.group(1)] = 'unreadable' if 'denied' in m.group(2) else 'missing'
        elif part == 'extra' and line.strip():
            extra.append(line.strip())
        elif part == 'nm' and ':' in line:
            name, _, path = line.rpartition(':')
            name = name.replace('\\:', ':')
            if path.startswith('/etc/NetworkManager/system-connections/'):     # saved profiles, not runtime ones
                nm.append({'name': name, 'file': path, 'pull_to': nm_target(name)})
    rows = []
    placed = set()
    for rel, dest in installed():
        placed.add(dest)
        mine = sha(rel)
        theirs = have.get(dest, 'missing')
        state = 'same' if theirs == mine else theirs if theirs in ('missing', 'unreadable') else 'differs'
        rows.append({'repo': rel, 'pi': dest, 'state': state})
    known_dirs = ('/opt/projectboard/ledmap/__pycache__', '/opt/projectboard/listener/__pycache__')
    extras = [p for p in extra if p not in placed and not p.startswith(known_dirs) and not p.endswith('.pyc')
              and not p.rstrip('/').endswith('__pycache__')
              and p not in ('/opt/projectboard/listener/patterns', '/etc/systemd/system/pb-ledmap.service')]
    return {'files': rows, 'extra': [{'path': p, 'pull_to': pull_target(p)} for p in extras], 'nm': nm}


def pull_target(pi_path):
    """Where a Pi-only file would go in the repo, or None if it isn't something to pull."""
    base = os.path.basename(pi_path)
    if not re.match(r'^[A-Za-z0-9_.@-]+$', base):
        return None
    if pi_path.startswith('/etc/systemd/system/') and base.endswith(('.service', '.timer')):
        return 'pi/systemd/' + base
    if pi_path.startswith(('/usr/local/sbin/', '/usr/local/bin/')):
        return 'pi/ops/' + base
    return None


def nm_target(name):
    safe = re.sub(r'[^A-Za-z0-9_.-]', '-', name)
    return 'pi/conf/%s.nmconnection' % safe


SECRET = re.compile(r'^\s*[A-Za-z0-9_-]*(psk|password|passwd|secret|private-key|wep-key\d*|pin)[A-Za-z0-9_-]*\s*=', re.I)


def has_secret(text):
    return any(SECRET.match(l) for l in text.splitlines())
