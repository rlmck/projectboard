"""App release (phase 7): the repo's state, read with the git CLI, and the checks
CLAUDE.md asks for before a deploy: CACHE bumped when app/ changed, the
three-places rule for a new app/ file, and the scripts' syntax check.
Read-only here; the writes (commit, push, bump) are actions in actions.py.
"""
import os
import re
import shutil
import subprocess

from procs import NO_WINDOW, REPO

SCRIPTS = ['state.js', 'core.js', 'problems.js', 'admin.js', 'account.js', 'authoring.js', 'circuits.js',
           'challenge.js', 'leaderboard.js', 'wall.js', 'app.js']
NOT_DEPLOYED = {'app/sw.js'}          # changes to it alone are the bump itself


def git(*args, timeout=30):
    p = subprocess.run(['git', *args], cwd=REPO, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


def out(*args):
    return git(*args)[1].strip()


def cache_of(text):
    m = re.search(r"const CACHE\s*=\s*'([^']+)'", text or '')
    return m.group(1) if m else None


def file_at(ref, path):
    code, text, _ = git('show', '%s:%s' % (ref, path))
    return text if code == 0 else None


def status():
    branch = out('rev-parse', '--abbrev-ref', 'HEAD')
    files = []
    for line in git('status', '--porcelain=v1', '-uall')[1].splitlines():
        if len(line) > 3:
            files.append({'xy': line[:2], 'path': line[3:].strip('"')})

    def count(a, b):
        code, text, _ = git('rev-list', '--count', '%s..%s' % (a, b))
        return int(text.strip()) if code == 0 and text.strip().isdigit() else None
    log = [l.split('\x1f') for l in out('log', '-12', '--format=%h\x1f%ad\x1f%s', '--date=format:%d %b %H:%M').splitlines()]
    return {
        'branch': branch, 'files': files, 'head': out('rev-parse', '--short', 'HEAD'),
        'ahead_dev': count('origin/dev', 'HEAD'), 'behind_dev': count('HEAD', 'origin/dev'),
        'dev_ahead_main': count('origin/main', 'origin/dev'), 'local_ahead_main': count('origin/main', 'HEAD'),
        'main_ahead_local': count('HEAD', 'origin/main'),
        'log': [{'hash': h, 'date': d, 'subject': s} for h, d, s in log],
        'unpushed': out('log', 'origin/dev..HEAD', '--format=%h %s').splitlines(),
        'to_main': out('log', 'origin/main..origin/dev', '--format=%h %s').splitlines(),
        'checks': checks(),
        'node': bool(shutil.which('node')),
    }


def changed_vs_main():
    """Paths changed between origin/main and the working tree (committed or not)."""
    names = set(out('diff', '--name-only', 'origin/main').splitlines())
    names |= {l[3:].strip('"') for l in git('status', '--porcelain=v1', '-uall')[1].splitlines() if len(l) > 3}
    return sorted(n for n in names if n)


def checks():
    """Warnings before shipping: CACHE, the three-places rule."""
    warn = []
    changed = changed_vs_main()
    app = [p for p in changed if p.startswith('app/') and p not in NOT_DEPLOYED]
    try:
        with open(os.path.join(REPO, 'app', 'sw.js'), encoding='utf-8') as f:
            sw = f.read()
    except OSError:
        sw = ''
    here, live = cache_of(sw), cache_of(file_at('origin/main', 'app/sw.js'))
    if app and here == live:
        warn.append('app/ changed since main (%s) but CACHE is still %s: bump it' % (', '.join(app[:6]), here))
    try:
        with open(os.path.join(REPO, 'build.sh'), encoding='utf-8') as f:
            build = f.read()
        with open(os.path.join(REPO, 'app', 'index.html'), encoding='utf-8') as f:
            index = f.read()
    except OSError:
        build = index = ''
    tracked = set(out('ls-files', 'app').splitlines())
    for p in sorted(set(changed) - tracked):
        if not p.startswith('app/') or '/' in p[4:]:
            continue
        name = p[4:]
        missing = [w for w, ok in (('build.sh', name in build), ('sw.js ASSETS', name in sw),
                                   ('a page', name in index or name.startswith('screenshot-'))) if not ok]
        if missing:
            warn.append('new file %s is not in %s (the three-places rule)' % (p, ', '.join(missing)))
    return {'warnings': warn, 'cache': here, 'cache_main': live, 'app_changed': app}


def diff(path=None, staged=False, limit=400000):
    args = ['diff', '--no-color', '--stat', '--patch']
    if staged:
        args.append('--cached')
    if path:
        args += ['--', path]
    text = git(*args)[1]
    untracked = [l[3:] for l in git('status', '--porcelain=v1', '-uall')[1].splitlines() if l.startswith('??')]
    if untracked and not staged and not path:
        text += '\nNew files (not tracked yet):\n' + '\n'.join('  ' + u for u in untracked) + '\n'
    return text[:limit] + ('\n… (cut)' if len(text) > limit else '')


def bumped(sw_text):
    """sw.js text with CACHE moved on by one (pb-v119 -> pb-v120)."""
    m = re.search(r"(const CACHE\s*=\s*'pb-v)(\d+)(')", sw_text)
    if not m:
        raise ValueError("no const CACHE = 'pb-vN' in app/sw.js")
    return sw_text[:m.start()] + m.group(1) + str(int(m.group(2)) + 1) + m.group(3) + sw_text[m.end():]

