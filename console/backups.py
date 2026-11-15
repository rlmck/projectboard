"""Backups (phase 12; weekly and automatic since 10 Nov 2026; a real database dump since 15 Nov 2026).

Two parts, both into backups/<date>/ at the repo root (gitignored, refused by the pre-commit
hook, local to this laptop only: never committed or uploaded, not encrypted; Ross, 15 Nov 2026):
  - the Pi's settings: pb-console-helper backup, a tar.gz with every secret stripped on the Pi;
  - the database (review CON-04): every table in the public schema (problems, circuits, holds,
    board_config, board_versions, challenges, and the members' data: profiles, ticks, likes
    (favourites), circuit_logs, challenge_attempts, cast_log, wall_keys (hashes only), ...),
    found from the catalogue at the time, so a new table is included without a change here.
    Read over db/.env (castlog.py's connection, TLS verified) in ONE `repeatable read, read
    only` transaction, so every table is from the same moment and nothing can be written.
    Each table is one JSON file (an array of rows, each row as Postgres' to_jsonb gives it),
    checked against count(*) in the same transaction and read back from disk, so a truncated
    read or write fails the backup instead of passing. manifest.json lists every table with its
    row count and columns. Written as db-HHMMSS.partial/ and renamed only when complete.
    The newest KEEP_DUMPS dumps are kept; older ones are deleted after a good dump.
    Not in it: Supabase Auth (auth.users: the sign-ins themselves) and Storage (the board
    images); restoring by hand: console/README.md -> Backups.

Weekly: the laptop's scheduled task (console/autodeploy.py, every 10 minutes) calls
run_if_due() after its deploy check, so nothing else needs installing; PB Console starts
one too if it's due while the console is open. Due = no good backup for 7 days, and no
try in the last hour (a Pi that's offline is retried hourly, not every 10 minutes).
The state is console/data/backups.json; PB Console's Home shows a warning only when the
last try failed or the newest good backup is more than 8 days old (tiles.backup_tile).
The button in Advanced -> Backups runs the same thing by hand.

Never print or return a row: the output and the state carry table names and counts only.
"""
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import time

import procs
import reports
from remote import Remote, helper_cmd

STATE = os.path.join(reports.DATA, 'backups.json')
EVERY_DAYS = 7
STALE_DAYS = 8
RETRY_S = 3600
KEEP_DUMPS = 8                  # the newest 8 database dumps (about two months of weekly ones)
TABLE_NAME = re.compile(r'^[a-z_][a-z0-9_]{0,62}$')
COVERS = ("every database table (members' data too: profiles, ticks, favourites, circuit runs, challenge "
          'attempts, the cast log, board versions, ...) and the Pi\'s settings; not the sign-ins (Supabase Auth) '
          'or the board images')


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


# -- the database dump ----------------------------------------------------------------------------

