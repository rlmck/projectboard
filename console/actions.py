"""Everything the console can do, as a fixed table. Each action checks its
arguments against lists or patterns here (and pb-console-helper checks them
again on the Pi), says whether it needs a confirm and the busy guard, and says
how it runs: one remote command, one local program, or a Python function. Plus
the audit log and the config.env sync.

The page never sends a command, only an action name and its arguments.
"""
import datetime
import difflib
import importlib.machinery
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import types

import drift
import gitops
import procs
import reports
from remote import helper_cmd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LAPTOP_CONFIG = os.path.join(REPO, 'pi', 'config.env')
AUDIT = os.path.join(HERE, 'audit.log')

UNITS = ('pb-listener', 'kiosk', 'board-cam', 'pb-netwatch', 'pb-health.timer', 'pb-mode.timer')
VERBS = ('start', 'stop', 'restart')
HHMM = re.compile(r'^([01][0-9]|2[0-3]):[0-5][0-9]$')


class Invalid(Exception):
    pass


def pattern_names():
    """[(name, about)] from the repo's pi/listener/patterns (the same list pb-idle has)."""
    sys.path.append(os.path.join(REPO, 'pi', 'listener'))     # last: the console's own modules win
    sys.dont_write_bytecode = True
    try:
        import patterns
        return [(n, patterns.PATTERNS[n].about) for n in patterns.NAMES]
    except Exception:
        return [(n, '') for n in ('glisten', 'chase', 'lava', 'breathe', 'aurora', 'rain', 'ripples',
                                  'fireflies', 'teaser', 'wave')]


PATTERNS = [n for n, _ in pattern_names()]
IDLE_CMDS = PATTERNS + ['cycle', 'tour', 'default', 'now', 'off']

_helper = None


def helper():
    """pi/ops/pb-console-helper as a module: its config key checks are the console's too."""
    global _helper
    if _helper is None:
        if 'syslog' not in sys.modules:
            try:
                import syslog  # noqa: F401
            except ImportError:             # Windows: the helper only logs on the Pi
                sys.modules['syslog'] = types.SimpleNamespace(openlog=lambda *a: None, syslog=lambda *a: None,
                                                              LOG_NOTICE=5)
        path = os.path.join(REPO, 'pi', 'ops', 'pb-console-helper')
        loader = importlib.machinery.SourceFileLoader('pb_console_helper', path)
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader('pb_console_helper', loader))
        loader.exec_module(mod)
        _helper = mod
    return _helper


def config_keys():
    """For the Config form: [{key, group, help, restart, choices?, range?}] in config.env.example's order."""
    h = helper()
    out = []
    for k, (check, group, what) in h.KEYS.items():
        row = {'key': k, 'group': group, 'help': what, 'restart': h.needs_restart(k)}
        if getattr(check, 'choices', None):
            row['choices'] = list(check.choices)
        if getattr(check, 'range', None):
            row['range'] = list(check.range)
        out.append(row)
    return out


class Action:
    """name: the audit name. describe: what the confirm says. start(app) returns a running
    process (procs.local, procs.func or Remote.start). shown: the command shown in the
    output. confirm: needs the page's confirm. busy: the 5-minute cast check first.
    config: 'keep' (refused when the two config.env copies differ; the laptop's follows
    the Pi's after) or 'sync' (the laptop's follows the Pi's after). preview: extra
    things for the confirm dialog (a diff, a log)."""

    def __init__(self, name, describe, start, shown='', confirm=False, busy=False, config=None, timeout=180,
                 preview=None):
        self.name, self.describe, self.start, self.shown = name, describe, start, shown
        self.confirm, self.busy, self.config, self.timeout = confirm, busy, config, timeout
        self.preview = preview or {}


def remote_action(name, cmd, describe, stdin=None, **kw):
    return Action(name, describe, lambda app: app.remote.start(cmd, stdin=stdin), shown=cmd, **kw)


def local_action(name, argv, describe, stdin=None, shown=None, **kw):
    return Action(name, describe, lambda app: procs.local(argv, stdin=stdin), shown=shown or ' '.join(argv), **kw)


