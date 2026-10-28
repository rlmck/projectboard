#!/usr/bin/env python3
"""PB Console: a local admin console for the Project Board (the Pi, the LEDs,
the wall kiosk, the live app, Supabase). Standard library only.

    bash console/start.sh                     (Git Bash, the repo root: makes the
                                               token, starts this, opens the browser)
    PB_CONSOLE_TOKEN=... python console/server.py [--port 8765] [--open]

Bound to 127.0.0.1 only. Every request goes through security.Gate (Host,
Origin, Sec-Fetch-Site, the session token on /api/, POST only as JSON). One
action at a time (a lock); every action goes to console/audit.log.

    GET  /api/overview[?refresh=1]   the tiles (Pi probe every 30 s, laptop checks every 60 s)
    GET  /api/realtime               a Realtime join test now
    GET  /api/state                  lock, helper installed, patterns, camera URL, audit tail
    GET  /api/logs?source=&since=&until=&lines=&filter=&follow=1   streamed text
    POST /api/preview {action, args}                 what a confirm would say, and the busy check
    POST /api/action  {action, args, confirm, override_busy}   streamed output, then '@@result {...}'
"""
import argparse
import json
import os
import queue
import re
import shlex
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True
import actions  # noqa: E402
import checks  # noqa: E402
import drift  # noqa: E402
import gitops  # noqa: E402
import reports  # noqa: E402
import supabase_api as supa  # noqa: E402
import security  # noqa: E402
import tiles  # noqa: E402
from remote import Remote  # noqa: E402

STATIC = {
    '/': ('static/index.html', 'text/html; charset=utf-8'),
    '/static/console.css': ('static/console.css', 'text/css; charset=utf-8'),
    '/static/console.js': ('static/console.js', 'text/javascript; charset=utf-8'),
    '/static/more.js': ('static/more.js', 'text/javascript; charset=utf-8'),
    '/static/dash.js': ('static/dash.js', 'text/javascript; charset=utf-8'),
    '/static/icon.svg': ('static/icon.svg', 'image/svg+xml'),
    '/tokens.css': ('../app/tokens.css', 'text/css; charset=utf-8'),   # the app's own design tokens
}
PI_TTL, LAPTOP_TTL, REALTIME_TTL = 25, 60, 300
KEEPALIVE_S = 15

LOG_SOURCES = {
    'pb-listener': ['-u', 'pb-listener'], 'kiosk': ['-u', 'kiosk'], 'board-cam': ['-u', 'board-cam'],
    'pb-netwatch': ['-u', 'pb-netwatch'], 'pb-ledmap': ['-u', 'pb-ledmap'],
    'pb-health': ['-t', 'pb-health'], 'pb-mode': ['-t', 'pb-mode'], 'pb-boot': ['-t', 'pb-boot'],
    'pb-console': ['-t', 'pb-console'],
    'NetworkManager': ['-u', 'NetworkManager'], 'wpa_supplicant': ['-u', 'wpa_supplicant'],
    'tailscaled': ['-u', 'tailscaled'], 'kernel': ['_TRANSPORT=kernel'], 'errors': ['-p', 'err'], 'all': [],
}
LOG_FILES = {'netlog': '/boot/firmware/netlog.txt', 'netwatch-file': '/boot/firmware/netwatch.txt'}
SINCE = re.compile(r'^(-?\d{1,4} ?(s|sec|min|m|h|hour|hours|d|day|days)( ago)?|today|yesterday|now'
                   r'|\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?)$')


def load_env(path):
    """console/.env.local: KEY=value lines (gitignored). The environment wins over it."""
    env = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"\'')
    except OSError:
        pass
    for k, v in os.environ.items():
        if k.startswith(('PB_', 'SUPABASE_')):
            env[k] = v
    return env


