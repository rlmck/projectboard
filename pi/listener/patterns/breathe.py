"""Breathe: the whole board slowly breathing between two palette colours,
dim on the out-breath, brighter on the in-breath. Each breath rises from the
bottom row to the top, so the board never changes all at once. Every few
breaths the pair of colours slides on to the next. Pure; on the grid.

Photosensitivity: one breath takes BREATH s (far from a flash), and the swing
is gentle (LOW to HIGH).
"""
import math

from .common import ACCENT, CELLS, INT, NAVY, ROWS, TEAL, VIOLET, Y, Pattern, scaled

# ---- Tunables -----------------------------------------------------------------
PAIRS = [                                   # (out-breath colour, in-breath colour)
    (NAVY, TEAL),
    (scaled(VIOLET, 1.1), scaled(ACCENT, 0.5)),
    (NAVY, scaled(INT, 0.6)),
]
BREATH = 9.0                # s, one breath out and in
RISE = 1.4                  # s for a breath to climb from row 1 to row 13
LOW, HIGH = 0.75, 1.05      # the brightness at the bottom and top of a breath
BREATHS_PER_PAIR = 5        # then the colours move on, over the last breath
# --------------------------------------------------------------------------------


class Breathe(Pattern):
    name = 'breathe'
    about = 'the whole board slowly breathing between two palette colours'

    def levels(self, t):
        self.step_dt(t)
        span = BREATH * BREATHS_PER_PAIR
        # One colour pair per row (the rows lag), worked out once each.
        rows = []
        for y in range(ROWS):
            tt = max(0.0, t - RISE * y / (ROWS - 1))
            b = 0.5 - 0.5 * math.cos(2 * math.pi * tt / BREATH)          # 0 out, 1 in
            b = b * b * (3 - 2 * b)
            p = tt / span
            i = int(p) % len(PAIRS)
            k = (p - int(p)) * BREATHS_PER_PAIR - (BREATHS_PER_PAIR - 1)  # the last breath: 0 -> 1
            lo, hi = PAIRS[i]
            if k > 0:
                lo2, hi2 = PAIRS[(i + 1) % len(PAIRS)]
                k = k * k * (3 - 2 * k)
                lo = tuple(a + (c - a) * k for a, c in zip(lo, lo2))
                hi = tuple(a + (c - a) * k for a, c in zip(hi, hi2))
            g = LOW + (HIGH - LOW) * b
            rows.append([(a + (c - a) * b) * g for a, c in zip(lo, hi)])
        return [list(rows[Y[c]]) for c in range(CELLS)]
