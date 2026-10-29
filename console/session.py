"""One console at a time, and a launch that always works.

A running console records itself in console/data/session.json (gitignored: its pid,
port, token and a stamp of its code). A new launch (start.sh, the desktop icon) reads
it first and asks that console who it is (GET /api/whoami, with its token):

  - it's running this code, or it's in the middle of an action  -> open it in the
    browser (with its own token) and stop: the tab you get works;
  - it's running older code and is idle                          -> ask it to stop
    (POST /api/shutdown), then start fresh;
  - no answer (crashed, a stale file)                            -> start fresh.

Starting fresh tries the configured port, then the next ten, so a port held by some
other program doesn't stop it either. The token in the file is what the browser gets
anyway; anything that can read files as you could already run the console itself.
"""
import glob
import hashlib
import http.client
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, 'data', 'session.json')
PORTS = 11                     # the configured port and the next ten


def code_stamp():
    """A hash of the console's own code: a newer one means a running console is out of date."""
    h = hashlib.sha1()
    files = sorted(glob.glob(os.path.join(HERE, '*.py')) + glob.glob(os.path.join(HERE, 'static', '*')))
    for f in files:
        try:
            with open(f, 'rb') as fh:
                h.update(os.path.basename(f).encode() + b'\0' + fh.read())
        except OSError:
            pass
    return h.hexdigest()[:12]


def read(path=PATH):
    try:
        with open(path, encoding='utf-8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) and isinstance(s.get('port'), int) and s.get('token') else None
    except (OSError, ValueError):
        return None


def write(port, token, path=PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump({'pid': os.getpid(), 'port': port, 'token': token, 'code': code_stamp(),
                   'started': time.time()}, f)
    os.replace(tmp, path)


def remove(token, path=PATH):
    """Delete the file, but only if it's still this console's (a newer launch may have replaced it)."""
    s = read(path)
    if s and s.get('token') == token:
        try:
            os.remove(path)
        except OSError:
            pass


def ask(s, method, path, timeout=3):
    """A request to the console described by s, through its own checks. (status, json) or (None, None)."""
    c = http.client.HTTPConnection('127.0.0.1', s['port'], timeout=timeout)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        c.putheader('Host', '127.0.0.1:%d' % s['port'])
        c.putheader('Origin', 'http://127.0.0.1:%d' % s['port'])
        c.putheader('X-PB-Token', s['token'])
        body = b'{}' if method == 'POST' else b''
        if method == 'POST':
            c.putheader('Content-Type', 'application/json')
            c.putheader('Content-Length', str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        return r.status, json.loads(r.read() or b'{}')
    except (OSError, ValueError, http.client.HTTPException):
        return None, None
    finally:
        c.close()


def url(s):
    return 'http://127.0.0.1:%d/#t=%s' % (s['port'], s['token'])


def existing(log=print, path=PATH):
    """The running console to reuse, or None (after stopping an out-of-date one)."""
    s = read(path)
    if not s:
        return None
    status, who = ask(s, 'GET', '/api/whoami')
    if status != 200 or not isinstance(who, dict):
        return None                                   # nothing there any more: a stale file
    if who.get('code') == code_stamp():
        return s
    if who.get('busy'):
        log('The running console has older code but is busy (%s): using it as it is.' % who['busy'])
        return s
    log('The running console has older code: stopping it and starting a fresh one.')
    ask(s, 'POST', '/api/shutdown')
    for _ in range(50):                               # up to 5 s for it to let go of the port
        if ask(s, 'GET', '/api/whoami', timeout=0.5)[0] is None:
            break
        time.sleep(0.1)
    return None
