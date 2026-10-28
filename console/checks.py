"""Checks run from the laptop: the live site and its sw.js version, Supabase's
REST API, and a Realtime channel join (a tiny standard-library WebSocket client,
since `websockets` isn't in the standard library). All read-only: the join test
joins the board's channel the way the Pi's listener does, sends nothing on it,
and leaves.
"""
import base64
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LIVE = 'https://symmetryboard.co.uk'
STAGING = 'https://dev-projectboard.rosslewismckechnie.workers.dev'
TOPIC = 'realtime:board:HangoutPortland'
UA = 'pb-console (laptop)'


def supabase_settings(env=None):
    """(url, anon key) from app/state.js, the one place the app keeps them (the anon key is public)."""
    env = env or {}
    if env.get('SUPABASE_URL') and env.get('SUPABASE_ANON_KEY'):
        return env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']
    with open(os.path.join(REPO, 'app', 'state.js'), encoding='utf-8') as f:
        src = f.read()
    url = re.search(r"https://[a-z0-9]+\.supabase\.co", src)
    key = re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", src)
    if not (url and key):
        raise RuntimeError('Supabase URL or anon key not found in app/state.js')
    return url.group(0), key.group(0)


def cache_version(text):
    m = re.search(r"const CACHE\s*=\s*'([^']+)'", text or '')
    return m.group(1) if m else None


def repo_cache():
    try:
        with open(os.path.join(REPO, 'app', 'sw.js'), encoding='utf-8') as f:
            return cache_version(f.read())
    except OSError:
        return None


def get(url, headers=None, timeout=10):
    """(status, body text, ms). status 0 = no answer."""
    req = urllib.request.Request(url, headers=dict({'User-Agent': UA}, **(headers or {})))
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(400000).decode('utf-8', 'replace')
            return r.status, body, int((time.monotonic() - t0) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, '', int((time.monotonic() - t0) * 1000)
    except (urllib.error.URLError, OSError) as e:
        return 0, str(getattr(e, 'reason', e)), int((time.monotonic() - t0) * 1000)


def site(base):
    status, _, ms = get(base + '/')
    sw_status, sw, _ = get(base + '/sw.js', {'Cache-Control': 'no-cache'})
    return {'url': base, 'status': status, 'ms': ms, 'sw_status': sw_status,
            'cache': cache_version(sw) if sw_status == 200 else None}


def supabase_rest(url, key):
    status, body, ms = get(url + '/rest/v1/board_config?select=wall&limit=1',
                           {'apikey': key, 'Authorization': 'Bearer ' + key})
    return {'status': status, 'ms': ms, 'error': None if status == 200 else body[:200]}


# -- a minimal WebSocket client (RFC 6455), enough for one Phoenix join ---------

def _ws_send(sock, text):
    data = text.encode()
    mask = os.urandom(4)
    head = bytes([0x81])
    n = len(data)
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack('>H', n)
    else:
        head += bytes([0x80 | 127]) + struct.pack('>Q', n)
    sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def _recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('closed by the server')
        buf += chunk
    return buf


def _ws_recv(sock):
    """(opcode, payload bytes) for one frame (the server's frames aren't masked)."""
    b1, b2 = _recv_exact(sock, 2)
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack('>H', _recv_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack('>Q', _recv_exact(sock, 8))[0]
    mask = _recv_exact(sock, 4) if b2 & 0x80 else None
    data = _recv_exact(sock, n)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return b1 & 0x0F, data


def realtime_join(url, key, topic=TOPIC, timeout=10):
    """Join the board's channel like the listener does. {'ok', 'ms', 'error'}."""
    host = urllib.parse.urlparse(url).hostname
    path = '/realtime/v1/websocket?apikey=%s&vsn=1.0.0' % urllib.parse.quote(key)
    t0 = time.monotonic()
    sock = None
    try:
        raw = socket.create_connection((host, 443), timeout=timeout)
        sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        sock.settimeout(timeout)
        wskey = base64.b64encode(os.urandom(16)).decode()
        sock.sendall(('GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: %s\r\n\r\n'
                      % (path, host, wskey, UA)).encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError('closed during the handshake')
            head += chunk
        lines = head.split(b'\r\n\r\n')[0].decode('latin-1').split('\r\n')
        if ' 101 ' not in lines[0] + ' ':
            raise ConnectionError('handshake refused: %s' % lines[0])
        accept = base64.b64encode(hashlib.sha1((wskey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not any(l.lower().startswith('sec-websocket-accept:') and l.split(':', 1)[1].strip() == accept for l in lines):
            raise ConnectionError('bad Sec-WebSocket-Accept')
        _ws_send(sock, json.dumps({'topic': topic, 'event': 'phx_join', 'ref': '1', 'payload': {
            'config': {'broadcast': {'self': False, 'ack': False}, 'presence': {'key': ''}, 'private': False},
            'access_token': key}}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            op, data = _ws_recv(sock)
            if op == 8:
                raise ConnectionError('closed by the server')
            if op != 1:
                continue
            m = json.loads(data)
            if m.get('topic') == topic and m.get('event') == 'phx_reply' and m.get('ref') == '1':
                status = (m.get('payload') or {}).get('status')
                ms = int((time.monotonic() - t0) * 1000)
                try:
                    _ws_send(sock, json.dumps({'topic': topic, 'event': 'phx_leave', 'ref': '2', 'payload': {}}))
                    mask = os.urandom(4)       # a close frame, code 1000, masked as a client must
                    sock.sendall(bytes([0x88, 0x82]) + mask + bytes(b ^ mask[i] for i, b in enumerate(b'\x03\xe8')))
                except OSError:
                    pass
                if status == 'ok':
                    return {'ok': True, 'ms': ms, 'error': None}
                return {'ok': False, 'ms': ms, 'error': 'join refused: %r' % (m.get('payload'),)}
        raise TimeoutError('no join reply in %d s' % timeout)
    except Exception as e:
        return {'ok': False, 'ms': int((time.monotonic() - t0) * 1000), 'error': '%s: %s' % (type(e).__name__, e)}
    finally:
        if sock:
            try:
                sock.close()
            except OSError:
                pass


def laptop_checks(env=None, realtime=True):
    url, key = supabase_settings(env)
    out = {'at': time.time(), 'live': site(LIVE), 'repo_cache': repo_cache(), 'supabase': supabase_rest(url, key)}
    if realtime:
        out['realtime'] = realtime_join(url, key)
    return out
