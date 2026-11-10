"""Automatic Pi deploys (10 Nov 2026): keep the board's Pi on exactly what's on main.

A Windows scheduled task runs this every 10 minutes (and at logon); /ship runs it
once straight after a push. Each run:

  1. git fetch origin main (never touches the working tree). The Pi's part of main
     is pi/, app/hold_map.json and app/board-fallback.jpg (what pi/deploy.sh sends),
     plus the laptop's pi/config.env. If that fingerprint is what was last deployed,
     stop: nothing to do (no ssh, no SD-card writes on the Pi).
  2. The busy check (console/probe.py busy, the same one /pi-deploy and PB Console
     use): inside opening hours, wait while anyone has used the board in the last
     15 minutes (casts, circuits, live LEDs while setting, wall-screen touches);
     outside them, go straight away. Busy: stop; the next run tries again.
  3. Refuse if the laptop's pi/config.env and the Pi's differ (a deploy would
     overwrite the Pi's): that needs Ross to pick one (PB Console -> Config).
  4. Export origin/main into a temporary folder (so local edits never reach the
     Pi), add the laptop's pi/config.env, run the pi tests there, check busy again,
     then bash pi/deploy.sh from that folder.

The result goes to console/data/autodeploy.json (PB Console's banner reads it:
only problems that need Ross are shown), each run's line to autodeploy.log, the
last deploy's output to autodeploy-last.txt, and a deploy to the audit log.

    python console/autodeploy.py              one run (what the scheduled task does)
    python console/autodeploy.py --force      deploy even if the fingerprint was deployed (still busy-checked)
    python console/autodeploy.py --status     print the state
    python console/autodeploy.py --install    (re)create the scheduled task; --uninstall removes it
"""
import datetime
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import actions  # noqa: E402
import procs  # noqa: E402
from remote import Remote  # noqa: E402

REPO = os.path.dirname(HERE)
DATA = os.path.join(HERE, 'data')
STATE = os.path.join(DATA, 'autodeploy.json')
LOG = os.path.join(DATA, 'autodeploy.log')
LAST = os.path.join(DATA, 'autodeploy-last.txt')
LOCK = os.path.join(DATA, 'autodeploy.lock')
TASK = r'\ProjectBoard\Pi autodeploy'
EVERY_MIN = 10
PI_PATHS = ('pi', 'app/hold_map.json', 'app/board-fallback.jpg')
STALE_LOCK_S = 45 * 60
LATE_H = 24              # an update still not on the Pi after this long is Ross's problem
FAILS_BEFORE_ALERT = 2
NO_WINDOW = procs.NO_WINDOW


# -- small helpers ----------------------------------------------------------------------------

def now_iso():
    return datetime.datetime.now().isoformat(timespec='seconds')


