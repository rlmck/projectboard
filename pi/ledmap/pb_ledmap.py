#!/usr/bin/env python3
"""pb-ledmap: the LED mapping tool. A small web page, served from the Pi, for
finding LEDs that don't sit under their holds: tap a hold and see which LED
lights, walk the board, step through raw LED indices, check every column's
direction, and light a problem exactly as the listener would.

    Started by pb-ledmap.service (`pb-ledmap` on the Pi), never at boot.
    The unit Conflicts= with pb-listener, so the two never drive the strip
    together, and its ExecStopPost starts the listener again however the
    session ends (Finish, Ctrl+C in `pb-ledmap`, the idle timeout, a crash).

    pb_ledmap.py [--config FILE] [--host IP] [--port 8081] [--brightness 0.3]
                 [--idle 1800] [--dry-run]

Bound to the Pi's Tailscale address (like board-cam), so only Tailscale
devices reach it. --dry-run prints LEDs instead of writing SPI (the laptop:
`--dry-run --host 127.0.0.1 --config pi/config.env`).

Endpoints (JSON; every POST needs Content-Type: application/json):
    GET  /api/status            what's lit, brightness, idle time left, day/night
    GET  /api/map               every cell: grid ref, holdN, LED (contract 6.4), real hold or not
    GET  /api/problems          every problem name (for the picker)
    POST /api/hold     {"hold": "hold24" | 24, "rgb": [r,g,b]?}   light one hold, nothing else
    POST /api/led      {"led": 54, "rgb": [r,g,b]?}               light one raw LED index
    POST /api/light    {"leds": {"54": [r,g,b]}, "holds": {"hold24": [r,g,b]}}   light a list
    POST /api/columns  {}                                         bottom of each column green, top red
    POST /api/problem  {"name": "Good Bug", "mirror": false}      as the listener lights it
    POST /api/brightness {"value": 0.3}
    POST /api/clear    {}
    POST /api/finish   {}       clear, stop; pb-listener starts again

Only the POSTs count as activity: a page left open, polling the status,
still times out.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import leds as ledlib  # noqa: E402
import mode as modelib  # noqa: E402

COLS = 'ABCDEFGHIJKLMNOPQRS'
WHITE, GREEN, RED = (255, 255, 255), (0, 255, 0), (255, 0, 0)
# The page and its two data files: next to this script on the Pi (install.sh
# copies them), or in the repo's app/ when run from a checkout.
STATIC = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/board.jpg': ('board.jpg', 'image/jpeg'),
    '/hold_map.json': ('hold_map.json', 'application/json'),
}
REPO_FALLBACK = {'board.jpg': ('app', 'board-fallback.jpg'), 'hold_map.json': ('app', 'hold_map.json')}


def log(msg):
    print(msg, flush=True)


def cell_ref(n):
    """Hold number 1-247 -> 'A1' .. 'S13' (row 1 at the bottom)."""
    return '%s%d' % (COLS[(n - 1) % board.COLS], (n - 1) // board.COLS + 1)


def static_path(name):
    p = os.path.join(HERE, name)
    if os.path.exists(p) or name not in REPO_FALLBACK:
        return p
    return os.path.join(os.path.dirname(os.path.dirname(HERE)), *REPO_FALLBACK[name])


def load_real_holds():
    """{holdN: {'x': %, 'y': %}} for the 188 real holds, from the shipped snapshot of the live board."""
    with open(static_path('hold_map.json'), encoding='utf-8') as f:
        m = json.load(f)
    return {k: v for k, v in m.items() if board.hold_number(k)}


def board_map(real):
    """Every grid cell with its LED under the current mapping (board.led_index, contract 6.4)."""
    cells = []
    for n in range(1, board.MAX_HOLD + 1):
        h = 'hold%d' % n
        cells.append({'hold': h, 'n': n, 'cell': cell_ref(n), 'col': (n - 1) % board.COLS,
                      'row': (n - 1) // board.COLS + 1, 'led': board.led_index(n),
                      'real': h in real, 'pos': real.get(h)})
    return cells


def parse_rgb(v, default=WHITE):
    if v is None:
        return default
    if isinstance(v, str):                       # '#rrggbb'
        s = v.lstrip('#')
        if len(s) != 6:
            raise ValueError('colour %r is not #rrggbb' % v)
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    if isinstance(v, (list, tuple)) and len(v) == 3 and all(isinstance(c, int) and 0 <= c <= 255 for c in v):
        return tuple(v)
    raise ValueError('colour %r is not [r, g, b] (0-255)' % (v,))


def parse_hold(v):
    n = v if isinstance(v, int) and not isinstance(v, bool) else board.hold_number(v)
    if not isinstance(n, int) or not 1 <= n <= board.MAX_HOLD:
        raise ValueError('%r is not a hold (hold1-hold247)' % (v,))
    return n


def column_frame():
    """Row 1 of every column green, row 13 red, through the current mapping."""
    out = {}
    for x in range(board.COLS):
        out[board.led_index(x + 1)] = GREEN
        out[board.led_index(x + 1 + (board.ROWS - 1) * board.COLS)] = RED
    return out


class LedMap:
    """Everything but HTTP: what's lit, the brightness, the idle clock. One lock
    around every strip write, so two requests can't interleave on SPI."""

    def __init__(self, strip, cfg, brightness=0.3, idle_s=1800, clock=time.monotonic,
                 fetch_problem=None, fetch_mirror_map=None, fetch_names=None):
        self.strip, self.cfg, self.clock = strip, cfg, clock
        self.brightness = min(max(float(brightness), 0.01), 1.0)
        self.idle_s = idle_s
        self.lit = {}                     # {led: (r, g, b)} as asked, before brightness
        self.what = 'nothing'
        self.fixed_brightness = None      # a problem shows at the listener's BRIGHTNESS, not the slider
        self.last_activity = clock()
        self.stop = threading.Event()
        self.stop_reason = None
        self.lock = threading.Lock()
        self.fetch_problem = fetch_problem
        self.fetch_mirror_map = fetch_mirror_map
        self.fetch_names = fetch_names
        self.names = None
        self.real = load_real_holds()
        self.cells = board_map(self.real)

    @property
    def pixels(self):
        return self.strip.pixels

    def touch(self):
        self.last_activity = self.clock()

    def idle_left(self):
        return max(0.0, self.idle_s - (self.clock() - self.last_activity))

    def _show(self, frame, what, brightness=None):
        """frame: {led: rgb} at full; scaled by the brightness, then the listener's current cap."""
        bad = [i for i in frame if not isinstance(i, int) or not 1 <= i < self.pixels]
        if bad:
            raise ValueError('LED index out of range 1-%d: %s' % (self.pixels - 1, bad[:5]))
        out, cap, ma = board.scale(frame, self.brightness if brightness is None else brightness,
                                   float(self.cfg.get('POWER_BUDGET_MA') or 8000),
                                   float(self.cfg.get('MA_PER_CHANNEL') or 20))
        with self.lock:
            self.strip.write(out)
            self.lit, self.what, self.fixed_brightness = dict(frame), what, brightness
        return {'lit': {str(i): list(rgb) for i, rgb in sorted(out.items())}, 'ma': round(ma), 'what': what}

    def hold(self, v, rgb=None):
        n = parse_hold(v)
        i = board.led_index(n)
        r = self._show({i: parse_rgb(rgb)}, 'hold%d (%s) -> LED %d' % (n, cell_ref(n), i))
        r.update(hold='hold%d' % n, cell=cell_ref(n), led=i)
        return r

    def led(self, v, rgb=None):
        if not isinstance(v, int) or isinstance(v, bool):
            raise ValueError('led must be a whole number')
        return dict(self._show({v: parse_rgb(rgb)}, 'LED %d' % v), led=v)

    def light(self, leds=None, holds=None):
        frame = {}
        for k, rgb in (leds or {}).items():
            try:
                i = int(k)
            except (TypeError, ValueError):
                raise ValueError('%r is not an LED index' % (k,))
            frame[i] = parse_rgb(rgb)
        for k, rgb in (holds or {}).items():
            frame[board.led_index(parse_hold(k))] = parse_rgb(rgb)
        return self._show(frame, 'a list of %d' % len(frame))

    def columns(self):
        return self._show(column_frame(), 'column check (row 1 green, row 13 red)')

    def problem(self, name, mirror=False):
        """As the listener lights it: the same row, order, roles, colours, mirror map,
        brightness (BRIGHTNESS from config.env) and current cap."""
        if not isinstance(name, str) or not name:
            raise ValueError('no problem name')
        row = self.fetch_problem(self.cfg, name)
        if not row:
            raise LookupError('no problem called %r' % name)
        mm = board.check_mirror_map(self.fetch_mirror_map(self.cfg)) if mirror else None
        frame, dropped = board.frame(row, bool(mirror), mm)
        roles = board.classify(board.problem_order(row))
        r = self._show(frame, '%r%s' % (row['name'], ' mirrored' if mirror else ''),
                       float(self.cfg.get('BRIGHTNESS') or 0.5))
        holds = []
        for h, role in roles.items():
            target = mm.get(h, h) if mirror else h
            n = board.hold_number(target)
            holds.append({'hold': h, 'shown_at': target, 'role': role,
                          'cell': cell_ref(n) if n else None, 'led': board.led_index(n) if n else None,
                          'real': target in self.real})
        r.update(name=row['name'], mirror=bool(mirror), holds=holds, dropped=dropped)
        return r

    def problem_names(self):
        if self.names is None:
            self.names = self.fetch_names(self.cfg)
        return self.names

    def set_brightness(self, v):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.01 <= v <= 1.0:
            raise ValueError('brightness must be 0.01-1')
        self.brightness = float(v)
        if self.lit and self.fixed_brightness is None:      # re-show at the new level
            return self._show(self.lit, self.what)
        return {'brightness': self.brightness}

    def clear(self):
        with self.lock:
            self.strip.clear()
            self.lit, self.what, self.fixed_brightness = {}, 'nothing', None
        return {'lit': {}, 'what': 'nothing'}

    def finish(self, reason):
        if not self.stop.is_set():
            self.stop_reason = reason
            self.stop.set()

    def status(self):
        try:
            m, why = modelib.mode_now(self.cfg)
        except Exception as e:                            # noqa: BLE001 (status must always answer)
            m, why = 'day', 'mode unknown (%s)' % e
        return {'what': self.what, 'lit': {str(i): list(rgb) for i, rgb in sorted(self.lit.items())},
                'brightness': self.brightness, 'cast_brightness': float(self.cfg.get('BRIGHTNESS') or 0.5),
                'pixels': self.pixels, 'idle_left_s': round(self.idle_left()), 'idle_s': self.idle_s,
                'mode': m, 'mode_reason': why, 'dry_run': isinstance(self.strip, ledlib.FakeStrip)}

    def map(self):
        return {'cols': board.COLS, 'rows': board.ROWS, 'pixels': self.pixels,
                'real_count': len(self.real), 'cells': self.cells,
                'mapping': 'contract 6.4: even columns (A, C, ...) run up, odd columns run down'}


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'pb-ledmap'

        def log_message(self, fmt, *args):            # only the POSTs, in log()
            pass

        def _send(self, code, body, ctype='application/json'):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split('?', 1)[0]
            try:
                if path in STATIC:
                    name, ctype = STATIC[path]
                    with open(static_path(name), 'rb') as f:
                        return self._send(200, f.read(), ctype)
                if path == '/api/status':
                    return self._send(200, app.status())
                if path == '/api/map':
                    return self._send(200, app.map())
                if path == '/api/problems':
                    return self._send(200, {'names': app.problem_names()})
            except OSError as e:
                return self._send(404, {'error': str(e)})
            except Exception as e:                    # noqa: BLE001 (Supabase down, say so)
                return self._send(502, {'error': '%s: %s' % (type(e).__name__, e)})
            self._send(404, {'error': 'no such page'})

        def do_POST(self):
            path = self.path.split('?', 1)[0]
            # A plain form or a cross-site page can't send JSON without a CORS
            # preflight, which this server never answers: a cheap CSRF guard.
            if (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json':
                return self._send(415, {'error': 'send Content-Type: application/json'})
            try:
                n = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(n) or b'{}') if n <= 65536 else None
                if not isinstance(body, dict):
                    raise ValueError('the body must be a JSON object (64 KB at most)')
            except ValueError as e:
                return self._send(400, {'error': str(e)})
            app.touch()
            try:
                if path == '/api/hold':
                    r = app.hold(body.get('hold'), body.get('rgb'))
                elif path == '/api/led':
                    r = app.led(body.get('led'), body.get('rgb'))
                elif path == '/api/light':
                    r = app.light(body.get('leds'), body.get('holds'))
                elif path == '/api/columns':
                    r = app.columns()
                elif path == '/api/problem':
                    r = app.problem(body.get('name'), body.get('mirror'))
                elif path == '/api/brightness':
                    r = app.set_brightness(body.get('value'))
                elif path == '/api/clear':
                    r = app.clear()
                elif path == '/api/finish':
                    app.finish('Finish on the page')
                    r = {'finished': True}
                else:
                    return self._send(404, {'error': 'no such action'})
            except LookupError as e:
                return self._send(404, {'error': str(e).strip('"\'')})
            except ValueError as e:
                return self._send(400, {'error': str(e)})
            except Exception as e:                    # noqa: BLE001 (SPI or Supabase: report, keep serving)
                log('%s failed: %s: %s' % (path, type(e).__name__, e))
                return self._send(500, {'error': '%s: %s' % (type(e).__name__, e)})
            log('%s %s' % (path, app.what))
            r['status'] = app.status()
            self._send(200, r)
    return Handler


