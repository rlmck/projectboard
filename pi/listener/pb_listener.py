#!/usr/bin/env python3
"""Project Board cast listener (pb-listener.service).

Supabase Realtime broadcasts on board:<wall> -> the WS2801 strip: `cast_problem`
lights a problem, `cast_circuit` runs a circuit (circuit.py), `stop` ends it.
Built to docs/cast-contract.md; the resilience rules are in the local
docs/pi4-listener-kiosk-plan.md, section R1:

- systemd Type=notify: READY once the strip is cleared (before any network),
  WATCHDOG every 10 s while the event loop runs, connected or not.
- Reconnect backoff 1 s doubling to 60 s with jitter; Phoenix heartbeat every
  25 s; no heartbeat reply for 60 s = dead socket.
- Every cast is checked; a bad one is logged and skipped. Latest cast wins.
- Night mode (mode.py): the strip fades out and casts are ignored, but the
  socket stays joined.
- The strip belongs to the LED thread (renderer.py): a cast is lit at once,
  IDLE_AFTER_S after the last cast the idle pattern (patterns/, IDLE_PATTERN)
  fades in, and at night the strip fades to black. SIGUSR1 = idle now.
  SIGUSR2 = read pb-idle's choice from /run/projectboard/idle-pattern (the
  file is removed at start, so a restart goes back to config.env).
- The benchmark problems (for the teaser pattern) are read every half hour.
- Status in /run/projectboard/listener.json for pb-health and pb-status.

    pb_listener.py [--dry-run] [--config FILE] [--status FILE]
"""
import asyncio
import json
import os
import random
import signal
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board  # noqa: E402
import circuit  # noqa: E402
import leds as ledlib  # noqa: E402
import mode as modelib  # noqa: E402
import renderer  # noqa: E402
import supa  # noqa: E402
from patterns import teaser  # noqa: E402

from websockets.asyncio.client import connect  # noqa: E402

HEARTBEAT_EVERY = 25
HEARTBEAT_DEAD = 60
JOIN_TIMEOUT = 15
BACKOFF_MAX = 60
STABLE_AFTER = 60          # a connection joined this long resets the backoff
TICK = 10                  # watchdog ping and status write
MODE_EVERY = 30
MIRROR_EVERY = 600
BENCHMARKS_EVERY = 1800    # the teaser's problems: one small read
IDLE_FILE = 'idle-pattern'  # pb-idle writes it next to the status file, then sends SIGUSR2
LED_STALL = 20             # the LED thread silent this long = stuck: exit, systemd restarts us


def log(msg, level=6):
    # <N> prefix: journald reads it as the priority (3 err, 4 warning, 6 info).
    print('<%d>%s' % (level, msg), flush=True)


def warn(msg):
    log(msg, 4)


def err(msg):
    log(msg, 3)


