"""The Pi side of the console's overview: read-only, standard library only.

The console sends this file over ssh (`ssh pi@projectboard python3 - [busy]`) and
reads one JSON object back; nothing is installed on the Pi for it. It runs as pi,
which can read the journal (the adm group), so it needs no sudo. It never
changes anything.

    python3 - < probe.py          everything the overview shows
    python3 - busy < probe.py     only the casts in the last 5 minutes (the busy guard)
"""
import json
import os
import re
import subprocess
import sys
import time

RUN = '/run/projectboard'
STATUS = RUN + '/listener.json'
SERVICES = ('pb-listener', 'kiosk', 'pb-netwatch', 'board-cam', 'pb-ledmap', 'tailscaled', 'NetworkManager')
TIMERS = ('pb-health', 'pb-mode', 'pb-weekly-reboot', 'pb-bootcheck')
BUSY_S = 300
NETWATCH_LOG = '/boot/firmware/netwatch.txt'


def sh(*cmd, timeout=20):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ''


def read(path):
    try:
        with open(path, encoding='utf-8', errors='replace') as f:
            return f.read()
    except OSError:
        return None


def show(unit, props):
    out = sh('systemctl', 'show', unit, '-p', ','.join(props))
    return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)


# The listener's lines: "cast received: 'Name' mirrored [wall, guest]" and
# "cast 'Name' mirrored ignored: night mode [wall, guest]". The mirrored and the
# [source, who] parts are optional (no [..] from apps before 29 Oct 2026), and %r
# quotes a name containing ' with ".
CAST_LINE = re.compile(r"^(\S+) \S+ \S+: cast (?:received: )?(['\"])(.*)\2( mirrored)?"
                       r"( ignored: night mode)?(?: \[(\w+), (\w+)\])?$")


# "circuit ended: 'Name' stopped after 23 moves (74 s), 3 s a move, loop, run 9f2c… [phone, member]"
# (pi/listener/circuit.py ended_line), and "circuit 'Name' ignored: night mode [wall, guest]".
CIRCUIT_LINE = re.compile(r"^(\S+) \S+ \S+: circuit ended: (['\"])(.*)\2 ([a-z][a-z ]*?) after (\d+) moves "
                          r"\((\d+) s\), ([\d.]+) s a move, (loop|once), run (\S+)(?: \[(\w+), (\w+)\])?$")
CIRCUIT_NIGHT = re.compile(r"^(\S+) \S+ \S+: circuit (['\"])(.*)\2 ignored: night mode(?: \[(\w+), (\w+)\])?$")


def casts_since(seconds):
    """[{at, name, mirror}] from the listener's 'cast received' lines."""
    out = sh('journalctl', '-u', 'pb-listener', '--since', '-%ds' % seconds, '-o', 'short-iso',
             '--no-pager', '-q', '--grep', 'cast received')
    casts = []
    for line in out.splitlines():
        m = CAST_LINE.match(line)
        if m and not m.group(5):
            casts.append({'at': m.group(1), 'name': m.group(3), 'mirror': bool(m.group(4))})
    return casts


def busy():
    s = {}
    try:
        s = json.loads(read(STATUS) or '{}')
    except ValueError:
        pass
    casts = casts_since(BUSY_S)
    last = s.get('last_cast_at')
    recent = bool(casts) or bool(last and time.time() - last < BUSY_S)
    recent = recent or s.get('leds') == 'circuit'      # a circuit run still going, however long ago it started
    return {'busy': recent, 'casts': casts, 'last_cast_at': last, 'last_cast_name': s.get('last_cast_name'),
            'pb_ledmap': sh('systemctl', 'is-active', 'pb-ledmap'), 'now': time.time()}


def journal_json(*args):
    out = sh('journalctl', '--no-pager', '-q', '-o', 'json', *args, timeout=40)
    rows = []
    for line in out.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows


def errors():
    """Error lines in the journal (priority err and worse): by source, now vs the day before."""
    def count(rows):
        c = {}
        for r in rows:
            src = r.get('_SYSTEMD_UNIT') or r.get('SYSLOG_IDENTIFIER') or '?'
            if src == 'init.scope':
                src = 'systemd'
            elif src.startswith('session-') and src.endswith('.scope'):
                src = 'login sessions (sudo, ssh)'
            c[src] = c.get(src, 0) + 1
        return c
    fields = '--output-fields=_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,MESSAGE,__REALTIME_TIMESTAMP'
    now = journal_json('-p', 'err', '--since', '-24h', fields)
    before = journal_json('-p', 'err', '--since', '-48h', '--until', '-24h', fields)
    boot = sh('journalctl', '-b', '-p', 'err', '--no-pager', '-q', '-o', 'cat')
    last = [{'at': int(r.get('__REALTIME_TIMESTAMP', 0)) / 1e6,
             'source': r.get('_SYSTEMD_UNIT') or r.get('SYSLOG_IDENTIFIER') or '?',
             'message': str(r.get('MESSAGE'))[:200]} for r in now[-8:]]
    return {'last24h': count(now), 'before': count(before), 'this_boot': len(boot.splitlines()) if boot else 0,
            'latest': last}


