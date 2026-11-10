#!/usr/bin/env python3
"""Day or night, worked out from the clock and the opening hours every time
it's asked (never from on/off events), so a boot at 2am comes up in night mode
and a missed timer can't strand the board in the wrong mode. Also reads the
config file.

Day = inside the day's opening hours (HOURS_MON ... HOURS_SUN in config.env,
Europe/London wall-clock time, so the clocks changing needs nothing), or a
"stay on until" override from PB Console. Night = everything else: LEDs dark,
casts ignored, the wall screen off.

    mode.py [--config FILE]      prints "day <reason>" or "night <reason>"
    mode.py --is-night           exit 0 at night, 1 in the day
    mode.py --is-day             exit 0 in the day (or on any error), 1 at night: kiosk.service's ExecCondition
    mode.py --json               the mode, the reason, the next change, the override, the hours
    mode.py --night YYYY-MM-DD   JSON {start, end}: the night that began on or covers that date

Used by the listener (LEDs and casts), by pb-mode (the screen, later the relays)
and by PB Console (through its probe), so all of them always agree.
"""
import datetime
import json
import os
import re
import sys

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/London')
except Exception:          # no tz database: the system clock's own zone (Europe/London on the Pi)
    TZ = None

CONFIG = os.environ.get('PB_CONFIG', '/etc/projectboard/config.env')
SYNC_FLAG = '/run/systemd/timesync/synchronized'   # written by systemd-timesyncd once per boot
STAY_ON = '/var/lib/projectboard/stay-on-until'     # PB Console's override: "YYYY-MM-DDTHH:MM", London time
DAYS = ('MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN')
DAY_NAMES = ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')
HOURS_RX = re.compile(r'^(closed|([01][0-9]|2[0-3]):[0-5][0-9]-(([01][0-9]|2[0-3]):[0-5][0-9]|24:00))$')
STAY_MAX = datetime.timedelta(hours=24)            # an override is never longer than this

