"""Teaser: every so often a random benchmark problem fades in on the board, in
its cast colours but dimmer, holds a few seconds and fades out again. In
between, Glisten's shimmer on its own (no sparkles or glint), turned down.
Pure; on the grid.

The problems come from ctx['benchmarks'], a list of (name, {cell: role}) that
the listener fetches from Supabase every half hour (supa.fetch_benchmarks, one
small read with the anon key) and hands to the renderer; from_rows() builds
it. Unmirrored. With none loaded yet (no network since the start), it's just
the shimmer.
"""
import board

from .common import CELLS, Pattern, smooth
from .glisten import Glisten

# ---- Tunables -----------------------------------------------------------------
FIRST = (4.0, 8.0)          # s before the first problem
EVERY = (14.0, 24.0)        # s from one problem fading out to the next fading in
FADE = 1.6                  # s in, and again out
HOLD = 5.0                  # s at full
LEVEL = 0.62                # the problem's holds (a cast at BRIGHTNESS 0.5 is about 0.73)
BACKGROUND = 1.0            # the shimmer between problems, times Glisten's
BACKGROUND_UNDER = 0.35     # and under a problem, so the holds read
# --------------------------------------------------------------------------------

ROLE = {role: tuple(v / 255 for v in rgb) for role, rgb in board.COLOURS.items()}


def from_rows(rows):
    """Problem rows (name + the three hold columns) -> [(name, {cell: role})], skipping bad ones."""
    out = []
    for row in rows or []:
        try:
            roles = board.classify(board.problem_order(row))
        except (ValueError, TypeError, AttributeError):
            continue
        cells = {}
        for h, role in roles.items():
            n = board.hold_number(h)
            if n is not None and h not in board.FEET_HOLDS:     # feet lights aren't holds
                cells[n - 1] = role
        if cells:
            out.append((row.get('name') or '?', cells))
    return out


class Teaser(Pattern):
    name = 'teaser'
    about = 'every so often a random benchmark problem fades in, dimmer, then out again'

    def setup(self):
        self.bg = Glisten(seed=self.rng.random())
        self.showing = None         # (name, {cell: role}, start)
        self.last = None
        self.shown = []             # names, in order (tests read it)
        self.next_at = self.rng.uniform(*FIRST)

    def _pick(self):
        probs = list(self.ctx.get('benchmarks') or [])
        if len(probs) > 1:
            probs = [p for p in probs if p[0] != self.last] or probs
        return self.rng.choice(probs) if probs else None

    def levels(self, t):
        self.step_dt(t)
        e = 0.0
        if self.showing:
            age = t - self.showing[2]
            if age >= 2 * FADE + HOLD:
                self.showing = None
                self.next_at = t + self.rng.uniform(*EVERY)
            else:
                e = smooth(min(1.0, age / FADE, (2 * FADE + HOLD - age) / FADE))
        if self.showing is None and t >= self.next_at:
            p = self._pick()
            if p:
                self.showing = (p[0], p[1], t)
                self.last = p[0]
                self.shown.append(p[0])
                del self.shown[:-50]
            else:
                self.next_at = t + 5.0          # nothing loaded yet: look again shortly
        px = self.bg._shimmer(t)
        g = BACKGROUND + (BACKGROUND_UNDER - BACKGROUND) * e
        for p in px:
            p[0] *= g
            p[1] *= g
            p[2] *= g
        if self.showing and e > 0:
            for c, role in self.showing[1].items():     # each hold crossfades to its pure cast colour
                if 0 <= c < CELLS:
                    p = px[c]
                    for i, v in enumerate(ROLE[role]):
                        p[i] += (v * LEVEL - p[i]) * e
        return px
