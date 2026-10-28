"""The idle patterns' registry, and Idle: what the renderer draws while idle.

Idle runs a Plan (one pattern, a cycle, or pb-idle's tour), crossfades from
one pattern to the next, and applies what every pattern shares: the idle
brightness, gamma and the idle current cap. A pattern that throws, or returns
a bad frame, is logged once and replaced by Glisten (and skipped from then on
until a restart); only if Glisten itself fails does the error reach the
renderer, which then leaves idle dark. Pure: the clock comes in as t.
"""
import math

from . import aurora, breathe, chase, fireflies, glisten, lava, rain, ripples, teaser, wave
from .common import CELLS, mix, smooth, to_leds

import board

# The tour's order, and every name IDLE_PATTERN, IDLE_CYCLE and pb-idle take.
PATTERNS = {c.name: c for c in (glisten.Glisten, chase.Chase, lava.Lava, breathe.Breathe, aurora.Aurora,
                                rain.Rain, ripples.Ripples, fireflies.Fireflies, teaser.Teaser, wave.Wave)}
NAMES = list(PATTERNS)
CROSSFADE = 3.0             # s, one pattern into the next
TOUR_S = 60.0               # s a pattern in pb-idle's tour
DEFAULT_CYCLE_MIN = 10.0
FALLBACK = 'glisten'


def _minutes(s):
    return '%g min' % (s / 60) if s >= 60 else '%g s' % s


class Plan:
    """What idle shows. kind: 'one' (names[0] for good), 'cycle' (each name for
    slot s in turn, round and round) or 'tour' (each for slot s, once through,
    then done). The position is worked out from the renderer's clock since
    epoch, so a cast in the middle doesn't send a cycle back to the start.
    epoch None = from when idle first shows it (the renderer sets it)."""

    def __init__(self, names, slot=0.0, epoch=0.0, kind='one', source='IDLE_PATTERN'):
        self.names = list(names) or [FALLBACK]
        self.slot = float(slot)
        self.epoch = epoch
        self.kind = kind if len(self.names) > 1 or kind == 'tour' else 'one'
        self.source = source

    def at(self, now):
        """(name, index, done) at renderer time now."""
        n = len(self.names)
        if self.kind == 'one' or self.slot <= 0:
            return self.names[0], 0, False
        k = max(0, int(math.floor((now - (self.epoch or 0.0)) / self.slot)))
        if self.kind == 'tour' and k >= n:
            return self.names[-1], n - 1, True
        return self.names[k % n], k % n, False

    def describe(self, i=None):
        by = ', pb-idle' if self.source == 'pb-idle' else ''
        n = len(self.names)
        if self.kind == 'one':
            return self.source
        if i is None:
            return '%s of %d, %s each%s' % (self.kind, n, _minutes(self.slot), by)
        return '%s %d/%d, %s each%s' % (self.kind, i + 1, n, _minutes(self.slot), by)

    def summary(self):
        if self.kind == 'one':
            return '%s (%s)' % (self.names[0], self.source)
        return '%s: %s' % (self.describe(), ', '.join(self.names))


def _names(raw, warn, what):
    out = []
    for n in (raw or '').replace(',', ' ').split():
        n = n.strip().lower()
        if n in PATTERNS:
            out.append(n)
        elif n:
            warn('%s: no pattern called %r, left out (patterns: %s)' % (what, n, ', '.join(NAMES)))
    return out


def config_plans(cfg, epoch, warn=print):
    """(the plan IDLE_PATTERN asks for, the IDLE_CYCLE plan): from config.env. Anything
    it can't use is warned about and falls back (to Glisten, or to every pattern)."""
    try:
        minutes = float(cfg.get('IDLE_CYCLE_MIN') or DEFAULT_CYCLE_MIN)
        if not 0.25 <= minutes <= 24 * 60:
            raise ValueError(minutes)
    except ValueError:
        warn('IDLE_CYCLE_MIN=%r is not a number of minutes (0.25-1440): %g used'
             % (cfg.get('IDLE_CYCLE_MIN'), DEFAULT_CYCLE_MIN))
        minutes = DEFAULT_CYCLE_MIN
    names = _names(cfg.get('IDLE_CYCLE'), warn, 'IDLE_CYCLE') or list(NAMES)
    cycle = Plan(names, minutes * 60, epoch, 'cycle', 'IDLE_CYCLE')
    want = (cfg.get('IDLE_PATTERN') or FALLBACK).strip().lower()
    if want == 'cycle':
        return cycle, cycle
    if want not in PATTERNS:
        warn('IDLE_PATTERN=%r: no such pattern, %s used (patterns: %s, or cycle)'
             % (want, FALLBACK, ', '.join(NAMES)))
        want = FALLBACK
    return Plan([want]), cycle