DEFAULTS = {
    'BOARD_WALL': 'HangoutPortland',
    'BRIGHTNESS': '0.5',
    'STRIP_PIXELS': '1200',
    'STRIP_LEDS': '248',            # the LEDs on the strip (0 to N-1): what LED mapping steps through
    'POWER_BUDGET_MA': '8000',
    'MA_PER_CHANNEL': '20',
    'IDLE_ANIMATION': 'on',
    'IDLE_PATTERN': 'glisten',
    'IDLE_CYCLE': '',
    'IDLE_CYCLE_MIN': '10',
    'IDLE_AFTER_S': '900',
    'IDLE_BRIGHTNESS': '1.0',
    'IDLE_MAX_AMPS': '2.0',
    'IDLE_FPS': '30',
    'CIRCUIT_MAX_S': '1800',
    'CIRCUIT_MAP_LEVEL': '0.2',
    'CIRCUIT_FINISH_LEVEL': '0.6',
    # Opening hours (7 Nov 2026; replaced NIGHT_START/NIGHT_END). Already 30 min
    # either side of the gym's own hours.
    'HOURS_MON': '15:30-22:00',
    'HOURS_TUE': '15:30-22:00',
    'HOURS_WED': '15:30-22:00',
    'HOURS_THU': '15:30-22:00',
    'HOURS_FRI': 'closed',
    'HOURS_SAT': '09:30-15:00',
    'HOURS_SUN': '09:30-15:00',
    'NIGHT_MODE': 'on',
    'NIGHT_FORCE': '',
    'STAY_ON_FILE': STAY_ON,
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


def london_now():
    """Now, as London wall-clock time (naive): what the hours are written in."""
    if TZ is not None:
        return datetime.datetime.now(TZ).replace(tzinfo=None, second=0, microsecond=0)
    return datetime.datetime.now().replace(second=0, microsecond=0)


def _minutes(hhmm):
    h, m = hhmm.strip().split(':')
    h, m = int(h), int(m)
    if not (0 <= h <= 24 and 0 <= m <= 59) or (h == 24 and m):
        raise ValueError(hhmm)
    return h * 60 + m


def parse_hours(value):
    """'closed' -> None; 'HH:MM-HH:MM' -> (start, end) in minutes. An end of 24:00 is
    midnight; an end before the start runs past midnight into the next day."""
    v = (value or '').strip().lower()
    if not HOURS_RX.match(v):
        raise ValueError(value)
    if v == 'closed':
        return None
    a, b = v.split('-')
    start, end = _minutes(a), _minutes(b)
    if start == end:
        raise ValueError(value)
    return start, end


def week(cfg):
    """[(start, end) | None] for Mon..Sun. ValueError names the bad key."""
    out = []
    for d in DAYS:
        key = 'HOURS_' + d
        try:
            out.append(parse_hours(cfg.get(key, DEFAULTS[key])))
        except ValueError:
            raise ValueError(key)
    return out


def hours_text(w):
    return 'closed' if w is None else '%02d:%02d-%02d:%02d' % (w[0] // 60, w[0] % 60, w[1] // 60, w[1] % 60)


def scheduled_open(now, hours):
    """Inside the opening hours at `now` (naive London time)? (open, the window that decides it)."""
    wd, m = now.weekday(), now.hour * 60 + now.minute
    today = hours[wd]
    if today is not None:
        s, e = today
        if (s <= m < e) if s < e else (m >= s):
            return True, (DAY_NAMES[wd], today)
    prev = hours[(wd - 1) % 7]
    if prev is not None and prev[1] < prev[0] and m < prev[1]:     # yesterday's hours past midnight
        return True, (DAY_NAMES[(wd - 1) % 7], prev)
    return False, (DAY_NAMES[wd], today)


def read_stay_on(cfg, now):
    """The override's end (naive London time) if it's still going, else None."""
    try:
        with open(cfg.get('STAY_ON_FILE') or STAY_ON, encoding='utf-8') as f:
            until = datetime.datetime.strptime(f.read().strip()[:16], '%Y-%m-%dT%H:%M')
    except (OSError, ValueError):
        return None
    return until if now < until <= now + STAY_MAX else None


def clock_synced(cfg):
    return os.path.exists(cfg.get('TIME_SYNC_FLAG') or SYNC_FLAG)


def current_mode(now, synced, cfg, stay_on=None):
    """('day' | 'night', reason) at `now` (naive London time). Fails open: anything doubtful is day.
    Order: NIGHT_FORCE, NIGHT_MODE=off, an unsynced clock, the stay-on override, the hours."""
    force = (cfg.get('NIGHT_FORCE') or '').strip().lower()
    if force in ('day', 'night'):
        return force, 'forced by NIGHT_FORCE'
    if (cfg.get('NIGHT_MODE') or 'on').strip().lower() not in ('on', 'yes', '1', 'true'):
        return 'day', 'night mode off'
    if not synced:
        return 'day', 'clock not synced (fail open)'
    if stay_on is not None and now < stay_on:
        return 'day', 'staying on until %s (PB Console)' % stay_on.strftime('%H:%M')
    try:
        hours = week(cfg)
    except ValueError as e:
        return 'day', 'bad %s (fail open)' % e
    is_open, (day, w) = scheduled_open(now, hours)
    clock = '%s %02d:%02d' % (DAY_NAMES[now.weekday()], now.hour, now.minute)
    if is_open:
        return 'day', 'clock %s, open %s %s' % (clock, day, hours_text(w))
    return 'night', 'clock %s, %s' % (clock, 'closed today' if w is None else 'outside %s' % hours_text(w))


def _edges(cfg, start, days):
    """Every moment the hours open or close from the day before `start` for `days` days."""
    try:
        hours = week(cfg)
    except ValueError:
        return []
    out = []
    d0 = start.date() - datetime.timedelta(days=1)
    for i in range(days + 2):
        d = d0 + datetime.timedelta(days=i)
        w = hours[d.weekday()]
        if w is None:
            continue
        s, e = w
        midnight = datetime.datetime.combine(d, datetime.time())
        out.append(midnight + datetime.timedelta(minutes=s))
        out.append(midnight + datetime.timedelta(minutes=e if e > s else 1440 + e))   # past midnight: the next day
    return sorted(set(out))


def next_change(now, cfg, stay_on=None):
    """(when, mode after) of the next switch (naive London time), or (None, None)."""
    mode, _ = current_mode(now, True, cfg, stay_on)
    cands = _edges(cfg, now, 8) + ([stay_on] if stay_on else [])
    for t in sorted(c for c in cands if c > now):
        m, _ = current_mode(t, True, cfg, stay_on)
        if m != mode:
            return t, m
    return None, None


def night_on(date, cfg):
    """The night that began on `date` or covers it: the last close at or before the end of
    that day, then the next open. {start, end} as naive London ISO times, or {error}."""
    end_of_day = datetime.datetime.combine(date, datetime.time()) + datetime.timedelta(days=1)
    try:
        week(cfg)
    except ValueError as e:
        return {'error': 'bad %s' % e}
    start = None
    for t in reversed([t for t in _edges(cfg, end_of_day - datetime.timedelta(days=8), 9) if t < end_of_day]):
        if current_mode(t, True, cfg)[0] == 'night' and current_mode(t - datetime.timedelta(minutes=1), True, cfg)[0] == 'day':
            start = t
            break
    if start is None:
        return {'error': 'no closing time in the week before %s' % date.isoformat()}
    end, _ = next_change(start, cfg)
    if end is None:
        return {'error': 'no opening time after %s' % start.isoformat()}
    return {'start': start.isoformat(timespec='minutes'), 'end': end.isoformat(timespec='minutes')}


def mode_now(cfg):
    now = london_now()
    return current_mode(now, clock_synced(cfg), cfg, read_stay_on(cfg, now))


def info(cfg):
    """Everything PB Console shows about the mode."""
    now = london_now()
    stay = read_stay_on(cfg, now)
    synced = clock_synced(cfg)
    mode, reason = current_mode(now, synced, cfg, stay)
    force = (cfg.get('NIGHT_FORCE') or '').strip().lower()
    when, after = (None, None) if force in ('day', 'night') else next_change(now, cfg, stay)
    try:
        hours = {d: hours_text(w) for d, w in zip(DAYS, week(cfg))}
    except ValueError as e:
        hours = {'error': 'bad %s' % e}
    return {'mode': mode, 'reason': reason, 'now': now.isoformat(timespec='minutes'), 'synced': synced,
            'force': force, 'night_mode': (cfg.get('NIGHT_MODE') or 'on'),
            'stay_on_until': stay.isoformat(timespec='minutes') if stay else None,
            'next_change': when.isoformat(timespec='minutes') if when else None, 'next_mode': after,
            'hours': hours}


def _config_arg(argv):
    return argv[argv.index('--config') + 1] if '--config' in argv else None


def main(argv):
    if '--is-day' in argv:
        try:
            return 0 if mode_now(load_config(_config_arg(argv)))[0] == 'day' else 1
        except Exception:          # never keep the screen off because of a bug here
            return 0
    path = _config_arg(argv)
    try:
        cfg = load_config(path)
    except OSError as e:
        cfg = dict(DEFAULTS)
        print('config unreadable (%s): using defaults' % e, file=sys.stderr)
    if '--json' in argv:
        print(json.dumps(info(cfg)))
        return 0
    if '--night' in argv:
        try:
            date = datetime.date.fromisoformat(argv[argv.index('--night') + 1])
        except (IndexError, ValueError):
            print(json.dumps({'error': '--night YYYY-MM-DD'}))
            return 2
        print(json.dumps(night_on(date, cfg)))
        return 0
    mode, reason = mode_now(cfg)
    if '--is-night' in argv:
        return 0 if mode == 'night' else 1
    print(mode, reason)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