def dump(conn, dest, out):
    """Every public table into dest/<table>.json plus dest/manifest.json, from one read-only,
    repeatable-read transaction on conn (a pg8000.native.Connection). Each table's rows are
    checked against count(*) in that transaction and the file read back. Returns the manifest.
    Raises on any mismatch; never prints a row."""
    os.makedirs(dest, exist_ok=True)
    conn.run('begin isolation level repeatable read read only')
    try:
        tables = [r[0] for r in conn.run(
            "select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname")]
        if not tables:
            raise RuntimeError('the database lists no public tables')
        manifest = {'taken_at': now_iso(), 'schema': 'public', 'format': 'one JSON array per table, each row as '
                    "to_jsonb(row); restore by hand: console/README.md -> Backups", 'tables': {}}
        total = 0
        for t in tables:
            if not TABLE_NAME.match(t):
                raise RuntimeError('a table name the dump does not expect: %r' % t)
            cols = conn.run("select column_name, data_type from information_schema.columns "
                            "where table_schema = 'public' and table_name = :t order by ordinal_position", t=t)
            n = int(conn.run('select count(*) from public."%s"' % t)[0][0])
            rows = [r[0] for r in conn.run('select to_jsonb(x) from public."%s" x' % t)]
            if len(rows) != n:
                raise RuntimeError('%s: read %d rows but count(*) says %d' % (t, len(rows), n))
            path = os.path.join(dest, t + '.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(rows, f, ensure_ascii=False, default=str)
            del rows
            with open(path, encoding='utf-8') as f:
                back = len(json.load(f))
            if back != n:
                raise RuntimeError('%s: the file holds %d rows, count(*) says %d' % (t, back, n))
            manifest['tables'][t] = {'rows': n, 'columns': [[c, ty] for c, ty in cols]}
            total += n
            out('%s: %d rows' % (t, n))
        conn.run('commit')
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    manifest['total_rows'] = total
    with open(os.path.join(dest, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1)
    return manifest


def dumps():
    """The complete database dumps, oldest first: [absolute path]."""
    found = glob.glob(os.path.join(reports.BACKUPS, '*', 'db-*'))
    done = [p for p in found if os.path.isdir(p) and not p.endswith('.partial')]
    return sorted(done, key=lambda p: (os.path.basename(os.path.dirname(p)), os.path.basename(p)))


def prune(out, keep=KEEP_DUMPS):
    """Keep the newest `keep` dumps; delete older ones, any half-written one, and emptied date folders."""
    for p in glob.glob(os.path.join(reports.BACKUPS, '*', 'db-*.partial')):
        shutil.rmtree(p, ignore_errors=True)
    old = dumps()[:-keep] if keep > 0 else dumps()
    for p in old:
        shutil.rmtree(p, ignore_errors=True)
        out('deleted an older dump: %s' % os.path.relpath(p, reports.REPO).replace('\\', '/'))
    for day in glob.glob(os.path.join(reports.BACKUPS, '*')):
        try:
            if os.path.isdir(day) and not os.listdir(day):
                os.rmdir(day)
        except OSError:
            pass
    return len(old)


def backup_db(out, connect=None):
    """The database dump (see the module's docstring). Returns None, or an error for the state.
    connect(): a pg8000 connection (tests pass a fake); by default db/.env's, through castlog."""
    import castlog
    if connect is None:
        url = castlog._db_url()
        if not url:
            out('Database dump failed: no db/.env on this laptop')
            return 'the database: no db/.env on this laptop'
        connect = lambda: castlog._connect(url)     # noqa: E731
    final = os.path.join(reports.backup_dir(), 'db-%s' % time.strftime('%H%M%S'))
    work = final + '.partial'
    try:
        conn = connect()
        try:
            m = dump(conn, work, out)
        finally:
            conn.close()
        if os.path.exists(final):
            raise RuntimeError('%s already exists' % os.path.basename(final))
        os.replace(work, final)
    except Exception as e:               # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        why = str(e) if isinstance(e, RuntimeError) else type(e).__name__
        out('Database dump failed: %s' % why)
        return 'the database: %s' % why[:160]
    rel = os.path.relpath(final, reports.REPO).replace('\\', '/')
    out('%s: %d tables, %d rows, each checked against count(*); local to this laptop (gitignored)'
        % (rel, len(m['tables']), m['total_rows']))
    prune(out)
    state = load_state()
    state['db'] = {'path': rel, 'tables': len(m['tables']), 'rows': m['total_rows'], 'at': m['taken_at']}
    save_state(state)
    return None


def run(remote=None, env=None, out=print, how='by hand', parts=('pi', 'db')):
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
    if 'db' in parts:
        e = backup_db(out)
        if e:
            errors.append(e)
    state = load_state()              # backup_db() recorded its dump
    state['tried_at'] = state.get('tried_at') or now_iso()
    full = {'pi', 'db'} <= set(parts)
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
    """What PB Console shows: {ok_at, tried_at, result, error, next_at, age_days, db, covers}."""
    state = load_state() if state is None else state
    now = now or time.time()
    good = last_good(state)
    return {'ok_at': good, 'tried_at': _ts(state.get('tried_at')), 'result': state.get('result'),
            'error': state.get('error'), 'how': state.get('how'), 'db': state.get('db'), 'covers': COVERS,
            'keep': KEEP_DUMPS, 'next_at': good + EVERY_DAYS * 86400 if good else None,
            'age_days': round((now - good) / 86400, 1) if good else None}
