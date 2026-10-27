"""Glisten: the board's idle animation. Pure: no I/O, no clock, no strip.

renderer.py asks for one frame at a time, giving the seconds since Glisten
started; tools/glisten_preview.py runs this same code on the laptop. Everything
is worked out on the 19 x 13 grid (contract 6.4: row 1 at the bottom, column A
on the left), so the effects are 2D on the wall, and only then turned into LED
indices. Pixel 0 is never lit.

Three layers, added in perceptual brightness (0-1, what the eye sees):
1. Shimmer: two octaves of smooth 2D value noise drifting across the grid in
   different directions, through a navy -> teal -> violet -> pink palette.
2. Sparkles: single cells flash cool white (a fast attack, an exponential decay).
3. Glint: every 20-40 s a soft diagonal band sweeps across the board.
Then gamma (perceptual -> the LED's linear PWM value, 0-255), then the idle
current cap through board.scale().

Photosensitivity: sparkles are single cells, two neighbours never start
together, and a cell can't sparkle again for SPARKLE_CELL_GAP s (so never more
than 1 flash in 2 s per cell, far under 3 a second). The glint is a slow sweep,
not a flash, and nothing changes the whole board at once.
"""
import math
import random

import board

# ---- Tunables ---------------------------------------------------------------
# Colours are perceptual RGB 0-1, before gamma. Keep every dark colour's
# strongest channel at about 0.25 or more: below that the 8-bit PWM steps
# (1, 2, 3 ...) show as visible jumps in a slow fade.

GAMMA = 2.2

# Shimmer: the noise (0-1) picks a colour along these stops. The navy is the
# floor (most of the board, most of the time), the pink (the app's --accent,
# #ec4899, dimmed) only shows at the noise peaks.
PALETTE = [
    (0.00, (0.05, 0.08, 0.27)),    # deep navy
    (0.40, (0.00, 0.30, 0.32)),    # teal
    (0.70, (0.25, 0.07, 0.42)),    # violet
    (0.90, (0.50, 0.15, 0.32)),    # accent pink
    (1.00, (0.60, 0.18, 0.39)),
]
SHIMMER_SCALE = 0.15          # noise lattice units per cell: blobs about 6 cells across
SHIMMER_DRIFT = (0.13, 0.05)  # octave 1 drift, lattice units/s (~1 cell/s: across the board in ~20 s)
SHIMMER_DETAIL = 2.3          # octave 2 frequency, times octave 1
SHIMMER_DETAIL_DRIFT = (-0.16, 0.21)
SHIMMER_DETAIL_WEIGHT = 0.4
SHIMMER_CONTRAST = 1.9        # stretches the noise around 0.5 so the whole palette gets used

# Sparkles
SPARKLE_COLOUR = (0.80, 0.88, 1.00)   # cool white, a little blue (the far end drops voltage)
SPARKLE_LEVEL = 0.85                  # peak, added on top of the shimmer
SPARKLE_ATTACK = 0.08                 # s, rise to the peak
SPARKLE_DECAY = (0.6, 1.2)            # s to fade to ~5%, picked per sparkle
SPARKLE_ALIVE = (3, 6)                # how many at once; the target wanders inside this range
SPARKLE_RATE = 6.0                    # spawn tries a second while under the target
SPARKLE_CELL_GAP = 2.0                # s before the same cell can sparkle again (>= 0.34 keeps under 3 Hz)
SPARKLE_NEIGHBOUR_GAP = 0.3           # s: no sparkle starts next to one this young

# Glint
GLINT_FIRST = (6.0, 14.0)    # s after Glisten starts
GLINT_EVERY = (20.0, 40.0)   # s between glints
GLINT_SWEEP = 2.5            # s to cross the board
GLINT_WIDTH = 1.0            # cells (the Gaussian's sigma across the band: ~2 cells visible)
GLINT_LEVEL = 0.22         # keeps the worst frame (glint + sparkles) under the 2 A default cap
GLINT_COLOUR = (0.75, 0.85, 1.00)
# ------------------------------------------------------------------------------

COLS, ROWS = board.COLS, board.ROWS
CELLS = COLS * ROWS
LED = [board.led_index(n) for n in range(1, CELLS + 1)]      # cell (n - 1) -> LED index
_LAT = 256                                                   # noise lattice, wraps

