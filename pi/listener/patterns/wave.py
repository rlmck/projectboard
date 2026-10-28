"""Wave: a vertical band sweeping left to right and back again, continuously,
like a Mexican wave, on an otherwise dark board. The band is lit in the
problem colours by height: green in the bottom quarter (the start zone),
red in the top three rows (the finish), blue in between. It eases at each
end before turning back. Pure; on the grid.

Photosensitivity: the band moves smoothly (a soft Gaussian edge, never a
column switching on at once), and any one column lights about once a lap.
"""
import math

from .common import CELLS, COLS, FINISH, INT, ROWS, START, X, Y, Pattern

# ---- Tunables -----------------------------------------------------------------
WIDTH = 0.15                # of the board's width: the band's full width at half brightness (~2.9 columns)
LAP = 8.0                   # s, left to right and back
LEVEL = 1.0                 # the band's centre (times the token colour)
START_ROWS = 0.25           # the bottom quarter of the rows is green (rows 1-3)
FINISH_ROWS = 3             # the top three rows are red (rows 11-13)
# --------------------------------------------------------------------------------

_SIGMA = WIDTH * COLS / 2.355                 # Gaussian sigma for that half-height width


def _colour(y):
    if y < round(START_ROWS * ROWS):
        return START
    if y >= ROWS - FINISH_ROWS:
        return FINISH
    return INT


_COLOUR = [_colour(Y[c]) for c in range(CELLS)]


class Wave(Pattern):
    name = 'wave'
    about = 'a vertical band sweeping left and right: green at the bottom, red at the top, blue between'
    dark = True             # lit only where the band is (the brightness test allows for it)

    def levels(self, t):
        self.step_dt(t)
        # Position: 0 (column A) -> COLS - 1 (column S) -> 0, easing at each end.
        centre = (COLS - 1) * (0.5 - 0.5 * math.cos(2 * math.pi * t / LAP))
        k = -0.5 / (_SIGMA * _SIGMA)
        col = []
        for x in range(COLS):
            d = x - centre
            col.append(LEVEL * math.exp(d * d * k) if abs(d) < 4 * _SIGMA else 0.0)
        px = []
        for c in range(CELLS):
            e = col[X[c]]
            r, g, b = _COLOUR[c]
            px.append([r * e, g * e, b * e])
        return px
