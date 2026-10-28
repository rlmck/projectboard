"""What every idle pattern shares: the grid, gamma, the app's palette and the
Pattern base class. Pure: no I/O, no clock, no strip.

The grid (contract 6.4): 19 x 13 cells, cell = hold number - 1, so cell 0 is A1
at the bottom left, cell 18 is S1, cell 246 is S13 at the top right. X[c] is the
column (0 = A), Y[c] the row (0 = row 1, at the BOTTOM: up is +y). Every cell
has an LED, holds or not; LED[c] is its strip index (1-247, column-major
serpentine: A runs up, B down, ...). Pixel 0 sits behind the board and is
never in a frame. Patterns work on the grid only, never on strip order.

A pattern returns perceptual levels (0-1, what the eye sees) per cell; gamma
2.2 turns them into PWM (0-255) and the idle current cap scales the frame, the
same for every pattern (to_leds() + Pattern.cap()).
"""
import math
import random

import board

COLS, ROWS = board.COLS, board.ROWS
CELLS = COLS * ROWS
X = [c % COLS for c in range(CELLS)]
Y = [c // COLS for c in range(CELLS)]
LED = [board.led_index(n) for n in range(1, CELLS + 1)]      # cell -> LED index


def _neighbours(c):
    x, y = c % COLS, c // COLS
    return [yy * COLS + xx for yy in (y - 1, y, y + 1) for xx in (x - 1, x, x + 1)
            if 0 <= xx < COLS and 0 <= yy < ROWS and (xx, yy) != (x, y)]


NEIGHBOURS = [_neighbours(c) for c in range(CELLS)]

# ---- Gamma --------------------------------------------------------------------
GAMMA = 2.2
_LUT_N = 4096
_PWM = [int(round(255 * (i / (_LUT_N - 1)) ** GAMMA)) for i in range(_LUT_N)]
PERCEPT = [(v / 255) ** (1 / GAMMA) for v in range(256)]


def to_pwm(p):
    """Perceptual 0-1 -> PWM 0-255 (gamma)."""
    if p <= 0:
        return 0
    if p >= 1:
        return 255
    return _PWM[int(p * (_LUT_N - 1) + 0.5)]


def to_leds(px, k=1.0):
    """Perceptual cells -> {led: (r, g, b)} PWM, scaled by k first; unlit LEDs left out."""
    leds, pw = {}, to_pwm
    for c, p in enumerate(px):
        r, g, b = pw(p[0] * k), pw(p[1] * k), pw(p[2] * k)
        if r or g or b:
            leds[LED[c]] = (r, g, b)
    return leds


def blend(a, b, k):
    """Crossfade two PWM frames ({led: (r, g, b)}) in perceptual space: k=0 is a, k=1 is b."""
    out = {}
    for i in set(a) | set(b):
        ca, cb = a.get(i, (0, 0, 0)), b.get(i, (0, 0, 0))
        rgb = tuple(to_pwm(PERCEPT[x] + (PERCEPT[y] - PERCEPT[x]) * k) for x, y in zip(ca, cb))
        if any(rgb):
            out[i] = rgb
    return out


def dim(frame, k):
    """A PWM frame faded by k (1 = as is, 0 = black), in perceptual space."""
    return blend(frame, {}, 1 - k)


def mix(a, b, k):
    """Crossfade two perceptual frames (lists of [r, g, b]): k=0 is a, k=1 is b."""
    return [[x + (y - x) * k for x, y in zip(p, q)] for p, q in zip(a, b)]


def smooth(x):
    return x * x * (3 - 2 * x)


def smoothstep(a, b, x):
    if x <= a:
        return 0.0
    if x >= b:
        return 1.0
    return smooth((x - a) / (b - a))


# ---- The palette ----------------------------------------------------------------
# Perceptual RGB 0-1 (a hex colour / 255 is already perceptual). The tokens are
# copied from app/tokens.css (pi/tests/test_patterns.py checks they still match);
# the Pi doesn't have app/.
TOKENS = {
    'accent': '#ec4899',     # the app's pink (also --cast)
    'start': '#22c55e',      # hold colours: start green, intermediate blue, finish red
    'int': '#3b82f6',
    'finish': '#ef4444',
    'gold': '#fbbf24',       # stars
    'feet': '#f59e0b',       # feet orange
}


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def scaled(rgb, k):
    return tuple(c * k for c in rgb)


ACCENT, START, INT, FINISH, GOLD, FEET = (hex_rgb(TOKENS[k]) for k in
                                          ('accent', 'start', 'int', 'finish', 'gold', 'feet'))
# Glisten's darker stops (not tokens): the deep navy floor most patterns sit on,
# teal and violet. Keep a dark colour's strongest channel at about 0.25 or more:
# below that the 8-bit PWM steps (1, 2, 3 ...) show as jumps in a slow fade.
NAVY = (0.05, 0.08, 0.27)
TEAL = (0.00, 0.30, 0.32)
VIOLET = (0.25, 0.07, 0.42)
COOL_WHITE = (0.80, 0.88, 1.00)


def palette_lut(stops, n=256, wrap=False):
    """[(position 0-1, rgb), ...] -> n colours along it (wrap: the last runs back into the first)."""
    if wrap:
        stops = list(stops) + [(1.0, stops[0][1])]
    lut = []
    for i in range(n):
        v = i / (n - 1) if not wrap else i / n
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            if v <= p1:
                k = (v - p0) / (p1 - p0) if p1 > p0 else 0
                lut.append(tuple(a + (b - a) * k for a, b in zip(c0, c1)))
                break
        else:
            lut.append(stops[-1][1])
    return lut


def splat(px, x, y, rgb, level, sigma, reach=None):
    """Add a soft round spot (a Gaussian, sigma cells) centred at grid point (x, y)."""
    reach = reach or 2.5 * sigma
    k = -0.5 / (sigma * sigma)
    r2max = reach * reach
    x0, x1 = max(0, int(math.ceil(x - reach))), min(COLS - 1, int(math.floor(x + reach)))
    y0, y1 = max(0, int(math.ceil(y - reach))), min(ROWS - 1, int(math.floor(y + reach)))
    cr, cg, cb = rgb[0] * level, rgb[1] * level, rgb[2] * level
    exp = math.exp
    for yy in range(y0, y1 + 1):
        dy2 = (yy - y) * (yy - y)
        row = yy * COLS
        for xx in range(x0, x1 + 1):
            d2 = (xx - x) * (xx - x) + dy2
            if d2 <= r2max:
                e = exp(d2 * k)
                p = px[row + xx]
                p[0] += cr * e
                p[1] += cg * e
                p[2] += cb * e


def fill(rgb=NAVY, k=1.0):
    """A fresh frame with every cell at one colour."""
    r, g, b = rgb[0] * k, rgb[1] * k, rgb[2] * k
    return [[r, g, b] for _ in range(CELLS)]


class Pattern:
    """One idle pattern. Subclasses set name and about, may override setup(),
    and must implement levels(t): t is seconds since the pattern started (it
    only goes forward; a late frame just jumps ahead), and the result is a list
    of CELLS [r, g, b] perceptual levels (0-1; anything outside is clipped).
    ctx is shared with the renderer (ctx['benchmarks']: see teaser.py).

    Used on its own (the tests, the bench), frame(t) applies the brightness,
    gamma and the idle current cap. On the Pi, patterns.Idle does that instead,
    so it can crossfade two patterns first.
    """
    name = ''
    about = ''

    def __init__(self, brightness=1.0, max_ma=2000.0, ma_per_channel=20.0, seed=None, ctx=None):
        self.brightness = min(max(float(brightness), 0.0), 1.0)
        self.max_ma = float(max_ma)
        self.ma_per_channel = float(ma_per_channel)
        self.rng = random.Random(seed)
        self.ctx = ctx if ctx is not None else {}
        self.t = None
        self.capped_frames = 0      # frames the current cap scaled down
        self.last_cap, self.last_ma = 1.0, 0.0
        self.setup()

    def setup(self):
        pass

    def step_dt(self, t):
        """Seconds since the last frame (0 for the first), and remember t."""
        dt = 0.0 if self.t is None else max(0.0, t - self.t)
        self.t = t
        return dt

    def levels(self, t):
        raise NotImplementedError

    def cap(self, leds):
        """The idle current cap on a PWM frame (board.scale); counts the frames it scaled down."""
        out, cap, ma = board.scale(leds, 1.0, self.max_ma, self.ma_per_channel)
        self.last_cap, self.last_ma = cap, ma
        if cap < 1:
            self.capped_frames += 1
        return out

    def frame(self, t):
        """{led: (r, g, b)} PWM 0-255 at t seconds, capped; unlit LEDs left out, pixel 0 never in it."""
        return self.cap(to_leds(self.levels(t), self.brightness))
