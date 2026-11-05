"""Circuit tracks (cast contract 8.6, db/37): read, check and write circuits.led_track.

A track is, for each move of a circuit, the ordered LEDs between one hold and the
next. Since 5 Nov 2026 the Pi doesn't light them in a run (contract 8.3, the map
and next hold look), but they're kept and checked. The console's Circuit tracks
tab edits them; this module is its server side:

- the check is the Pi's own: pi/listener/circuit.py check_track() (loaded from
  the repo), plus what a save needs on top: no problems at all, every move of
  the circuit present (matches excepted), and the size limits;
- reads and writes go over direct Postgres with db/.env's SUPABASE_DB_URL, the
  way db/apply.py connects (console/castlog.py's connection), never printing it;
- a write is one transaction that locks the row and refuses if the circuit's
  hold_sequence changed since it was checked; the old value goes to an undo file
  in console/data/undo/ (gitignored).

From the command line (the db/README.md seed step):

    python console/tracks.py show "Pat Burner"
    python console/tracks.py import tools/circuit-tracks-pat-burner.json [--circuit NAME] [--dry-run]
"""
import datetime
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
UNDO = os.path.join(HERE, 'data', 'undo')
HOLD_MAP = os.path.join(REPO, 'app', 'hold_map.json')
COLS, ROWS = 19, 13
FEET = ('hold2', 'hold21')

_circuit = None


def circuit_mod():
    """pi/listener/circuit.py: the listener's own check_track() and limits."""
    global _circuit
    if _circuit is None:
        path = os.path.join(REPO, 'pi', 'listener')
        if path not in sys.path:
            sys.path.append(path)          # last: the console's own modules win
        sys.dont_write_bytecode = True
        import circuit
        _circuit = circuit
    return _circuit


class Refused(ValueError):
    pass


# -- board positions (as tools/circuit-trace-demo.html) ---------------------------

def cells(hold_map=None):
    """{n: [x %, y %, 1 if a hold is there else 0]} for every grid cell 1-247: real holds from
    app/hold_map.json, empty cells estimated as the mean x of their column and the mean y of
    their row (rounded to 2 places), exactly as the demo's CELLS table."""
    if hold_map is None:
        with open(HOLD_MAP, encoding='utf-8') as f:
            hold_map = json.load(f)
    pos = {}
    for k, v in hold_map.items():
        if k.startswith('hold') and isinstance(v, dict):
            try:
                pos[int(k[4:])] = (float(v['x']), float(v['y']))
            except (ValueError, KeyError):
                continue
    col, row = {}, {}
    for n, (x, y) in pos.items():
        col.setdefault((n - 1) % COLS, []).append(x)
        row.setdefault((n - 1) // COLS, []).append(y)
    out = {}
    for n in range(1, COLS * ROWS + 1):
        if n in pos:
            out[n] = [pos[n][0], pos[n][1], 1]
        else:
            cx, ry = col.get((n - 1) % COLS), row.get((n - 1) // COLS)
            if cx and ry:
                out[n] = [round(statistics.mean(cx), 2), round(statistics.mean(ry), 2), 0]
    return out


def num(h):
    try:
        return int(str(h)[4:])
    except ValueError:
        return None


# -- moves -------------------------------------------------------------------------

def legs(seq, loop):
    """[(move, from, to)] for every non-match move: 1..L-1, and L (back to the first) on a loop."""
    L = len(seq)
    out = [(i + 1, seq[i], seq[i + 1]) for i in range(L - 1)]
    if loop and L > 1:
        out.append((L, seq[-1], seq[0]))
    return [m for m in out if m[1] != m[2]]


def suggested(seq, a, b):
    """The demo's straight line: the grid cells on the line from a to b, minus the circuit's holds."""
    in_circ = {num(h) for h in seq}
    na, nb = num(a), num(b)
    x0, y0, x1, y1 = (na - 1) % COLS, (na - 1) // COLS, (nb - 1) % COLS, (nb - 1) // COLS
    k = max(abs(x1 - x0), abs(y1 - y0))
    out = []
    for i in range(1, k):
        c = _round(y0 + (y1 - y0) * i / k) * COLS + _round(x0 + (x1 - x0) * i / k) + 1
        if c not in in_circ and c not in out and 'hold%d' % c not in FEET:
            out.append(c)
    return ['hold%d' % c for c in out]


def _round(v):
    """JavaScript's Math.round (halves up), as the demo."""
    import math
    return int(math.floor(v + 0.5))


def along(a, b, cellids, pos):
    """Cells ordered from hold a to hold b by their position on the photo (the demo's along())."""
    pa, pb = pos.get(num(a)), pos.get(num(b))
    if not pa or not pb:
        return list(cellids)
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]

    def key(c):
        p = pos.get(num(c))
        return ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) if p else 0
    return sorted(cellids, key=key)


