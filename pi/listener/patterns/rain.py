"""Rain: soft drops falling down the columns (from row 13 to row 1) with short
fading trails, over the navy floor. A column waits for its last drop to get
well down before it takes another. Pure; on the grid.
"""
import math

from .common import COLS, INT, NAVY, ROWS, TEAL, COOL_WHITE, Pattern, fill, scaled

# ---- Tunables -----------------------------------------------------------------
COLOURS = [INT, INT, scaled(TEAL, 2.4), scaled(COOL_WHITE, 0.8)]   # picked at random per drop
SPEED = (3.5, 6.0)          # rows/s
TRAIL = 3.2                 # rows behind the head
LEVEL = (0.6, 0.85)         # a drop's head, picked per drop
ALIVE = (8, 12)             # how many at once; the target wanders inside this range
RATE = 5.0                  # spawn tries a second while under the target
GAP = 5.0                   # rows a column's last drop must have fallen before the next
FLOOR = 1.1                 # the navy, times NAVY
# --------------------------------------------------------------------------------


class Rain(Pattern):
    name = 'rain'
    about = 'soft drops falling down the columns with short trails'

    def setup(self):
        self.drops = []             # [column, head row (float, falling), speed, colour, level]
        self.target = self.rng.randint(*ALIVE)
        self.retarget_at = self.rng.uniform(4, 9)

    def _spawn(self):
        rng = self.rng
        busy = {d[0] for d in self.drops if d[1] > ROWS - 1 - GAP}
        free = [x for x in range(COLS) if x not in busy]
        if not free:
            return
        self.drops.append([rng.choice(free), ROWS - 1 + 1.0, rng.uniform(*SPEED), rng.choice(COLOURS),
                           rng.uniform(*LEVEL)])

    def levels(self, t):
        dt = min(self.step_dt(t), 0.5)
        rng = self.rng
        if t >= self.retarget_at:
            self.target = rng.randint(*ALIVE)
            self.retarget_at = t + rng.uniform(4, 9)
        for d in self.drops:
            d[1] -= d[2] * dt
        self.drops = [d for d in self.drops if d[1] > -TRAIL - 1]
        if len(self.drops) < self.target and rng.random() < 1 - math.exp(-RATE * dt):
            self._spawn()
        px = fill(NAVY, FLOOR)
        for x, head, _, col, level in self.drops:
            lo = max(0, int(head) - 1)
            hi = min(ROWS - 1, int(head + TRAIL) + 1)
            for y in range(lo, hi + 1):
                d = y - head                    # > 0: above the head, in the trail
                if d < -1 or d > TRAIL:
                    continue
                w = 1 + d if d < 0 else (1 - d / TRAIL) ** 1.6
                e = level * w
                p = px[y * COLS + x]
                p[0] += col[0] * e
                p[1] += col[1] * e
                p[2] += col[2] * e
        return px
