"""App release (phase 7): the repo's state, read with the git CLI, and the CACHE
stamp a deploy gets. Read-only here; the writes (ship, staging, rollback) are
actions in actions.py.

Deploys follow CLAUDE.md's working rule 2: work on main; Ship commits and pushes
main (live), Staging pushes HEAD to dev (a fast-forward only), Rollback reverts a
commit on main and pushes. The gate is build.sh itself (`bash build.sh --check`:
the syntax check and the three-places rule), the same one Cloudflare runs, and
the CACHE stamp comes from `bash build.sh --stamp <ref>`, so neither is written twice.
"""
import re
import subprocess

import procs
from procs import NO_WINDOW, REPO

RECENT = 15                 # commits on origin/main offered for a rollback
SHA = re.compile(r'^[0-9a-f]{7,40}$')
_stamps = {}                # commit sha -> stamp (a commit's stamp never changes)


def git(*args, timeout=30):
    p = subprocess.run(['git', *args], cwd=REPO, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


def out(*args):
    return git(*args)[1].strip()


def cache_of(text):
    m = re.search(r"const CACHE\s*=\s*'([^']+)'", text or '')
    return m.group(1) if m else None


def stamp(ref):
    """The CACHE a build of ref gets (build.sh --stamp), or None."""
    sha = out('rev-parse', '--verify', '-q', ref + '^{commit}')
    if not sha:
        return None
    if sha not in _stamps:
        p = subprocess.run([procs.find_bash(), 'build.sh', '--stamp', sha], cwd=REPO, capture_output=True,
                           timeout=60, creationflags=NO_WINDOW)
        s = p.stdout.decode('utf-8', 'replace').strip()
        if p.returncode or not s.startswith('pb-'):
            return None
        _stamps[sha] = s
    return _stamps[sha]


def count(a, b):
    code, text, _ = git('rev-list', '--count', '%s..%s' % (a, b))
    return int(text.strip()) if code == 0 and text.strip().isdigit() else None


def is_ancestor(a, b):
    return git('merge-base', '--is-ancestor', a, b)[0] == 0


def recent_main():
    """[{hash, date, subject}] of origin/main's last RECENT commits: what Rollback may revert."""
    rows = [l.split('\x1f') for l in out('log', 'origin/main', '-%d' % RECENT, '--no-merges',
                                         '--format=%h\x1f%ad\x1f%s', '--date=format:%d %b %H:%M').splitlines()]
    return [{'hash': h, 'date': d, 'subject': s} for h, d, s in rows]


def status():
    branch = out('rev-parse', '--abbrev-ref', 'HEAD')
    files = []
    for line in git('status', '--porcelain=v1', '-uall')[1].splitlines():
        if len(line) > 3:
            files.append({'xy': line[:2], 'path': line[3:].strip('"')})
    log = [l.split('\x1f') for l in out('log', '-12', '--format=%h\x1f%ad\x1f%s', '--date=format:%d %b %H:%M').splitlines()]
    return {
        'branch': branch, 'files': files, 'head': out('rev-parse', '--short', 'HEAD'),
        'ahead_main': count('origin/main', 'HEAD'), 'behind_main': count('HEAD', 'origin/main'),
        'dev_behind': count('origin/dev', 'HEAD'),
        'staging_ff': is_ancestor('origin/dev', 'HEAD'),
        'log': [{'hash': h, 'date': d, 'subject': s} for h, d, s in log],
        'unpushed': out('log', 'origin/main..HEAD', '--format=%h %s').splitlines(),
        'recent_main': recent_main(),
        'checks': {'stamp_main': stamp('origin/main'), 'stamp_head': stamp('HEAD')},
    }


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


def build_check():
    """(exit code, output) of `bash build.sh --check`: the deploy gate."""
    p = subprocess.run([procs.find_bash(), 'build.sh', '--check'], cwd=REPO, capture_output=True, timeout=120,
                       creationflags=NO_WINDOW)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')
