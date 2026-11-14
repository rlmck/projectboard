"""A circuit run: from (the circuit, seconds since the cast) to LED colours. Pure, no I/O.

The look is the "map and next hold" look Ross agreed on 5 Nov 2026 (it replaced
direction 4, "Pulse and fade", and the circuit-track lighting). It is ported to
tools/circuit-led-simulator.html (its runFrame() is this file's Run.layers());
keep the two in step. Contract section 8.3 (docs/cast-contract.md). Tested by
pi/tests/test_circuit.py.

- The map: every hold of the circuit blue at CIRCUIT_MAP_LEVEL (0.20) for the
  whole countdown and run. The finish (the last hold of the sequence) is red at
  CIRCUIT_FINISH_LEVEL (0.60), but only on the final lap of a run with a set
  number of laps (a 1-lap run: from the countdown on). An endless run never
  shows red.
- Countdown (5 s): the start holds (start_count, 1 or 2) green, blinking once a
  second: full for 0.08 s, fading linearly to off over the next 0.8 s, then off.
- Run: one move every `interval` s. Only the hold to go to is lit, green, full
  and solid, over the map. Start holds are blue in the run, on every lap.
- A match (the hold to go to is the one the climber is on, c or c-1): the green
  blinks twice at the start of its beat (off 0-0.15 s, on 0.15-0.30 s, off
  0.30-0.45 s, then on). The beat is still one interval.
- Laps: lap 1 begins on the start holds, so its moves go to positions
  s .. L-1; every later lap goes all the way round, 0 (the wrap move) .. L-1. A
  run of N laps is (L - s) + (N - 1) * L moves and ends on position L-1.
- The top (a set number of laps): the finish blinks red three times (the
  countdown's blink, one a second), then the map fades to off over 1 s: done.
  Endless runs until stop (or the listener's CIRCUIT_MAX_S).
- A green or red blink is drawn over what's under it (the map): the colour is
  a crossfade, overlay * a + under * (1 - a), so the map stays steady beneath.

Circuit tracks (circuits.led_track, db/37, contract 8.6) are no longer drawn by
the Pi (5 Nov 2026); check_track(), their checker, went on 14 Nov 2026 (review
SEAM-07: nothing called it once PB Console's tracks tab was removed).

The static view (show_circuit, 2 Nov 2026, contract 8.7) is static_frame(): every
hold of the circuit lit at once in a problem's colours (start green, the last
hold red, the rest blue), as the wall screen draws it (circuitHoldRoles in
app/circuits.js). No animation: the listener shows it like a problem cast.
"""
import board

COUNTDOWN = 5.0
MIN_INTERVAL, MAX_INTERVAL = 1.0, 10.0      # seconds a move the listener accepts (the app sends 2, 3 or 5)
MAX_LAPS = 10                               # cast_circuit laps: 0 (endless) or 1-10
GREEN, BLUE, RED = (0, 255, 0), (0, 0, 255), (255, 0, 0)
BLINK_FULL, BLINK_FADE = 0.08, 0.8          # s: a blink is full, then fades linearly to off, once a second
MATCH_OFF = ((0.0, 0.15), (0.30, 0.45))     # s into a match beat when its green is off
TOP_BLINKS, TOP_FADE = 3, 1.0               # the top: three red blinks (one a second), then the map fades out

OPTION_DEFAULTS = {'map_level': 0.2, 'finish_level': 0.6}
OPTION_KEYS = (('CIRCUIT_MAP_LEVEL', 'map_level', 0.05, 0.6), ('CIRCUIT_FINISH_LEVEL', 'finish_level', 0.1, 1.0))


def options(cfg, warn=None):
    """The circuit keys from config.env (mode.py DEFAULTS), checked: a bad value is
    warned about and the default used. -> {'map_level', 'finish_level'}."""
    out = dict(OPTION_DEFAULTS)
    for key, name, lo, hi in OPTION_KEYS:
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
    return out