def sd_notify(msg):
    addr = os.environ.get('NOTIFY_SOCKET')
    if not addr:
        return
    if addr[0] == '@':
        addr = '\0' + addr[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.connect(addr)
            s.sendall(msg.encode())
    except OSError as e:
        warn('sd_notify failed: %s' % e)


class DeadSocket(Exception):
    pass


class Listener:
    def __init__(self, cfg_path, dry_run, status_path):
        self.cfg_path = cfg_path
        self.cfg = modelib.load_config(cfg_path)
        for k in ('SUPABASE_URL', 'SUPABASE_ANON_KEY'):
            if not self.cfg.get(k):
                raise SystemExit('%s is empty in %s' % (k, cfg_path or modelib.CONFIG))
        self.strip = ledlib.make_strip(self.cfg, dry_run)
        self.status_path = status_path
        self.topic = 'realtime:board:' + self.cfg['BOARD_WALL']
        host = self.cfg['SUPABASE_URL'].rstrip('/').replace('https://', 'wss://', 1)
        self.ws_url = '%s/realtime/v1/websocket?apikey=%s&vsn=1.0.0' % (host, self.cfg['SUPABASE_ANON_KEY'])
        self.pending = None
        self.cast_ready = asyncio.Event()
        self.mirror_wanted = asyncio.Event()
        self.benchmarks_wanted = asyncio.Event()
        self.idle_file = os.path.join(os.path.dirname(status_path), IDLE_FILE) if status_path else None
        self.stop = asyncio.Event()
        self.mirror_map = None
        self.mode, self.mode_reason = modelib.mode_now(self.cfg)
        self.leds = renderer.Renderer(self.strip, self.cfg, self.mode == 'night', log, warn, err)
        now = time.time()
        self.status = {
            'pid': os.getpid(), 'started_at': now, 'mode': self.mode, 'mode_reason': self.mode_reason,
            'state': 'starting', 'connected_since': None, 'disconnected_since': now,
            'last_message_at': None, 'last_cast_at': None, 'last_cast_name': None,
            'casts_shown': 0, 'circuits_shown': 0, 'casts_ignored_night': 0, 'error_count': 0, 'last_error': None,
            'mirror_map_at': None, 'updated_at': now,
            'leds': None, 'idle_pattern': None, 'idle_plan': None, 'idle_override': None, 'benchmarks': None,
            'idle_fps': None, 'idle_frame_ms': None, 'idle_capped_frames': 0, 'led_write_errors': 0,
        }

    # -- status -------------------------------------------------------------

    def set(self, **kw):
        self.status.update(kw)
        self.write_status()

    def error(self, msg):
        err(msg)
        self.status['error_count'] += 1
        self.status['last_error'] = '%s %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg[:200])
        self.write_status()

    def write_status(self):
        if not self.status_path:
            return
        self.status['updated_at'] = time.time()
        tmp = self.status_path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.status, f)
            os.replace(tmp, self.status_path)
        except OSError as e:
            warn('status file not written: %s' % e)

    def set_state(self, state):
        if state == self.status['state']:
            return
        now = time.time()
        if state == 'joined':
            self.set(state=state, connected_since=now, disconnected_since=None)
        elif self.status['state'] == 'joined':
            self.set(state=state, connected_since=None, disconnected_since=now)
        else:
            self.set(state=state)

    # -- the strip ----------------------------------------------------------

    async def clear(self, why):
        """Only before the LED thread starts and after it stops: it owns the strip in between."""
        try:
            await asyncio.to_thread(self.strip.clear)
            log('strip cleared (%s)' % why)
        except Exception as e:
            self.error('clearing the strip failed (%s): %s' % (why, e))

    def idle_now(self):
        log('SIGUSR1: idle now')
        self.leds.idle_now()

    def idle_pattern(self):
        """SIGUSR2 from pb-idle: its choice is in the idle file."""
        try:
            with open(self.idle_file, encoding='utf-8') as f:
                spec = f.read(200).strip()
        except (OSError, TypeError) as e:
            warn('SIGUSR2 but no idle pattern to read: %s' % e)
            return
        log('SIGUSR2: idle pattern %r' % spec)
        self.leds.set_pattern(spec)
        # Show it in listener.json straight away (pb-idle reads it back), not at the next tick.
        asyncio.get_running_loop().call_later(0.5, self.refresh_leds_status)

    def refresh_leds_status(self):
        self.status.update(self.leds.stats(reset=False))
        self.write_status()

    # -- background tasks ---------------------------------------------------

    async def ticker(self):
        """The watchdog ping proves the event loop is running, connected or not."""
        last_mode = 0.0
        while True:
            if not self.leds.is_alive():
                raise RuntimeError('the LED thread died')
            if time.monotonic() - self.leds.beat > LED_STALL:
                raise RuntimeError('the LED thread is stuck (%d s)' % (time.monotonic() - self.leds.beat))
            self.status.update(self.leds.stats())
            sd_notify('WATCHDOG=1')
            if time.monotonic() - last_mode >= MODE_EVERY:
                last_mode = time.monotonic()
                await self.check_mode()
            self.write_status()
            await asyncio.sleep(TICK)

    async def check_mode(self):
        try:
            self.cfg = modelib.load_config(self.cfg_path)   # night times can change without a restart
        except OSError as e:
            warn('config unreadable, keeping the last one: %s' % e)
        mode, reason = modelib.mode_now(self.cfg)
        self.status['mode_reason'] = reason
        if mode == self.mode:
            return
        log('mode %s -> %s (%s)' % (self.mode, mode, reason))
        self.mode = mode
        self.set(mode=mode)
        if mode == 'night':
            self.pending = None
        self.leds.set_night(mode == 'night')

    async def mirror_loop(self):
        while True:
            try:
                await asyncio.wait_for(self.mirror_wanted.wait(), MIRROR_EVERY)
            except asyncio.TimeoutError:
                pass
            self.mirror_wanted.clear()
            try:
                mm = board.check_mirror_map(await asyncio.to_thread(supa.fetch_mirror_map, self.cfg))
                if mm != self.mirror_map:
                    log('mirror map loaded: %d entries' % len(mm))
                self.mirror_map = mm
                self.set(mirror_map_at=time.time())
            except Exception as e:
                self.error('mirror map not loaded (%s): %s' % (
                    'keeping the last one' if self.mirror_map is not None else 'mirrored casts skipped', e))

    async def benchmarks_loop(self):
        while True:
            try:
                await asyncio.wait_for(self.benchmarks_wanted.wait(), BENCHMARKS_EVERY)
            except asyncio.TimeoutError:
                pass
            self.benchmarks_wanted.clear()
            try:
                found = teaser.from_rows(await asyncio.to_thread(supa.fetch_benchmarks, self.cfg))
            except Exception as e:      # only the teaser needs them: a warning, not an error
                warn('benchmarks not loaded (the teaser keeps the last ones): %s: %s' % (type(e).__name__, e))
                continue
            if len(found) != self.status['benchmarks']:
                log('benchmarks loaded: %d' % len(found))
            self.status['benchmarks'] = len(found)
            self.leds.set_benchmarks(found)

    async def worker(self):
        while True:
            await self.cast_ready.wait()
            self.cast_ready.clear()
            job, self.pending = self.pending, None
            if job:
                kind, args = job[0], job[1:]
                try:
                    await (self.show_circuit if kind == 'circuit' else self.show)(*args)
                except Exception as e:
                    self.error('%s %r failed: %s: %s' % (
                        'circuit' if kind == 'circuit' else 'cast', args[0], type(e).__name__, e))

    async def show(self, name, mirror, t0):
        row = await asyncio.to_thread(supa.fetch_problem, self.cfg, name)
        if self.pending:
            log('cast %r superseded by %r before it was shown' % (name, self.pending[1]))
            return
        if row is None:
            warn('unknown problem %r: board left as it is' % name)
            return
        if mirror and self.mirror_map is None:
            self.error('mirrored cast %r skipped: no mirror map loaded' % name)
            return
        leds, dropped = board.frame(row, mirror, self.mirror_map)
        if dropped:
            warn('cast %r: hold ids off the grid ignored: %s' % (name, dropped))
        out, cap, ma = board.scale(leds, self.cfg['BRIGHTNESS'], float(self.cfg['POWER_BUDGET_MA']),
                                   float(self.cfg['MA_PER_CHANNEL']))
        if self.mode == 'night':
            log('cast %r ignored: night began while it was fetched' % name)
            return
        self.leds.cast(out)         # the LED thread writes it at once, cutting into any animation
        self.status['casts_shown'] += 1
        self.set(last_cast_at=time.time(), last_cast_name=name)
        log('lit %r%s: %d LEDs, ~%d mA%s in %d ms' % (
            name, ' mirrored' if mirror else '', len(out), ma,
            ' (capped x%.2f)' % cap if cap < 1 else '', (time.monotonic() - t0) * 1000))

    async def show_circuit(self, name, interval, loop, mirror, token, tag, t0):
        row = await asyncio.to_thread(supa.fetch_circuit, self.cfg, name)
        if self.pending:
            log('circuit %r superseded by %r before it started' % (name, self.pending[1]))
            return
        if row is None:
            warn('unknown circuit %r: board left as it is' % name)
            return
        if mirror and self.mirror_map is None:
            self.error('mirrored circuit %r skipped: no mirror map loaded' % name)
            return
        if loop is None:
            loop = bool(row.get('loops'))
        run = circuit.Run(name, row.get('hold_sequence'), row.get('start_count'), interval, loop, token,
                          self.mirror_map if mirror else None, tag)
        if run.dropped:
            warn('circuit %r: hold ids off the grid ignored: %s' % (name, sorted(run.dropped)))
        if self.mode == 'night':
            log('circuit %r ignored: night began while it was fetched' % name)
            return
        self.leds.circuit(run)      # the countdown starts now
        self.status['circuits_shown'] += 1
        self.set(last_cast_at=time.time(), last_cast_name='circuit: ' + name)
        log('circuit started %r%s: %d holds, %d moves, %g s a move, %s, run %s, in %d ms' % (
            name, ' mirrored' if mirror else '', run.L, run.moves, interval, 'loop' if loop else 'once',
            token or '-', (time.monotonic() - t0) * 1000))

    # -- casts --------------------------------------------------------------

    def on_cast(self, body):
        if not isinstance(body, dict):
            warn('cast_problem with a non-object payload ignored: %r' % (body,))
            return
        name = body.get('problem_name')
        mirror = body.get('mirror', False)
        if not isinstance(name, str) or not 1 <= len(name) <= 60:
            warn('cast_problem with a bad problem_name ignored: %r' % (body,))
            return
        if mirror not in (True, False):
            warn('cast_problem with a bad mirror ignored: %r' % (body,))
            return
        tag = board.origin(body)            # ' [wall, guest]': PB Console's Activity reads it
        if self.mode == 'night':
            self.status['casts_ignored_night'] += 1
            log('cast %r%s ignored: night mode%s' % (name, ' mirrored' if mirror else '', tag))
            self.write_status()
            return
        log('cast received: %r%s%s' % (name, ' mirrored' if mirror else '', tag))
        self.pending = ('problem', name, mirror, time.monotonic())
        self.cast_ready.set()

    def on_circuit(self, body):
        """cast_circuit (contract 8): circuit_name, interval (s a move), loop, mirror, run token."""
        if not isinstance(body, dict):
            warn('cast_circuit with a non-object payload ignored: %r' % (body,))
            return
        name, interval = body.get('circuit_name'), body.get('interval')
        loop, mirror, token = body.get('loop'), body.get('mirror', False), body.get('run')
        if not isinstance(name, str) or not 1 <= len(name) <= 60:
            warn('cast_circuit with a bad circuit_name ignored: %r' % (body,))
            return
        if isinstance(interval, bool) or not isinstance(interval, (int, float)) \
                or not circuit.MIN_INTERVAL <= interval <= circuit.MAX_INTERVAL:
            warn('cast_circuit with a bad interval ignored: %r' % (body,))
            return
        if loop not in (True, False, None) or mirror not in (True, False):
            warn('cast_circuit with a bad loop or mirror ignored: %r' % (body,))
            return
        if token is not None and (not isinstance(token, str) or not 1 <= len(token) <= 64):
            warn('cast_circuit with a bad run token ignored: %r' % (body,))
            return
        tag = board.origin(body)
        if self.mode == 'night':
            self.status['casts_ignored_night'] += 1
            log('circuit %r ignored: night mode%s' % (name, tag))
            self.write_status()
            return
        how = 'loop' if loop else 'once' if loop is False else "the circuit's loop setting"
        log('circuit received: %r%s, %g s a move, %s%s' % (name, ' mirrored' if mirror else '', interval, how, tag))
        self.pending = ('circuit', name, float(interval), loop, mirror, token, tag, time.monotonic())
        self.cast_ready.set()

    def on_stop(self, body):
        """stop (contract 8): ends the circuit run with this run token, or any run without one."""
        body = body if isinstance(body, dict) else {}
        token = body.get('run')
        if token is not None and not isinstance(token, str):
            warn('stop with a bad run token ignored: %r' % (body,))
            return
        if self.pending and self.pending[0] == 'circuit' and token in (None, self.pending[5]):
            self.pending = None             # stopped before it was even fetched
        log('stop received: run %s%s' % (token or 'any', board.origin(body)))
        self.leds.stop_circuit(token)

    EVENTS = {'cast_problem': on_cast, 'cast_circuit': on_circuit, 'stop': on_stop}

    # -- the socket ---------------------------------------------------------

    def handle(self, raw):
        """One frame. Returns 'heartbeat' for a heartbeat reply; raises DeadSocket on channel errors."""
        self.status['last_message_at'] = time.time()
        try:
            m = json.loads(raw)
        except ValueError:
            warn('non-JSON frame ignored: %r' % raw[:200])
            return None
        if not isinstance(m, dict):
            return None
        topic, event = m.get('topic'), m.get('event')
        if topic == 'phoenix' and event == 'phx_reply':
            return 'heartbeat'
        if topic != self.topic:
            return None
        if event in ('phx_error', 'phx_close'):
            raise DeadSocket('channel %s' % event)
        if event == 'broadcast':
            p = m.get('payload') or {}
            fn = self.EVENTS.get(p.get('event'))
            if fn:
                fn(self, p.get('payload'))
        elif event == 'system':
            p = m.get('payload') or {}
            if p.get('status') not in (None, 'ok'):
                warn('Realtime system message: %r' % (p,))
        return None

    async def join(self, ws):
        await ws.send(json.dumps({'topic': self.topic, 'event': 'phx_join', 'ref': '1', 'payload': {
            'config': {'broadcast': {'self': False, 'ack': False}, 'presence': {'key': ''}, 'private': False},
            'access_token': self.cfg['SUPABASE_ANON_KEY']}}))
        deadline = time.monotonic() + JOIN_TIMEOUT
        while True:
            raw = await asyncio.wait_for(ws.recv(), max(0.1, deadline - time.monotonic()))
            self.status['last_message_at'] = time.time()
            m = json.loads(raw)
            if m.get('topic') == self.topic and m.get('event') == 'phx_reply' and m.get('ref') == '1':
                status = (m.get('payload') or {}).get('status')
                if status != 'ok':
                    raise DeadSocket('join refused: %r' % (m.get('payload'),))
                return

    async def pump(self, ws):
        ref = 100
        sent = replied = time.monotonic()
        while True:
            wait = max(0.1, sent + HEARTBEAT_EVERY - time.monotonic())
            try:
                raw = await asyncio.wait_for(ws.recv(), wait)
            except asyncio.TimeoutError:
                raw = None
            if raw is not None and self.handle(raw) == 'heartbeat':
                replied = time.monotonic()
            now = time.monotonic()
            if now - replied > HEARTBEAT_DEAD:
                raise DeadSocket('no heartbeat reply for %d s' % (now - replied))
            if now - sent >= HEARTBEAT_EVERY:
                ref += 1
                await ws.send(json.dumps({'topic': 'phoenix', 'event': 'heartbeat', 'payload': {}, 'ref': str(ref)}))
                sent = now

    async def connection(self):
        attempt = 0
        while True:
            self.set_state('connecting')
            joined_at = None
            try:
                async with connect(self.ws_url, open_timeout=15, ping_interval=None, close_timeout=5,
                                   max_size=1 << 20) as ws:
                    await self.join(ws)
                    joined_at = time.monotonic()
                    self.set_state('joined')
                    log('joined %s' % self.topic)
                    self.mirror_wanted.set()
                    if self.status['benchmarks'] is None:
                        self.benchmarks_wanted.set()
                    await self.pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.error('connection lost: %s: %s' % (type(e).__name__, e))
            if joined_at is not None and time.monotonic() - joined_at >= STABLE_AFTER:
                attempt = 0
            delay = min(BACKOFF_MAX, 2 ** attempt) * random.uniform(0.5, 1.0)
            attempt += 1
            self.set_state('backoff')
            log('reconnecting in %.1f s' % delay)
            await asyncio.sleep(delay)

    # -- main ---------------------------------------------------------------

    async def run(self):
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.stop.set)
            except (NotImplementedError, AttributeError):
                pass                      # Windows, when testing on the laptop
        if hasattr(signal, 'SIGUSR1'):
            loop.add_signal_handler(signal.SIGUSR1, self.idle_now)
            loop.add_signal_handler(signal.SIGUSR2, self.idle_pattern)
        if self.idle_file:
            try:
                os.remove(self.idle_file)       # pb-idle's choice lasts until a restart
            except FileNotFoundError:
                pass
            except OSError as e:
                warn('could not remove %s: %s' % (self.idle_file, e))
        log('starting: %s, mode %s (%s)' % (self.topic, self.mode, self.mode_reason))
        await self.clear('start')
        self.leds.start()
        self.write_status()
        sd_notify('READY=1')
        tasks = [asyncio.create_task(c) for c in
                 (self.ticker(), self.mirror_loop(), self.benchmarks_loop(), self.worker(), self.connection())]
        stopper = asyncio.create_task(self.stop.wait())
        done, _ = await asyncio.wait(tasks + [stopper], return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            if t is not stopper and t.exception():
                err('task died: %r' % t.exception())
        sd_notify('STOPPING=1')
        for t in tasks + [stopper]:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending = None
        self.leds.stop()
        await asyncio.to_thread(self.leds.join, 5)
        await self.clear('stop')
        self.set_state('stopped')
        log('stopped')
        # A task dying is a bug: exit non-zero so systemd restarts us.
        return 0 if self.stop.is_set() else 1


def main(argv):
    path = argv[argv.index('--config') + 1] if '--config' in argv else None
    status = argv[argv.index('--status') + 1] if '--status' in argv else '/run/projectboard/listener.json'
    if '--no-status' in argv:
        status = None
    listener = Listener(path, '--dry-run' in argv, status)
    try:
        return asyncio.run(listener.run())
    except KeyboardInterrupt:
        return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