def func_action(name, fn, describe, shown='', **kw):
    """fn(app, out) -> exit code."""
    return Action(name, describe, lambda app: procs.func(lambda out: fn(app, out)), shown=shown or name, **kw)


def _git_files(files):
    """Only paths git status lists now (the page shows them; nothing else gets staged)."""
    listed = {f['path'] for f in gitops.status()['files']}
    if not isinstance(files, list) or not files or not all(isinstance(f, str) and f in listed for f in files):
        raise Invalid('files: choose from the changed files git status lists')
    return files


STAGING_URL = 'https://dev-projectboard.rosslewismckechnie.workers.dev'


def _fetch_ok(out):
    code, o, e = gitops.git('fetch', 'origin', timeout=120)
    out('$ git fetch origin\n%s%s' % (o, e))
    return code == 0


def _gate(out):
    """The deploy gate: build.sh --check, as Cloudflare runs it."""
    code, text = gitops.build_check()
    out('$ bash build.sh --check\n' + text)
    if code:
        out('Stopped: build.sh --check failed, nothing pushed.')
    return code == 0


def _commit(files, msg, out):
    """Stage exactly these files and commit them (the pre-commit secret scan runs). Exit code."""
    code, o, e = gitops.git('add', '--', *files)
    out(o + e)
    if code:
        return code
    p = subprocess.run(['git', 'commit', '-F', '-', '--', *files], cwd=REPO, input=msg.encode(),
                       capture_output=True, creationflags=procs.NO_WINDOW)
    out(p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace'))
    return p.returncode


def _push(argv, out):
    p = subprocess.run(argv, cwd=REPO, capture_output=True, timeout=180, creationflags=procs.NO_WINDOW)
    out('$ %s\n%s' % (' '.join(argv), (p.stdout + p.stderr).decode('utf-8', 'replace')))
    return p.returncode


def build(kind, args):
    """An Action from the page's {action, args}, or Invalid."""
    args = args if isinstance(args, dict) else {}
    # -- services and the board (phases 2-3) --------------------------------------------
    if kind == 'service':
        unit, verb = args.get('unit'), args.get('verb')
        if unit not in UNITS or verb not in VERBS:
            raise Invalid('service: unit one of %s, verb one of %s' % (', '.join(UNITS), ', '.join(VERBS)))
        what = '%s %s' % (verb.capitalize(), unit)
        if unit == 'pb-listener' and verb != 'start':
            what += ': the board goes dark for a moment' + (' and stays off until you start it' if verb == 'stop' else '')
        if unit == 'kiosk' and verb == 'restart':
            what += ': the wall screen reloads the latest app'
        return remote_action('service %s %s' % (verb, unit), helper_cmd('unit', verb, unit), what,
                             confirm=True, busy=verb in ('stop', 'restart'))
    if kind == 'reboot':
        return remote_action('reboot', helper_cmd('reboot'),
                             'Reboot the Pi: the board and the wall screen are off for about 2 minutes',
                             confirm=True, busy=True, timeout=30)
    if kind == 'idle':
        cmd = args.get('cmd')
        if cmd not in IDLE_CMDS:
            raise Invalid('idle: one of %s' % ', '.join(IDLE_CMDS))
        return remote_action('idle %s' % cmd, 'pb-idle %s' % cmd, 'pb-idle %s' % cmd, timeout=30)
    if kind == 'brightness':
        try:
            v = round(float(args.get('value')), 2)
        except (TypeError, ValueError):
            v = -1
        if not 0.05 <= v <= 1:
            raise Invalid('brightness: a value from 0.05 to 1')
        return remote_action('brightness %g' % v, 'pb-idle brightness %g' % v, 'brightness x%g' % v, timeout=30)
    if kind == 'night':
        mode = args.get('mode')
        if mode not in ('auto', 'day', 'night'):
            raise Invalid('night: auto, day or night')
        what = {'auto': 'Night mode by the clock (NIGHT_FORCE empty)',
                'day': 'Force day (NIGHT_FORCE=day): LEDs and screen stay on through the night until set back to auto',
                'night': 'Force night (NIGHT_FORCE=night): LEDs off, casts ignored, screen off, until set back to auto'}[mode]
        return remote_action('night %s' % mode, helper_cmd('night', mode),
                             what + '. Writes config.env on the Pi and pi/config.env here.', confirm=True, config='keep')
    if kind == 'night-hours':
        start, end = args.get('start'), args.get('end')
        if not (isinstance(start, str) and isinstance(end, str) and HHMM.match(start) and HHMM.match(end)) or start == end:
            raise Invalid('night-hours: two different HH:MM times')
        return remote_action('night-hours %s %s' % (start, end), helper_cmd('night-hours', start, end),
                             'Night from %s to %s. Writes config.env on the Pi and pi/config.env here.' % (start, end),
                             confirm=True, config='keep')
    if kind == 'screen':
        state = args.get('state')
        if state not in ('on', 'off'):
            raise Invalid('screen: on or off')
        what = ('Turn the wall screen off (stops the kiosk) until "screen on" or a reboot' if state == 'off'
                else 'Turn the wall screen back on (starts the kiosk; not at night)')
        return remote_action('screen %s' % state, helper_cmd('screen', state), what, confirm=True)

    # -- phase 5: config ----------------------------------------------------------------------
    if kind == 'config-set':
        values = args.get('values')
        if not isinstance(values, dict) or not values:
            raise Invalid('config-set: {values: {KEY: value}}')
        h = helper()
        try:
            for k, v in values.items():
                if not isinstance(v, str):
                    raise h.Refused('%s: a text value' % k)
                h.check_value(k, v)
        except h.Refused as e:
            raise Invalid(str(e))
        restart = sorted(k for k in values if h.needs_restart(k))
        what = 'Set %s in config.env on the Pi (backed up first) and pi/config.env here.' % ', '.join(
            '%s=%s' % (k, values[k]) for k in sorted(values))
        what += (' The listener restarts (the board goes dark for a moment) for %s.' % ', '.join(restart) if restart
                 else ' No restart: these are re-read.')
        return remote_action('config-set %s' % ' '.join(sorted(values)),
                             helper_cmd('config-set', *('%s=%s' % (k, values[k]) for k in sorted(values))),
                             what, confirm=True, busy=bool(restart), config='keep')
    if kind == 'config-restore':
        name = args.get('name')
        if not isinstance(name, str) or not re.match(r'^config\.env\.\d{8}-\d{6}(-\d+)?$', name):
            raise Invalid('config-restore: a backup name')
        return remote_action('config-restore %s' % name, helper_cmd('config-restore', name),
                             'Put back config.env from %s (the current one is backed up first). The listener restarts '
                             'if a key it reads at start changes.' % name, confirm=True, busy=True, config='keep')
    if kind == 'config-push':
        text = laptop_config()
        if text is None:
            raise Invalid('there is no pi/config.env on the laptop')
        h = helper()
        try:
            h.check_text(text)
        except h.Refused as e:
            raise Invalid('pi/config.env: %s' % e)
        return remote_action('config-push', helper_cmd('config-put'),
                             "Make the Pi's config.env the same as the laptop's pi/config.env (the Pi's is backed up "
                             'first). The listener restarts if a key it reads at start changes.',
                             stdin=text, confirm=True, busy=True, config='sync')
    if kind == 'config-pull':
        def pull(app, out):
            p = app.pi(refresh=True)
            if not p.get('ok') or p.get('config_env') is None:
                out("couldn't read the Pi's config.env")
                return 1
            save_laptop_config(p['config_env'])
            out("pi/config.env on the laptop now matches the Pi's")
            return 0
        return func_action('config-pull', pull, "Make the laptop's pi/config.env the same as the Pi's (only the "
                           'laptop file changes).', confirm=True)

    # -- phase 6: Pi deploy ----------------------------------------------------------------------
    if kind == 'deploy':
        # Since 30 Oct 2026 the Pi lets deploy.sh install without a password
        # (pi/conf/pb-deploy.sudoers), so the password is optional: only a Pi without
        # that rule yet needs one, which goes to sudo -S through stdin.
        pw = args.get('password') or ''
        dry = args.get('dry_run') is True
        if not isinstance(pw, str) or len(pw) > 200 or '\n' in pw or '\r' in pw:
            raise Invalid("deploy: the Pi's password")
        argv = [procs.find_bash(), 'pi/deploy.sh'] + (['--sudo-stdin'] if pw else []) + (['--dry-run'] if dry else [])
        what = ('Dry run: copy pi/ to the Pi and list what would change (nothing installed).' if dry else
                'Deploy pi/ to the Pi: install what changed and restart what needs it. If listener files or '
                "config.env changed, the listener restarts and the board goes dark for a moment. The laptop's "
                'pi/config.env is installed as the Pi\'s.')
        return Action('deploy%s' % (' --dry-run' if dry else ''), what,
                      lambda app: procs.local(argv, stdin=(pw + '\n') if pw else '', env={'PB_HOST': app.remote.host}),
                      shown='bash pi/deploy.sh%s%s' % (' --sudo-stdin' if pw else '', ' --dry-run' if dry else ''),
                      confirm=True, busy=not dry, timeout=600)
    if kind == 'pull-file':
        path = args.get('path')
        target = drift.pull_target(path) if isinstance(path, str) else None
        if not target:
            raise Invalid('pull-file: a Pi-only unit or script the drift check listed')

        def pull_file(app, out):
            code, text, err = app.remote.run('cat %s' % shlex.quote(path))
            if code != 0:
                out('reading %s failed: %s' % (path, err.strip()))
                return 1
            if drift.has_secret(text):
                out('refused: %s has a password-like line; copy it by hand without it' % path)
                return 1
            _write_repo(target, text)
            out('%s -> %s (%d bytes). Add its install line to pi/install.sh before the next deploy.'
                % (path, target, len(text)))
            return 0
        return func_action('pull %s' % path, pull_file, 'Copy %s from the Pi into the repo as %s.' % (path, target),
                           confirm=True)
    if kind == 'pull-nm':
        name = args.get('name')
        if not isinstance(name, str) or not re.match(r'^[A-Za-z0-9 _.:-]{1,64}$', name):
            raise Invalid('pull-nm: a NetworkManager connection name')
        target = drift.nm_target(name)

        def pull_nm(app, out):
            code, text, err = app.remote.run(helper_cmd('nm-export', name))
            if code != 0:
                out('nm-export failed: %s' % (err or text).strip())
                return 1
            if drift.has_secret(text):
                out('refused: a secret line came through; nothing written')
                return 1
            _write_repo(target, text)
            out('%s -> %s, secrets stripped on the Pi and checked again here. Review it before committing.'
                % (name, target))
            return 0
        return func_action('pull-nm %s' % name, pull_nm, 'Copy the NetworkManager profile %r into the repo as %s, '
                           'with every password/psk/secret line removed on the Pi.' % (name, target), confirm=True)

    # -- phase 7: app release (CLAUDE.md working rule 2: Ship = commit + push main) ------------------
    if kind == 'git-pull':
        def pull(app, out):
            for s in (['fetch', 'origin'], ['pull', '--ff-only']):
                code, o, e = gitops.git(*s, timeout=120)
                out('$ git %s\n%s%s' % (' '.join(s), o, e))
                if code:
                    return code
            return 0
        return func_action('git pull', pull, 'Fetch and fast-forward.')
    if kind == 'ship':
        st = gitops.status()
        if st['branch'] != 'main':
            raise Invalid('ship: work on main (on %s)' % st['branch'])
        files = args.get('files') or []
        msg = args.get('message') or ''
        if files:
            files = _git_files(files)
            if not isinstance(msg, str) or not msg.strip() or len(msg) > 5000:
                raise Invalid('ship: a commit message')
        elif not st['unpushed']:
            raise Invalid('ship: nothing to commit and nothing to push')

        def ship(app, out):
            if not _fetch_ok(out):
                return 1
            if gitops.count('HEAD', 'origin/main'):
                out('main on GitHub has commits this copy lacks: Pull first, then Ship.')
                return 1
            if not _gate(out):
                return 1
            if files and _commit(files, msg, out):
                return 1
            return _push(['git', 'push', 'origin', 'HEAD:main'], out)
        what = ('Commit %d file(s) and push main: ' % len(files) if files else 'Push main: ')
        return func_action('ship', ship, what + 'THIS DEPLOYS TO REAL USERS (symmetryboard.co.uk). Runs build.sh '
                           '--check first; Cloudflare runs it again and keeps the last good version if it fails.',
                           shown='bash build.sh --check && git commit && git push origin HEAD:main', confirm=True,
                           timeout=300,
                           preview={'log': '\n'.join(st['unpushed'] + (['(new) ' + msg.strip().splitlines()[0]]
                                                                       if files else [])) or '(nothing)',
                                    'diff': ''.join(gitops.diff(f, limit=60000) for f in files)[:200000]})
    if kind == 'staging':
        st = gitops.status()
        if not st['staging_ff']:
            raise Invalid("staging: dev on GitHub has commits this branch lacks, so pushing would need a force "
                          "push (Ross's call, outside the console)")
        if not st['dev_behind']:
            raise Invalid('staging: dev already has every commit here (commit first: Staging pushes commits only)')
        log = gitops.out('log', 'origin/dev..HEAD', '--format=%h %s')
        dirty = [f['path'] for f in st['files'] if f['xy'] != '??']

        def staging(app, out):
            if not _fetch_ok(out) or not _gate(out):
                return 1
            return _push(['git', 'push', 'origin', 'HEAD:dev'], out)
        return func_action('staging', staging, 'Push %s to dev: staging (%s) rebuilds from it. Live is untouched.'
                           % (st['branch'], STAGING_URL) + (' Uncommitted changes are NOT included.' if dirty else ''),
                           shown='bash build.sh --check && git push origin HEAD:dev', confirm=True, timeout=300,
                           preview={'log': log or '(nothing)'})
    if kind == 'rollback':
        sha = args.get('commit')
        st = gitops.status()
        if not isinstance(sha, str) or sha not in {c['hash'] for c in st['recent_main']}:
            raise Invalid('rollback: choose one of the last %d commits on main' % gitops.RECENT)
        if st['branch'] != 'main':
            raise Invalid('rollback: on main only (on %s)' % st['branch'])
        if [f for f in st['files'] if f['xy'] != '??']:
            raise Invalid('rollback: commit or discard the changes here first')
        if st['ahead_main'] or st['behind_main']:
            raise Invalid('rollback: this copy and main on GitHub differ (pull, or ship, first)')

        def rollback(app, out):
            if not _fetch_ok(out):
                return 1
            if gitops.count('HEAD', 'origin/main') or gitops.count('origin/main', 'HEAD'):
                out('main moved on GitHub: pull, then try again.')
                return 1
            code, o, e = gitops.git('revert', '--no-edit', sha, timeout=60)
            out('$ git revert --no-edit %s\n%s%s' % (sha, o, e))
            if code:
                gitops.git('revert', '--abort')
                out("The revert didn't apply cleanly (a later commit changed the same lines): nothing pushed.")
                return code
            if not _gate(out):
                gitops.git('reset', '--hard', 'HEAD~1')
                out('The reverted tree fails build.sh: the revert commit was dropped, nothing pushed.')
                return 1
            return _push(['git', 'push', 'origin', 'HEAD:main'], out)
        return func_action('rollback %s' % sha, rollback, 'Revert %s on main and push: THIS DEPLOYS TO REAL USERS. '
                           'A new commit undoes it; history is kept.' % sha,
                           shown='git revert --no-edit %s && git push origin HEAD:main' % sha, confirm=True,
                           timeout=300, preview={'diff': gitops.out('show', '--stat', '--format=%h %s%n%ad%n', sha)})
    if kind == 'build-check':
        def check(app, out):
            code, text = gitops.build_check()
            out(text)
            return code
        return func_action('build check', check, 'bash build.sh --check: the syntax check and the three-places '
                           'rule, as Cloudflare runs them.')

    # -- phase 8: LED mapping ------------------------------------------------------------------------
    if kind == 'ledmap':
        state = args.get('state')
        if state not in ('start', 'stop'):
            raise Invalid('ledmap: start or stop')
        what = ('Start the LED mapping tool: the listener pauses (casts don\'t light) until you stop it, or after 30 '
                'minutes without a click.' if state == 'start' else 'Stop the LED mapping tool: the strip clears and '
                'the listener starts again.')
        return remote_action('ledmap %s' % state, helper_cmd('ledmap', state), what, confirm=True,
                             busy=state == 'start', timeout=90)

    # -- phase 9: test cast ---------------------------------------------------------------------------
    if kind == 'test-cast':
        name, mirror = args.get('name'), args.get('mirror') is True
        if not isinstance(name, str) or not 1 <= len(name) <= 60:
            raise Invalid('test-cast: a problem name')

        def cast(app, out):
            import supabase_api as supa
            status, ms, sent, body = supa.cast(name, mirror, app.env)
            out('sent %r%s at %s: HTTP %s in %d ms %s' % (name, ' mirrored' if mirror else '',
                                                       time.strftime('%H:%M:%S', time.localtime(sent)), status, ms,
                                                       '' if status == 202 else body))
            if status != 202:
                return 1
            out('waiting for the listener (up to 15 s)…')
            got = None
            for _ in range(8):
                time.sleep(2)
                code, text, _ = app.remote.run("journalctl -u pb-listener --since @%d --no-pager -q "
                                               "-o json --output-fields=MESSAGE" % int(sent - 1), timeout=20)
                got = _receipt(text, name, sent)
                if got.get('lit') or got.get('ignored') or got.get('unknown'):
                    break
            for k in ('received', 'lit', 'ignored', 'unknown'):
                if got.get(k):
                    out('%-9s %s' % (k, got[k]))
            if not got.get('received'):
                out("no 'cast received' line from the listener: is it running and joined? (night ignores casts)")
                return 1
            return 0
        return func_action('test cast %s%s' % (name, ' mirrored' if mirror else ''), cast,
                           'Cast %r%s to the real board, exactly as the app does. Whoever is climbing sees it.'
                           % (name, ' mirrored' if mirror else ''), confirm=True, busy=True, timeout=60)

    # -- phase 11: acceptance tests --------------------------------------------------------------------
    if kind == 'test-step':
        targs = args.get('args')
        if not isinstance(targs, list) or tuple(targs) not in reports.R8_TESTS:
            raise Invalid('test-step: one of the checklist steps')
        return remote_action('test %s' % ' '.join(targs), helper_cmd('test', *targs),
                             'Acceptance test step: %s. It deliberately breaks something on the Pi and checks it '
                             'heals; the board may go dark or offline for a while.' % ' '.join(targs),
                             confirm=True, busy=True, timeout=60)

    # -- phase 12: backups ---------------------------------------------------------------------------
    if kind == 'backup-pi':
        def backup(app, out):
            dest = os.path.join(reports.backup_dir(), 'pi-%s.tar.gz' % time.strftime('%H%M%S'))
            p = subprocess.run(app.remote.argv(helper_cmd('backup')), capture_output=True, timeout=120,
                               creationflags=procs.NO_WINDOW)
            if p.returncode != 0 or p.stdout[:2] != b'\x1f\x8b':
                out('backup failed: %s' % p.stderr.decode('utf-8', 'replace')[-500:])
                return 1
            with open(dest, 'wb') as f:
                f.write(p.stdout)
            out('%s (%d KB): config.env and its backups, the units, drop-ins, scripts and NetworkManager profiles '
                '(secrets removed on the Pi)' % (os.path.relpath(dest, REPO), len(p.stdout) // 1024))
            return 0
        return func_action('backup pi', backup, 'Back up the Pi\'s settings into backups/ (gitignored).')
    if kind == 'backup-supabase':
        def backup(app, out):
            import supabase_api as supa
            d = os.path.join(reports.backup_dir(), 'supabase-%s' % time.strftime('%H%M%S'))
            os.makedirs(d, exist_ok=True)
            for table, rows in supa.export(app.env).items():
                with open(os.path.join(d, table + '.json'), 'w', encoding='utf-8') as f:
                    json.dump(rows, f, indent=1)
                out('%s: %d rows' % (table, len(rows)))
            out('saved in %s' % os.path.relpath(d, REPO))
            return 0
        return func_action('backup supabase', backup, 'Export the public tables (problems, circuits, board_config, '
                           'challenges) into backups/ (gitignored).')
    raise Invalid('no action called %r' % kind)


def _receipt(json_lines, name, sent):
    """From the listener's journal after a test cast: when it was received, lit (with its ms), or ignored."""
    got = {}
    q = repr(name)
    for line in json_lines.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        msg = str(r.get('MESSAGE') or '')
        at = int(r.get('__REALTIME_TIMESTAMP', 0)) / 1e6
        lag = '%s (%+d ms after sending)' % (time.strftime('%H:%M:%S', time.localtime(at)), round((at - sent) * 1000))
        if msg.startswith('cast received: ' + q) and 'received' not in got:
            got['received'] = lag
        elif msg.startswith('lit ' + q) and 'lit' not in got:
            got['lit'] = '%s; %s' % (lag, msg)
        elif msg.startswith('cast ' + q) and 'ignored' in msg:
            got['ignored'] = '%s; %s' % (lag, msg)
        elif msg.startswith('unknown problem ' + q):
            got['unknown'] = msg
    return got


def _write_repo(rel, text):
    path = os.path.join(REPO, *rel.split('/'))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text.replace('\r\n', '\n'))


# -- config.env: the laptop's copy and the Pi's stay the same -----------------

def laptop_config():
    try:
        with open(LAPTOP_CONFIG, 'rb') as f:
            return f.read().decode('utf-8')
    except OSError:
        return None


def config_drift(pi_text):
    """None if the laptop's pi/config.env matches the Pi's (or doesn't exist), else a diff."""
    mine = laptop_config()
    if mine is None or pi_text is None or mine == pi_text:
        return None
    return ''.join(difflib.unified_diff(mine.splitlines(True), pi_text.splitlines(True),
                                        'pi/config.env (laptop)', '/etc/projectboard/config.env (Pi)'))


def save_laptop_config(pi_text):
    """After the Pi's config.env changed: the laptop's copy follows, LF line endings (deploy.sh refuses CRLF)."""
    with open(LAPTOP_CONFIG + '.tmp', 'wb') as f:
        f.write(pi_text.replace('\r\n', '\n').encode('utf-8'))
    os.replace(LAPTOP_CONFIG + '.tmp', LAPTOP_CONFIG)


def text_diff(a, b, name_a, name_b):
    return ''.join(difflib.unified_diff((a or '').splitlines(True), (b or '').splitlines(True), name_a, name_b))


# -- the audit log -------------------------------------------------------------

_audit_lock = threading.Lock()


def audit(action, result, detail='', ms=None, path=None):
    """One JSON line: time, action, result (ok, failed, refused, cancelled), detail."""
    row = {'time': datetime.datetime.now().isoformat(timespec='seconds'), 'action': action, 'result': result}
    if detail:
        row['detail'] = str(detail)[:500]
    if ms is not None:
        row['ms'] = ms
    with _audit_lock:
        with open(path or AUDIT, 'a', encoding='utf-8') as f:
            f.write(json.dumps(row) + '\n')


def audit_tail(n=50, path=None):
    try:
        with open(path or AUDIT, encoding='utf-8') as f:
            lines = f.readlines()[-n:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out
