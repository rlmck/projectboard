"""The local-request checks: what keeps other web pages, and other programs that
don't have this launch's token, from driving the console.

The console binds 127.0.0.1 only. On top of that, every request is checked here
before it reaches a route:

- Host must be 127.0.0.1:<port> or localhost:<port> (stops DNS rebinding: a
  page on evil.example that resolves to 127.0.0.1 still sends its own Host).
- Origin, when present, must be the console's own; a POST must carry it.
- Sec-Fetch-Site on /api/, when present, must be same-origin or none.
- /api/ requests must carry X-PB-Token, the random token start.sh made for this
  launch (compared in constant time). A custom header also means a foreign page
  can't send it without a CORS preflight, which is never answered.
- Only GET and POST; a POST must be JSON. Routes that change anything are POST.

The static shell (/, /static/*, /tokens.css) needs no token, since its URL
can't carry one without putting it in history: it holds no data, and every
call it makes for data is an /api/ request with the token.
"""
import hmac

TOKEN_HEADER = 'X-PB-Token'

# Sent with every response. No CORS headers, ever.
def headers(cam_origin=''):
    img = "'self' data:" + (' ' + cam_origin if cam_origin else '')
    return {
        'Content-Security-Policy': ("default-src 'none'; script-src 'self'; style-src 'self'; "
                                    "img-src %s; connect-src 'self'; font-src 'self'; "
                                    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'" % img),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
    }


class Gate:
    def __init__(self, token, port):
        if not token or len(token) < 20:
            raise ValueError('the session token is missing or too short')
        self.token = token.encode()
        self.port = int(port)
        self.hosts = {'127.0.0.1:%d' % self.port, 'localhost:%d' % self.port}
        self.origins = {'http://' + h for h in self.hosts}

    def check(self, method, path, headers):
        """None if the request may go on, else (status, message). headers: a case-insensitive mapping."""
        if method not in ('GET', 'POST'):
            return 405, 'GET and POST only'
        host = (headers.get('Host') or '').strip().lower()
        if host not in self.hosts:
            return 403, 'wrong Host'
        origin = headers.get('Origin')
        if origin is not None and origin.strip().lower() not in self.origins:
            return 403, 'wrong Origin'
        if method == 'POST' and origin is None:
            return 403, 'a POST must carry Origin'
        site = headers.get('Sec-Fetch-Site')
        if path.startswith('/api/'):
            # The shell may be opened from anywhere (a link, the launcher); its data calls may not.
            if site is not None and site.strip().lower() not in ('same-origin', 'none'):
                return 403, 'cross-site request'
            sent = (headers.get(TOKEN_HEADER) or '').encode()
            if not sent or not hmac.compare_digest(sent, self.token):
                return 401, 'missing or wrong session token (start the console with bash console/start.sh)'
        elif method == 'POST':
            return 405, 'POST only to /api/'
        if method == 'POST':
            ctype = (headers.get('Content-Type') or '').split(';')[0].strip().lower()
            if ctype != 'application/json':
                return 415, 'a POST must be application/json'
        return None
