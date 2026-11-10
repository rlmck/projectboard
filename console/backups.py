"""Backups (phase 12; weekly and automatic since 10 Nov 2026).

Two parts, both into backups/<date>/ at the repo root (gitignored):
  - the Pi's settings: pb-console-helper backup, a tar.gz with every secret stripped on the Pi;
  - the public Supabase tables (problems, circuits, board_config, challenges) as JSON.

Weekly: the laptop's scheduled task (console/autodeploy.py, every 10 minutes) calls
run_if_due() after its deploy check, so nothing else needs installing; PB Console starts
one too if it's due while the console is open. Due = no good backup for 7 days, and no
try in the last hour (a Pi that's offline is retried hourly, not every 10 minutes).
The state is console/data/backups.json; PB Console's Home shows a warning only when the
last try failed or the newest good backup is more than 8 days old (tiles.backup_tile).
The button in Advanced -> Backups runs the same thing by hand.
"""
import datetime
import json
import os
import subprocess
import time

import procs
import reports
from remote import Remote, helper_cmd

STATE = os.path.join(reports.DATA, 'backups.json')
EVERY_DAYS = 7
STALE_DAYS = 8
RETRY_S = 3600


def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def load_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(s, f, indent=1)
    os.replace(STATE + '.tmp', STATE)


def _ts(iso):
    try:
        return datetime.datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return None


def last_good(state=None):
    """The newest good backup's time (Unix), from the state or, before the state existed,
    from the newest folder in backups/ that holds a Pi backup."""
    state = load_state() if state is None else state
    t = _ts(state.get('ok_at'))
    if t:
        return t
    newest = None
    for b in reports.backups_list():
        if os.path.basename(b['path']).startswith('pi-'):
            try:
                st = os.path.getmtime(os.path.join(reports.REPO, b['path']))
            except OSError:
                continue
            newest = max(newest or 0, st)
    return newest


def due(state=None, now=None):
    state = load_state() if state is None else state
    now = now or time.time()
    good = last_good(state)
    tried = _ts(state.get('tried_at'))
    if good and now - good < EVERY_DAYS * 86400:
        return False
    return not tried or now - tried >= RETRY_S


def backup_pi(remote, out):
    dest = os.path.join(reports.backup_dir(), 'pi-%s.tar.gz' % time.strftime('%H%M%S'))
    p = subprocess.run(remote.argv(helper_cmd('backup')), capture_output=True, timeout=120,
                       creationflags=procs.NO_WINDOW)
    if p.returncode != 0 or p.stdout[:2] != b'\x1f\x8b':
        why = p.stderr.decode('utf-8', 'replace').strip()[-300:] or 'exit %s' % p.returncode
        out('Pi backup failed: %s' % why)
        return 'the Pi: %s' % why.splitlines()[-1][:160] if why else 'the Pi'
    with open(dest, 'wb') as f:
        f.write(p.stdout)
    out('%s (%d KB): config.env and its backups, the units, drop-ins, scripts and NetworkManager profiles '
        '(secrets removed on the Pi)' % (os.path.relpath(dest, reports.REPO), len(p.stdout) // 1024))
    return None


def backup_supabase(env, out):
    import supabase_api as supa
    try:
        tables = supa.export(env)
    except Exception as e:
        out('Supabase export failed: %s: %s' % (type(e).__name__, e))
        return 'Supabase: %s' % type(e).__name__
    d = os.path.join(reports.backup_dir(), 'supabase-%s' % time.strftime('%H%M%S'))
    os.makedirs(d, exist_ok=True)
    for table, rows in tables.items():
        with open(os.path.join(d, table + '.json'), 'w', encoding='utf-8') as f:
            json.dump(rows, f, indent=1)
        out('%s: %d rows' % (table, len(rows)))
    out('saved in %s' % os.path.relpath(d, reports.REPO))
    return None


def run(remote=None, env=None, out=print, how='by hand', parts=('pi', 'supabase')):
    """Back up and record the result. Returns an exit code (0: every part worked)."""
    remote = remote or Remote()
    state = load_state()
    state['tried_at'] = now_iso()
    save_state(state)                 # first, so a second runner (the console, the task) sees it and waits
    errors = []
    if 'pi' in parts:
        e = backup_pi(remote, out)
        if e:
            errors.append(e)
    if 'supabase' in parts:
        e = backup_supabase(env, out)
        if e:
            errors.append(e)
    full = set(parts) == {'pi', 'supabase'}
    if errors:
        state.update(result='failed', error='; '.join(errors), how=how)
    elif full:
        state.update(result='ok', error=None, ok_at=state['tried_at'], how=how)
    save_state(state)
    return 1 if errors else 0


def run_if_due(remote=None, env=None, say=print):
    """The weekly backup, when it's due (autodeploy.py's scheduled task, and PB Console)."""
    if not due():
        return None
    lines = []
    code = run(remote, env, out=lines.append, how='automatic')
    say('backup: %s' % ('ok' if code == 0 else 'failed: %s' % load_state().get('error')))
    return code


def summary(state=None, now=None):
    """What PB Console shows: {ok_at, tried_at, result, error, next_at, age_days}."""
    state = load_state() if state is None else state
    now = now or time.time()
    good = last_good(state)
    return {'ok_at': good, 'tried_at': _ts(state.get('tried_at')), 'result': state.get('result'),
            'error': state.get('error'), 'how': state.get('how'),
            'next_at': good + EVERY_DAYS * 86400 if good else None,
            'age_days': round((now - good) / 86400, 1) if good else None}
