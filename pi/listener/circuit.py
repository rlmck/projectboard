"""A circuit run: from (the circuit, seconds since the cast) to LED colours. Pure, no I/O.

The look is direction 4, "Pulse and fade", chosen by Ross on 30 Oct 2026 in
tools/circuit-led-simulator.html (this is a port of its timeline(),
sharedPhase(), matchSolid() and direction 4; keep the two in step). Contract
section 8 (docs/cast-contract.md). Tested by pi/tests/test_circuit.py.

- Countdown (5 s): the start holds flash red once a second, the first two moves
  flash blue with them.
- Then one move every `interval` seconds. Positions run 0, 1, 2 ... through the
  sequence (wrapping when it loops); c is the last one reached, so the climber
  is on c and c-1 and is going to c+1:
    the holds you're on    their colour (start green on the first lap only, else blue), full
    the hold to go to      solid, its colour (blue, or red for the finish of a circuit run once)
    the hold after that    amber, swelling up once a second, each swell brighter through the move
    the hold let go of     soft red pulses fading out over the move ("catch up")
  A match (the hold to go to is one you're on) stays solid at full brightness.
- Once: at the top, a beat on the finish, the route runs up in green and fades;
  then the run is done. A loop runs until stopped (or the listener's time limit).
"""
import math

import board

COUNTDOWN = 5.0
MIN_INTERVAL, MAX_INTERVAL = 1.0, 10.0      # seconds a move the listener accepts (the app sends 2, 3 or 5)
GREEN, BLUE, RED, AMBER = (0, 255, 0), (0, 0, 255), (255, 0, 0), (255, 110, 0)
FIN_HOLD, FIN_STEP, FIN_FADE = 1.0, 0.07, 1.2


class Run:
    """One cast circuit. `seq` is the hold sequence in climbing order (contract 8: not inverted)."""

    def __init__(self, name, seq, start_count, interval, loop, token=None, mirror_map=None):
        if not seq or not all(isinstance(h, str) for h in seq):
            raise ValueError('hold_sequence is empty or not hold ids')
        self.name, self.token = name, token
        self.seq = [mirror_map.get(h, h) for h in seq] if mirror_map is not None else list(seq)
        self.L = len(self.seq)
        self.s = max(1, min(int(start_count or 1), 2, self.L))
        self.interval = float(interval)
        self.loop = bool(loop)
        self.moves = self.L - self.s
        # Hold id -> LED index, once; ids off the grid light nothing (the timing is unchanged).
        self.led = {}
        self.dropped = []
        for h in set(self.seq):
            n = board.hold_number(h)
            if n is None or h in board.FEET_HOLDS:
                self.dropped.append(h)
            else:
                self.led[h] = board.led_index(n)

    def hold(self, i):
        return self.seq[i % self.L]

    def exists(self, i):
        return i >= 0 and (self.loop or i < self.L)

    def colour(self, i):
        p = i % self.L
        if p < self.s and i < self.L:
            return GREEN
        if not self.loop and p == self.L - 1:
            return RED
        return BLUE

    def finish_length(self):
        return FIN_HOLD + FIN_STEP * self.L + FIN_FADE

    def holds_at(self, t):
        """({hold id: ((r, g, b), brightness 0-1)}, done) at t seconds after the cast."""
        out, pri = {}, {}

        def put(h, rgb, a, p):
            if h not in pri or p > pri[h]:
                pri[h] = p
                out[h] = (rgb, max(0.0, min(1.0, a)))

        s, L, iv = self.s, self.L, self.interval
        if t < COUNTDOWN:
            if t - math.floor(t) < 0.5:
                for i in range(s):
                    put(self.hold(i), RED, 1, 5)
                for i in range(s, s + 2):
                    if self.exists(i):
                        put(self.hold(i), BLUE, 1, 4)
            return out, False

        tb = t - COUNTDOWN
        b = int(tb // iv)
        in_beat = tb - b * iv
        f = in_beat / iv
        c = s - 1 + b

        if not self.loop and c >= L - 1:
            after = tb - self.moves * iv
            if after < FIN_HOLD:
                put(self.hold(L - 1), RED, 1, 5)
                if L > 1:
                    put(self.hold(L - 2), self.colour(L - 2), 1, 4)
            elif after < self.finish_length():
                k = (after - FIN_HOLD) / FIN_STEP
                run_end = FIN_HOLD + FIN_STEP * L
                fade = 1 - (after - run_end) / FIN_FADE if after > run_end else 1
                for i in range(L):
                    if i > k:
                        break
                    put(self.hold(i), RED if i == L - 1 else GREEN, fade, 1)
            else:
                return out, True
            return out, False

        held = [c, c - 1] if c >= 1 else [c]
        target = c + 1
        if c - 2 >= 0:      # let go of: a soft pulse once a second, fading out over the move
            pulse = 0.5 - 0.5 * math.cos(2 * math.pi * in_beat)
            put(self.hold(c - 2), RED, pulse * (1 - f) ** 1.5, 1)
        for i in held:
            put(self.hold(i), self.colour(i), 1, 6)
        put(self.hold(target), self.colour(target), 1, 7)
        if self.exists(c + 2):   # amber: swells up for 0.75 s, drops back in 0.25 s; brighter through the move
            x = in_beat % 1.0
            swell = _smooth(x / 0.75) if x < 0.75 else 1 - _smooth((x - 0.75) / 0.25)
            put(self.hold(c + 2), AMBER, 0.1 + (0.35 + 0.4 * f) * swell, 5)
        if any(self.hold(i) == self.hold(target) for i in held):     # a match: solid
            out[self.hold(target)] = (self.colour(target), 1.0)
        return out, False

    def frame(self, t):
        """({led: (r, g, b) floats, before the cast brightness}, done)."""
        holds, done = self.holds_at(t)
        leds = {}
        for h, (rgb, a) in holds.items():
            i = self.led.get(h)
            if i is not None and a > 0:
                leds[i] = tuple(v * a for v in rgb)
        return leds, done

    def moves_at(self, t):
        """Moves made by t (one per LED advance, counting across laps): what the app logs."""
        if t < COUNTDOWN:
            return 0
        b = int((t - COUNTDOWN) // self.interval)
        return b if self.loop else min(b, self.moves)


def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)