def resolve_laps(laps, loop, loops):
    """The laps a run makes (0 = endless) from the cast's laps and loop and the circuit's loops
    (contract 8.1): a circuit whose loops is false always runs 1 lap; laps absent (None) means
    loop true -> 0, loop false -> 1, loop absent -> the circuit's loops (true -> 0)."""
    if not loops:
        return 1
    if laps is not None:
        return int(laps)
    if loop is None:
        return 0
    return 0 if loop else 1


def laps_text(laps):
    return 'endless' if laps == 0 else '1 lap' if laps == 1 else '%d laps' % laps


def blink(x):
    """A blink's level x seconds into its second: full for BLINK_FULL, a linear fade to off over
    BLINK_FADE, then off until the next second."""
    x = x % 1.0
    if x < BLINK_FULL:
        return 1.0
    if x < BLINK_FULL + BLINK_FADE:
        return max(0.0, 1.0 - (x - BLINK_FULL) / BLINK_FADE)
    return 0.0


def match_on(x):
    """A match beat's green, x seconds into the beat: two blinks, then on."""
    return 0.0 if any(a <= x < b for a, b in MATCH_OFF) else 1.0


def static_frame(seq, start_count):
    """A circuit's static view (contract 8.7): ({led: (r, g, b)}, [dropped hold ids]).

    Every distinct hold in the sequence (climbing order, not inverted) lit once, in
    its strongest role across its places in the sequence: the last hold is the
    finish (red), the first start_count (clamped to 1-2, as a run) are starts
    (green), the rest moves (blue). Finish beats start beats a move, the rule of
    the wall screen's board (circuitHoldRoles) and of a problem (board.RANK), so a
    hold that's both a start and the last hold is red. `loops` changes nothing: the
    view is the route's map, not the run. Feet signs and ids off the grid light
    nothing. Never mirrored (no mirrored circuits). Raises ValueError for an empty
    sequence or one that isn't hold ids."""
    if not seq or not isinstance(seq, list) or not all(isinstance(h, str) for h in seq):
        raise ValueError('hold_sequence is empty or not hold ids')
    L = len(seq)
    try:
        s = max(1, min(int(start_count or 1), 2, L))
    except (TypeError, ValueError):
        s = 1
    roles = {}
    for pos, h in enumerate(seq):
        role = board.FINISH if pos == L - 1 else board.START if pos < s else board.INT
        if h not in roles or board.RANK[role] > board.RANK[roles[h]]:
            roles[h] = role
    leds, ranks, dropped = {}, {}, []
    for h, role in roles.items():
        i = board.hold_led(h) if h not in board.FEET_HOLDS else None
        if i is None:
            dropped.append(h)
            continue
        if i not in ranks or board.RANK[role] > ranks[i]:
            ranks[i] = board.RANK[role]
            leds[i] = board.COLOURS[role]
    return leds, dropped


def _over(top, a, under):
    """`top` drawn at level a over `under` (crossfade); both (r, g, b) floats."""
    return tuple(t * a + u * (1 - a) for t, u in zip(top, under))