def tailscale_ip():
    try:
        out = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.split()[0] if out.split() else None


def listener_active():
    try:
        return subprocess.run(['systemctl', 'is-active', '--quiet', 'pb-listener'], timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def fetch_names(cfg):
    import supa
    rows = supa._retry_once(lambda: supa._get(cfg, 'problems', {'select': 'name', 'order': 'name', 'limit': '5000'}))
    return [r['name'] for r in rows if isinstance(r, dict) and r.get('name')]


def main(argv):
    ap = argparse.ArgumentParser(description='The LED mapping tool (see the docstring).')
    ap.add_argument('--config', default=None)
    ap.add_argument('--host', default=None, help='default: the Tailscale IPv4 address')
    ap.add_argument('--port', type=int, default=8081)
    ap.add_argument('--brightness', type=float, default=0.3)
    ap.add_argument('--idle', type=int, default=1800, help='seconds without a POST before it stops')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)

    if not a.dry_run and listener_active():
        log('pb-listener is running: start this with `pb-ledmap` (or sudo systemctl start pb-ledmap),'
            ' which pauses the listener, so the two never write the strip together')
        return 1
    host = a.host or tailscale_ip()
    if not host:
        log('no Tailscale address yet (is tailscaled up?)')
        return 1
    try:
        cfg = modelib.load_config(a.config)
    except OSError as e:
        log('config unreadable (%s): defaults, so "light a problem" will not work' % e)
        cfg = dict(modelib.DEFAULTS)
    import supa
    app = LedMap(ledlib.make_strip(cfg, a.dry_run), cfg, a.brightness, a.idle,
                 fetch_problem=supa.fetch_problem, fetch_mirror_map=supa.fetch_mirror_map, fetch_names=fetch_names)
    httpd = ThreadingHTTPServer((host, a.port), make_handler(app))
    httpd.daemon_threads = True

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda s, _f: app.finish(signal.Signals(s).name))
    threading.Thread(target=httpd.serve_forever, name='http', daemon=True).start()
    app.clear()
    m, why = modelib.mode_now(cfg)
    log('LED mapping on http://%s:%d/ (brightness %.2f, stops after %d min without a request; mode %s: %s)'
        % (host, a.port, app.brightness, a.idle // 60, m, why))

    while not app.stop.wait(5):
        if app.idle_left() <= 0:
            app.finish('%d min without a request' % (a.idle // 60))
        elif not a.dry_run and listener_active():
            # Conflicts= makes this impossible through systemd; a hand-run copy could still meet it.
            app.finish('pb-listener started: it owns the strip now')
            httpd.shutdown()
            log('stopped (%s), the strip left to the listener' % app.stop_reason)
            return 0
    time.sleep(0.3)                                   # let the Finish reply go out
    httpd.shutdown()
    try:
        app.clear()
    except Exception as e:                            # noqa: BLE001
        log('clearing the strip failed: %s' % e)
    log('stopped (%s): strip cleared; pb-listener starts again (ExecStopPost)' % app.stop_reason)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
