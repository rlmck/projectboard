"""The LED thread: the only thing that writes to the strip while the listener runs.

Five states (night always wins):
- cast:  a problem is lit (a cast cuts straight in, no fade);
- circuit: a circuit run is animating (circuit.py: countdown, the moving holds,
         the finish), from a cast_circuit; a stop with its run token (or none),
         its finish, or CIRCUIT_MAX_S (a forgotten loop) crossfades into idle
         (or back to a preview still going). A problem cast or another circuit
         cuts straight in;
- preview: the holds someone is setting on Create/Edit, from preview_holds
         (contract 9), lit at once on every change. It ends with an `end`
         message, after PREVIEW_TIMEOUT_S with no message (the app sends a
         keep-alive), at night, or when SIGUSR1 asks for idle, and then goes
         idle. A problem cast takes the board from it, and so does another
         person's preview (the latest wins): that session is then "taken over"
         and its messages are ignored until one says `show` (the app's Show on
         board). A circuit cast wins too, but the preview waits and comes back
         when the run ends, if it's still going;
- idle:  an idle pattern (patterns/: IDLE_PATTERN, one pattern or a cycle),
         from IDLE_AFTER_S after the last cast, and at start and at the end
         of the night; it fades in over 1.5 s. With IDLE_ANIMATION=off the
         strip is just cleared;
- night: a 3 s fade to black, then the strip cleared.

The event loop never waits on it: cast(), circuit(), stop_circuit(), preview(), preview_end(),
set_night(), idle_now(),
set_pattern() (pb-idle: a pattern, off, brightness), set_benchmarks() and
stop() only post a command and
wake the thread. step() does one round of work and
says how long to sleep, so the tests drive it with a fake clock and no thread.

pb-idle's runtime overrides (until the next restart): `off` takes the board dark
now (a lit problem too) and keeps idle dark, while casts still light; any
pattern or `default` ends it. `brightness K` (0.05-1) dims everything written,
casts and idle, to K of its configured brightness, never brighter. Frames are
kept undimmed in `shown`; the dimming is applied only at the strip.

A pattern that throws is replaced by Glisten (patterns/idle.py). If Glisten
throws too, it's logged once, the strip is cleared and idle stays dark until
the next restart; casts carry on. `beat` is the time of the last loop
round: the listener exits (and systemd restarts it) if it goes stale.
"""
import threading
import time
import traceback

import board
import patterns
from patterns.common import blend, dim, smooth

CAST, RUN, IDLE, NIGHT, PREVIEW = 'cast', 'circuit', 'idle', 'night', 'preview'
TAKEN_KEEP = 3600         # s a taken-over preview session is remembered (it needs `show` to come back)
TAKEN_MAX = 50
FADE_TO_IDLE = 1.5        # s, the lit problem (or black) crossfading into the idle pattern
FADE_TO_NIGHT = 3.0       # s, whatever is showing fading to black at the start of the night
# Animation frames write pixels 0-247 only: 6 ms at 1 MHz instead of 29 ms for
# all 1200. Pixels past the board stay dark from the full clear before them.
BOARD_PIXELS = board.MAX_HOLD + 1
MAX_SLEEP = 1.0           # the loop comes round at least this often (keeps `beat` fresh)
SCALE_MIN = 0.05          # pb-idle brightness: the lowest it takes (1 = as configured)


def _on(v):
    return (v or '').strip().lower() not in ('off', 'no', '0', 'false')


