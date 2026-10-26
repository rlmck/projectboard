"""From a problem row to LED colours: pure functions, no I/O.

Follows docs/cast-contract.md section 6 and the app's problemHoldOrder() /
classifyHolds() in app/core.js. Tested on the laptop by pi/tests/test_board.py.
"""
import re

COLS, ROWS = 19, 13                 # A-S x 1-13, row 1 at the bottom
MAX_HOLD = COLS * ROWS              # 247
START, INT, FINISH = 'start', 'int', 'finish'
COLOURS = {START: (0, 255, 0), INT: (0, 0, 255), FINISH: (255, 0, 0)}   # contract 6.2
# Two holds that land on one LED (only possible with a bad mirror map): the
# stronger role wins.
RANK = {INT: 0, START: 1, FINISH: 2}

_HOLD = re.compile(r'^hold([0-9]{1,3})$')


def hold_number(h):
    """'hold24' -> 24; None for anything that isn't a hold id on the grid."""
    m = _HOLD.match(h) if isinstance(h, str) else None
    if not m:
        return None
    n = int(m.group(1))
    return n if 1 <= n <= MAX_HOLD else None


def led_index(n):
    """Hold number (1-247) -> LED index (1-247). Contract 6.4, Gareth's formula."""
    x = (n - 1) % COLS              # column, 0 = A
    y = (n - 1) // COLS             # row, 0 = row 1 (bottom)
    return x * ROWS + y + 1 if x % 2 == 0 else x * ROWS + (ROWS - y)


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        return v
    raise ValueError('hold list is a %s' % type(v).__name__)


def problem_order(row):
    """[finish] + intermediates + starts: the stored holds are inverted (contract 6.2)."""
    order = _as_list(row.get('finish_hold')) + _as_list(row.get('intermediate_holds')) \
        + _as_list(row.get('start_holds'))
    bad = [h for h in order if not isinstance(h, str)]
    if bad:
        raise ValueError('non-text hold ids: %r' % bad[:5])
    return order


def classify(order):
    """hold id -> role, exactly as classifyHolds(): first two = starts, last = finish."""
    cls = {}
    for h in order:
        cls.setdefault(h, INT)
    for h in order[:2]:
        cls[h] = START
    if order:
        cls[order[-1]] = FINISH
    return cls


def frame(row, mirror=False, mirror_map=None):
    """Problem row -> ({led: (r, g, b)}, [dropped hold ids]).

    Roles are worked out on the stored ids first, then out-of-range ids are
    dropped (the stopgap dropped first, which could shift roles), then each
    hold is moved to its mirror partner when mirrored (contract 6.3: a hold
    absent from the map, or mapped to itself, stays put; roles don't change).
    """
    roles = classify(problem_order(row))
    leds, ranks, dropped = {}, {}, []
    for h, role in roles.items():
        target = mirror_map.get(h, h) if mirror else h
        n = hold_number(target)
        if n is None:
            dropped.append(h if target == h else '%s->%s' % (h, target))
            continue
        i = led_index(n)
        if i not in ranks or RANK[role] > ranks[i]:
            ranks[i] = RANK[role]
            leds[i] = COLOURS[role]
    return leds, dropped


def scale(leds, brightness, budget_ma, ma_per_channel):
    """Apply the cast brightness, then cap the whole frame's estimated current.

    Returns ({led: (r, g, b)} as ints 0-255, the cap factor applied, estimated mA).
    The estimate is ma_per_channel at full for each of R, G and B, linear in the value.
    """
    b = min(max(float(brightness), 0.0), 1.0)
    raw = {i: tuple(c * b for c in rgb) for i, rgb in leds.items()}
    ma = sum(c / 255.0 * ma_per_channel for rgb in raw.values() for c in rgb)
    cap = 1.0
    if budget_ma > 0 and ma > budget_ma:
        cap = budget_ma / ma
    out = {i: tuple(int(round(c * cap)) for c in rgb) for i, rgb in raw.items()}
    return out, cap, ma * cap


def check_mirror_map(mm):
    """Validate board_config.mirror_map: a dict of hold id -> hold id."""
    if isinstance(mm, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in mm.items()):
        return mm
    raise ValueError('mirror_map is not a dict of hold ids')
