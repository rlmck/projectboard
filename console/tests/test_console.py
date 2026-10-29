"""Laptop tests for PB Console (no Pi, no network: ssh and the laptop checks are faked).

    python -m unittest discover -s console/tests      (from the repo root)

The request checks (token, Host, Origin, Sec-Fetch-Site, methods, JSON) both on
security.Gate and end to end through the real HTTP server; the action table's
argument checks; one action at a time; the busy guard; confirms; the audit log;
the config.env sync between laptop and Pi; the overview tiles' thresholds; and
pb-console-helper's own checks.
"""
import contextlib
import http.client
import io
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE = os.path.dirname(HERE)
REPO = os.path.dirname(CONSOLE)
sys.path.insert(0, CONSOLE)
sys.dont_write_bytecode = True
import actions  # noqa: E402
import security  # noqa: E402
import server  # noqa: E402
import tiles  # noqa: E402

TOKEN = 'test-token-0123456789abcdefghijkl'


def load_helper():
    if 'syslog' not in sys.modules:
        try:
            import syslog  # noqa: F401
        except ImportError:                   # Windows: no syslog; the helper only runs on the Pi
            import types
            sys.modules['syslog'] = types.SimpleNamespace(openlog=lambda *a: None, syslog=lambda *a: None, LOG_NOTICE=5)
    path = os.path.join(REPO, 'pi', 'ops', 'pb-console-helper')
    loader = importlib.machinery.SourceFileLoader('pb_console_helper', path)
    spec = importlib.util.spec_from_loader('pb_console_helper', loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


class FakeRemote:
    """Stands in for ssh: records commands and runs a local process instead."""
    host = 'pi@fake'

    def __init__(self):
        self.cmds = []
        self.busy_result = {'ok': True, 'busy': False, 'casts': []}
        self.config = 'NIGHT_FORCE=\n'
        self.hold = None          # a threading.Event the fake command waits on

    def probe(self, mode=''):
        return {'ok': True, 'ms': 5, 'config_env': self.config, 'helper': True, 'services': {}, 'timers': {},
                'hardware': {}, 'wifi': {}, 'tailscale': {}}

    def busy(self):
        return self.busy_result

    def start(self, cmd, stdin=None):
        import subprocess
        self.cmds.append(cmd)
        code = 'import sys,time\nprint("ran", flush=True)\n'
        if self.hold is not None:
            code += 'time.sleep(1.0)\n'
        return subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.g = security.Gate(TOKEN, 8765)
        self.ok = {'Host': '127.0.0.1:8765', 'X-PB-Token': TOKEN}

    def check(self, method='GET', path='/api/state', **h):
        headers = dict(self.ok)
        for k, v in h.items():
            k = k.replace('_', '-')
            if v is None:
                headers.pop(k, None)
            else:
                headers[k] = v
        return self.g.check(method, path, headers)

    def test_good_requests(self):
        self.assertIsNone(self.check())
        self.assertIsNone(self.check(Host='localhost:8765'))
        self.assertIsNone(self.check('POST', '/api/action', Origin='http://127.0.0.1:8765',
                                     Content_Type='application/json'))
        self.assertIsNone(self.check('GET', '/', X_PB_Token=None))      # the static shell

    def test_token(self):
        self.assertEqual(self.check(X_PB_Token=None)[0], 401)
        self.assertEqual(self.check(X_PB_Token='wrong')[0], 401)
        self.assertEqual(self.check(X_PB_Token=TOKEN + 'x')[0], 401)

    def test_host(self):
        for h in ('evil.example:8765', '127.0.0.1:9999', '127.0.0.1', '192.168.1.5:8765', ''):
            self.assertEqual(self.check(Host=h)[0], 403, h)
        self.assertEqual(self.check('GET', '/', Host='evil.example')[0], 403)

    def test_origin(self):
        self.assertEqual(self.check(Origin='http://evil.example')[0], 403)
        self.assertEqual(self.check(Origin='http://127.0.0.1:9999')[0], 403)
        self.assertEqual(self.check('POST', '/api/action', Content_Type='application/json')[0], 403)   # none
        self.assertEqual(self.check('POST', '/api/action', Origin='null', Content_Type='application/json')[0], 403)

    def test_cross_site(self):
        self.assertEqual(self.check(Sec_Fetch_Site='cross-site')[0], 403)
        self.assertEqual(self.check(Sec_Fetch_Site='same-site')[0], 403)
        self.assertIsNone(self.check(Sec_Fetch_Site='same-origin'))
        self.assertIsNone(self.check('GET', '/', X_PB_Token=None, Sec_Fetch_Site='cross-site'))   # opening the shell

    def test_methods_and_json(self):
        self.assertEqual(self.check('PUT')[0], 405)
        self.assertEqual(self.check('POST', '/', Origin='http://127.0.0.1:8765', Content_Type='application/json')[0], 405)
        self.assertEqual(self.check('POST', '/api/action', Origin='http://127.0.0.1:8765',
                                    Content_Type='text/plain')[0], 415)

    def test_short_token_refused(self):
        with self.assertRaises(ValueError):
            security.Gate('short', 8765)


class ServerBase(unittest.TestCase):
    """The real HTTP server on 127.0.0.1, with ssh and the laptop checks faked."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._audit, self._cfg = actions.AUDIT, actions.LAPTOP_CONFIG
        actions.AUDIT = os.path.join(self.tmp, 'audit.log')
        actions.LAPTOP_CONFIG = os.path.join(self.tmp, 'config.env')
        with open(actions.LAPTOP_CONFIG, 'w', newline='\n') as f:
            f.write('NIGHT_FORCE=\n')
        self.httpd = server.ConsoleServer(('127.0.0.1', 0), None)
        self.port = self.httpd.server_address[1]
        self.remote = FakeRemote()
        self.app = server.Console(TOKEN, self.port, {}, remote=self.remote,
                                  laptop=lambda realtime: {'live': {}, 'supabase': {}, 'realtime': None})
        self.httpd.RequestHandlerClass = server.make_handler(self.app)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        actions.AUDIT, actions.LAPTOP_CONFIG = self._audit, self._cfg

    def req(self, method, path, body=None, host=None, origin='same', token=TOKEN, ctype='application/json', extra=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=20)
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        c.putheader('Host', host or '127.0.0.1:%d' % self.port)
        if origin == 'same':
            origin = 'http://127.0.0.1:%d' % self.port
        if origin:
            c.putheader('Origin', origin)
        if token:
            c.putheader('X-PB-Token', token)
        for k, v in (extra or {}).items():
            c.putheader(k, v)
        data = json.dumps(body).encode() if body is not None else b''
        if body is not None:
            c.putheader('Content-Type', ctype)
            c.putheader('Content-Length', str(len(data)))
        c.endheaders(data)
        r = c.getresponse()
        out = r.status, r.read().decode(), dict(r.getheaders())
        c.close()
        return out

    def audit_rows(self):
        return actions.audit_tail(100, actions.AUDIT)


class ServerTests(ServerBase):
    def test_no_token_rejected(self):
        self.assertEqual(self.req('GET', '/api/state', token=None)[0], 401)
        self.assertEqual(self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'now'}}, token=None)[0], 401)
        self.assertEqual(self.req('GET', '/api/state', token='x' * 40)[0], 401)
        self.assertEqual(self.remote.cmds, [])

    def test_wrong_host_rejected(self):
        self.assertEqual(self.req('GET', '/api/state', host='evil.example')[0], 403)
        self.assertEqual(self.req('GET', '/', host='evil.example:%d' % self.port)[0], 403)
        self.assertEqual(self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'now'}},
                                  host='attacker.test:%d' % self.port)[0], 403)
        self.assertEqual(self.remote.cmds, [])

    def test_wrong_origin_rejected(self):
        self.assertEqual(self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'now'}},
                                  origin='http://evil.example')[0], 403)
        self.assertEqual(self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'now'}}, origin=None)[0], 403)
        self.assertEqual(self.req('GET', '/api/state', origin='https://evil.example')[0], 403)
        self.assertEqual(self.req('GET', '/api/state', extra={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.remote.cmds, [])

    def test_post_only_and_json_only(self):
        self.assertEqual(self.req('GET', '/api/action')[0], 404)        # no GET route changes anything
        self.assertEqual(self.req('POST', '/api/action', {'action': 'idle'}, ctype='text/plain')[0], 415)
        self.assertEqual(self.req('PUT', '/api/action')[0], 405)
        self.assertEqual(self.req('DELETE', '/api/state')[0], 405)
        self.assertEqual(self.remote.cmds, [])

    def test_port_cannot_be_shared(self):
        with self.assertRaises(OSError):
            server.ConsoleServer(('127.0.0.1', self.port), None)

    def test_static_shell_and_headers(self):
        status, body, h = self.req('GET', '/', token=None, origin=None)
        self.assertEqual(status, 200)
        self.assertIn('PB Console', body)
        self.assertIn("script-src 'self'", h['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', h)
        self.assertEqual(self.req('GET', '/tokens.css', token=None, origin=None)[0], 200)
        self.assertEqual(self.req('GET', '/static/../server.py', token=None, origin=None)[0], 404)

    def test_an_action_runs_and_is_audited(self):
        status, body, _ = self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'wave'}})
        self.assertEqual(status, 200)
        self.assertIn('ran', body)
        self.assertIn('@@result {"ok": true', body)
        self.assertEqual(self.remote.cmds, ['pb-idle wave'])
        self.assertEqual(self.audit_rows()[-1]['action'], 'idle wave')
        self.assertEqual(self.audit_rows()[-1]['result'], 'ok')

    def test_bad_arguments_refused(self):
        for body in ({'action': 'idle', 'args': {'cmd': 'wave; reboot'}},
                     {'action': 'service', 'args': {'unit': 'sshd', 'verb': 'stop', }, 'confirm': True},
                     {'action': 'brightness', 'args': {'value': 2}},
                     {'action': 'night-hours', 'args': {'start': '25:00', 'end': '08:00'}, 'confirm': True},
                     {'action': 'shell', 'args': {'cmd': 'ls'}}):
            self.assertEqual(self.req('POST', '/api/action', body)[0], 400, body)
        self.assertEqual(self.remote.cmds, [])
        self.assertTrue(all(r['result'] == 'refused' for r in self.audit_rows()))

    def test_confirm_needed(self):
        body = {'action': 'service', 'args': {'unit': 'kiosk', 'verb': 'restart'}}
        self.assertEqual(self.req('POST', '/api/action', body)[0], 400)
        self.assertEqual(self.req('POST', '/api/action', dict(body, confirm='yes'))[0], 400)
        self.assertEqual(self.remote.cmds, [])
        self.assertEqual(self.req('POST', '/api/action', dict(body, confirm=True))[0], 200)
        self.assertEqual(self.remote.cmds, ['sudo -n /usr/local/sbin/pb-console-helper unit restart kiosk'])

    def test_busy_guard(self):
        self.remote.busy_result = {'ok': True, 'busy': True, 'casts': [{'at': '2026-10-28T20:00:00', 'name': 'X'}]}
        body = {'action': 'reboot', 'args': {}, 'confirm': True}
        status, out, _ = self.req('POST', '/api/action', body)
        self.assertEqual(status, 409)
        self.assertIn('cast', json.loads(out)['error'])
        self.assertEqual(self.remote.cmds, [])
        self.remote.busy_result = None             # the Pi didn't answer: also refused without the override
        self.assertEqual(self.req('POST', '/api/action', body)[0], 409)
        self.assertEqual(self.req('POST', '/api/action', dict(body, override_busy=True))[0], 200)
        self.assertEqual(len(self.remote.cmds), 1)

    def test_preview_reports_busy_without_running(self):
        self.remote.busy_result = {'ok': True, 'busy': True, 'casts': []}
        status, out, _ = self.req('POST', '/api/preview', {'action': 'service', 'args': {'unit': 'pb-listener', 'verb': 'restart'}})
        d = json.loads(out)
        self.assertEqual(status, 200)
        self.assertTrue(d['confirm'] and d['busy']['busy'])
        self.assertEqual(self.remote.cmds, [])

    def test_one_action_at_a_time(self):
        self.remote.hold = True
        results = []
        t = threading.Thread(target=lambda: results.append(self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'now'}})))
        t.start()
        for _ in range(100):
            if self.app.current:
                break
            time.sleep(0.02)
        status, out, _ = self.req('POST', '/api/action', {'action': 'idle', 'args': {'cmd': 'off'}})
        t.join()
        self.assertEqual(status, 409)
        self.assertTrue(json.loads(out)['locked'])
        self.assertEqual(results[0][0], 200)
        self.assertEqual(self.remote.cmds, ['pb-idle now'])
        self.assertIsNone(self.app.current)

    def test_config_actions_keep_the_laptop_copy_in_step(self):
        body = {'action': 'night', 'args': {'mode': 'night'}, 'confirm': True}
        self.remote.config = 'NIGHT_FORCE=day\n'          # the copies differ: refused
        status, out, _ = self.req('POST', '/api/action', body)
        self.assertEqual(status, 409)
        self.assertIn('config_drift', json.loads(out))
        self.assertEqual(self.remote.cmds, [])
        self.remote.config = 'NIGHT_FORCE=\n'             # the same: runs, then the laptop copy follows the Pi
        orig = self.remote.start

        def start(cmd, stdin=None):
            self.remote.config = 'NIGHT_FORCE=night\n'
            return orig(cmd, stdin)
        self.remote.start = start
        self.assertEqual(self.req('POST', '/api/action', body)[0], 200)
        with open(actions.LAPTOP_CONFIG, 'rb') as f:
            self.assertEqual(f.read(), b'NIGHT_FORCE=night\n')

    def test_logs_checked(self):
        self.assertEqual(self.req('GET', '/api/logs?source=evil')[0], 400)
        self.assertEqual(self.req('GET', '/api/logs?source=pb-listener&since=$(reboot)')[0], 400)
        status, body, _ = self.req('GET', '/api/logs?source=pb-health&since=-2h&lines=20&filter=ran')
        self.assertEqual(status, 200)
        self.assertEqual(self.remote.cmds, ['journalctl --no-pager -o short-iso -n 20 -t pb-health --since -2h '
                                            '--case-sensitive=no --grep ran'])
        self.assertIn('ran', body)
        self.req('GET', '/api/logs?source=pb-listener&filter=' + urllib.parse.quote("it's (x)"))
        self.assertEqual(self.remote.cmds[-1], 'journalctl --no-pager -o short-iso -n 300 -u pb-listener '
                                               r"""--case-sensitive=no --grep 'it'"'"'s\ \(x\)'""")


class ActionTableTests(unittest.TestCase):
    def test_commands_are_fixed(self):
        self.assertEqual(actions.build('idle', {'cmd': 'tour'}).shown, 'pb-idle tour')
        self.assertEqual(actions.build('brightness', {'value': 0.5}).shown, 'pb-idle brightness 0.5')
        a = actions.build('night-hours', {'start': '22:30', 'end': '07:00'})
        self.assertEqual(a.shown, 'sudo -n /usr/local/sbin/pb-console-helper night-hours 22:30 07:00')
        self.assertTrue(a.confirm and a.config and not a.busy)
        r = actions.build('reboot', {})
        self.assertTrue(r.confirm and r.busy)
        self.assertFalse(actions.build('service', {'unit': 'kiosk', 'verb': 'start'}).busy)
        self.assertTrue(actions.build('service', {'unit': 'kiosk', 'verb': 'stop'}).busy)

    def test_the_lists_match_the_helper(self):
        helper = load_helper()
        self.assertEqual(tuple(actions.UNITS), tuple(helper.UNITS))
        self.assertEqual(tuple(actions.VERBS), tuple(helper.VERBS))

    def test_patterns_from_the_repo(self):
        self.assertIn('wave', actions.PATTERNS)
        self.assertIn('glisten', actions.PATTERNS)


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.h = load_helper()

    def test_set_keys(self):
        text = '# comment\nNIGHT_START=23:00\nNIGHT_END=08:00\nNIGHT_FORCE=\n'
        self.assertEqual(self.h.set_keys(text, {'NIGHT_FORCE': 'night'}),
                         '# comment\nNIGHT_START=23:00\nNIGHT_END=08:00\nNIGHT_FORCE=night\n')
        self.assertEqual(self.h.set_keys('A=1\n', {'NIGHT_FORCE': ''}), 'A=1\nNIGHT_FORCE=\n')
        with self.assertRaises(self.h.Refused):
            self.h.set_keys(text, {'NIGHT_FORCE': 'x\nEVIL=1'})
        with self.assertRaises(self.h.Refused):
            self.h.set_keys(text, {'NIGHT_FORCE': '$(reboot)'})

    def test_write_config_backs_up(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, 'config.env')
        with open(path, 'w', newline='\n') as f:
            f.write('NIGHT_FORCE=\n')
        self.h.BACKUPS = os.path.join(tmp, 'backups')
        self.h.log = lambda msg: None
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(self.h.write_config({'NIGHT_FORCE': 'day'}, path))
            self.assertFalse(self.h.write_config({'NIGHT_FORCE': 'day'}, path))      # no change, no backup
        with open(path) as f:
            self.assertEqual(f.read(), 'NIGHT_FORCE=day\n')
        self.assertEqual(len(self.h.backups()), 1)

    def test_refuses_before_running_anything(self):
        ran = []
        self.h.run = lambda *a, **k: ran.append(a) or (0, '')
        self.h.write_config = lambda *a, **k: ran.append(a)
        for cmd, args in (('unit', ['restart', 'ssh']), ('unit', ['kill', 'kiosk']), ('unit', ['stop']),
                          ('reboot', ['now']), ('night', ['dusk']), ('night-hours', ['23:00', '23:00']),
                          ('night-hours', ['9:00', '08:00']), ('screen', ['dim'])):
            with self.assertRaises(self.h.Refused, msg='%s %s' % (cmd, args)):
                self.h.COMMANDS[cmd](args)
        self.assertEqual(ran, [])


class TileTests(unittest.TestCase):
    def test_throttle(self):
        self.assertEqual(tiles.throttle('0x0')[0], tiles.OK)
        self.assertEqual(tiles.throttle('0x50000')[0], tiles.WARN)
        self.assertEqual(tiles.throttle('0x50005')[0], tiles.BAD)
        self.assertEqual(tiles.throttle(None)[0], tiles.UNKNOWN)

    def test_unreachable(self):
        t = tiles.pi_tiles({'ok': False, 'error': 'timed out'})
        self.assertEqual([x['level'] for x in t], [tiles.BAD])

    def probe(self, **kw):
        p = {'ok': True, 'ms': 10, 'mode': 'day clock 12:00', 'time_synced': 'yes',
             'hardware': {'temp_c': 55, 'throttled': '0x0', 'disk_total': 100, 'disk_free': 60,
                          'mem_total': 100, 'mem_available': 50, 'uptime_s': 3600, 'boot_at': 0, 'load': [0.1, 0.1, 0.1]},
             'wifi': {'ssid': 'Hangout', 'signal': 70}, 'tailscale': {'state': 'Running'},
             'services': {u: {'ActiveState': 'active', 'NRestarts': '0'} for u in tiles.SERVICE_TITLES},
             'timers': {t: {'ActiveState': 'active', 'service_result': 'success'} for t in tiles.TIMER_TITLES},
             'listener': {'state': 'joined', 'file_age_s': 3, 'leds': 'wave', 'idle_pattern': 'wave'},
             'health': {}, 'errors': {'last24h': {}, 'before': {}}}
        for k, v in kw.items():
            p[k] = v
        return {t['id']: t for t in tiles.pi_tiles(p, now=1000)}

    def test_all_well(self):
        t = self.probe()
        self.assertTrue(all(x['level'] == tiles.OK for x in t.values()), [(k, x['level']) for k, x in t.items()])

    def test_thresholds(self):
        self.assertEqual(self.probe(hardware={'temp_c': 82, 'throttled': '0x0'})['hw']['level'], tiles.BAD)
        self.assertEqual(self.probe(hardware={'temp_c': 50, 'throttled': '0x1'})['hw']['level'], tiles.BAD)
        self.assertEqual(self.probe(wifi={'ssid': 'Hangout', 'signal': 35})['wifi']['level'], tiles.WARN)
        self.assertEqual(self.probe(wifi={'ssid': None})['wifi']['level'], tiles.BAD)
        self.assertEqual(self.probe(wifi={'ssid': 'x', 'signal': 90, 'rescue_up': True})['wifi']['level'], tiles.BAD)
        self.assertEqual(self.probe(listener={'state': 'joined', 'file_age_s': 200})['listener']['level'], tiles.BAD)
        self.assertEqual(self.probe(listener={'state': 'connecting', 'file_age_s': 3, 'disconnected_since': 900})['listener']['level'], tiles.WARN)
        self.assertEqual(self.probe(errors={'last24h': {'kernel': 600}, 'before': {}})['errors']['level'], tiles.BAD)

    def test_kiosk_off_at_night_is_fine(self):
        services = {u: {'ActiveState': 'active', 'NRestarts': '0'} for u in tiles.SERVICE_TITLES}
        services['kiosk'] = {'ActiveState': 'inactive'}
        self.assertEqual(self.probe(services=services, mode='night clock 23:30')['svc-kiosk']['level'], tiles.OK)
        self.assertEqual(self.probe(services=services)['svc-kiosk']['level'], tiles.BAD)

    def test_listener_paused_for_mapping(self):
        services = {u: {'ActiveState': 'active', 'NRestarts': '0'} for u in tiles.SERVICE_TITLES}
        services['pb-listener'] = {'ActiveState': 'inactive'}
        services['pb-ledmap'] = {'ActiveState': 'active'}
        t = self.probe(services=services, listener=None)
        self.assertEqual(t['svc-pb-listener']['level'], tiles.WARN)

    def test_site_version(self):
        lap = {'live': {'status': 200, 'cache': 'pb-5557a7c0a3'}, 'repo_cache': 'pb-0123456789', 'supabase': {'status': 200},
               'realtime': {'ok': True, 'ms': 300, 'at': time.time()}}
        site, sb = tiles.laptop_tiles(lap)
        self.assertEqual(site['level'], tiles.WARN)
        self.assertEqual(sb['level'], tiles.OK)
        lap['realtime'] = {'ok': False, 'error': 'refused'}
        self.assertEqual(tiles.laptop_tiles(lap)[1]['level'], tiles.BAD)


    def test_metrics(self):
        p = {'ok': True, 'ms': 10, 'hardware': {'temp_c': 55, 'throttled': '0x0', 'disk_total': 100, 'disk_free': 60,
                                                'mem_total': 100, 'mem_available': 50},
             'wifi': {'ssid': 'Hangout', 'signal': 70}, 'listener': {'state': 'joined'}, 'casts_24h': 3,
             'casts_recent': [{'at': 'x', 'name': 'a', 'mirror': False}],
             'errors': {'last24h': {'kernel': 5, 'kiosk': 2}, 'before': {'kernel': 1}}, 'health': {}}
        m = tiles.metrics(p, {'live': {'status': 200, 'cache': 'pb-5557a7c0a3'}, 'repo_cache': 'pb-5557a7c0a3'})
        self.assertAlmostEqual(m['hw']['disk_used'], 0.4)
        self.assertAlmostEqual(m['hw']['mem_used'], 0.5)
        self.assertEqual(m['errors']['total'], 7)
        self.assertEqual(m['errors']['sources'][0], ['kernel', 5, 1])
        self.assertEqual(m['listener']['casts_24h'], 3)
        self.assertEqual(m['site']['cache'], 'pb-5557a7c0a3')
        down = tiles.metrics({'ok': False}, None)
        self.assertFalse(down['pi_ok'])
        self.assertNotIn('hw', down)


if __name__ == '__main__':
    unittest.main()
