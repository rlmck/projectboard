"""Git and the build from the console: the CACHE stamp a commit gets (`bash build.sh --stamp
<ref>`, for Home's live-site check) and the deploy gate (`bash build.sh --check`, the same one
Cloudflare runs), so neither is written twice; git() and out() for Holds' Ship the snapshot
(actions.py), the console's only push. Ship, Staging and Rollback left the console on 10 Nov
2026: Claude Code ships (CLAUDE.md working rule 2).
"""
import subprocess

import procs
from procs import NO_WINDOW, REPO

_stamps = {}                # commit sha -> stamp (a commit's stamp never changes)


def git(*args, timeout=30):
    p = subprocess.run(['git', *args], cwd=REPO, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')


def out(*args):
    return git(*args)[1].strip()


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


def build_check():
    """(exit code, output) of `bash build.sh --check`: the deploy gate."""
    p = subprocess.run([procs.find_bash(), 'build.sh', '--check'], cwd=REPO, capture_output=True, timeout=120,
                       creationflags=NO_WINDOW)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')