_LUT_N = 4096
_PWM = [int(round(255 * (i / (_LUT_N - 1)) ** GAMMA)) for i in range(_LUT_N)]
_PERCEPT = [(v / 255) ** (1 / GAMMA) for v in range(256)]


def to_pwm(p):
    """Perceptual 0-1 -> PWM 0-255 (gamma)."""
    if p <= 0:
        return 0
    if p >= 1:
        return 255
    return _PWM[int(p * (_LUT_N - 1) + 0.5)]


def blend(a, b, k):
    """Crossfade two PWM frames ({led: (r, g, b)}) in perceptual space: k=0 is a, k=1 is b."""
    out = {}
    for i in set(a) | set(b):
        ca, cb = a.get(i, (0, 0, 0)), b.get(i, (0, 0, 0))
        rgb = tuple(to_pwm(_PERCEPT[x] + (_PERCEPT[y] - _PERCEPT[x]) * k) for x, y in zip(ca, cb))
        if any(rgb):
            out[i] = rgb
    return out


def dim(frame, k):
    """A PWM frame faded by k (1 = as is, 0 = black), in perceptual space."""
    return blend(frame, {}, 1 - k)


def smooth(x):
    return x * x * (3 - 2 * x)


def _palette_lut(n=256):
    lut = []
    for i in range(n):
        v = i / (n - 1)
        for (p0, c0), (p1, c1) in zip(PALETTE, PALETTE[1:]):
            if v <= p1:
                k = (v - p0) / (p1 - p0) if p1 > p0 else 0
                lut.append(tuple(a + (b - a) * k for a, b in zip(c0, c1)))
                break
    return lut


_PAL = _palette_lut()


def _neighbours(c):
    x, y = c % COLS, c // COLS
    return [yy * COLS + xx for yy in (y - 1, y, y + 1) for xx in (x - 1, x, x + 1)
            if 0 <= xx < COLS and 0 <= yy < ROWS and (xx, yy) != (x, y)]