def health():
    out = sh('journalctl', '-t', 'pb-health', '--since', '-7d', '-o', 'short-iso', '--no-pager', '-q',
             '--grep', ' ?ACTION ')
    actions = []
    for line in out.splitlines():
        m = re.match(r'^(\S+) \S+ \S+: ACTION ([a-z-]+): (.*)$', line)
        if m:
            actions.append({'at': m.group(1), 'action': m.group(2), 'why': m.group(3)})
    check = sh('journalctl', '-t', 'pb-health', '-o', 'short-iso', '--no-pager', '-q', '-n', '200',
               '--grep', 'check:').splitlines()
    watchdog = sh('journalctl', '-u', 'pb-listener', '--since', '-24h', '--no-pager', '-q', '-o', 'cat',
                  '--grep', 'Watchdog timeout').splitlines()
    nw = (read(NETWATCH_LOG) or '').splitlines()
    reboots = (read('/var/lib/projectboard/reboots') or '').split('\n')
    return {'actions': actions, 'last_check': check[-1] if check else None, 'watchdog_24h': len(watchdog),
            'netwatch_tail': nw[-12:], 'health_reboots': [r for r in reboots if r.strip()][-5:]}


def wifi():
    line = ''
    for l in sh('nmcli', '-t', '-f', 'IN-USE,SSID,SIGNAL,FREQ', 'device', 'wifi', 'list', '--rescan', 'no').splitlines():
        if l.startswith('*:'):
            line = l
    parts = line.split(':') if line else []
    conns = sh('nmcli', '-t', '-f', 'NAME,DEVICE', 'connection', 'show', '--active')
    conn = next((c.split(':')[0] for c in conns.splitlines() if c.endswith(':wlan0')), None)
    addr = sh('ip', '-4', '-br', 'addr', 'show', 'wlan0').split()
    return {'ssid': parts[1] if len(parts) > 2 else None, 'signal': int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None,
            'freq': parts[3] if len(parts) > 3 else None, 'connection': conn,
            'ip': addr[2] if len(addr) > 2 else None, 'rescue_up': 'pb-rescue' in conns}


def hardware():
    temp = read('/sys/class/thermal/thermal_zone0/temp')
    thr = sh('vcgencmd', 'get_throttled')
    mem = {}
    for line in (read('/proc/meminfo') or '').splitlines():
        k, _, v = line.partition(':')
        if k in ('MemTotal', 'MemAvailable'):
            mem[k] = int(v.split()[0]) * 1024
    st = os.statvfs('/')
    up = float((read('/proc/uptime') or '0').split()[0])
    return {'temp_c': round(int(temp) / 1000, 1) if temp and temp.strip().isdigit() else None,
            'throttled': thr.split('=', 1)[1] if '=' in thr else None,
            'mem_total': mem.get('MemTotal'), 'mem_available': mem.get('MemAvailable'),
            'disk_total': st.f_blocks * st.f_frsize, 'disk_free': st.f_bavail * st.f_frsize,
            'load': os.getloadavg(), 'uptime_s': up, 'boot_at': time.time() - up}


def everything():
    t0 = time.time()
    services = {}
    for u in SERVICES:
        services[u] = show(u, ['ActiveState', 'SubState', 'UnitFileState', 'NRestarts', 'ActiveEnterTimestamp', 'Result'])
    timers = {}
    for t in TIMERS:
        timers[t] = show(t + '.timer', ['ActiveState', 'UnitFileState', 'LastTriggerUSec', 'NextElapseUSecRealtime'])
        timers[t]['service_result'] = show(t + '.service', ['Result']).get('Result')
    listener = None
    raw = read(STATUS)
    if raw:
        try:
            listener = json.loads(raw)
            listener['file_age_s'] = time.time() - os.stat(STATUS).st_mtime
        except (ValueError, OSError):
            listener = {'unreadable': True}
    ts = {}
    try:
        tsj = json.loads(sh('tailscale', 'status', '--json') or '{}')
        ts = {'state': tsj.get('BackendState'), 'ips': (tsj.get('Self') or {}).get('TailscaleIPs') or tsj.get('TailscaleIPs')}
    except ValueError:
        pass
    cfg = read('/etc/projectboard/config.env')
    day_casts = casts_since(86400)
    return {
        'host': sh('hostname'), 'now': time.time(),
        'hardware': hardware(), 'wifi': wifi(), 'tailscale': ts,
        'services': services, 'timers': timers, 'listener': listener,
        'mode': sh('python3', '/opt/projectboard/listener/mode.py'),
        'mode_applied': (read(RUN + '/mode') or '').strip() or None,
        'screen_off_flag': os.path.exists(RUN + '/screen-off'),
        'boot_line': (sh('journalctl', '-b', '-t', 'pb-boot', '-o', 'cat', '--no-pager', '-q').splitlines() or [None])[-1],
        'time_synced': sh('timedatectl', 'show', '-p', 'NTPSynchronized', '--value'),
        'health': health(), 'errors': errors(),
        'casts_5min': casts_since(BUSY_S), 'casts_24h': len(day_casts), 'casts_recent': day_casts[-8:],
        'helper': os.path.exists('/usr/local/sbin/pb-console-helper') and os.path.exists('/etc/sudoers.d/pb-console'),
        'config_env': cfg,
        'probe_ms': None, '_t0': t0,
    }


