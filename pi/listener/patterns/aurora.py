"""Aurora: slow horizontal bands of colour, like curtains, waving across the
board: green low down, through teal and the app's blue to violet and pink at
the top. Each column's bands sit a little higher or lower than its
neighbour's, and that offset travels sideways, so the bands ripple. Pure; on
the grid.
"""
import math

from .common import ACCENT, CELLS, COLS, INT, NAVY, ROWS, START, TEAL, VIOLET, Pattern, palette_lut, scaled

# ---- Tunables -----------------------------------------------------------------
PALETTE = [                       # by height (0 = row 1, 1 = row 13, waving)
    (0.00, scaled(START, 0.8)),
    (0.30, scaled(TEAL, 1.9)),
    (0.55, scaled(INT, 0.85)),
    (0.80, scaled(VIOLET, 1.8)),
    (1.00, scaled(ACCENT, 0.85)),
]
BAND = 4.2                        # cells from one band to the next
BAND_DRIFT = 0.12                 # bands a second, rising
WAVE = [(1.5, 0.40, 0.33), (0.8, 0.17, -0.21)]   # (rows of sway, rad per column, rad/s): the ripple
SHARP = 1.6                       # higher = thinner bands, more dark between
FLICKER = (0.18, 1.1, 0.7)        # (depth, rad per column, rad/s): the curtains' slow shimmer
LEVEL = 0.85
FLOOR = 0.9                       # the navy between the bands, times NAVY
# --------------------------------------------------------------------------------

_PAL = palette_lut(PALETTE)


class Aurora(Pattern):
    name = 'aurora'
    about = 'slow horizontal bands of colour waving across the board'

    def setup(self):
        self.phase = [self.rng.uniform(0, 6.3) for _ in range(len(WAVE) + 1)]

    def levels(self, t):
        self.step_dt(t)
        nr, ng, nb = (v * FLOOR for v in NAVY)
        cols = []
        fd, fx, ft = FLICKER
        for x in range(COLS):
            off = sum(a * math.sin(kx * x + w * t + p) for (a, kx, w), p in zip(WAVE, self.phase))
            fl = 1 - fd * (0.5 + 0.5 * math.sin(fx * x + ft * t + self.phase[-1] + math.sin(0.23 * t)))
            cols.append((off, fl))
        px = [None] * CELLS
        drift = BAND_DRIFT * t
        for y in range(ROWS):
            row = y * COLS
            for x in range(COLS):
                off, fl = cols[x]
                u = (y - off) / BAND - drift
                b = 0.5 + 0.5 * math.cos(2 * math.pi * u)
                b = b ** SHARP * LEVEL * fl
                h = (y + 0.6 * off) / (ROWS - 1)
                r, g, bl = _PAL[0 if h <= 0 else 255 if h >= 1 else int(h * 255)]
                px[row + x] = [nr + (r - nr) * b, ng + (g - ng) * b, nb + (bl - nb) * b]
        return px
