"""Turns the probe's JSON (the Pi) and the laptop checks into the overview's
tiles: each {id, title, level, value, lines}. level is ok, warn, bad or unknown
(green, amber, red, grey). Pure: no I/O, so the thresholds are tested on the laptop.
"""
import datetime
import time

OK, WARN, BAD, UNKNOWN = 'ok', 'warn', 'bad', 'unknown'
RANK = {UNKNOWN: 0, OK: 1, WARN: 2, BAD: 3}

# vcgencmd get_throttled bits: (bit, text, level)
THROTTLE_BITS = [
    (0, 'under-voltage now', BAD), (1, 'ARM frequency capped now', WARN), (2, 'throttled now', BAD),
    (3, 'soft temperature limit now', WARN), (16, 'under-voltage since boot', WARN),
    (17, 'frequency capped since boot', WARN), (18, 'throttled since boot', WARN),
    (19, 'soft temperature limit since boot', WARN),
]
SERVICE_TITLES = {'pb-listener': 'Listener service', 'kiosk': 'Kiosk (wall screen)', 'pb-netwatch': 'Wi-Fi watchdog',
                  'board-cam': 'Webcam'}
TIMER_TITLES = {'pb-health': 'Health check', 'pb-mode': 'Night mode', 'pb-weekly-reboot': 'Weekly reboot',
                'pb-bootcheck': 'Boot check'}


def tile(id, title, level, value, lines=()):
    return {'id': id, 'title': title, 'level': level, 'value': value, 'lines': [l for l in lines if l]}


def worst(*levels):
    return max(levels, key=lambda l: RANK[l]) if levels else UNKNOWN