class Run:
    """One cast circuit. `seq` is the hold sequence in climbing order (contract 8: not inverted).
    `laps` is 0 (endless) or 1-10 (resolve_laps() works it out from the cast and the circuit)."""

    def __init__(self, name, seq, start_count, interval, laps, token=None, mirror_map=None, tag='',
                 map_level=0.2, finish_level=0.6):
        if not seq or not all(isinstance(h, str) for h in seq):
            raise ValueError('hold_sequence is empty or not hold ids')
        if isinstance(laps, bool) or not isinstance(laps, int) or not 0 <= laps <= MAX_LAPS:
            raise ValueError('laps is not 0-%d' % MAX_LAPS)
        self.name, self.token = name, token
        self.tag = tag              # ' [phone, member]' (board.origin), for the line logged when it ends
        self.seq = [mirror_map.get(h, h) for h in seq] if mirror_map is not None else list(seq)
        self.L = len(self.seq)
        self.s = max(1, min(int(start_count or 1), 2, self.L))
        self.interval = float(interval)
        self.laps = laps
        self.endless = laps == 0
        # Moves in the whole run (None: endless). Lap 1 starts on the start holds.
        self.moves = None if self.endless else (self.L - self.s) + (laps - 1) * self.L
        self.map_level = max(0.0, min(1.0, float(map_level)))
        self.finish_level = max(0.0, min(1.0, float(finish_level)))
        # Hold id -> LED index, once; ids off the grid light nothing (the timing is unchanged).
        self.led = {}
        self.dropped = []
        for h in dict.fromkeys(self.seq):
            i = board.hold_led(h) if h not in board.FEET_HOLDS else None
            if i is None:
                self.dropped.append(h)
            else:
                self.led[h] = i
        self.finish = self.seq[-1]

    def hold(self, i):
        return self.seq[i % self.L]

    def target(self, k):
        """The absolute index (s + k) the climber goes to on move k (0-based); its hold is hold(i)."""
        return self.s + k

    def lap_of(self, k):
        return self.target(k) // self.L + 1

    def is_match(self, k):
        """Move k goes to a hold the climber is already on: hold c or c-1 (c = the index reached)."""
        i = self.target(k)
        return any(j >= 0 and self.hold(j) == self.hold(i) for j in (i - 1, i - 2))

    def top_length(self):
        return TOP_BLINKS + TOP_FADE

    def phase(self, t):
        """'count', 'run', 'top' or 'done' at t seconds after the cast."""
        if t < COUNTDOWN:
            return 'count'
        if self.endless:
            return 'run'
        after = t - COUNTDOWN - self.moves * self.interval
        if after < 0:
            return 'run'
        return 'top' if after < self.top_length() else 'done'

    def layers(self, t):
        """({hold id: (r, g, b) floats 0-255}, done) at t seconds after the cast."""
        ph = self.phase(t)
        if ph == 'done':
            return {}, True
        blue = tuple(v * self.map_level for v in BLUE)
        out = {h: blue for h in self.led}
        if ph == 'top':
            after = t - COUNTDOWN - self.moves * self.interval
            out[self.finish] = (0.0, 0.0, 0.0)
            if after < TOP_BLINKS:
                out[self.finish] = _over(RED, blink(after), out[self.finish])
            else:
                fade = max(0.0, 1.0 - (after - TOP_BLINKS) / TOP_FADE)
                out = {h: tuple(v * fade for v in rgb) for h, rgb in out.items()}
            return out, False
        if ph == 'count':
            final = self.laps == 1
        else:
            k = int((t - COUNTDOWN) // self.interval)
            final = not self.endless and self.lap_of(k) == self.laps
        if final:
            out[self.finish] = tuple(v * self.finish_level for v in RED)
        if ph == 'count':
            a = blink(t)
            for i in range(self.s):
                h = self.hold(i)
                out[h] = _over(GREEN, a, out.get(h, (0.0, 0.0, 0.0)))
            return out, False
        x = (t - COUNTDOWN) - k * self.interval
        a = match_on(x) if self.is_match(k) else 1.0
        h = self.hold(self.target(k))
        out[h] = _over(GREEN, a, out.get(h, (0.0, 0.0, 0.0)))
        return out, False

    def frame(self, t):
        """({led: (r, g, b) floats, before the cast brightness}, done)."""
        holds, done = self.layers(t)
        leds = {}
        for h, rgb in holds.items():
            i = self.led.get(h)
            if i is not None and max(rgb) > 0:
                leds[i] = rgb
        return leds, done

    def ended_line(self, how, t):
        """The journal line PB Console's Activity reads (console/probe.py CIRCUIT_LINE)."""
        return 'circuit ended: %r %s after %d moves (%d s), %g s a move, %s, run %s%s' % (
            self.name, how, self.moves_at(t), max(0, t), self.interval, laps_text(self.laps),
            self.token or '-', self.tag)

    def moves_at(self, t):
        """Moves made by t (one per LED advance, counting across laps): what the app logs."""
        if t < COUNTDOWN:
            return 0
        b = int((t - COUNTDOWN) // self.interval)
        return b if self.endless else min(b, self.moves)