# -- the check ---------------------------------------------------------------------

def normalise(track):
    """{version: 1, moves: [{move, from, to, cells}]} sorted by move, with nothing else kept."""
    moves = []
    for m in track.get('moves', []):
        if isinstance(m, dict):
            moves.append({'move': m.get('move'), 'from': m.get('from'), 'to': m.get('to'), 'cells': m.get('cells')})
    moves.sort(key=lambda m: m['move'] if isinstance(m['move'], int) else 0)
    return {'version': 1, 'moves': moves}


def check_for_save(track, row):
    """The track a save would write, or Refused. The Pi's check_track() must find no
    problem; every non-match move of the circuit must be there; and the size limits."""
    c = circuit_mod()
    if not isinstance(track, dict):
        raise Refused('track: an object {"version": 1, "moves": [...]}')
    track = normalise(track) if isinstance(track.get('moves'), list) and track.get('version') == 1 else track
    size = len(json.dumps(track, separators=(',', ':')))
    if size > c.TRACK_MAX_BYTES:
        raise Refused('track: %d bytes (at most %d)' % (size, c.TRACK_MAX_BYTES))
    seq = list(row['hold_sequence'] or [])
    moves, problems = c.check_track(track, seq)
    if problems:
        raise Refused('track: ' + '; '.join(problems[:8]) + (' …' if len(problems) > 8 else ''))
    want = {m for m, _, _ in legs(seq, row['loops'])}
    missing = sorted(want - set(moves))
    if missing:
        raise Refused('track: moves missing (every move is stored, edited or not): %s'
                      % ', '.join(str(m) for m in missing))
    return track


def describe_changes(old, new, seq):
    """Lines naming each move that changes, for the confirm."""
    c = circuit_mod()
    before, stale = c.check_track(old, seq) if old else ({}, [])
    after, _ = c.check_track(new, seq) if new else ({}, [])
    lines = []
    for n in sorted(set(before) | set(after)):
        a, b = before.get(n), after.get(n)
        if a == b:
            continue
        what = ('added: ' if a is None else 'removed: ' if b is None else '') + \
            '%s -> %s' % (', '.join(_cell(x) for x in (a or [])) or '(none)', ', '.join(_cell(x) for x in (b or [])) or '(none)')
        lines.append('move %d (%s -> %s): %s' % (n, _cell(seq[n - 1]), _cell(seq[n % len(seq)]), what))
    if stale:
        lines.append('stored now with problems, replaced: ' + '; '.join(stale[:5]))
    return lines