def ago(seconds):
    if seconds is None:
        return '-'
    s = int(max(0, seconds))
    if s < 90:
        return '%d s ago' % s
    if s < 5400:
        return '%d min ago' % (s // 60)
    if s < 172800:
        return '%dh%02d ago' % (s // 3600, s % 3600 // 60)
    return '%d days ago' % (s // 86400)


def span(seconds):
    s = int(max(0, seconds or 0))
    d, h, m = s // 86400, s % 86400 // 3600, s % 3600 // 60
    return ('%dd %dh' % (d, h)) if d else ('%dh %02dm' % (h, m)) if h else '%d min' % m


def gb(n):
    return '%.1f GB' % (n / 1e9) if n is not None else '?'


def throttle(hexval):
    """(level, [texts]) for a get_throttled value like '0x50000'."""
    try:
        v = int(hexval, 16)
    except (TypeError, ValueError):
        return UNKNOWN, ['throttled: no answer']
    found = [(t, l) for bit, t, l in THROTTLE_BITS if v & (1 << bit)]
    if not found:
        return OK, ['never throttled or under-voltage since boot']
    return worst(*(l for _, l in found)), [t for t, _ in found]


def pi_tiles(p, now=None, err_warn=50, err_bad=500):
    now = now or time.time()
    if not p or not p.get('ok'):
        why = (p or {}).get('error') or 'no answer'
        return [tile('pi', 'Pi online', BAD, 'unreachable', ['ssh pi@projectboard failed: %s' % why,
                                                              'Runbook: the rescue hotspot steps in pi/README.md'])]
    hw, wifi, ts = p.get('hardware') or {}, p.get('wifi') or {}, p.get('tailscale') or {}
    out = []

    up = hw.get('uptime_s')
    out.append(tile('pi', 'Pi online', OK if ts.get('state') == 'Running' else WARN,
                    'up %s' % span(up),
                    ['last boot %s' % time.strftime('%a %d %b %H:%M', time.localtime(hw['boot_at'])) if hw.get('boot_at') else None,
                     'Tailscale %s' % (ts.get('state') or '?'), 'clock synced: %s' % p.get('time_synced'),
                     p.get('boot_line'), 'probe %d ms' % p.get('ms', 0)]))

    t = hw.get('temp_c')
    tl, tlines = throttle(hw.get('throttled'))
    temp_level = UNKNOWN if t is None else OK if t < 70 else WARN if t < 80 else BAD
    out.append(tile('hw', 'Temperature & power', worst(temp_level, tl),
                    '%s °C' % t if t is not None else '?', ['throttled %s' % hw.get('throttled')] + tlines))

    used = None
    if hw.get('disk_total'):
        used = 1 - hw['disk_free'] / hw['disk_total']
    mem = hw.get('mem_available') / hw['mem_total'] if hw.get('mem_total') else None
    lvl = worst(UNKNOWN if used is None else OK if used < 0.8 else WARN if used < 0.9 else BAD,
                UNKNOWN if mem is None else OK if mem > 0.15 else WARN if mem > 0.05 else BAD)
    out.append(tile('disk', 'Disk & memory', lvl, '%d%% disk used' % round(used * 100) if used is not None else '?',
                    ['%s free of %s' % (gb(hw.get('disk_free')), gb(hw.get('disk_total'))),
                     'memory %s available of %s' % (gb(hw.get('mem_available')), gb(hw.get('mem_total'))),
                     'load %s' % ' '.join('%.2f' % x for x in hw.get('load') or [])]))

    sig = wifi.get('signal')
    if wifi.get('rescue_up'):
        wl, wv = BAD, 'rescue hotspot up'
    elif not wifi.get('ssid'):
        wl, wv = BAD, 'not connected'
    else:
        wl = OK if sig is not None and sig >= 50 else WARN if sig is not None and sig >= 30 else BAD
        wv = '%s %s%%' % (wifi['ssid'], sig)
    out.append(tile('wifi', 'Wi-Fi', wl, wv, ['connection %s' % wifi.get('connection'), wifi.get('ip'), wifi.get('freq')]))

    services = p.get('services') or {}
    mode = (p.get('mode') or '').split(' ')[0]
    ledmap = (services.get('pb-ledmap') or {}).get('ActiveState') == 'active'
    for u, title in SERVICE_TITLES.items():
        s = services.get(u) or {}
        state = s.get('ActiveState', '?')
        lines = ['%s, %s' % (s.get('SubState', '?'), s.get('UnitFileState', '?')),
                 'since %s' % s['ActiveEnterTimestamp'] if s.get('ActiveEnterTimestamp') else None]
        if s.get('NRestarts') not in (None, '', '0'):
            lines.append('restarted %s times by systemd' % s['NRestarts'])
        if state == 'active':
            level = WARN if s.get('NRestarts') not in (None, '', '0') else OK
        elif u == 'pb-listener' and ledmap:
            level, lines = WARN, lines + ['paused for LED mapping (pb-ledmap)']
        elif u == 'kiosk' and mode == 'night':
            level, lines = OK, lines + ['off for the night (pb-mode)']
        elif u == 'kiosk' and p.get('screen_off_flag'):
            level, lines = WARN, lines + ['screen off by hand (console)']
        elif state == 'activating':
            level = WARN
        else:
            level = BAD
        out.append(tile('svc-' + u, title, level, state, lines))

    timers = p.get('timers') or {}
    tlines, tlevels = [], []
    for t_, title in TIMER_TITLES.items():
        tm = timers.get(t_) or {}
        bad = tm.get('ActiveState') != 'active' or tm.get('service_result') not in (None, '', 'success')
        tlevels.append(BAD if tm.get('ActiveState') != 'active' else WARN if bad else OK)
        tlines.append('%s: %s%s%s' % (title, tm.get('ActiveState', '?'),
                                      ', last %s' % tm['LastTriggerUSec'] if tm.get('LastTriggerUSec') else '',
                                      ', last run %s' % tm['service_result'] if tm.get('service_result') not in (None, '', 'success') else ''))
    out.append(tile('timers', 'Timers', worst(*tlevels), '%d of %d active' % (tlevels.count(OK) + tlevels.count(WARN), len(tlevels)), tlines))

    out.append(listener_tile(p.get('listener'), now, ledmap, p))
    out.append(health_tile(p.get('health') or {}, services))
    out.append(errors_tile(p.get('errors') or {}, err_warn, err_bad))
    return out


def listener_tile(s, now, ledmap=False, p=None):
    if not s:
        return tile('listener', 'Listener', WARN if ledmap else BAD, 'paused (pb-ledmap)' if ledmap else 'no status file',
                    ['/run/projectboard/listener.json missing'])
    if s.get('unreadable'):
        return tile('listener', 'Listener', BAD, 'status unreadable', [])
    age = s.get('file_age_s') or 0
    state = s.get('state')
    if age > 90:
        level = BAD
    elif state == 'joined':
        level = OK
    else:
        down = now - s['disconnected_since'] if s.get('disconnected_since') else 0
        level = WARN if down < 300 else BAD
    leds = s.get('leds')
    value = {'cast': 'cast: %s' % s.get('last_cast_name'), 'night': 'night', 'off': 'off (pb-idle)'}.get(
        leds, s.get('idle_pattern') or leds or '?')
    lines = ['%s, connected %s' % (state, ago(now - s['connected_since']) if s.get('connected_since') else '-'),
             'mode %s (%s)' % (s.get('mode'), s.get('mode_reason')),
             '%s fps, %s ms a frame' % (s.get('idle_fps'), s.get('idle_frame_ms')) if s.get('idle_fps') else None,
             'brightness x%s (pb-idle)' % s['brightness_scale'] if s.get('brightness_scale', 1) < 1 else None,
             'last cast %r %s' % (s.get('last_cast_name'), ago(now - s['last_cast_at'])) if s.get('last_cast_at') else 'no cast since it started',
             '%s shown, %s ignored at night' % (s.get('casts_shown'), s.get('casts_ignored_night')),
             'casts in 24 h (journal): %s' % p.get('casts_24h') if p else None,
             'errors %s%s' % (s.get('error_count'), ', last: %s' % s['last_error'] if s.get('last_error') else ''),
             'status file %d s old' % age if age > 90 else None]
    return tile('listener', 'Listener', level, value, lines)


def health_tile(h, services):
    actions = h.get('actions') or []
    from_ = time.time() - 86400
    day = [a for a in actions if _iso_ts(a.get('at')) >= from_]
    counts = {}
    for a in day:
        counts[a['action']] = counts.get(a['action'], 0) + 1
    watchdog = h.get('watchdog_24h') or 0
    restarts = int((services.get('pb-listener') or {}).get('NRestarts') or 0)
    if any(a in counts for a in ('reboot', 'reboot-suppressed')):
        level = BAD
    elif day or watchdog or restarts:
        level = WARN
    else:
        level = OK
    lines = ['24 h: %s' % (', '.join('%s %d' % kv for kv in sorted(counts.items())) or 'no actions'),
             '7 days: %d actions' % len(actions),
             'listener watchdog timeouts (24 h): %d' % watchdog,
             'listener restarts since boot: %d' % restarts]
    lines += ['%s %s: %s' % (a['at'][5:16].replace('T', ' '), a['action'], a['why'][:80]) for a in actions[-4:]]
    if h.get('last_check'):
        lines.append('last check: %s' % h['last_check'].split(': ', 1)[-1][:100])
    nw = [l for l in h.get('netwatch_tail') or [] if 'watchdog start' not in l]
    if nw:
        lines.append('pb-netwatch: %s' % nw[-1][:100])
    return tile('health', 'Self-healing', level, '%d actions in 24 h' % len(day), lines)


def _iso_ts(s):
    """'2026-10-28T13:03:28+00:00' -> epoch seconds (0 if it can't be read)."""
    try:
        return datetime.datetime.fromisoformat(s).timestamp()
    except (TypeError, ValueError):
        return 0


def errors_tile(e, warn_at=50, bad_at=500):
    now, before = e.get('last24h') or {}, e.get('before') or {}
    total, prev = sum(now.values()), sum(before.values())
    level = OK if total <= warn_at else WARN if total <= bad_at else BAD
    lines = ['%s: %d%s' % (src, n, ' (day before %d)' % before.get(src, 0))
             for src, n in sorted(now.items(), key=lambda kv: -kv[1])[:6]]
    lines.append('this boot: %s' % e.get('this_boot'))
    for r in (e.get('latest') or [])[-3:]:
        lines.append('%s %s: %s' % (time.strftime('%H:%M', time.localtime(r['at'])), r['source'], r['message'][:90]))
    return tile('errors', 'Journal errors (24 h)', level, '%d (day before %d)' % (total, prev), lines)


def laptop_tiles(c):
    if not c:
        return [tile('site', 'Live site', UNKNOWN, 'not checked yet'),
                tile('supabase', 'Supabase', UNKNOWN, 'not checked yet')]
    live = c.get('live') or {}
    repo = c.get('repo_cache')
    if live.get('status') != 200:
        sl, sv = BAD, 'down (%s)' % (live.get('status') or 'no answer')
    elif live.get('cache') and repo and live['cache'] != repo:
        sl, sv = WARN, live['cache']
    else:
        sl, sv = OK, live.get('cache') or 'up'
    site = tile('site', 'Live site', sl, sv, [
        '%s: %s in %s ms' % (live.get('url'), live.get('status'), live.get('ms')),
        'sw.js CACHE %s; repo %s%s' % (live.get('cache'), repo, '' if live.get('cache') == repo else ' (differ)')])
    sb, rt = c.get('supabase') or {}, c.get('realtime')
    lvl = OK if sb.get('status') == 200 else BAD
    lines = ['REST: %s in %s ms' % (sb.get('status') or 'no answer', sb.get('ms'))]
    if rt:
        lines.append('Realtime join %s in %s ms%s' % ('ok' if rt['ok'] else 'FAILED', rt.get('ms'),
                                                      ': ' + rt['error'] if rt.get('error') else ''))
        lines.append('joined %s' % ago(time.time() - rt['at']) if rt.get('at') else None)
        if not rt['ok']:
            lvl = worst(lvl, BAD)
    return [site, tile('supabase', 'Supabase', lvl, 'reachable' if lvl == OK else 'problem', lines)]


def metrics(p, c=None):
    """The raw numbers behind the tiles, for the overview's gauges and charts. The tiles
    keep every line of detail; this is only what the dashboard draws. Pure, like the rest."""
    p, c = p or {}, c or {}
    out = {'pi_ok': bool(p.get('ok'))}
    hw, wifi, ts = p.get('hardware') or {}, p.get('wifi') or {}, p.get('tailscale') or {}
    if p.get('ok'):
        tl, ttexts = throttle(hw.get('throttled'))
        out['pi'] = {'host': p.get('host'), 'uptime_s': hw.get('uptime_s'), 'boot_at': hw.get('boot_at'),
                     'tailscale': ts.get('state'), 'synced': p.get('time_synced'), 'probe_ms': p.get('ms'),
                     'mode': p.get('mode')}
        out['hw'] = {'temp_c': hw.get('temp_c'), 'throttled': hw.get('throttled'), 'throttle_level': tl,
                     'throttle': ttexts, 'load': hw.get('load'),
                     'disk_used': 1 - hw['disk_free'] / hw['disk_total'] if hw.get('disk_total') else None,
                     'disk_free': hw.get('disk_free'), 'disk_total': hw.get('disk_total'),
                     'mem_used': 1 - hw['mem_available'] / hw['mem_total'] if hw.get('mem_total') else None,
                     'mem_available': hw.get('mem_available'), 'mem_total': hw.get('mem_total')}
        out['wifi'] = {k: wifi.get(k) for k in ('ssid', 'signal', 'ip', 'freq', 'connection', 'rescue_up')}
        s = p.get('listener') or {}
        out['listener'] = {k: s.get(k) for k in (
            'state', 'leds', 'idle_pattern', 'last_cast_name', 'last_cast_at', 'casts_shown', 'casts_ignored_night',
            'idle_fps', 'idle_frame_ms', 'error_count', 'last_error', 'connected_since', 'file_age_s', 'mode')}
        out['listener']['casts_24h'] = p.get('casts_24h')
        out['casts_recent'] = p.get('casts_recent') or []
        e = p.get('errors') or {}
        now, before = e.get('last24h') or {}, e.get('before') or {}
        out['errors'] = {'total': sum(now.values()), 'before': sum(before.values()), 'this_boot': e.get('this_boot'),
                         'sources': [[k, n, before.get(k, 0)] for k, n in sorted(now.items(), key=lambda kv: -kv[1])[:6]]}
        h = p.get('health') or {}
        acts = h.get('actions') or []
        day = [a for a in acts if _iso_ts(a.get('at')) >= time.time() - 86400]
        counts = {}
        for a in day:
            counts[a['action']] = counts.get(a['action'], 0) + 1
        out['health'] = {'day': len(day), 'week': len(acts), 'counts': counts, 'watchdog': h.get('watchdog_24h') or 0,
                         'restarts': int(((p.get('services') or {}).get('pb-listener') or {}).get('NRestarts') or 0),
                         'recent': acts[-3:]}
        out['services'] = {u: {'state': s.get('ActiveState'), 'sub': s.get('SubState'), 'restarts': s.get('NRestarts'),
                               'since': s.get('ActiveEnterTimestamp')} for u, s in (p.get('services') or {}).items()}
        out['timers'] = {t: {'state': s.get('ActiveState'), 'last': s.get('LastTriggerUSec'),
                             'next': s.get('NextElapseUSecRealtime'), 'result': s.get('service_result')}
                         for t, s in (p.get('timers') or {}).items()}
    live, sb, rt = c.get('live') or {}, c.get('supabase') or {}, c.get('realtime') or {}
    out['site'] = {'status': live.get('status'), 'ms': live.get('ms'), 'cache': live.get('cache'), 'repo': c.get('repo_cache')}
    out['supabase'] = {'status': sb.get('status'), 'ms': sb.get('ms'), 'rt_ok': rt.get('ok'), 'rt_ms': rt.get('ms'),
                       'rt_at': rt.get('at')}
    return out
