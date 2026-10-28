"""Chase: comets with fading tails running round the board, one behind another
on a looping track (a rounded rectangle just inside the edge), each weaving a
little across it. Their speeds wander, and now and then one surges, so they
close up and overtake. Pure; worked out on the grid, not in strip order.
"""
import math

from .common import ACCENT, COLS, GOLD, INT, NAVY, ROWS, START, Pattern, fill, smooth, splat

# ---- Tunables -----------------------------------------------------------------
COMETS = [ACCENT, INT, START, GOLD]     # head colours, spaced evenly round the track at the start
SPEED = (3.2, 4.4)          # cells/s, each comet's own cruising speed (one lap is ~40 cells)
WANDER = 0.25               # its speed drifts by up to this fraction, slowly
SURGE_EVERY = (8.0, 16.0)   # s between surges
SURGE = 0.9                 # a surging comet goes this much faster at the peak
SURGE_FOR = 4.0             # s, the surge's length (it eases in and out)
TAIL = 7.0                  # cells behind the head
TAIL_STEP = 0.6             # cells between the tail's spots
HEAD_LEVEL = 0.5            # each tail spot's peak (they overlap: the head reads about 2.5x this)
SPOT = 0.7                  # sigma of each spot, cells
LANE = 0.9                  # cells either side of the track a comet weaves
TRACK = (8.1, 5.0, 0.55)    # half-width, half-height (cells), squareness (1 = ellipse, lower = squarer)
FLOOR = 0.0                 # the navy under it all, times NAVY (0: dark between the comets, Ross 28 Oct)
# --------------------------------------------------------------------------------

_M = 400                    # points round the track


def _track():
    cx, cy = (COLS - 1) / 2, (ROWS - 1) / 2
    ax, ay, p = TRACK
    pts = []
    for i in range(_M):
        a = 2 * math.pi * i / _M
        c, s = math.cos(a), math.sin(a)
        pts.append((cx + ax * math.copysign(abs(c) ** p, c), cy + ay * math.copysign(abs(s) ** p, s)))
    # Resample by arc length, so a comet's speed is in cells/s all the way round.
    seg = [math.dist(pts[i], pts[(i + 1) % _M]) for i in range(_M)]
    length = sum(seg)
    out, acc, j = [], 0.0, 0
    for i in range(_M):
        want = length * i / _M
        while acc + seg[j] < want:
            acc += seg[j]
            j += 1
        k = (want - acc) / seg[j] if seg[j] else 0
        (x0, y0), (x1, y1) = pts[j], pts[(j + 1) % _M]
        out.append((x0 + (x1 - x0) * k, y0 + (y1 - y0) * k))
    normals = []
    for i in range(_M):
        (x0, y0), (x1, y1) = out[i - 1], out[(i + 1) % _M]
        dx, dy = x1 - x0, y1 - y0
        n = math.hypot(dx, dy) or 1
        normals.append((dy / n, -dx / n))
    return out, normals, length


_PTS, _NORM, LENGTH = _track()


class Chase(Pattern):
    name = 'chase'
    about = 'comets with fading tails chasing round the board, now and then overtaking'
    dark = True             # lit only where the comets are (the brightness test allows for it)

    def setup(self):
        rng = self.rng
        n = len(COMETS)
        # [position (cells along the track), cruising speed, wander phase, lane phase, colour]
        self.comets = [[LENGTH * i / n, rng.uniform(*SPEED), rng.uniform(0, 6.3), rng.uniform(0, 6.3), COMETS[i]]
                       for i in range(n)]
        self.surge = None           # (comet, start)
        self.next_surge = rng.uniform(*SURGE_EVERY)

    def _speed(self, i, t):
        pos, cruise, ph, _, _ = self.comets[i]
        v = cruise * (1 + WANDER * math.sin(0.21 * t + ph))
        if self.surge and self.surge[0] == i:
            k = (t - self.surge[1]) / SURGE_FOR
            if 0 <= k <= 1:
                v *= 1 + SURGE * math.sin(math.pi * k) ** 2
        return v

    def levels(self, t):
        dt = min(self.step_dt(t), 0.5)
        if self.surge and t - self.surge[1] > SURGE_FOR:
            self.surge = None
        if self.surge is None and t >= self.next_surge:
            self.surge = (self.rng.randrange(len(self.comets)), t)
            self.next_surge = t + SURGE_FOR + self.rng.uniform(*SURGE_EVERY)
        px = fill(NAVY, FLOOR)
        steps = int(TAIL / TAIL_STEP) + 1
        for i, c in enumerate(self.comets):
            c[0] = (c[0] + self._speed(i, t) * dt) % LENGTH
            lane = LANE * math.sin(0.37 * t + c[3])
            for j in range(steps):
                d = j * TAIL_STEP
                s = (c[0] - d) % LENGTH
                idx = int(s / LENGTH * _M) % _M
                x, y = _PTS[idx]
                nx, ny = _NORM[idx]
                level = HEAD_LEVEL * (1 - smooth(d / TAIL)) ** 1.3
                if level > 0.01:
                    splat(px, x + nx * lane, y + ny * lane, c[4], level, SPOT)
        return px