def _cell(h):
    n = num(h)
    return '%s%d' % ('ABCDEFGHIJKLMNOPQRS'[(n - 1) % COLS], (n - 1) // COLS + 1) if n and 1 <= n <= 247 else str(h)


# -- the import (the demo's export format) -------------------------------------------

def from_export(data, row, name=None):
    """A tools/circuit-trace-demo.html export ("pb-circuit-tracks", version 1) -> (track for
    `row`, notes). Every move of the circuit is filled: from the export when its move, from
    and to match the circuit now, else the suggested straight line (noted)."""
    if not isinstance(data, dict) or data.get('format') != 'pb-circuit-tracks' or data.get('version') != 1:
        raise Refused('not a pb-circuit-tracks version 1 file')
    entry = (data.get('circuits') or {}).get(name or row['name'])
    if not isinstance(entry, dict):
        raise Refused('the file has no circuit called %r' % (name or row['name']))
    seq = list(row['hold_sequence'])
    pos = {n: (p[0], p[1]) for n, p in cells().items()}
    given = {}
    for m in entry.get('moves') or []:
        if isinstance(m, dict) and isinstance(m.get('move'), int):
            given[(m['move'], m.get('from'), m.get('to'))] = m.get('cells')
    moves, notes = [], []
    used = set()
    for n, a, b in legs(seq, row['loops']):
        got = given.get((n, a, b))
        if isinstance(got, list):
            used.add((n, a, b))
            moves.append({'move': n, 'from': a, 'to': b, 'cells': list(got)})
        else:
            moves.append({'move': n, 'from': a, 'to': b, 'cells': along(a, b, suggested(seq, a, b), pos)})
            notes.append('move %d (%s -> %s): not in the file, the suggested line used' % (n, _cell(a), _cell(b)))
    for k in sorted(set(given) - used):
        notes.append('move %d (%s -> %s) in the file: not a move of the circuit now, left out' % (k[0], k[1], k[2]))
    return {'version': 1, 'moves': moves}, notes


# -- the database ----------------------------------------------------------------------

def _conn():
    import castlog
    url = castlog._db_url()
    if not url:
        raise RuntimeError('no db/.env on this laptop')
    return castlog._connect(url)


def _row(r):
    track = r[6]
    if isinstance(track, str):
        try:
            track = json.loads(track)
        except ValueError:
            pass
    return {'id': str(r[0]), 'name': r[1], 'grade': r[2], 'hold_sequence': list(r[3] or []),
            'start_count': r[4], 'loops': bool(r[5]), 'led_track': track}


SELECT = 'select id, name, grade, hold_sequence, start_count, loops, led_track from public.circuits'


def list_circuits():
    conn = _conn()
    try:
        conn.run('set session characteristics as transaction read only')
        return [_row(r) for r in conn.run(SELECT + ' order by name')]
    finally:
        conn.close()


def get_circuit(name):
    conn = _conn()
    try:
        conn.run('set session characteristics as transaction read only')
        rows = conn.run(SELECT + ' where name = :n', n=name)
    finally:
        conn.close()
    return _row(rows[0]) if rows else None


def write(name, track, seq, out=print):
    """Set (or with track None, remove) a circuit's led_track. One transaction: the row is
    locked and the write refused if its hold_sequence isn't `seq` any more. The old value is
    kept in console/data/undo/. Returns the number of rows written (1)."""
    conn = _conn()
    try:
        conn.run('begin')
        rows = conn.run('select id, hold_sequence, led_track from public.circuits where name = :n for update', n=name)
        if not rows:
            conn.run('rollback')
            raise Refused('no circuit called %r' % name)
        if list(rows[0][1] or []) != list(seq):
            conn.run('rollback')
            raise Refused('%r was edited since the check (its holds changed): reload and try again' % name)
        old = rows[0][2]
        os.makedirs(UNDO, exist_ok=True)
        undo = os.path.join(UNDO, '%s-led_track.json' % datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
        with open(undo, 'w', encoding='utf-8') as f:
            json.dump({'table': 'circuits', 'name': name, 'column': 'led_track', 'old': old}, f, indent=1)
        if track is None:
            conn.run('update public.circuits set led_track = null where id = :id', id=rows[0][0])
        else:
            conn.run('update public.circuits set led_track = cast(:t as jsonb) where id = :id',
                     t=json.dumps(track, separators=(',', ':')), id=rows[0][0])
        n = conn.row_count
        if n != 1:
            conn.run('rollback')
            raise RuntimeError('%d rows written, expected 1: nothing changed' % n)
        conn.run('commit')
        out('undo record: %s' % os.path.relpath(undo, REPO))
        return n
    except Exception:
        try:
            conn.run('rollback')
        except Exception:               # noqa: BLE001
            pass
        raise
    finally:
        conn.close()


def save(name, track, out=print):
    """Check against the live row and write. Returns the lines describing what changed."""
    row = get_circuit(name)
    if not row:
        raise Refused('no circuit called %r' % name)
    track = check_for_save(track, row)
    lines = describe_changes(row['led_track'], track, row['hold_sequence'])
    write(name, track, row['hold_sequence'], out)
    return lines


def show(row, out=print):
    seq = row['hold_sequence']
    moves, problems = circuit_mod().check_track(row['led_track'], seq)
    out('%s: %d holds, %s, track: %s' % (row['name'], len(seq), 'loop' if row['loops'] else 'once',
                                         'none' if row['led_track'] is None else '%d moves' % len(moves)))
    for n in sorted(moves):
        out('  move %2d  %-4s -> %-4s  %s' % (n, _cell(seq[n - 1]), _cell(seq[n % len(seq)]),
                                              ', '.join('%s (%s)' % (c, _cell(c)) for c in moves[n]) or '(no LEDs)'))
    for p in problems:
        out('  problem: ' + p)


def main(argv):
    sys.path.insert(0, HERE)
    if len(argv) >= 2 and argv[0] == 'show':
        row = get_circuit(argv[1])
        if not row:
            print('no circuit called %r' % argv[1])
            return 1
        show(row)
        return 0
    if len(argv) >= 2 and argv[0] == 'import':
        with open(argv[1], encoding='utf-8') as f:
            data = json.load(f)
        names = [argv[argv.index('--circuit') + 1]] if '--circuit' in argv else list((data.get('circuits') or {}))
        for name in names:
            row = get_circuit(name)
            if not row:
                print('no circuit called %r: skipped' % name)
                continue
            track, notes = from_export(data, row, name)
            for n in notes:
                print('  note: ' + n)
            track = check_for_save(track, row)
            for line in describe_changes(row['led_track'], track, row['hold_sequence']) or ['no change']:
                print('  ' + line)
            if '--dry-run' in argv:
                print('%s: checked, not written (dry run)' % name)
                continue
            write(name, track, row['hold_sequence'])
            print('%s: written' % name)
            show(get_circuit(name))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