class Console:
    def __init__(self, token, port, env=None, remote=None, laptop=None):
        self.env = env or {}
        self.gate = security.Gate(token, port)
        self.remote = remote or Remote(self.env.get('PB_HOST') or 'pi@projectboard', self.env.get('PB_SSH'))
        self.laptop = laptop or (lambda realtime: checks.laptop_checks(self.env, realtime))
        self.cam_url = self.env.get('PB_CAM_URL') or 'http://projectboard:8080/stream'
        p = urllib.parse.urlparse(self.cam_url)
        self.cam_origin = '%s://%s' % (p.scheme, p.netloc) if p.netloc else ''
        self.ledmap_url = self.env.get('PB_LEDMAP_URL') or 'http://projectboard:8081/'
        p = urllib.parse.urlparse(self.ledmap_url)
        self.ledmap_origin = '%s://%s' % (p.scheme, p.netloc) if p.netloc else ''
        self.err_warn = int(self.env.get('PB_ERR_WARN') or 50)
        self.err_bad = int(self.env.get('PB_ERR_BAD') or 500)
        self.lock = threading.Lock()          # one action at a time
        self.current = None
        self._pi, self._pi_at, self._pi_lock = None, 0.0, threading.Lock()
        self._lap, self._lap_at, self._rt_at, self._lap_lock = None, 0.0, 0.0, threading.Lock()

    def pi(self, refresh=False):
        with self._pi_lock:
            if refresh or not self._pi or time.time() - self._pi_at > PI_TTL:
                self._pi, self._pi_at = self.remote.probe(), time.time()
            return self._pi

    def laptop_checks(self, refresh=False, realtime=None):
        with self._lap_lock:
            now = time.time()
            if realtime is None:
                realtime = refresh or now - self._rt_at > REALTIME_TTL
            if refresh or realtime or not self._lap or now - self._lap_at > LAPTOP_TTL:
                old_rt = (self._lap or {}).get('realtime')
                c = self.laptop(realtime)
                if realtime and c.get('realtime') is not None:
                    c['realtime']['at'] = now
                    self._rt_at = now
                else:
                    c['realtime'] = old_rt
                self._lap, self._lap_at = c, now
            return self._lap

    def overview(self, refresh=False):
        result = {}
        t = threading.Thread(target=lambda: result.setdefault('lap', self.laptop_checks(refresh)))
        t.start()
        p = self.pi(refresh)
        t.join()
        lap = result.get('lap')
        pi_tiles = tiles.pi_tiles(p, err_warn=self.err_warn, err_bad=self.err_bad)
        drift = actions.config_drift(p.get('config_env')) if p.get('ok') else None
        listener = p.get('listener') or {}
        units = {u: s.get('ActiveState') for u, s in (p.get('services') or {}).items()}
        units.update({t + '.timer': s.get('ActiveState') for t, s in (p.get('timers') or {}).items()})
        return {'at': time.time(), 'units': units, 'tiles': pi_tiles[:1] + tiles.laptop_tiles(lap) + pi_tiles[1:],
                'pi_ok': bool(p.get('ok')), 'helper': p.get('helper'), 'config_drift': drift,
                'board': {'leds': listener.get('leds'), 'pattern': listener.get('idle_pattern'),
                          'plan': listener.get('idle_plan'), 'override': listener.get('idle_override'),
                          'scale': listener.get('brightness_scale', 1.0), 'mode': p.get('mode'),
                          'screen_off': p.get('screen_off_flag'), 'config': _night_cfg(p.get('config_env'))},
                'casts_5min': p.get('casts_5min'), 'metrics': tiles.metrics(p, lap)}