class Renderer:
    def __init__(self, strip, cfg, night, log=print, warn=print, err=print, clock=time.monotonic, seed=None):
        self.strip = strip
        self.log, self.warn, self.err = log, warn, err
        self.clock = clock
        self.seed = seed
        self.idle_after = float(cfg.get('IDLE_AFTER_S') or 1200)
        self.animate = _on(cfg.get('IDLE_ANIMATION'))
        self.dt = 1.0 / max(1.0, min(60.0, float(cfg.get('IDLE_FPS') or 30)))
        # A circuit run's frames: the cast brightness and current cap, as a problem's (board.scale).
        self.cast_args = (float(cfg.get('BRIGHTNESS') or 0.5), float(cfg.get('POWER_BUDGET_MA') or 8000),
                          float(cfg.get('MA_PER_CHANNEL') or 20))
        self.run_max = float(cfg.get('CIRCUIT_MAX_S') or 1800)
        self.circ = None            # the circuit.Run animating (state RUN)
        self.run_t0 = None
        self.run_full = False       # the run's first frame clears the whole strip
        self.pv_timeout = float(cfg.get('PREVIEW_TIMEOUT_S') or 60)
        self.pv = None              # the preview going: {'token', 'frame', 'last'} (shown, or waiting on a circuit)
        self.pv_taken = {}          # token -> when: sessions a cast or another preview took the board from
        self.pv_night = set()       # sessions already logged as not shown at night
        self.idle_args = dict(brightness=float(cfg.get('IDLE_BRIGHTNESS') or 1.0),
                              max_ma=float(cfg.get('IDLE_MAX_AMPS') or 2.0) * 1000,
                              ma_per_channel=float(cfg.get('MA_PER_CHANNEL') or 20))
        # What idle shows: config.env's plan, unless pb-idle has set another (until a restart).
        self.config_plan, self.cycle_plan = patterns.config_plans(cfg, clock(), warn)
        self.override = None
        self.override_spec = None
        self.dark = False           # pb-idle off: idle stays dark (casts still light)
        self.scale = 1.0            # pb-idle brightness: everything written dimmed to this
        self.ctx = {'benchmarks': []}       # shared with the patterns (the teaser reads it)
        self._lock = threading.Lock()
        self._cmds = []
        self._wake = threading.Event()
        self._stopping = False
        self._thread = None
        self.state = NIGHT if night else None      # None: not started; the first step goes idle
        self.shown = {}             # the frame on the strip now
        self.cast_at = None
        self.fade = None            # (start, seconds, the frame it fades from)
        self.anim = None
        self.anim_t0 = None
        self.next_frame = None
        self.broken = False         # Glisten (the fallback) threw: idle stays dark until a restart
        self.cap_logged = False
        self.write_errors = 0
        self.beat = clock()
        self.frames = 0             # animation frames written (window for the status)
        self.busy = 0.0             # seconds spent rendering + writing them
        self.window_at = clock()

    # -- called from the event loop (any thread) ----------------------------------

    def _post(self, cmd):
        with self._lock:
            self._cmds.append(cmd)
        self._wake.set()

    def cast(self, frame):
        self._post(('cast', frame))

    def circuit(self, run):
        """A circuit.Run: its countdown starts now."""
        self._post(('circuit', run))

    def stop_circuit(self, token=None):
        """End the running circuit: the one with this run token, or any with None."""
        self._post(('stop', token))

    def preview(self, token, frame, show=False):
        """preview_holds: session `token` is setting these LEDs ({led: rgb}, already scaled).
        show: the app's Show on board, which takes the board back after a takeover."""
        self._post(('preview', (token, frame, bool(show))))

    def preview_end(self, token):
        self._post(('preview_end', token))

    def set_night(self, night):
        self._post(('night', bool(night)))

    def idle_now(self):
        self._post(('idle', None))

    def set_pattern(self, spec):
        """pb-idle: a pattern name, 'cycle' (IDLE_CYCLE), 'tour' (each for TOUR_S, once), 'default',
        'off' (dark when idle) or 'brightness K'."""
        self._post(('pattern', spec))

    def set_benchmarks(self, benchmarks):
        """[(name, {cell: role})] for the teaser (patterns/teaser.py from_rows)."""
        self._post(('benchmarks', benchmarks))

    def start(self):
        self._thread = threading.Thread(target=self.run, name='leds', daemon=True)
        self._thread.start()

    def stop(self):
        self._stopping = True
        self._wake.set()

    def join(self, timeout=None):
        if self._thread:
            self._thread.join(timeout)

    def is_alive(self):
        return bool(self._thread and self._thread.is_alive())

    def plan(self):
        return self.override or self.config_plan

    def stats(self, reset=True):
        """For listener.json; resets the frame-rate window (unless reset=False)."""
        now = self.clock()
        span, frames, busy = now - self.window_at, self.frames, self.busy
        if reset:
            self.frames, self.busy, self.window_at = 0, 0.0, now
        anim = self.anim if self.state == IDLE and self.animate and not self.broken and not self.dark else None
        s = {'leds': anim.name if anim else ('off' if self.dark else 'dark') if self.state == IDLE else self.state,
             'idle_pattern': anim.label if anim else None,
             'idle_plan': ('off (pb-idle)' if self.dark else 'off (IDLE_ANIMATION)' if not self.animate
                           else 'dark (Glisten failed)' if self.broken else self.plan().summary()),
             'idle_override': 'off' if self.dark else self.override_spec,
             'brightness_scale': self.scale,
             'idle_fps': round(frames / span, 1) if frames and span > 0 else None,
             'idle_frame_ms': round(busy / frames * 1000, 1) if frames else None,
             'idle_capped_frames': self.anim.capped_frames if self.anim else 0,
             'led_write_errors': self.write_errors}
        return s

    # -- the thread ---------------------------------------------------------------

    def run(self):
        while not self._stopping:
            self.beat = self.clock()
            self._wake.clear()
            try:
                wait = self.step(self.clock())
            except Exception as e:      # a bug here must not kill the thread
                self.err('LED thread: %s: %s' % (type(e).__name__, e))
                wait = MAX_SLEEP
            self._wake.wait(min(max(wait, 0.0), MAX_SLEEP))

    def _write(self, frame, full):
        try:
            self.strip.write(dim(frame, self.scale) if self.scale < 1 else frame, None if full else BOARD_PIXELS)
        except Exception as e:
            self.write_errors += 1
            if self.write_errors == 1 or self.write_errors % 1000 == 0:
                self.err('writing the strip failed (%d so far): %s: %s' % (self.write_errors, type(e).__name__, e))
            return False
        self.shown = frame
        return True

    def _go_idle(self, now, why):
        self.state = IDLE
        if self.dark:
            self.log('LEDs: idle, off (pb-idle) (%s)' % why)
            self.anim = None
            if self.shown:
                self.fade = (now, FADE_TO_IDLE, self.shown)
            else:
                self.fade = None
                self._write({}, True)
        elif self.animate and not self.broken:
            plan = self.plan()
            if plan.epoch is None:          # a pb-idle tour or cycle starts when it first shows
                plan.epoch = now
            self.anim = patterns.Idle(plan, now, self.ctx, log=self.log, err=self.err, seed=self.seed,
                                      **self.idle_args)
            self.log('LEDs: idle, %s (%s)' % (self.anim.label, why))
            self.anim_t0 = now
            self.fade = (now, FADE_TO_IDLE, self.shown)
            self.next_frame = now
        else:
            self.log('LEDs: cleared (%s%s)' % (why, ', IDLE_ANIMATION off' if not self.broken else ''))
            self.fade = None
            self._write({}, True)

    def step(self, now):
        """One round: take the commands, change state, write at most one frame. Returns seconds to sleep."""
        with self._lock:
            cmds, self._cmds = self._cmds, []
        for kind, arg in cmds:
            if kind == 'cast':
                if self.state == NIGHT:
                    self.log('LEDs: cast not shown, night')
                    continue
                self._end_circuit(now, 'replaced')
                self._take_preview(now, 'a problem cast')
                self.state, self.fade, self.cast_at, self.circ = CAST, None, now, None
                self._write(arg, True)
            elif kind == 'circuit':
                if self.state == NIGHT:
                    self.log('LEDs: circuit not shown, night')
                    continue
                self._end_circuit(now, 'replaced')
                if self.state == PREVIEW and self.pv:
                    self.log('LEDs: preview %s waits for the circuit' % self.pv['token'])
                self.state, self.fade, self.circ, self.run_t0, self.run_full = RUN, None, arg, now, True
                self.next_frame = now
            elif kind == 'stop':
                if self.state == RUN and (arg is None or arg == self.circ.token):
                    self._end_circuit(now, 'stopped')
                    self._after_run(now, 'circuit %r stopped' % self.circ.name)
                elif self.state == RUN:
                    self.log('LEDs: stop for another run ignored')
            elif kind == 'preview':
                self._preview(now, *arg)
            elif kind == 'preview_end':
                self._preview_end(now, arg)
            elif kind == 'night':
                if arg and self.state != NIGHT:
                    self._end_circuit(now, 'night')
                    if self.pv:
                        self.log('LEDs: preview %s ended: night' % self.pv['token'])
                        self.pv = None
                    self.state = NIGHT
                    self.log('LEDs: night, fading out')
                    if self.shown:
                        self.fade = (now, FADE_TO_NIGHT, self.shown)
                    else:
                        self.fade = None
                        self._write({}, True)
                elif not arg and self.state == NIGHT:
                    self.pv_night.clear()
                    self._go_idle(now, 'night over')
            elif kind == 'idle' and self.state not in (NIGHT, IDLE):
                self._end_circuit(now, 'sent to idle')
                if self.pv:
                    self.log('LEDs: preview %s ended: sent to idle' % self.pv['token'])
                    self.pv = None
                self._go_idle(now, 'asked for')
            elif kind == 'pattern':
                self._set_pattern(arg, now)
            elif kind == 'benchmarks':
                self.ctx['benchmarks'] = list(arg or [])
        if self.state is None:
            self._go_idle(now, 'start')
        if self.state == CAST and now - self.cast_at >= self.idle_after:
            self._go_idle(now, '%d s since the last cast' % self.idle_after)
        if self.pv and now - self.pv['last'] >= self.pv_timeout:
            self.log('LEDs: preview %s ended: no message for %d s' % (self.pv['token'], self.pv_timeout))
            self.pv = None
            if self.state == PREVIEW:
                self._go_idle(now, 'the preview timed out')

        if self.state == NIGHT:
            return self._fade_out(now)
        if self.state == RUN:
            return self._run_frame(now)
        if self.state == CAST:
            return min(MAX_SLEEP, self.cast_at + self.idle_after - now)
        if self.state == PREVIEW:
            return MAX_SLEEP
        return self._idle_frame(now)

    # -- the preview (contract 9) ---------------------------------------------

    def _preview(self, now, token, frame, show):
        if self.state == NIGHT:
            if token not in self.pv_night:
                self.pv_night.add(token)
                self.log('LEDs: preview %s not shown, night' % token)
            return
        for t in [t for t, at in self.pv_taken.items() if now - at > TAKEN_KEEP]:
            del self.pv_taken[t]
        if token in self.pv_taken:
            if not show:
                return                      # taken over: only Show on board brings it back
            del self.pv_taken[token]
        mine = bool(self.pv) and self.pv['token'] == token
        if self.pv and not mine:
            self._take(self.pv['token'], now, 'another preview')
        self.pv = {'token': token, 'frame': frame, 'last': now}
        if self.state == RUN:
            if not mine:
                self.log('LEDs: preview %s waits for the circuit' % token)
            return
        if not mine or self.state != PREVIEW:
            self.log('LEDs: preview %s%s: %d LEDs' % (token, ', shown again' if show else '', len(frame)))
        if self.state != PREVIEW or frame != self.shown:
            self.state, self.fade, self.circ = PREVIEW, None, None
            self._write(frame, True)

    def _preview_end(self, now, token):
        self.pv_taken.pop(token, None)
        if not self.pv or self.pv['token'] != token:
            return
        self.pv = None
        self.log('LEDs: preview %s ended' % token)
        if self.state == PREVIEW:
            self._go_idle(now, 'the preview ended')

    def _take(self, token, now, why):
        """A session loses the board: its messages are ignored until one says `show`."""
        self.pv_taken[token] = now
        while len(self.pv_taken) > TAKEN_MAX:
            del self.pv_taken[min(self.pv_taken, key=self.pv_taken.get)]
        self.log('LEDs: preview %s taken over by %s' % (token, why))

    def _take_preview(self, now, why):
        if self.pv:
            self._take(self.pv['token'], now, why)
            self.pv = None

    def _after_run(self, now, why):
        """A circuit run ended: back to the preview that waited for it, if it's still going, else idle."""
        if self.pv and now - self.pv['last'] < self.pv_timeout:
            self.state, self.fade = PREVIEW, None
            self.log('LEDs: preview %s back (%s)' % (self.pv['token'], why))
            self._write(self.pv['frame'], True)
        else:
            self._go_idle(now, why)

    def _end_circuit(self, now, how):
        """A run that's showing ends: one line for PB Console's Activity (how, moves, time)."""
        if self.state == RUN and self.circ is not None:
            self.log(self.circ.ended_line(how, now - self.run_t0))

    def _run_frame(self, now):
        """One frame of the circuit run, paced like the idle animation."""
        if now < self.next_frame:
            return self.next_frame - now
        t = now - self.run_t0
        if t >= self.run_max:
            self._end_circuit(now, 'time limit')
            self._after_run(now, 'circuit %r ran %d s, the limit' % (self.circ.name, self.run_max))
            return 0
        leds, done = self.circ.frame(t)
        if done:
            self._end_circuit(now, 'finished')
            self._after_run(now, 'circuit %r finished' % self.circ.name)
            return 0
        out, _, _ = board.scale(leds, *self.cast_args)
        self._write(out, self.run_full)
        self.run_full = False
        self.next_frame += self.dt
        end = self.clock()
        if self.next_frame <= end:
            self.next_frame = end + self.dt
        return self.next_frame - end

    def _fade_out(self, now):
        """Night, or idle with pb-idle off: finish fading to black, then clear."""
        if not self.fade:
            return MAX_SLEEP
        t0, span, frm = self.fade
        k = (now - t0) / span
        if k >= 1:
            self.fade = None
            self._write({}, True)
            return MAX_SLEEP
        self._write(dim(frm, 1 - k), False)
        return self.dt

    def _set_scale(self, spec):
        """pb-idle brightness K: everything written from now on dimmed to K (SCALE_MIN-1)."""
        try:
            k = float(spec.split()[1])
        except (IndexError, ValueError):
            k = -1.0
        if not SCALE_MIN <= k <= 1:
            self.warn('pb-idle: brightness %r is not %g-1, ignored' % (spec[10:].strip(), SCALE_MIN))
            return
        self.scale = k
        self.log('LEDs: pb-idle brightness x%.2f (until a restart)' % k)
        if self.state in (CAST, PREVIEW) and self.shown:
            self._write(self.shown, True)      # the lit problem, at the new level

    def _set_pattern(self, spec, now):
        """pb-idle's choice: at once if idle (crossfading), else from the next idle. Never touches night;
        only `off` touches a cast (it takes the board dark now)."""
        spec = ' '.join((spec or '').strip().lower().split())
        showing = self.state == IDLE
        if spec.startswith('brightness'):
            return self._set_scale(spec)
        if spec == 'off':
            was = self.dark
            self.dark = True
            self.log('LEDs: pb-idle off: dark when idle, casts still light (pb-idle default ends it)')
            if self.state == CAST:
                self._go_idle(now, 'pb-idle off')
            elif showing and not was:
                self._go_idle(now, 'pb-idle off')
            return
        if spec in ('', 'default'):
            plan = None
        elif spec == 'tour':
            plan = patterns.Plan(patterns.NAMES, patterns.TOUR_S, now if showing else None, 'tour', 'pb-idle')
        elif spec == 'cycle':
            c = self.cycle_plan
            plan = patterns.Plan(c.names, c.slot, now if showing else None, 'cycle', 'pb-idle')
        elif spec in patterns.PATTERNS:
            plan = patterns.Plan([spec], source='pb-idle')
        else:
            self.warn('pb-idle: no pattern called %r, ignored' % spec)
            return
        was_dark, self.dark = self.dark, False
        self.override, self.override_spec = plan, (spec if plan else None)
        self.log('LEDs: pb-idle asked for %s%s' % (spec or 'default', '' if showing else
                                                   ' (shows at the next idle; now %s)' % self.state))
        if showing and (was_dark or self.anim is None):
            self._go_idle(now, 'pb-idle %s' % (spec or 'default'))
        elif showing and not self.broken:
            self.anim.switch(self.plan(), now - self.anim_t0)

    def _idle_frame(self, now):
        if self.dark:
            return self._fade_out(now)
        if not self.animate or self.broken:
            return MAX_SLEEP
        if now < self.next_frame:
            return self.next_frame - now
        try:
            frame = self.anim.frame(now - self.anim_t0)
            if self.fade:
                t0, span, frm = self.fade
                k = (now - t0) / span
                if k >= 1:
                    self.fade = None
                else:
                    frame = self.anim.cap(blend(frm, frame, smooth(k)))
        except Exception as e:
            self.broken = True
            self.err('Glisten failed (the fallback for every pattern), idle stays dark until a restart: %s: %s\n%s' % (
                type(e).__name__, e, traceback.format_exc(limit=4)))
            self.fade = None
            self._write({}, True)
            return MAX_SLEEP
        if self.anim.capped_frames and not self.cap_logged:
            self.cap_logged = True
            self.warn('idle pattern %s over IDLE_MAX_AMPS: frame scaled x%.2f (~%d mA); logged once'
                      % (self.anim.name, self.anim.last_cap, self.anim.last_ma))
        self._write(frame, False)
        if self.anim.done:                  # pb-idle's tour has been round once
            self.override, self.override_spec = None, None
            self.log('LEDs: the tour is over, back to the default')
            self.anim.switch(self.config_plan, now - self.anim_t0)
        # Frame-time based: the animation reads the clock, so a late frame
        # skips ahead instead of slowing everything down.
        self.next_frame += self.dt
        end = self.clock()
        if self.next_frame <= end:
            self.next_frame = end + self.dt
        self.frames += 1
        self.busy += end - now
        return self.next_frame - end