def activity(days):
    """Casts from the listener's journal over the last `days` days (phase 10):
    casts [at, name, mirror, shown, source, who] (source/who None before the app sent them), and
    circuit runs [at (when it ended), name, how, moves, seconds, s a move, loop, run, source, who]
    (how 'night mode' and moves None: ignored at night)."""
    out = sh('journalctl', '-u', 'pb-listener', '--since', '-%dd' % days, '-o', 'short-iso', '--no-pager', '-q',
             '--grep', r'cast received|ignored: night mode|circuit ended', timeout=60)
    casts, circuits = [], []
    for line in out.splitlines():
        m = CAST_LINE.match(line)
        if m:
            casts.append([m.group(1), m.group(3), bool(m.group(4)), not m.group(5), m.group(6), m.group(7)])
            continue
        m = CIRCUIT_LINE.match(line)
        if m:
            circuits.append([m.group(1), m.group(3), m.group(4), int(m.group(5)), int(m.group(6)), float(m.group(7)),
                             m.group(8) == 'loop', None if m.group(9) == '-' else m.group(9), m.group(10), m.group(11)])
            continue
        m = CIRCUIT_NIGHT.match(line)
        if m:
            circuits.append([m.group(1), m.group(3), 'night mode', None, None, None, None, None, m.group(4), m.group(5)])
    boots = [l for l in sh('journalctl', '--list-boots', '--no-pager', '-q').splitlines() if l.strip()]
    first = boots[0].split() if boots else []
    # the oldest boot line: IDX BOOT-ID Day YYYY-MM-DD HH:MM:SS ZONE ...: the journal starts there
    return {'casts': casts, 'circuits': circuits, 'days': days, 'journal_from': ' '.join(first[3:5]) if len(first) > 4 else None}


def last_night(date):
    """What happened around NIGHT_START and NIGHT_END for the night starting on `date` (YYYY-MM-DD)."""
    cfg = {}
    for line in (read('/etc/projectboard/config.env') or '').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            cfg[k.strip()] = v.strip()
    start, end = cfg.get('NIGHT_START') or '23:00', cfg.get('NIGHT_END') or '08:00'
    import datetime
    d = datetime.date.fromisoformat(date)
    s_at = datetime.datetime.combine(d, datetime.time.fromisoformat(start))
    e_day = d + datetime.timedelta(days=1) if end <= start else d
    e_at = datetime.datetime.combine(e_day, datetime.time.fromisoformat(end))

    def around(t):
        a, b = (t - datetime.timedelta(minutes=3)).strftime('%Y-%m-%d %H:%M:%S'), (t + datetime.timedelta(minutes=5)).strftime('%Y-%m-%d %H:%M:%S')
        return sh('journalctl', '--since', a, '--until', b, '-o', 'short-iso', '--no-pager', '-q',
                  '_SYSTEMD_UNIT=pb-listener.service', '+', '_SYSTEMD_UNIT=kiosk.service', '+',
                  'SYSLOG_IDENTIFIER=pb-mode', timeout=30).splitlines()
    return {'start': s_at.isoformat(), 'end': e_at.isoformat(), 'at_start': around(s_at)[-60:],
            'at_end': around(e_at)[-60:], 'ignored': sh('journalctl', '-u', 'pb-listener', '--since',
                                                        s_at.strftime('%Y-%m-%d %H:%M:%S'), '--until',
                                                        e_at.strftime('%Y-%m-%d %H:%M:%S'), '-o', 'cat',
                                                        '--no-pager', '-q', '--grep', 'ignored').splitlines()[-20:]}


def config_backups():
    d = '/var/lib/projectboard/config-backups'
    out = []
    try:
        names = sorted((n for n in os.listdir(d) if n.startswith('config.env.')), reverse=True)
    except OSError:
        names = []
    for n in names:
        out.append({'name': n, 'text': read(os.path.join(d, n))})
    return {'backups': out, 'current': read('/etc/projectboard/config.env')}


def main(argv):
    if argv[:1] == ['busy']:
        out = busy()
    elif argv[:1] == ['activity']:
        out = activity(max(1, min(60, int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else 14)))
    elif argv[:1] == ['night'] and len(argv) > 1 and re.match(r'^\d{4}-\d{2}-\d{2}$', argv[1]):
        out = last_night(argv[1])
    elif argv[:1] == ['config']:
        out = config_backups()
    else:
        out = everything()
        out['probe_ms'] = int((time.time() - out.pop('_t0')) * 1000)
    json.dump(out, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
