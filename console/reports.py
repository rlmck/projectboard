"""Read-only views built from probe output and local files: activity (phase 10),
the R8 acceptance checklist and last night's check (phase 11), the LED mapping
results history (phase 8), the backups list (phase 12) and the runbook (phase 15).
Local state lives in console/data/ and backups/ (both gitignored).
"""
import collections
import datetime
import json
import os
import re

from procs import HERE, REPO

DATA = os.path.join(HERE, 'data')
BACKUPS = os.path.join(REPO, 'backups')


def data_path(*parts):
    p = os.path.join(DATA, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def load_json(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


# -- activity ------------------------------------------------------------------------

RECENT_CASTS = 100          # the latest casts listed on the Activity tab


def activity(raw):
    """The latest casts (when, which climb, from the wall, a phone or the console, member or
    guest), casts per day and per hour, mirrored share, ignored at night, top problems.
    raw: the probe's {'casts': [[iso, name, mirror, shown, source, who]], ...}. No user data:
    a cast says only whether someone was signed in, never who."""
    per_day, per_hour, names = collections.Counter(), collections.Counter(), collections.Counter()
    sources, whos = collections.Counter(), collections.Counter()
    mirrored = ignored = 0
    recent = []
    for row in raw.get('casts') or []:
        at, name, mirror, shown = row[:4]
        source, who = (list(row[4:6]) + [None, None])[:2]
        if name.startswith('~cast-test'):
            continue
        try:
            t = datetime.datetime.fromisoformat(at).astimezone()
        except ValueError:
            continue
        recent.append({'at': t.isoformat(timespec='seconds'), 'name': name, 'mirror': bool(mirror),
                       'shown': bool(shown), 'source': source, 'who': who})
        if not shown:
            ignored += 1
            continue
        per_day[t.strftime('%Y-%m-%d')] += 1
        per_hour[t.hour] += 1
        names[name] += 1
        mirrored += bool(mirror)
        sources[source or 'unknown'] += 1
        whos[who or 'unknown'] += 1
    total = sum(per_day.values())
    recent.sort(key=lambda r: r['at'], reverse=True)
    days = []
    if per_day or raw.get('days'):
        end = datetime.date.today()
        for i in range(int(raw.get('days') or 14) - 1, -1, -1):
            d = (end - datetime.timedelta(days=i)).isoformat()
            days.append([d, per_day.get(d, 0)])
    return {'total': total, 'per_day': days, 'per_hour': [[h, per_hour.get(h, 0)] for h in range(24)],
            'mirrored': mirrored, 'ignored_night': ignored, 'top': names.most_common(10),
            'recent': recent[:RECENT_CASTS], 'last': recent[0] if recent else None,
            'sources': dict(sources), 'who': dict(whos), 'journal_from': raw.get('journal_from')}


# -- acceptance tests (plan R8) ---------------------------------------------------------

# id: (title, what to expect, [(button label, helper test args)])
R8 = [
    ('kill', 'Kill the listener', 'Back in about 5 s, strip cleared, rejoined; restarts since boot +1 (Overview).',
     [('Kill -9 pb-listener', ['kill-listener'])]),
    ('freeze', 'Freeze it', 'Within 30 s systemd logs a watchdog timeout, kills and restarts it (Logs: pb-listener).',
     [('SIGSTOP pb-listener', ['freeze-listener'])]),
    ('wifi', 'Drop the Wi-Fi', 'SSH drops in 5 s; within about 2 min pb-health logs "connection up" and the Pi is back; '
     'the listener rejoins without a restart. A safety net brings the connection up after 4 min anyway.',
     [('Wi-Fi down in 5 s', ['wifi-drop'])]),
    ('supabase', 'Block Supabase', 'Dead socket within 60 s, backoff to 60 s, no network action; after 5 min pb-health '
     'restarts the listener (and each 5 min); no reboot. Unblocked by itself after 12 min; then rejoined within a '
     'minute and a cast works.', [('Block Supabase (12 min)', ['block-supabase']), ('Unblock now', ['unblock-supabase'])]),
    ('reboot', 'Reboot mid-cast', 'Cast a problem (Test cast tab), then reboot (Services). Strip dark from '
     'leds-off-at-boot until the next cast; a "pb-boot … came up OK" line; the next cast lights.', []),
    ('clock', 'Clock across 23:00 and 08:00', 'At 23:00: strip cleared, kiosk stopped, screen off; a cast is logged as '
     'ignored. At 08:00: screen on, kiosk back, a cast lights. Then NTP back on. (If turning NTP off removes the synced '
     'flag, the fake clock reads as day: then use Force night / Force day instead.)',
     [('Clock to 22:59:30', ['clock', '22:59:30']), ('Clock to 07:59:30', ['clock', '07:59:30']),
      ('NTP back on', ['clock-ntp'])]),
    ('nonet', 'Boot with no network', 'On site only (Wi-Fi off at the access point, then reboot): listener up and '
     'backing off, day mode (unsynced), pb-health trying, a guarded reboot at 10 min. Record the result here.', []),
    ('weekly', 'Weekly reboot skip', 'With uptime under 1 h it logs a skip; pb-status shows every action from the tests.',
     [('Start pb-weekly-reboot', ['weekly-reboot'])]),
]
R8_TESTS = {tuple(args) for _, _, _, steps in R8 for _, args in steps}


def acceptance():
    notes = load_json(data_path('acceptance.json'), {})
    return [{'id': i, 'title': t, 'expect': e, 'steps': [{'label': l, 'args': a} for l, a in steps],
             'result': (notes.get(i) or {}).get('result'), 'note': (notes.get(i) or {}).get('note', ''),
             'at': (notes.get(i) or {}).get('at')} for i, t, e, steps in R8]


def save_note(test_id, result, note):
    if test_id not in {i for i, *_ in R8}:
        raise ValueError('no test %r' % test_id)
    if result not in (None, 'pass', 'fail'):
        raise ValueError('result: pass, fail or none')
    path = data_path('acceptance.json')
    notes = load_json(path, {})
    notes[test_id] = {'result': result, 'note': str(note or '')[:2000],
                      'at': datetime.datetime.now().isoformat(timespec='seconds')}
    save_json(path, notes)


NIGHT_CHECKS = [
    ('at_start', 'listener switched to night', r'mode day -> night'),
    ('at_start', 'LEDs faded out', r'LEDs: night'),
    ('at_start', 'pb-mode: night', r'pb-mode\[\d+\]: mode night'),
    ('at_start', 'kiosk stopped', r'stopping kiosk|Stopped kiosk'),
    ('at_start', 'screen off', r'screen off'),
    ('at_end', 'listener switched to day', r'mode night -> day'),
    ('at_end', 'LEDs back to idle', r'LEDs: .*night over'),
    ('at_end', 'pb-mode: day', r'pb-mode\[\d+\]: mode day'),
    ('at_end', 'screen on', r'screen on'),
    ('at_end', 'kiosk started', r'starting kiosk'),
]


def night_report(raw):
    out = []
    for part, label, rx in NIGHT_CHECKS:
        hit = next((l for l in raw.get(part) or [] if re.search(rx, l)), None)
        out.append({'check': label, 'ok': bool(hit), 'at': hit[11:19] if hit else None})
    return {'start': raw.get('start'), 'end': raw.get('end'), 'checks': out,
            'ignored_casts': len(raw.get('ignored') or []), 'lines_start': raw.get('at_start'),
            'lines_end': raw.get('at_end')}


# -- LED mapping results ------------------------------------------------------------------

def ledmap_save(obj):
    if not isinstance(obj, dict):
        raise ValueError('a JSON object from the mapping page (Export JSON)')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    save_json(data_path('ledmap', '%s.json' % stamp), obj)
    return stamp


def _ledmap_counts(obj):
    holds = obj.get('holds')
    rows = holds.values() if isinstance(holds, dict) else holds if isinstance(holds, list) else []
    c = collections.Counter()
    for r in rows:
        st = (r.get('status') or r.get('result') or 'unchecked') if isinstance(r, dict) else 'unchecked'
        c[str(st).lower()] += 1
    return dict(c)


def ledmap_history():
    d = os.path.join(DATA, 'ledmap')
    out = []
    for n in sorted(os.listdir(d), reverse=True) if os.path.isdir(d) else []:
        if n.endswith('.json'):
            obj = load_json(os.path.join(d, n), {})
            out.append({'name': n, 'counts': _ledmap_counts(obj), 'keys': sorted(obj)[:12]})
    return out


# -- backups --------------------------------------------------------------------------------

def backups_list():
    out = []
    if not os.path.isdir(BACKUPS):
        return out
    for day in sorted(os.listdir(BACKUPS), reverse=True):
        p = os.path.join(BACKUPS, day)
        if not os.path.isdir(p):
            continue
        for n in sorted(os.listdir(p), reverse=True):
            q = os.path.join(p, n)
            size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(q) for f in fs) if os.path.isdir(q) \
                else os.path.getsize(q)
            out.append({'path': 'backups/%s/%s' % (day, n), 'bytes': size})
    return out


def backup_dir():
    d = os.path.join(BACKUPS, datetime.date.today().isoformat())
    os.makedirs(d, exist_ok=True)
    return d


# -- runbook ----------------------------------------------------------------------------------

RUNBOOK_SECTIONS = ('Wi-Fi (28 Oct 2026)', 'Looking at it (Git Bash on the laptop, over Tailscale)', 'Deploying',
                    'LED mapping', 'Tests', 'PB Console', 'A fresh SD card')


def runbook():
    """Sections of pi/README.md, read at each request so they stay in step."""
    try:
        with open(os.path.join(REPO, 'pi', 'README.md'), encoding='utf-8') as f:
            text = f.read()
    except OSError:
        return []
    parts = re.split(r'^## ', text, flags=re.M)
    found = {p.split('\n', 1)[0].strip(): p.split('\n', 1)[1] if '\n' in p else '' for p in parts[1:]}
    return [{'title': t, 'text': found[t].strip()} for t in RUNBOOK_SECTIONS if t in found]
