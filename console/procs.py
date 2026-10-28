"""Things an action can run, all with the same shape as a subprocess.Popen (stdout
lines, poll, wait, kill), so the server streams every kind of action the same way:

    local(argv, stdin=None)    a program on the laptop, in the repo root
    func(fn)                   a Python function run in a thread; fn(out) writes lines with out(text),
                               returns an exit code (or raises: exit 1 with the error)
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
    """Git Bash's bash, never WSL's (C:\\Windows\\System32\\bash.exe runs in Linux, without the laptop's ssh key)."""
    env = os.environ.get('PB_BASH')
    if env:
        return env
    found = shutil.which('bash')
    if found and 'system32' not in found.lower():
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


class FuncProc:
    """A Python function behind a Popen-like face."""

    def __init__(self, fn):
        r, w = os.pipe()
        self.stdout = os.fdopen(r, 'rb')
        self._w = os.fdopen(w, 'wb')
        self.returncode = None
        self.cancelled = False
        self._t = threading.Thread(target=self._run, args=(fn,), daemon=True)
        self._t.start()

    def _out(self, text):
        if self.cancelled:
            raise KeyboardInterrupt('cancelled')
        try:
            self._w.write((text if text.endswith('\n') else text + '\n').encode('utf-8'))
            self._w.flush()
        except (OSError, ValueError):
            self.cancelled = True

    def _run(self, fn):
        code = 1
        try:
            code = fn(self._out)
            code = 0 if code is None else int(code)
        except KeyboardInterrupt:
            code = 130
        except Exception as e:
            try:
                self._out('error: %s: %s' % (type(e).__name__, e))
                self._out(traceback.format_exc(limit=3))
            except Exception:
                pass
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
        self.cancelled = True


def func(fn):
    return FuncProc(fn)
