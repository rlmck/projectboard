"""Things an action can run, all with the same shape as a subprocess.Popen (stdout
lines, poll, wait, kill), so the server streams every kind of action the same way:

    local(argv, stdin=None)    a program on the laptop, in the repo root
    func(fn)                   a Python function run in a thread; fn(out) writes lines with out(text),
                               returns an exit code (or raises: exit 1 with the error)

A closed tab or the action's timeout only *asks* a func to stop (review CON-03, 15 Nov 2026):
out() never raises, so nothing is cut off between two irreversible steps (a commit and its
push, a publish and its record). The function checks out.cancelled() at the points where
stopping is safe and raises Cancelled there (exit 130). Its own return value is the result.
"""
import os
import shutil
import subprocess
import threading
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def find_bash():
    """Git Bash's bash, never WSL's (C:\\Windows\\System32\\bash.exe runs in Linux, without the laptop's ssh key).
    The WindowsApps\\bash.exe launcher is WSL's too: the scheduled autodeploy found it and its
    deploy.sh hung until the 900 s timeout (12 and 14 Nov 2026)."""
    env = os.environ.get('PB_BASH')
    if env:
        return env
    found = shutil.which('bash')
    if found and not any(w in found.lower() for w in ('system32', 'windowsapps')):
        return found
    for p in (r'C:\Program Files\Git\bin\bash.exe', r'C:\Program Files (x86)\Git\bin\bash.exe'):
        if os.path.exists(p):
            return p
    return found or 'bash'


def local(argv, stdin=None, cwd=REPO, env=None):
    p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
                         env=dict(os.environ, **(env or {})))
    if stdin is not None:
        def feed():
            try:
                p.stdin.write(stdin if isinstance(stdin, bytes) else stdin.encode('utf-8'))
                p.stdin.close()
            except OSError:
                pass
        threading.Thread(target=feed, daemon=True).start()
    return p


class Cancelled(Exception):
    """Raised by a func at a safe point once out.cancelled() says the tab went away (exit 130).
    An Exception, not a BaseException, so `except Exception: rollback` still rolls back."""


class FuncProc:
    """A Python function behind a Popen-like face."""

    def __init__(self, fn):
        r, w = os.pipe()
        self.stdout = os.fdopen(r, 'rb')
        self._w = os.fdopen(w, 'wb')
        self.returncode = None
        self.cancelled = False

        def out(text):
            self._out(text)
        out.cancelled = lambda: self.cancelled
        self.out = out
        self._t = threading.Thread(target=self._run, args=(fn,), daemon=True)
        self._t.start()

    def _out(self, text):
        """Write a line; never raises (a reader that went away just loses the line)."""
        try:
            self._w.write((text if text.endswith('\n') else text + '\n').encode('utf-8'))
            self._w.flush()
        except (OSError, ValueError):
            self.cancelled = True

    def _run(self, fn):
        code = 1
        try:
            code = fn(self.out)
            code = 0 if code is None else int(code)
        except (Cancelled, KeyboardInterrupt):
            self._out('stopped (the tab closed or the action took too long), at a safe point')
            code = 130
        except Exception as e:
            self._out('error: %s: %s' % (type(e).__name__, e))
            self._out(traceback.format_exc(limit=3))
        finally:
            self.returncode = code
            try:
                self._w.close()
            except OSError:
                pass

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self._t.join(timeout)
        return self.returncode

    def kill(self):
        """Ask the function to stop at its next safe point (it isn't interrupted)."""
        self.cancelled = True


def func(fn):
    return FuncProc(fn)


def check_cancelled(out):
    """At a safe point: raise Cancelled if the tab went away. out may be a plain callable (tests, print)."""
    c = getattr(out, 'cancelled', None)
    if c and c():
        raise Cancelled()
