"""Ripples: rings expanding from random spots on the board, softening and
fading as they spread, over the navy floor. Rings that cross just add. Pure;
on the grid.

Photosensitivity: a ring fades in over FADE_IN s, so a new one never pops.
"""
import math

from .common import ACCENT, CELLS, COLS, INT, NAVY, ROWS, START, TEAL, VIOLET, X, Y, Pattern, fill, scaled

# ---- Tunables -----------------------------------------------------------------
COLOURS = [ACCENT, INT, scaled(TEAL, 2.4), scaled(VIOLET, 2.0), START]
EVERY = (1.0, 2.4)          # s between new rings
ALIVE = 4                   # at most this many at once
SPEED = (2.4, 3.4)          # cells/s
LIFE = (3.5, 5.0)           # s
WIDTH = 0.8                 # cells (the ring's Gaussian sigma), widening by half as it spreads
LEVEL = 0.8
FADE_IN = 0.4               # s
FLOOR = 1.1                 # the navy, times NAVY
# --------------------------------------------------------------------------------


class Ripples(Pattern):
    name = 'ripples'
    about = 'rings expanding from random holds and fading'

    def setup(self):
        self.rings = []             # [x, y, start, speed, life, colour]
        self.next_at = self.rng.uniform(0.2, 1.0)

    def levels(self, t):
        self.step_dt(t)
        rng = self.rng
        self.rings = [r for r in self.rings if t - r[2] < r[4]]
        if t >= self.next_at:
            self.next_at = t + rng.uniform(*EVERY)
            if len(self.rings) < ALIVE:
                c = rng.randrange(CELLS)
                self.rings.append([X[c], Y[c], t, rng.uniform(*SPEED), rng.uniform(*LIFE), rng.choice(COLOURS)])
        px = fill(NAVY, FLOOR)
        exp, sqrt = math.exp, math.sqrt
        for x0, y0, t0, speed, life, col in self.rings:
            age = t - t0
            k = age / life
            radius = speed * age
            w = WIDTH * (1 + 0.5 * k)
            a = LEVEL * (1 - k) ** 1.5 * min(1.0, age / FADE_IN)
            if a < 0.01:
                continue
            inv = -0.5 / (w * w)
            reach = 3 * w
            cr, cg, cb = col[0] * a, col[1] * a, col[2] * a
            ylo, yhi = max(0, int(y0 - radius - reach)), min(ROWS - 1, int(y0 + radius + reach) + 1)
            for y in range(ylo, yhi + 1):
                dy2 = (y - y0) * (y - y0)
                row = y * COLS
                for x in range(COLS):
                    dd = sqrt((x - x0) * (x - x0) + dy2) - radius
                    if -reach < dd < reach:
                        e = exp(dd * dd * inv)
                        p = px[row + x]
                        p[0] += cr * e
                        p[1] += cg * e
                        p[2] += cb * e
        return px