NEIGHBOURS = [_neighbours(c) for c in range(CELLS)]
# Distance across the glint band, for each of its two diagonals (cells).
_DIAG = [[(c % COLS + c // COLS) / math.sqrt(2) for c in range(CELLS)],
         [(c % COLS + (ROWS - 1 - c // COLS)) / math.sqrt(2) for c in range(CELLS)]]
_DIAG_MAX = (COLS - 1 + ROWS - 1) / math.sqrt(2)


class Glisten:
    def __init__(self, brightness=1.0, max_ma=2000.0, ma_per_channel=20.0, seed=None):
        self.brightness = min(max(float(brightness), 0.0), 1.0)
        self.max_ma = float(max_ma)
        self.ma_per_channel = float(ma_per_channel)
        self.rng = rng = random.Random(seed)
        self.lat = [[rng.random() for _ in range(_LAT)] for _ in range(_LAT)]
        self.off = (rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100))
        self.t = None
        self.sparkles = []          # [cell, start, decay]
        self.last_start = {}        # cell -> when it last sparkled
        self.started = []           # (cell, start), every sparkle so far (tests read it)
        self.target = rng.randint(*SPARKLE_ALIVE)
        self.retarget_at = rng.uniform(3, 8)
        self.glint = None           # (start, which diagonal, direction)
        self.next_glint = rng.uniform(*GLINT_FIRST)
        self.capped_frames = 0      # frames the current cap scaled down
        self.last_cap, self.last_ma = 1.0, 0.0

    # -- the layers -----------------------------------------------------------

    def _octave(self, scale, ox, oy):
        lat, m = self.lat, _LAT - 1
        cols = []
        for x in range(COLS):
            u = x * scale + ox
            i = math.floor(u)
            cols.append((i & m, (i + 1) & m, smooth(u - i)))
        out = []
        for y in range(ROWS):
            v = y * scale + oy
            j = math.floor(v)
            g = smooth(v - j)
            r0, r1 = lat[j & m], lat[(j + 1) & m]
            for i0, i1, f in cols:
                a = r0[i0] + (r0[i1] - r0[i0]) * f
                b = r1[i0] + (r1[i1] - r1[i0]) * f
                out.append(a + (b - a) * g)
        return out

    def _shimmer(self, t):
        o = self.off
        n1 = self._octave(SHIMMER_SCALE, o[0] + SHIMMER_DRIFT[0] * t, o[1] + SHIMMER_DRIFT[1] * t)
        s2 = SHIMMER_SCALE * SHIMMER_DETAIL
        n2 = self._octave(s2, o[2] + SHIMMER_DETAIL_DRIFT[0] * t, o[3] + SHIMMER_DETAIL_DRIFT[1] * t)
        w, k, pal = SHIMMER_DETAIL_WEIGHT, SHIMMER_CONTRAST, _PAL
        out = []
        for a, b in zip(n1, n2):
            v = ((a + b * w) / (1 + w) - 0.5) * k + 0.5
            out.append(list(pal[0 if v <= 0 else 255 if v >= 1 else int(v * 255)]))
        return out

    def _update_sparkles(self, t, dt):
        rng = self.rng
        self.sparkles = [s for s in self.sparkles if t - s[1] < SPARKLE_ATTACK + s[2] * 1.6]
        if t >= self.retarget_at:
            self.target = rng.randint(*SPARKLE_ALIVE)
            self.retarget_at = t + rng.uniform(3, 8)
        if len(self.sparkles) < self.target and rng.random() < 1 - math.exp(-SPARKLE_RATE * dt):
            young = {s[0] for s in self.sparkles if t - s[1] < SPARKLE_NEIGHBOUR_GAP}
            for _ in range(12):
                c = rng.randrange(CELLS)
                if t - self.last_start.get(c, -1e9) < SPARKLE_CELL_GAP:
                    continue
                if c in young or any(n in young for n in NEIGHBOURS[c]):
                    continue
                self.sparkles.append([c, t, rng.uniform(*SPARKLE_DECAY)])
                self.last_start[c] = t
                self.started.append((c, t))
                del self.started[:-500]
                break

    def _update_glint(self, t):
        if self.glint and t - self.glint[0] >= GLINT_SWEEP:
            self.glint = None
            self.next_glint = t + self.rng.uniform(*GLINT_EVERY)
        if self.glint is None and t >= self.next_glint:
            self.glint = (t, self.rng.randrange(2), self.rng.choice((1, -1)))

    def levels(self, t):
        """The perceptual frame at t seconds: a list of [r, g, b] (0-1) per cell, cell = hold number - 1."""
        dt = 0.0 if self.t is None else max(0.0, t - self.t)
        self.t = t
        px = self._shimmer(t)
        self._update_sparkles(t, dt)
        for c, t0, decay in self.sparkles:
            age = t - t0
            e = age / SPARKLE_ATTACK if age < SPARKLE_ATTACK else math.exp(-3 * (age - SPARKLE_ATTACK) / decay)
            e *= SPARKLE_LEVEL
            p = px[c]
            for i in range(3):
                p[i] += SPARKLE_COLOUR[i] * e
        self._update_glint(t)
        if self.glint:
            t0, which, way = self.glint
            k = smooth(min(1.0, (t - t0) / GLINT_SWEEP))
            if way < 0:
                k = 1 - k
            centre = -3 * GLINT_WIDTH + (_DIAG_MAX + 6 * GLINT_WIDTH) * k
            for c, d in enumerate(_DIAG[which]):
                z = (d - centre) / GLINT_WIDTH
                if -3 < z < 3:
                    e = GLINT_LEVEL * math.exp(-0.5 * z * z)
                    p = px[c]
                    for i in range(3):
                        p[i] += GLINT_COLOUR[i] * e
        b = self.brightness
        if b != 1.0:
            for p in px:
                p[0] *= b
                p[1] *= b
                p[2] *= b
        return px

    # -- output -----------------------------------------------------------------

    def cap(self, leds):
        """The idle current cap on a PWM frame (board.scale); counts the frames it scaled down."""
        out, cap, ma = board.scale(leds, 1.0, self.max_ma, self.ma_per_channel)
        self.last_cap, self.last_ma = cap, ma
        if cap < 1:
            self.capped_frames += 1
        return out

    def frame(self, t):
        """{led: (r, g, b)} PWM 0-255 at t seconds, capped; unlit LEDs left out, pixel 0 never in it."""
        leds = {}
        for c, p in enumerate(self.levels(t)):
            rgb = (to_pwm(p[0]), to_pwm(p[1]), to_pwm(p[2]))
            if rgb[0] or rgb[1] or rgb[2]:
                leds[LED[c]] = rgb
        return self.cap(leds)