def load_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(s):
    os.makedirs(DATA, exist_ok=True)
    with open(STATE + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(s, f, indent=1)
    os.replace(STATE + '.tmp', STATE)


def log(line):
    os.makedirs(DATA, exist_ok=True)
    try:
        if os.path.getsize(LOG) > 200_000:
            os.replace(LOG, LOG + '.1')
    except OSError:
        pass
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write('%s %s\n' % (now_iso(), line))


def git(*args, timeout=60):
    p = subprocess.run([shutil.which('git') or 'git', '-C', REPO, *args], capture_output=True,
                       timeout=timeout, creationflags=NO_WINDOW)
    if p.returncode != 0:
        raise RuntimeError('git %s: %s' % (' '.join(args), p.stderr.decode('utf-8', 'replace').strip()[-300:]))
    return p.stdout


def python_exe():
    """python.exe beside pythonw.exe (the scheduled task runs pythonw: no window)."""
    exe = sys.executable
    if os.path.basename(exe).lower() == 'pythonw.exe':
        alt = os.path.join(os.path.dirname(exe), 'python.exe')
        if os.path.exists(alt):
            return alt
    return exe


def fingerprint(ref='origin/main'):
    """(commit, fingerprint): the Pi's part of `ref` plus the laptop's pi/config.env."""
    commit = git('rev-parse', ref).decode().strip()
    h = hashlib.sha256()
    for p in PI_PATHS:
        h.update(git('rev-parse', '%s:%s' % (ref, p)).strip())
    h.update(hashlib.sha256((actions.laptop_config() or '').encode('utf-8')).digest())
    return commit, h.hexdigest()[:16]


def take_lock():
    os.makedirs(DATA, exist_ok=True)
    try:
        if time.time() - os.path.getmtime(LOCK) > STALE_LOCK_S:
            os.remove(LOCK)
    except OSError:
        pass
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return True


def drop_lock():
    try:
        os.remove(LOCK)
    except OSError:
        pass


def hhmm(t):
    return datetime.datetime.fromtimestamp(t).strftime('%H:%M') if t else '?'


def busy_reason(b):
    if b.get('pb_ledmap') == 'active':
        return 'an LED mapping session is running'
    if b.get('running'):
        return 'someone is using the board right now (a circuit, or setting with live LEDs)'
    return 'the board was used at %s (%s); waiting for 15 quiet minutes, until about %s' % (
        hhmm(b.get('last_use_at')), b.get('mode_reason') or 'open', hhmm(b.get('quiet_at')))


# -- what needs Ross (PB Console's banner) ---------------------------------------------------

def problem(kind, **kw):
    """The plain-English line for something only Ross can sort out. tab: where the console sends him."""
    if kind == 'config':
        return {'kind': kind, 'tab': 'config',
                'title': "The board's settings on this laptop and on the Pi don't match.",
                'todo': 'Automatic Pi updates are paused until they do. Open Config, look at the difference, '
                        'and keep the right copy.'}
    if kind == 'tests':
        return {'kind': kind, 'tab': 'deploy',
                'title': "A Pi update on main fails its tests, so it hasn't been put on the Pi.",
                'todo': 'Ask Claude to fix the Pi tests on main (python -m unittest discover -s pi/tests).'}
    if kind == 'password':
        return {'kind': kind, 'tab': 'deploy',
                'title': 'The Pi asked for its password, so the update could not install.',
                'todo': 'In Git Bash at the repo root, run bash pi/deploy.sh once and type the Pi\'s password: '
                        'that puts back the rule that lets updates install on their own.'}
    if kind == 'failed':
        return {'kind': kind, 'tab': 'deploy',
                'title': 'The Pi update failed %d times in a row: %s' % (kw.get('n', 2), kw.get('why') or 'see the log'),
                'todo': 'Ask Claude to look at console/data/autodeploy-last.txt.'}
    if kind == 'late':
        return {'kind': kind, 'tab': 'overview',
                'title': 'The Pi has been out of date since %s.' % kw.get('since', '?'),
                'todo': 'Latest reason: %s. If the Pi is offline, check it is powered and on Tailscale.' % kw.get('why', '?')}
    if kind == 'task':
        return {'kind': kind, 'tab': 'deploy',
                'title': "Automatic Pi updates aren't set up on this laptop.",
                'todo': 'In Git Bash at the repo root, run python console/autodeploy.py --install (or ask Claude).'}
    raise ValueError(kind)


def late_problem(state, now=None):
    """An update that's been waiting more than LATE_H hours, whatever the reason."""
    since = state.get('pending_since')
    if not since:
        return None
    try:
        t = datetime.datetime.fromisoformat(since)
    except ValueError:
        return None
    now = now or datetime.datetime.now()
    if now - t < datetime.timedelta(hours=LATE_H):
        return None
    return problem('late', since=t.strftime('%a %d %b %H:%M'), why=state.get('waiting') or 'unknown')


def attention(state, config_drift, task_ok, now=None):
    """PB Console's list of things that need Ross, most urgent first. config_drift comes from the
    console's own live check (so it's never stale); the rest from the last run's state."""
    out = []
    if config_drift:
        out.append(problem('config'))
    p = state.get('problem')
    if p and p.get('kind') != 'config':
        out.append(p)
    late = late_problem(state, now)
    if late and not (p and p.get('kind') in ('tests', 'password', 'failed')):
        out.append(late)
    if task_ok is False:
        out.append(problem('task'))
    return out


# -- one run ---------------------------------------------------------------------------------

def run(force=False, remote=None, say=print):
    remote = remote or Remote()
    state = load_state()
    state['checked_at'] = now_iso()

    def finish(result, line, prob=None, waiting=None):
        state['result'] = result
        state['problem'] = prob
        state['waiting'] = waiting
        save_state(state)
        log('%s: %s' % (result, line))
        say('%s: %s' % (result, line))
        return result

    try:
        git('fetch', '-q', 'origin', 'main', timeout=120)
    except Exception as e:                                  # offline: the next run tries again
        return finish('waiting', 'git fetch failed (%s)' % e, prob=None, waiting='the laptop could not reach GitHub')
    commit, fp = fingerprint()
    if state.get('fingerprint') != fp:
        state['failures'] = 0                               # a new version: its own count of failed tries
    state['target'], state['fingerprint'] = commit, fp
    if state.get('deployed') == fp and not force:
        state['pending_since'] = None
        state['failures'] = 0
        return finish('up to date', 'the Pi has main %s' % commit[:7])
    if not state.get('pending_since'):
        state['pending_since'] = now_iso()

    b = remote.busy()
    if b is None:
        return finish('waiting', 'the Pi did not answer the busy check', waiting='the Pi is not answering')
    if b.get('busy'):
        why = busy_reason(b)
        return finish('waiting', why, waiting=why)

    cfg = remote.probe('config')
    if not cfg.get('ok'):
        return finish('waiting', "could not read the Pi's config.env", waiting='the Pi is not answering')
    if actions.config_drift(cfg.get('current')):
        return finish('blocked', "pi/config.env differs between the laptop and the Pi", prob=problem('config'),
                      waiting="the laptop's and the Pi's settings differ")

    tmp = tempfile.mkdtemp(prefix='pb-autodeploy-')
    try:
        data = subprocess.run([shutil.which('git') or 'git', '-C', REPO, '-c', 'core.autocrlf=false', 'archive',
                               '--format=tar', commit], capture_output=True, timeout=120,
                              creationflags=NO_WINDOW, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            t.extractall(tmp, filter='data')
        laptop_cfg = actions.laptop_config()
        if laptop_cfg is not None:
            with open(os.path.join(tmp, 'pi', 'config.env'), 'wb') as f:
                f.write(laptop_cfg.replace('\r\n', '\n').encode('utf-8'))

        tests = subprocess.run([python_exe(), '-m', 'unittest', 'discover', '-s', 'pi/tests'], cwd=tmp,
                               capture_output=True, text=True, timeout=600, creationflags=NO_WINDOW,
                               env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
        if tests.returncode != 0:
            with open(LAST, 'w', encoding='utf-8') as f:
                f.write('pi tests failed on %s\n\n%s%s' % (commit, tests.stdout, tests.stderr))
            return finish('blocked', 'the pi tests fail on main %s' % commit[:7], prob=problem('tests'),
                          waiting='the Pi tests fail on main')

        b = remote.busy()                                   # the tests took a while: ask again
        if b is None or b.get('busy'):
            why = 'the Pi did not answer the busy check' if b is None else busy_reason(b)
            return finish('waiting', why, waiting=why)

        say('deploying main %s to the Pi (%s)' % (commit[:7], b.get('mode_reason') or b.get('mode')))
        p = subprocess.run([procs.find_bash(), 'pi/deploy.sh'], cwd=tmp, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=900, creationflags=NO_WINDOW,
                           stdin=subprocess.DEVNULL)
        out = p.stdout + p.stderr
        with open(LAST, 'w', encoding='utf-8') as f:
            f.write('$ bash pi/deploy.sh   (main %s, %s)\n\n%s' % (commit, now_iso(), out))
        if p.returncode == 0:
            state.update(deployed=fp, deployed_commit=commit, deployed_at=now_iso(), pending_since=None, failures=0)
            actions.audit('autodeploy', 'ok', 'main %s' % commit[:7])
            return finish('deployed', 'main %s is on the Pi' % commit[:7])
        state['failures'] = int(state.get('failures') or 0) + 1
        actions.audit('autodeploy', 'failed', 'main %s, exit %s' % (commit[:7], p.returncode))
        last = [l for l in out.strip().splitlines() if l.strip()][-1:] or ['exit %s' % p.returncode]
        if 'password' in out.lower() and 'sudo' in out.lower():
            prob = problem('password')
        elif state['failures'] >= FAILS_BEFORE_ALERT:
            prob = problem('failed', n=state['failures'], why=last[0][:160])
        else:
            prob = None
        return finish('failed', 'deploy.sh exit %s: %s' % (p.returncode, last[0][:200]), prob=prob,
                      waiting='the last try failed: %s' % last[0][:160])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# -- the scheduled task ----------------------------------------------------------------------

def task_command():
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), 'pythonw.exe')
    return (w if os.path.exists(w) else exe), os.path.join(HERE, 'autodeploy.py')


def install_task():
    exe, script = task_command()
    folder, name = TASK.rsplit('\\', 1)
    ps = (
        "$a = New-ScheduledTaskAction -Execute '{exe}' -Argument '\"{script}\"' -WorkingDirectory '{repo}';"
        "$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes {every});"
        "$t2 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;"
        "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable "
        "-MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40);"
        "Register-ScheduledTask -TaskPath '{folder}\\' -TaskName '{name}' -Action $a -Trigger $t1,$t2 -Settings $s "
        "-Description 'Keeps the board Pi on main (ProjectBoard console/autodeploy.py)' -Force | Out-Null"
    ).format(exe=exe, script=script, repo=REPO, every=EVERY_MIN, folder=folder, name=name)
    p = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit('could not create the task: %s' % (p.stderr or p.stdout).strip())
    print('scheduled task %s: every %d min and at logon, runs %s %s' % (TASK, EVERY_MIN, exe, script))


def uninstall_task():
    subprocess.run(['schtasks', '/Delete', '/TN', TASK, '/F'], capture_output=True)
    print('removed %s' % TASK)


def task_installed():
    """True / False, or None when it can't be told (not Windows)."""
    if os.name != 'nt':
        return None
    try:
        p = subprocess.run(['schtasks', '/Query', '/TN', TASK], capture_output=True, timeout=20,
                           creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.returncode == 0


def start_background():
    """Start one run without waiting (PB Console, when the last check is old)."""
    exe, script = task_command()
    subprocess.Popen([exe, script], cwd=REPO, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)


def main(argv):
    if '--install' in argv:
        install_task()
        return 0
    if '--uninstall' in argv:
        uninstall_task()
        return 0
    if '--status' in argv:
        print(json.dumps(load_state(), indent=1))
        return 0
    if not take_lock():
        print('another run is going (%s): not starting a second' % LOCK)
        return 0
    try:
        result = run(force='--force' in argv)
    except Exception as e:
        log('error: %s: %s' % (type(e).__name__, e))
        print('error: %s: %s' % (type(e).__name__, e))
        return 1
    finally:
        drop_lock()
    return 1 if result == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