def _night_cfg(text):
    out = {}
    for line in (text or '').splitlines():
        m = re.match(r'^\s*(NIGHT_[A-Z]+|IDLE_PATTERN|BRIGHTNESS|IDLE_BRIGHTNESS|RELAY_[A-Z_]+)\s*=\s*(.*)$', line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"\'')
    return out


MAX_BODY = 4 * 1024 * 1024       # the LED mapping export is the biggest (~200 KB)


def _num(q, key, default, lo, hi):
    try:
        return max(lo, min(hi, int(q.get(key) or default)))
    except ValueError:
        raise ValueError('%s: a number' % key)


def r_config(app, q):
    raw = app.remote.probe('config')
    if not raw.get('ok'):
        raise RuntimeError(raw.get('error') or 'the Pi did not answer')
    h = actions.helper()
    current = raw.get('current') or ''
    return {'values': h.parse_config(current), 'keys': actions.config_keys(), 'text': current,
            'drift': actions.config_drift(current), 'laptop_exists': actions.laptop_config() is not None,
            'backups': [{'name': b['name'], 'diff': actions.text_diff(b['text'], current, b['name'], 'config.env (now)')}
                        for b in raw.get('backups') or []]}


def r_drift(app, q):
    from remote import helper_cmd
    code, text, err = app.remote.run(drift.remote_script(), timeout=60)
    if code == 255:
        raise RuntimeError(err.strip() or 'ssh failed')
    rcode, root, _ = app.remote.run(helper_cmd('hashes'), timeout=30)
    out = drift.compare(text, root if rcode == 0 else '')
    out['config_drift'] = actions.config_drift(app.pi().get('config_env'))
    return out


def r_git(app, q):
    return gitops.status()


def r_git_diff(app, q):
    path = q.get('path')
    if path and path not in {f['path'] for f in gitops.status()['files']}:
        raise ValueError('path: one of the changed files')
    return {'diff': gitops.diff(path, staged=q.get('staged') == '1')}


def r_live(app, q):
    s = checks.site(checks.LIVE)
    return {'cache': s.get('cache'), 'status': s.get('status'), 'repo': gitops.checks()['cache'],
            'staging': checks.site(checks.STAGING).get('cache')}


def r_ledmap(app, q):
    b = app.remote.busy() or {}
    return {'state': b.get('pb_ledmap'), 'url': app.ledmap_url, 'history': reports.ledmap_history()}


def r_problems(app, q):
    return {'problems': supa.problems(app.env)}


def r_problem(app, q):
    name = q.get('name') or ''
    row = supa.problem(name, app.env)
    if not row:
        raise ValueError('no problem called %r' % name)
    return {'name': row['name'], 'grade': row.get('grade'),
            'holds': supa.holds_with_mirror(row, supa.board(app.env).get('mirror_map'))}


def r_activity(app, q):
    days = _num(q, 'days', 14, 1, 60)
    raw = app.remote.probe('activity %d' % days)
    if not raw.get('ok'):
        raise RuntimeError(raw.get('error') or 'the Pi did not answer')
    return reports.activity(raw)


def r_acceptance(app, q):
    return {'tests': reports.acceptance()}


def r_last_night(app, q):
    import datetime
    date = q.get('date') or (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', date):
        raise ValueError('date: YYYY-MM-DD')
    raw = app.remote.probe('night %s' % date)
    if not raw.get('ok'):
        raise RuntimeError(raw.get('error') or 'the Pi did not answer')
    return reports.night_report(raw)


def r_backups(app, q):
    return {'backups': reports.backups_list()}


def r_runbook(app, q):
    return {'sections': reports.runbook()}


GET_ROUTES = {'/api/config': r_config, '/api/drift': r_drift, '/api/git': r_git, '/api/git-diff': r_git_diff,
              '/api/live': r_live, '/api/ledmap': r_ledmap, '/api/problems': r_problems, '/api/problem': r_problem,
              '/api/activity': r_activity, '/api/acceptance': r_acceptance, '/api/last-night': r_last_night,
              '/api/backups': r_backups, '/api/runbook': r_runbook}


class ConsoleServer(ThreadingHTTPServer):
    """No address reuse: on Windows SO_REUSEADDR would let a second program bind the
    same port alongside the console; SO_EXCLUSIVEADDRUSE refuses that outright."""
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'pb-console'
        sys_version = ''

        def log_message(self, fmt, *args):
            pass

        def _headers(self, code, ctype, extra=None):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            for k, v in security.headers(app.cam_origin, app.ledmap_origin).items():
                self.send_header(k, v)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, code, body):
            data = json.dumps(body).encode()
            self._headers(code, 'application/json', {'Content-Length': str(len(data))})
            self.wfile.write(data)

        def _gate(self, method):
            path = urllib.parse.urlsplit(self.path).path
            refused = app.gate.check(method, path, self.headers)
            if refused:
                try:                      # drain a small body, so the client sees the answer, not a reset
                    n = int(self.headers.get('Content-Length') or 0)
                    if 0 < n <= 65536:
                        self.rfile.read(n)
                except (ValueError, OSError):
                    pass
                self._json(refused[0], {'error': refused[1]})
                return None
            return path

        def do_GET(self):
            path = self._gate('GET')
            if path is None:
                return
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
            if path in STATIC:
                name, ctype = STATIC[path]
                try:
                    with open(os.path.normpath(os.path.join(HERE, name)), 'rb') as f:
                        data = f.read()
                except OSError:
                    return self._json(404, {'error': 'not found'})
                self._headers(200, ctype, {'Content-Length': str(len(data))})
                return self.wfile.write(data)
            if path == '/api/overview':
                return self._json(200, app.overview(q.get('refresh') == '1'))
            if path == '/api/realtime':
                return self._json(200, app.laptop_checks(realtime=True).get('realtime') or {})
            if path == '/api/state':
                return self._json(200, {'busy': app.current, 'host': app.remote.host, 'cam_url': app.cam_url,
                                        'patterns': actions.pattern_names(), 'audit': actions.audit_tail(30),
                                        'log_sources': list(LOG_SOURCES) + list(LOG_FILES),
                                        'units': actions.UNITS})
            if path == '/api/logs':
                return self.logs(q)
            route = GET_ROUTES.get(path)
            if route:
                try:
                    return self._json(200, route(app, q))
                except ValueError as e:
                    return self._json(400, {'error': str(e)})
                except Exception as e:
                    return self._json(502, {'error': '%s: %s' % (type(e).__name__, e)})
            return self._json(404, {'error': 'not found'})

        def do_POST(self):
            path = self._gate('POST')
            if path is None:
                return
            try:
                n = int(self.headers.get('Content-Length') or 0)
                if n > MAX_BODY:
                    return self._json(413, {'error': 'too big'})
                body = json.loads(self.rfile.read(n) or b'{}') if n else {}
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self._json(400, {'error': 'send a JSON object'})
            if path == '/api/ledmap-results':
                try:
                    return self._json(200, {'saved': reports.ledmap_save(body.get('results'))})
                except ValueError as e:
                    return self._json(400, {'error': str(e)})
            if path == '/api/preview':
                return self.preview(body)
            if path == '/api/action':
                return self.action(body)
            if path == '/api/acceptance-note':
                try:
                    reports.save_note(body.get('id'), body.get('result'), body.get('note'))
                except ValueError as e:
                    return self._json(400, {'error': str(e)})
                return self._json(200, {'ok': True})
            return self._json(404, {'error': 'not found'})

        def do_PUT(self):
            self._gate('PUT')
        do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = do_PUT

        # -- actions --------------------------------------------------------------

        def preview(self, body):
            try:
                a = actions.build(body.get('action'), body.get('args'))
            except actions.Invalid as e:
                return self._json(400, {'error': str(e)})
            out = {'describe': a.describe, 'confirm': a.confirm, 'busy_check': a.busy, 'config': a.config,
                   'shown': a.shown}
            out.update(a.preview)
            if a.busy:
                out['busy'] = app.remote.busy()
            if a.config == 'keep':
                p = app.pi(refresh=True)
                out['config_drift'] = actions.config_drift(p.get('config_env')) if p.get('ok') else None
            return self._json(200, out)

        def action(self, body):
            kind = body.get('action')
            try:
                a = actions.build(kind, body.get('args'))
            except actions.Invalid as e:
                actions.audit(str(kind), 'refused', str(e))
                return self._json(400, {'error': str(e)})
            if a.confirm and body.get('confirm') is not True:
                actions.audit(a.name, 'refused', 'not confirmed')
                return self._json(400, {'error': 'this action needs confirming'})
            if not app.lock.acquire(blocking=False):
                actions.audit(a.name, 'refused', 'another action running: %s' % app.current)
                return self._json(409, {'error': 'another action is running: %s' % app.current, 'locked': True})
            try:
                app.current = a.name
                if a.busy and body.get('override_busy') is not True:
                    b = app.remote.busy()
                    if b is None or b.get('busy'):
                        why = 'the Pi did not answer the busy check' if b is None else 'a cast came in during the last 5 minutes'
                        actions.audit(a.name, 'refused', why)
                        return self._json(409, {'error': why, 'busy': b})
                if a.config == 'keep':
                    p = app.pi(refresh=True)
                    if not p.get('ok'):
                        return self._json(502, {'error': 'the Pi did not answer: %s' % p.get('error')})
                    drift = actions.config_drift(p.get('config_env'))
                    if drift:
                        actions.audit(a.name, 'refused', 'config.env differs between laptop and Pi')
                        return self._json(409, {'error': "pi/config.env (laptop) and the Pi's config.env differ: "
                                                         'make them the same first', 'config_drift': drift})
                self.run_streamed(a)
            finally:
                app.current = None
                app.lock.release()

        def run_streamed(self, a):
            t0 = time.monotonic()
            self._headers(200, 'text/plain; charset=utf-8')
            self.wfile.write(('$ %s\n' % a.shown).encode())
            try:
                proc = a.start(app)
            except OSError as e:
                self.wfile.write(('could not start: %s\n' % e).encode())
                actions.audit(a.name, 'failed', str(e))
                return
            code, cut = self.pump(proc, timeout=a.timeout)
            ms = int((time.monotonic() - t0) * 1000)
            extra = ''
            if a.config and code == 0:
                p = app.pi(refresh=True)
                if p.get('ok') and p.get('config_env') is not None:
                    actions.save_laptop_config(p['config_env'])
                    extra = 'pi/config.env on the laptop updated to match'
                else:
                    extra = "couldn't read the Pi's config.env back: pi/config.env not updated"
            if a.name == 'reboot' and code == 255:
                code = 0          # ssh drops as the Pi goes down
            result = 'cancelled' if cut else 'ok' if code == 0 else 'failed'
            actions.audit(a.name, result, 'exit %s%s' % (code, '; ' + extra if extra else ''), ms)
            app._pi_at = 0       # the next overview probes afresh
            if not cut:
                try:
                    if extra:
                        self.wfile.write(('%s\n' % extra).encode())
                    self.wfile.write(('@@result %s\n' % json.dumps({'ok': code == 0, 'code': code, 'ms': ms})).encode())
                except OSError:
                    pass

        def pump(self, proc, filt=None, timeout=None):
            """Copy a process's output to the client as it comes, with a keepalive line so a
            closed tab is noticed. Returns (exit code, cut short by the client)."""
            q = queue.Queue()

            def reader():
                try:
                    for raw in iter(proc.stdout.readline, b''):
                        q.put(raw.decode('utf-8', 'replace'))
                except (OSError, ValueError):     # closed under it after the tab went away
                    pass
                q.put(None)
            threading.Thread(target=reader, daemon=True).start()
            deadline = time.monotonic() + timeout if timeout else None
            cut = False
            try:
                while True:
                    if deadline and time.monotonic() > deadline:
                        deadline = None
                        proc.kill()
                        self.wfile.write(b'(stopped: took too long)\n')
                    try:
                        line = q.get(timeout=KEEPALIVE_S)
                    except queue.Empty:
                        self.wfile.write(b'@@ping\n')
                        self.wfile.flush()
                        continue
                    if line is None:
                        break
                    if filt and filt not in line.lower():
                        continue
                    self.wfile.write(line.encode())
                    self.wfile.flush()
            except OSError:           # the tab went away
                cut = True
            if proc.poll() is None and cut:
                proc.kill()
            code = proc.wait()
            if not cut:
                proc.stdout.close()
            return code, cut

        # -- logs (read-only, no lock) ------------------------------------------

        def logs(self, q):
            source = q.get('source', 'pb-listener')
            follow = q.get('follow') == '1'
            try:
                lines = max(1, min(5000, int(q.get('lines') or 300)))
            except ValueError:
                return self._json(400, {'error': 'lines: a number'})
            since, until = q.get('since') or '', q.get('until') or ''
            for v in (since, until):
                if v and not SINCE.match(v):
                    return self._json(400, {'error': 'since/until: like -1h, 2 hours ago, today, 2026-10-28 14:00'})
            if source in LOG_FILES:
                cmd = 'tail -n %d %s%s' % (lines, '-F ' if follow else '', shlex.quote(LOG_FILES[source]))
            elif source in LOG_SOURCES:
                parts = ['journalctl', '--no-pager', '-o', 'short-iso', '-n', str(lines)] + LOG_SOURCES[source]
                if since:
                    parts += ['--since', since]
                if until and not follow:
                    parts += ['--until', until]
                if q.get('filter'):           # in the journal, so --lines counts matching lines
                    parts += ['--case-sensitive=no', '--grep', re.escape(q['filter'])[:200]]
                if follow:
                    parts.append('-f')
                cmd = ' '.join(shlex.quote(p) for p in parts)
            else:
                return self._json(400, {'error': 'no log called %r' % source})
            self._headers(200, 'text/plain; charset=utf-8')
            self.wfile.write(('$ %s\n' % cmd).encode())
            filt = (q.get('filter') or '').lower() if source in LOG_FILES else None
            code, _ = self.pump(app.remote.start(cmd), filt=filt or None)
            try:
                self.wfile.write(('@@result %s\n' % json.dumps({'ok': code == 0, 'code': code})).encode())
            except OSError:
                pass

    return Handler


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int)
    ap.add_argument('--open', action='store_true', help='open the browser once listening')
    a = ap.parse_args(argv)
    env = load_env(os.path.join(HERE, '.env.local'))
    port = a.port or int(env.get('PB_CONSOLE_PORT') or 8765)
    token = os.environ.get('PB_CONSOLE_TOKEN', '')
    if len(token) < 20:
        sys.exit('PB_CONSOLE_TOKEN is not set: start it with  bash console/start.sh')
    app = Console(token, port, env)
    try:
        httpd = ConsoleServer(('127.0.0.1', port), make_handler(app))
    except OSError as e:
        sys.exit('port %d is taken (%s): is the console already running? Or set PB_CONSOLE_PORT' % (port, e))
    url = 'http://127.0.0.1:%d/#t=%s' % (port, token)
    print('PB Console on http://127.0.0.1:%d/  (Pi: %s)' % (port, app.remote.host), flush=True)
    print('this launch: %s' % url, flush=True)
    print('Ctrl+C stops it.', flush=True)
    actions.audit('console start', 'ok', 'port %d' % port)
    if a.open:
        threading.Timer(0.3, webbrowser.open, [url]).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        actions.audit('console stop', 'ok')
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