class Idle:
    """Drives a Plan's patterns. The renderer calls frame(t) (t = seconds since
    this Idle began, t0 on the renderer clock) and cap(); switch() changes the
    plan with a crossfade. Same outside as a single Pattern: capped_frames,
    last_cap, last_ma, t."""

    def __init__(self, plan, t0, ctx=None, log=print, err=print, seed=None,
                 brightness=1.0, max_ma=2000.0, ma_per_channel=20.0):
        self.plan, self.t0 = plan, t0
        self.ctx = ctx if ctx is not None else {}
        self.log, self.err = log, err
        self.seed, self.made = seed, 0
        self.brightness = min(max(float(brightness), 0.0), 1.0)
        self.max_ma, self.ma_per_channel = float(max_ma), float(ma_per_channel)
        self.capped_frames = 0
        self.last_cap, self.last_ma = 1.0, 0.0
        self.t = None
        self.cur = None             # [name, pattern, its t=0]
        self.prev = None            # the one fading out
        self.fade_at = None
        self.failed = set()
        self.done = False
        self.index = 0
        self._pick(0.0, quiet=True)

    @property
    def name(self):
        return self.cur[0]

    @property
    def label(self):
        return '%s (%s)' % (self.cur[0], self.plan.describe(self.index if self.plan.kind != 'one' else None))

    def _make(self, name, t):
        seed = None if self.seed is None else self.seed * 1000 + self.made
        self.made += 1
        return [name, PATTERNS[name](seed=seed, ctx=self.ctx), t]

    def _pick(self, t, quiet=False):
        name, self.index, done = self.plan.at(self.t0 + t)
        if done:
            self.done = True
            return
        if name in self.failed:
            name = FALLBACK
        if self.cur and self.cur[0] == name:
            return
        if self.cur is not None:
            self.prev, self.fade_at = self.cur, t
        self.cur = self._make(name, t)
        if not quiet:
            self.log('LEDs: idle pattern %s' % self.label)

    def switch(self, plan, t):
        """A new plan from t (seconds since this Idle began): crossfades if the pattern changes."""
        self.plan, self.done = plan, False
        before = self.cur[0]
        self._pick(t, quiet=True)
        if self.cur[0] == before:
            self.log('LEDs: idle pattern %s, carrying on' % self.label)
        else:
            self.log('LEDs: idle pattern %s' % self.label)

    def _run(self, e, t):
        """One pattern's levels, checked: a list of CELLS cells, all finite."""
        px = e[1].levels(t - e[2])
        if len(px) != CELLS:
            raise ValueError('%d cells, not %d' % (len(px), CELLS))
        s = sum(p[0] + p[1] + p[2] for p in px)
        if s != s or s in (math.inf, -math.inf):
            raise ValueError('a level is not a number')
        return px

    def _failed(self, e, ex):
        self.failed.add(e[0])
        self.err('idle pattern %s failed, Glisten instead (until a restart): %s: %s' % (e[0], type(ex).__name__, ex))

    def levels(self, t):
        """The perceptual frame: the current pattern, crossfaded from the last one."""
        self.t = t
        self._pick(t)
        try:
            px = self._run(self.cur, t)
        except Exception as ex:
            if self.cur[0] == FALLBACK:
                raise
            self._failed(self.cur, ex)
            self.cur = self._make(FALLBACK, t)
            px = self._run(self.cur, t)         # Glisten failing too goes up to the renderer
        if self.prev:
            k = (t - self.fade_at) / CROSSFADE
            if k >= 1:
                self.prev = None
            else:
                try:
                    old = self._run(self.prev, t)
                except Exception as ex:
                    if self.prev[0] != FALLBACK:
                        self._failed(self.prev, ex)
                    self.prev = None
                else:
                    px = mix(old, px, smooth(max(0.0, k)))
        return px

    def cap(self, leds):
        out, cap, ma = board.scale(leds, 1.0, self.max_ma, self.ma_per_channel)
        self.last_cap, self.last_ma = cap, ma
        if cap < 1:
            self.capped_frames += 1
        return out

    def frame(self, t):
        """{led: (r, g, b)} PWM 0-255, brightness, gamma and the cap applied; pixel 0 never in it."""
        return self.cap(to_leds(self.levels(t), self.brightness))
