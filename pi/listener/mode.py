#!/usr/bin/env python3
"""Day or night, worked out from the clock every time it's asked (never from
on/off events), so a boot at 2am comes up in night mode and a missed timer
can't strand the board in the wrong mode. Also reads the config file.

    mode.py [--config FILE]      prints "day <reason>" or "night <reason>"
    mode.py --is-night           exit 0 at night, 1 in the day

Used by the listener (LEDs and casts) and by pb-mode (the screen, later the relays),
so both always agree.
"""
import datetime
import os
import sys

CONFIG = os.environ.get('PB_CONFIG', '/etc/projectboard/config.env')
SYNC_FLAG = '/run/systemd/timesync/synchronized'   # written by systemd-timesyncd once per boot

DEFAULTS = {
    'BOARD_WALL': 'HangoutPortland',
    'BRIGHTNESS': '0.5',
    'STRIP_PIXELS': '1200',
    'POWER_BUDGET_MA': '8000',
    'MA_PER_CHANNEL': '20',
    'IDLE_ANIMATION': 'on',
    'IDLE_PATTERN': 'glisten',
    'IDLE_CYCLE': '',
    'IDLE_CYCLE_MIN': '10',
    'IDLE_AFTER_S': '1200',
    'IDLE_BRIGHTNESS': '1.0',
    'IDLE_MAX_AMPS': '2.0',
    'IDLE_FPS': '30',
    'NIGHT_MODE': 'on',
    'NIGHT_START': '23:00',
    'NIGHT_END': '08:00',
    'NIGHT_FORCE': '',
    'TIME_SYNC_FLAG': SYNC_FLAG,
    'WIFI_CONNECTION': 'hangout-fixed',
    'WIFI_IFACE': 'wlan0',
    'RELAY_PINS': '',
    'RELAY_ACTIVE_LOW': 'yes',
}


def load_config(path=None):
    """KEY=value lines (the systemd EnvironmentFile format); # comments; quotes stripped."""
    cfg = dict(DEFAULTS)
    path = path or CONFIG
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                v = v[1:-1]
            cfg[k.strip()] = v
    return cfg


def _minutes(hhmm):
    h, m = hhmm.strip().split(':')
    h, m = int(h), int(m)
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError(hhmm)
    return h * 60 + m


def clock_synced(cfg):
    return os.path.exists(cfg.get('TIME_SYNC_FLAG') or SYNC_FLAG)


def current_mode(now, synced, cfg):
    """('day' | 'night', reason). Fails open: anything doubtful is day."""
    force = (cfg.get('NIGHT_FORCE') or '').strip().lower()
    if force in ('day', 'night'):
        return force, 'forced by NIGHT_FORCE'
    if (cfg.get('NIGHT_MODE') or 'on').strip().lower() not in ('on', 'yes', '1', 'true'):
        return 'day', 'night mode off'
    if not synced:
        return 'day', 'clock not synced (fail open)'
    try:
        start, end = _minutes(cfg['NIGHT_START']), _minutes(cfg['NIGHT_END'])
    except (KeyError, ValueError):
        return 'day', 'bad NIGHT_START/NIGHT_END (fail open)'
    window = '%s-%s' % (cfg['NIGHT_START'], cfg['NIGHT_END'])
    if start == end:
        return 'day', 'empty night window ' + window
    m = now.hour * 60 + now.minute
    night = start <= m < end if start < end else (m >= start or m < end)
    return ('night' if night else 'day'), 'clock %02d:%02d, night %s' % (now.hour, now.minute, window)


def mode_now(cfg):
    return current_mode(datetime.datetime.now(), clock_synced(cfg), cfg)


def main(argv):
    path = None
    if '--config' in argv:
        path = argv[argv.index('--config') + 1]
    try:
        cfg = load_config(path)
    except OSError as e:
        cfg = dict(DEFAULTS)
        print('config unreadable (%s): using defaults' % e, file=sys.stderr)
    mode, reason = mode_now(cfg)
    if '--is-night' in argv:
        return 0 if mode == 'night' else 1
    print(mode, reason)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
