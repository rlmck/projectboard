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

Circuit tracks (1 Nov 2026, contract 8.6), all below everything above, so Pulse
and fade is unchanged wherever it lights an LED:
- TRACE, `trace_s` seconds (0-5, the cast's trace_s) before the countdown: the
  circuit's holds dim white and its track LEDs dim pink fade in over 0.3 s, and
  a white spot with a two-LED tail (100% / 45% / 15%) runs along the path (each
  move's from-hold, then its track cells; every LED once a lap).
- The ghost: every distinct circuit hold dim white (CIRCUIT_GHOST) in the
  countdown and the run (not the finish), the lowest layer.
- The track in the run (CIRCUIT_TRACK_RUN): off, move (the current move's cells,
  from the hold you're on to the one to go to) or all, dim pink at
  CIRCUIT_TRACK_LEVEL, just above the ghost; never on a circuit hold's LED.
The track is circuits.led_track (db/37): {"version": 1, "moves": [{"move", "from",
"to", "cells"}]}, checked move by move against the circuit's hold_sequence by
check_track() (PB Console saves through the same function); a move that fails
is skipped. A mirrored run has no track (the track is drawn for the unmirrored
holds).
"""
import json
import math

import board

COUNTDOWN = 5.0
MIN_INTERVAL, MAX_INTERVAL = 1.0, 10.0      # seconds a move the listener accepts (the app sends 2, 3 or 5)
GREEN, BLUE, RED, AMBER = (0, 255, 0), (0, 0, 255), (255, 0, 0), (255, 110, 0)
FIN_HOLD, FIN_STEP, FIN_FADE = 1.0, 0.07, 1.2

# Circuit tracks (contract 8.6)
WHITE, PINK = (255, 255, 255), (236, 72, 153)
TRACE_MAX = 5.0                     # s, the most trace_s the listener takes
TRACE_FADE = 0.3                    # s, the dim route fading in
TRACE_LAP = 2.8                     # s, a lap of the spot (before the clamp below)
TRACE_STEP_MIN, TRACE_STEP_MAX = 0.034, 0.15     # s a step: 0.034 is at least one frame at 30 fps
TRACE_DIM = 0.12                    # the trace's dim route is never dimmer than this
TAIL = ((2, 0.15), (1, 0.45), (0, 1.0))         # steps behind the head, brightness (the head drawn last)
TRACK_RUN_MODES = ('off', 'move', 'all')
TRACK_MAX_MOVES = 200               # size limits (PB Console refuses bigger; the Pi skips the track)
TRACK_MAX_CELLS = 40                # LEDs in one move
TRACK_MAX_BYTES = 32768             # the JSON, as PB Console saves it
OPTION_DEFAULTS = {'ghost': 0.12, 'track_run': 'move', 'track_level': 0.2}


def options(cfg, warn=None):
    """The circuit-track keys from config.env (mode.py DEFAULTS), checked: a bad value is
    warned about and the default used. -> {'ghost', 'track_run', 'track_level'}."""
    out = dict(OPTION_DEFAULTS)
    for key, name, lo, hi in (('CIRCUIT_GHOST', 'ghost', 0.0, 0.3), ('CIRCUIT_TRACK_LEVEL', 'track_level', 0.0, 0.5)):
        raw = (cfg.get(key) or '').strip()
        if not raw:
            continue
        try:
            v = float(raw)
            if not lo <= v <= hi:
                raise ValueError
            out[name] = v
        except ValueError:
            if warn:
                warn('%s=%r is not %g-%g: using %g' % (key, raw, lo, hi, out[name]))
    raw = (cfg.get('CIRCUIT_TRACK_RUN') or '').strip().lower()
    if raw in TRACK_RUN_MODES:
        out['track_run'] = raw
    elif raw and warn:
        warn('CIRCUIT_TRACK_RUN=%r is not off, move or all: using %s' % (raw, out['track_run']))
    return out


def check_track(led_track, seq):
    """circuits.led_track against the circuit's hold_sequence (climbing order) ->
    ({move number: [hold ids in order]}, [problems, one line each]).

    Never raises. The whole track is refused (no moves) if it isn't
    {"version": 1, "moves": [...]} or has more than TRACK_MAX_MOVES moves. Each
    move is then checked on its own and skipped with a problem line if: it isn't
    an object; its move number isn't 1..len(seq) or is listed twice; its from/to
    aren't hold_sequence[move-1] and the next hold (wrapping to the first) now
    (a stale move: the circuit was edited); from == to (a match has no track);
    its cells aren't a list of at most TRACK_MAX_CELLS hold ids on the grid, none
    of them a feet sign (hold2/hold21), none twice. PB Console saves only a track
    with no problems."""
    if led_track is None:
        return {}, []
    if isinstance(led_track, str):
        try:
            led_track = json.loads(led_track)
        except ValueError:
            return {}, ['led_track is not JSON']
    version = led_track.get('version') if isinstance(led_track, dict) else None
    if isinstance(version, bool) or version != 1 or not isinstance(led_track.get('moves'), list):
        return {}, ['led_track is not {"version": 1, "moves": [...]}']
    raw = led_track['moves']
    if len(raw) > TRACK_MAX_MOVES:
        return {}, ['led_track has %d moves (at most %d)' % (len(raw), TRACK_MAX_MOVES)]
    seq = list(seq or [])
    L = len(seq)
    moves, problems = {}, []
    for k, m in enumerate(raw):
        if not isinstance(m, dict):
            problems.append('entry %d: not an object' % (k + 1))
            continue
        n = m.get('move')
        if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= L:
            problems.append('entry %d: move %r is not 1-%d' % (k + 1, n, L))
            continue
        if n in moves:
            problems.append('move %d: listed twice' % n)
            continue
        want = (seq[n - 1], seq[n % L])
        got = (m.get('from'), m.get('to'))
        if got != want:
            problems.append('move %d: %s -> %s, but the circuit now goes %s -> %s (stale)'
                            % (n, got[0], got[1], want[0], want[1]))
            continue
        if want[0] == want[1]:
            problems.append('move %d: a match has no track' % n)
            continue
        cells = m.get('cells')
        if not isinstance(cells, list) or len(cells) > TRACK_MAX_CELLS:
            problems.append('move %d: cells is not a list of at most %d hold ids' % (n, TRACK_MAX_CELLS))
            continue
        bad = [c for c in cells if board.hold_number(c) is None or c in board.FEET_HOLDS]
        if bad:
            problems.append('move %d: not track LEDs: %s' % (n, ', '.join(repr(c) for c in bad[:5])))
            continue
        if len(set(cells)) != len(cells):
            problems.append('move %d: an LED listed twice' % n)
            continue
        moves[n] = list(cells)
    return moves, problems


class Run:
    """One cast circuit. `seq` is the hold sequence in climbing order (contract 8: not inverted)."""

    def __init__(self, name, seq, start_count, interval, loop, token=None, mirror_map=None, tag='',
                 trace_s=0, track=None, ghost=0.0, track_run='off', track_level=0.2):
        """The defaults add nothing to Pulse and fade (no trace, ghost or track); the listener
        passes the cast's trace_s, the circuit's led_track and options(cfg)."""
        if not seq or not all(isinstance(h, str) for h in seq):
            raise ValueError('hold_sequence is empty or not hold ids')
        self.name, self.token = name, token
        self.tag = tag              # ' [phone, member]' (board.origin), for the line logged when it ends
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
        # Circuit tracks (contract 8.6).
        self.trace = max(0.0, min(TRACE_MAX, float(trace_s or 0)))
        self.ghost = max(0.0, min(1.0, float(ghost or 0)))
        self.track_run = track_run if track_run in TRACK_RUN_MODES else 'off'
        self.track_level = max(0.0, min(1.0, float(track_level or 0)))
        if mirror_map is not None:
            self.track, self.track_problems = {}, (['mirrored: the track is not used'] if track else [])
        else:
            self.track, self.track_problems = check_track(track, seq)
        self.hold_leds = set(self.led.values())
        # Each move this run can make -> its LEDs in order, never a circuit hold's LED.
        # The wrap move (the last hold back to the first) only when it loops.
        last = self.L if self.loop else self.L - 1
        self.move_leds = {}
        for n, cells in self.track.items():
            if n <= last:
                out = []
                for c in cells:
                    i = board.led_index(board.hold_number(c))
                    if i not in self.hold_leds and i not in out:
                        out.append(i)
                self.move_leds[n] = out
        self.track_leds = []
        for n in sorted(self.move_leds):
            self.track_leds += [i for i in self.move_leds[n] if i not in self.track_leds]
        self.path = self._path()
        self.step = max(TRACE_STEP_MIN, min(TRACE_STEP_MAX, TRACE_LAP / max(1, len(self.path))))

    def _path(self):
        """The trace's path: each move's from-hold then its track LEDs, in climbing order
        (matches skipped), then the last hold unless it loops; every LED once (a lap
        never lights one twice). With no track it's just the holds."""
        L, path = self.L, []
        legs = list(range(L - 1)) + ([L - 1] if self.loop and L > 1 else [])
        for i in legs:
            a, b = self.seq[i], self.seq[(i + 1) % L]
            if a == b:
                continue
            path.append(self.led.get(a))
            path += self.move_leds.get(i + 1, [])
        if not self.loop or not path:
            path.append(self.led.get(self.seq[-1]))
        out = []
        for i in path:
            if i is not None and i not in out:
                out.append(i)
        return out

    def phase(self, t):
        """'trace', 'count', 'run', 'finish' or 'done' at t seconds after the cast."""
        t -= self.trace
        if t < 0:
            return 'trace'
        if t < COUNTDOWN:
            return 'count'
        c = self.s - 1 + int((t - COUNTDOWN) // self.interval)
        if not self.loop and c >= self.L - 1:
            return 'done' if t - COUNTDOWN - self.moves * self.interval >= self.finish_length() else 'finish'
        return 'run'

    def move_at(self, t):
        """The move being made in the run (1-based: from seq[move-1] to the next hold)."""
        c = self.s - 1 + int((t - self.trace - COUNTDOWN) // self.interval)
        return c % self.L + 1

    def trace_frame(self, t):
        """{led: (r, g, b) floats} in the trace: the dim route, then the spot over it."""
        fade = _smooth(t / TRACE_FADE)
        leds = {}
        dim = max(self.ghost, TRACE_DIM) * fade
        for i in self.hold_leds:
            leds[i] = tuple(v * dim for v in WHITE)
        dim = max(self.track_level, TRACE_DIM) * fade
        for i in self.track_leds:
            leds[i] = tuple(v * dim for v in PINK)
        n = len(self.path)
        if n:
            k = int(t // self.step)
            for back, a in TAIL:
                if k - back >= 0:
                    leds[self.path[(k - back) % n]] = tuple(v * a for v in WHITE)
        return leds

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

        t -= self.trace                 # the trace comes first (trace_frame draws it)
        if t < 0:
            return {}, False
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
        """({led: (r, g, b) floats, before the cast brightness}, done).

        Layers, top first: Pulse and fade (holds_at, unchanged), the track (the run
        only), the ghost (the countdown and the run). A lower layer only fills LEDs
        nothing above it lit."""
        if t < self.trace:
            return self.trace_frame(t), False
        holds, done = self.holds_at(t)
        leds = {}
        for h, (rgb, a) in holds.items():
            i = self.led.get(h)
            if i is not None and a > 0:
                leds[i] = tuple(v * a for v in rgb)
        ph = self.phase(t)
        if ph == 'run' and self.track_run != 'off' and self.track_level > 0:
            cells = self.move_leds.get(self.move_at(t), []) if self.track_run == 'move' else self.track_leds
            pink = tuple(v * self.track_level for v in PINK)
            for i in cells:
                leds.setdefault(i, pink)
        if ph in ('count', 'run') and self.ghost > 0:
            white = tuple(v * self.ghost for v in WHITE)
            for i in self.hold_leds:
                leds.setdefault(i, white)
        return leds, done

    def ended_line(self, how, t):
        """The journal line PB Console's Activity reads (console/probe.py CIRCUIT_LINE)."""
        return 'circuit ended: %r %s after %d moves (%d s), %g s a move, %s, run %s%s' % (
            self.name, how, self.moves_at(t), max(0, t), self.interval, 'loop' if self.loop else 'once',
            self.token or '-', self.tag)

    def moves_at(self, t):
        """Moves made by t (one per LED advance, counting across laps): what the app logs."""
        t -= self.trace
        if t < COUNTDOWN:
            return 0
        b = int((t - COUNTDOWN) // self.interval)
        return b if self.loop else min(b, self.moves)


def _smooth(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)
