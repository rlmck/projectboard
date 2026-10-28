"""Fireflies: a handful of warm points fading in and out at random, each
drifting slowly while it glows, over a dimmer navy floor. A point sits
between cells as easily as on one (it's a soft spot), so the drift is smooth.
Pure; on the grid.

Photosensitivity: each one fades in and out over LIFE s; nothing flashes.
"""
import math

from .common import COLS, FEET, GOLD, NAVY, ROWS, START, Pattern, fill, scaled, splat

# ---- Tunables -----------------------------------------------------------------
COLOURS = [GOLD, GOLD, FEET, scaled(START, 0.4)]   # mostly gold, some amber, a few green (a hint of the glow)
ALIVE = (8, 12)             # how many at once; the target wanders inside this range
RATE = 2.0                  # spawn tries a second while under the target
LIFE = (3.0, 6.5)           # s from fading in to gone
DRIFT = 0.35                # cells/s
TURN = 0.8                  # rad/s, how fast its heading wanders
LEVEL = (0.75, 1.0)         # its peak, picked per firefly
SPOT = 0.7                  # sigma, cells
FLOOR = 1.1                 # the navy, times NAVY
# --------------------------------------------------------------------------------


class Fireflies(Pattern):
    name = 'fireflies'
    about = 'a handful of warm points fading in and out at random, drifting slightly'

    def setup(self):
        self.flies = []             # [x, y, heading, start, life, colour, level]
        self.target = self.rng.randint(*ALIVE)
        self.retarget_at = self.rng.uniform(5, 10)

    def levels(self, t):
        dt = min(self.step_dt(t), 0.5)
        rng = self.rng
        if t >= self.retarget_at:
            self.target = rng.randint(*ALIVE)
            self.retarget_at = t + rng.uniform(5, 10)
        self.flies = [f for f in self.flies if t - f[3] < f[4]]
        if len(self.flies) < self.target and rng.random() < 1 - math.exp(-RATE * dt):
            self.flies.append([rng.uniform(0.5, COLS - 1.5), rng.uniform(0.5, ROWS - 1.5), rng.uniform(0, 6.3),
                               t, rng.uniform(*LIFE), rng.choice(COLOURS), rng.uniform(*LEVEL)])
        px = fill(NAVY, FLOOR)
        for f in self.flies:
            f[2] += rng.uniform(-TURN, TURN) * dt * 3
            f[0] = min(COLS - 1, max(0.0, f[0] + math.cos(f[2]) * DRIFT * dt))
            f[1] = min(ROWS - 1, max(0.0, f[1] + math.sin(f[2]) * DRIFT * dt))
            k = (t - f[3]) / f[4]
            e = math.sin(math.pi * k) ** 2 * f[6]
            if e > 0.01:
                splat(px, f[0], f[1], f[5], e, SPOT)
        return px
