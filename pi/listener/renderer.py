"""The LED thread: the only thing that writes to the strip while the listener runs.

Three states (night always wins):
- cast:  a problem is lit (a cast cuts straight in, no fade);
- idle:  Glisten (glisten.py), from IDLE_AFTER_S after the last cast, and at
         start and at the end of the night; it fades in over 1.5 s. With
         IDLE_ANIMATION=off the strip is just cleared;
- night: a 3 s fade to black, then the strip cleared.

The event loop never waits on it: cast(), set_night(), idle_now() and stop()
only post a command and wake the thread. step() does one round of work and
says how long to sleep, so the tests drive it with a fake clock and no thread.

If Glisten throws, it's logged once, the strip is cleared and idle stays dark
until the next restart; casts carry on. `beat` is the time of the last loop
round: the listener exits (and systemd restarts it) if it goes stale.
"""
import threading
import time
import traceback

import board
import glisten

CAST, IDLE, NIGHT = 'cast', 'idle', 'night'
FADE_TO_IDLE = 1.5        # s, the lit problem (or black) crossfading into Glisten
FADE_TO_NIGHT = 3.0       # s, whatever is showing fading to black at the start of the night
# Animation frames write pixels 0-247 only: 6 ms at 1 MHz instead of 29 ms for
# all 1200. Pixels past the board stay dark from the full clear before them.
BOARD_PIXELS = board.MAX_HOLD + 1
MAX_SLEEP = 1.0           # the loop comes round at least this often (keeps `beat` fresh)


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
        self.glisten_args = dict(brightness=float(cfg.get('IDLE_BRIGHTNESS') or 1.0),
                                 max_ma=float(cfg.get('IDLE_MAX_AMPS') or 2.0) * 1000,
                                 ma_per_channel=float(cfg.get('MA_PER_CHANNEL') or 20))
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
        self.broken = False         # Glisten threw: idle stays dark until a restart
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

    def set_night(self, night):
        self._post(('night', bool(night)))

    def idle_now(self):
        self._post(('idle', None))

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

    def stats(self):
        """For listener.json; resets the frame-rate window."""
        now = self.clock()
        span, frames, busy = now - self.window_at, self.frames, self.busy
        self.frames, self.busy, self.window_at = 0, 0.0, now
        s = {'leds': 'glisten' if self.state == IDLE and self.animate and not self.broken
             else 'dark' if self.state == IDLE else self.state,
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
            self.strip.write(frame, None if full else BOARD_PIXELS)
        except Exception as e:
            self.write_errors += 1
            if self.write_errors == 1 or self.write_errors % 1000 == 0:
                self.err('writing the strip failed (%d so far): %s: %s' % (self.write_errors, type(e).__name__, e))
            return False
        self.shown = frame
        return True

    def _go_idle(self, now, why):
        self.state = IDLE
        if self.animate and not self.broken:
            self.log('LEDs: Glisten (%s)' % why)
            self.anim = glisten.Glisten(seed=self.seed, **self.glisten_args)
            self.anim_t0 = now
            self.fade = (now, FADE_TO_IDLE, self.shown)
            self.next_frame = now
        else:
            self.log('LEDs: cleared (%s%s)' % (why, ', Glisten off' if not self.broken else ''))
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
                self.state, self.fade, self.cast_at = CAST, None, now
                self._write(arg, True)
            elif kind == 'night':
                if arg and self.state != NIGHT:
                    self.state = NIGHT
                    self.log('LEDs: night, fading out')
                    if self.shown:
                        self.fade = (now, FADE_TO_NIGHT, self.shown)
                    else:
                        self.fade = None
                        self._write({}, True)
                elif not arg and self.state == NIGHT:
                    self._go_idle(now, 'night over')
            elif kind == 'idle' and self.state not in (NIGHT, IDLE):
                self._go_idle(now, 'asked for')
        if self.state is None:
            self._go_idle(now, 'start')
        if self.state == CAST and now - self.cast_at >= self.idle_after:
            self._go_idle(now, '%d s since the last cast' % self.idle_after)

        if self.state == NIGHT:
            if not self.fade:
                return MAX_SLEEP
            t0, span, frm = self.fade
            k = (now - t0) / span
            if k >= 1:
                self.fade = None
                self._write({}, True)
                return MAX_SLEEP
            self._write(glisten.dim(frm, 1 - k), False)
            return self.dt
        if self.state == CAST:
            return min(MAX_SLEEP, self.cast_at + self.idle_after - now)
        return self._idle_frame(now)

    def _idle_frame(self, now):
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
                    frame = self.anim.cap(glisten.blend(frm, frame, glisten.smooth(k)))
        except Exception as e:
            self.broken = True
            self.err('Glisten failed, idle stays dark until a restart: %s: %s\n%s' % (
                type(e).__name__, e, traceback.format_exc(limit=4)))
            self.fade = None
            self._write({}, True)
            return MAX_SLEEP
        if self.anim.capped_frames and not self.cap_logged:
            self.cap_logged = True
            self.warn('Glisten over IDLE_MAX_AMPS: frame scaled x%.2f (~%d mA); logged once'
                      % (self.anim.last_cap, self.anim.last_ma))
        self._write(frame, False)
        # Frame-time based: the animation reads the clock, so a late frame
        # skips ahead instead of slowing everything down.
        self.next_frame += self.dt
        end = self.clock()
        if self.next_frame <= end:
            self.next_frame = end + self.dt
        self.frames += 1
        self.busy += end - now
        return self.next_frame - end
