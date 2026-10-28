"""Lava: big soft blobs (metaballs) drifting slowly round the board, merging
where they meet (their colours blend), each glowing brighter and dimmer on
its own slow beat, over the navy floor. Pure; worked out on the grid.
"""
import math

from .common import ACCENT, CELLS, COLS, FINISH, INT, NAVY, ROWS, VIOLET, X, Y, Pattern, scaled

# ---- Tunables -----------------------------------------------------------------
BLOBS = [ACCENT, scaled(VIOLET, 2.0), INT, FINISH, ACCENT]   # one colour each
RADIUS = (2.6, 3.8)         # cells
DRIFT = (0.05, 0.11)        # rad/s of each blob's wandering path (~a minute to cross the board)
GLOW = (0.08, 0.16)         # rad/s of each blob's glow beat
GLOW_DEPTH = 0.35           # how far the glow dips
EDGE = (0.45, 1.5)          # the field from black to full (a soft edge: 1 is a blob's own radius)
LEVEL = 0.62                # a blob at full
CORE = 0.25                 # where blobs pile up (field over 2) they warm towards white this much
FLOOR = 0.9                 # the navy, times NAVY
# --------------------------------------------------------------------------------


class Lava(Pattern):
    name = 'lava'
    about = 'big soft blobs drifting slowly, merging and glowing in and out'

    def setup(self):
        rng = self.rng
        self.blobs = []
        for c in BLOBS:
            self.blobs.append(dict(
                colour=c, r=rng.uniform(*RADIUS),
                wx=rng.uniform(*DRIFT) * rng.choice((1, -1)), wy=rng.uniform(*DRIFT) * rng.choice((1, -1)),
                px=rng.uniform(0, 6.3), py=rng.uniform(0, 6.3),
                gw=rng.uniform(*GLOW), gp=rng.uniform(0, 6.3)))

    def levels(self, t):
        self.step_dt(t)
        cx, cy = (COLS - 1) / 2, (ROWS - 1) / 2
        live = []
        for b in self.blobs:
            # A wandering path (two sines per axis), kept a little inside the board.
            x = cx + (COLS / 2 - 1.5) * (0.7 * math.sin(b['wx'] * t + b['px']) + 0.3 * math.sin(2.3 * b['wx'] * t))
            y = cy + (ROWS / 2 - 1.5) * (0.7 * math.sin(b['wy'] * t + b['py']) + 0.3 * math.cos(1.9 * b['wy'] * t))
            g = 1 - GLOW_DEPTH * (0.5 + 0.5 * math.sin(b['gw'] * t + b['gp']))
            r2 = b['r'] * b['r']
            # Per blob: g * r^2 (the top of its pull), dx^2 per column, then dy^2 + 0.6 r^2 per row.
            live.append((g * r2, [(xx - x) * (xx - x) for xx in range(COLS)],
                         [(yy - y) * (yy - y) + 0.6 * r2 for yy in range(ROWS)], b['colour']))
        e0, e1 = EDGE
        nr, ng, nb = (v * FLOOR for v in NAVY)
        px = []
        for c in range(CELLS):
            xc, yc = X[c], Y[c]
            f = r = gg = bb = 0.0
            for top, dx2, dy2, col in live:
                w = top / (dx2[xc] + dy2[yc])
                f += w
                r += col[0] * w
                gg += col[1] * w
                bb += col[2] * w
            # f is about 1.7 at a blob's centre, 0.6 at its radius
            v = (f - e0) / (e1 - e0)
            if v <= 0:
                px.append([nr, ng, nb])
                continue
            if v > 1:
                v = 1.0
            s = v * v * (3 - 2 * v)
            k = LEVEL / f                       # the blobs' colours, weighted by their pull here
            hot = CORE * max(0.0, min(1.0, f - 2.0))
            pr, pg, pb = r * k, gg * k, bb * k
            px.append([nr + (pr - nr) * s + hot, ng + (pg - ng) * s + hot * 0.8, nb + (pb - nb) * s + hot * 0.6])
        return px
