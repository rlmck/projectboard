"""
register_holds.py -- built the BACKUP hold map, app/hold_map.json (10 June 2026).

You shouldn't need to run this. The real hold map lives in the database
(board_config.hold_map) and is edited in the app with #calibrate. This script
only rebuilds the backup the app falls back to when the database can't be
reached, and it can only ever rebuild the same backup from the same June
inputs. Re-running it is safe: it reproduces the committed file exactly.

What it does, in plain English
------------------------------
The app draws a problem's holds as dots on a picture of the board, so it needs
to know where each hold sits on that picture ("hold53 is 62% across, 71% down").
In June we had two half-answers:

  * Gareth's layout (reference/.../dtb/dicholdlist.txt) knows WHICH hold is which,
    but its positions are pixels on HIS old 800x750 wall photo, which is framed
    differently from ours. [-30,-30] there means "no hold in this grid cell".
  * Ross's 187 dots (tools/hold_positions.json), clicked on app/ProjectBoard.png,
    are exactly WHERE the holds are on our picture, but they're unlabelled.

So the script:
  1. shrinks, slides and rotates Gareth's labelled layout until it sits on top of
     Ross's dots as closely as possible (an "ICP" fit: pair every hold with its
     nearest dot, refit, repeat; it tries the layout flipped too, and keeps
     whichever fits better);
  2. gives each dot the label of the nearest hold in the fitted layout (each dot
     and each hold is used once, closest pairs first);
  3. adds the hand-made fixes in SAME_HOLD below;
  4. writes app/hold_map.json: hold id -> {x, y} as % of ProjectBoard.png. The
     positions are always Ross's dots; only the labels come from Gareth.

Two of Gareth's 189 holds have no dot, and that's expected:
  * hold243 (O13): Gareth's routes use two ids, hold242 (N13) and hold243 (O13),
    for the single hold at the top of the wall. 14 problems use hold243 (11 of
    them as their finish; 11 Sep 2026), so it's drawn on hold242's dot (SAME_HOLD). This was first added to the map by
    hand on 19 June 2026 (commit b54d5a6); it lives here now so a re-run keeps it.
  * hold218 (I12): Ross didn't dot it, and Gareth's own position for it is 70 px
    above the top of his photo, so neither source can place it. The live map has
    it (added through #calibrate). No problem used it as of 11 Sep 2026.

Needs reference/original-pi-codebase/dtb/ (local only, gitignored). Run it from
anywhere: python tools/register_holds.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))        # tools/
ROOT = os.path.dirname(HERE)                             # repo root
APP = os.path.join(ROOT, "app")                          # the deployed site
REF = os.path.join(ROOT, "reference", "original-pi-codebase", "dtb")

# Hand-made fixes: hold id -> the hold whose dot it shares (see the header).
SAME_HOLD = {243: 242}

# ---- Gareth's labelled layout ----
with open(os.path.join(REF, "SettingsFolder", "holdlist.csv"), encoding="utf-8") as f:
    names = [ln.strip() for ln in f if ln.strip()]          # names[N] = grid name of holdN
name_to_hold = {nm: i for i, nm in enumerate(names)}        # 'O3' -> 53

with open(os.path.join(REF, "dicholdlist.txt"), encoding="utf-8") as f:
    coords = json.load(f)

src = []   # (holdN, name, px, py)  real holds only
for nm, (px, py) in coords.items():
    if [float(px), float(py)] == [-30.0, -30.0]:
        continue
    if nm not in name_to_hold:
        continue
    src.append((name_to_hold[nm], nm, float(px), float(py)))

# ---- Ross's dots ----
with open(os.path.join(HERE, "hold_positions.json"), encoding="utf-8") as f:
    dots = [(float(d["x"]), float(d["y"])) for d in json.load(f)]


def fit_similarity(s, d):
    """Least-squares similarity (rot+uniform scale+translation) mapping complex
    points s -> d. Returns (w, t) with model w*s + t."""
    n = len(s)
    cs = sum(s) / n
    cd = sum(d) / n
    a = [p - cs for p in s]
    b = [q - cd for q in d]
    denom = sum((p.real * p.real + p.imag * p.imag) for p in a)
    num = sum(b[i] * a[i].conjugate() for i in range(n))
    w = num / denom if denom else complex(1, 0)
    t = cd - w * cs
    return w, t


def icp(source, target, flip):
    """Run ICP; flip=-1 reflects source y first. Returns (w,t,flip,rms,mean_nn)."""
    s_pts = [complex(px, -py if flip < 0 else py) for (_, _, px, py) in source]
    t_pts = target[:]

    # initial: match centroids + RMS scale, no rotation
    n_s = len(s_pts)
    cs = sum(s_pts) / n_s
    ct = sum(t_pts) / len(t_pts)
    rs = math.sqrt(sum(abs(p - cs) ** 2 for p in s_pts) / n_s)
    rt = math.sqrt(sum(abs(p - ct) ** 2 for p in t_pts) / len(t_pts))
    w = complex(rt / rs, 0)
    t = ct - w * cs

    for _ in range(60):
        moved = [w * p + t for p in s_pts]
        ps, pd = [], []
        for i, m in enumerate(moved):
            nn = min(t_pts, key=lambda q: abs(q - m))
            ps.append(s_pts[i])
            pd.append(nn)
        w, t = fit_similarity(ps, pd)

    moved = [w * p + t for p in s_pts]
    nn_d = [min(abs(q - m) for q in t_pts) for m in moved]
    rms = math.sqrt(sum(d * d for d in nn_d) / len(nn_d))
    return w, t, flip, rms, sum(nn_d) / len(nn_d)


target = [complex(x, y) for (x, y) in dots]
runs = [icp(src, target, +1), icp(src, target, -1)]
w, t, flip, rms, mean_nn = min(runs, key=lambda r: r[3])

print("=== registration (Gareth's labelled layout -> Ross's dots) ===")
print(f"  source real holds : {len(src)}")
print(f"  target dots       : {len(dots)}")
print(f"  chosen orientation: {'flipped vertically' if flip < 0 else 'same orientation'}")
print(f"  fit RMS / mean NN : {rms:.2f}% / {mean_nn:.2f}%   "
      f"(other orientation RMS {max(runs, key=lambda r: r[3])[3]:.2f}%)")
print()

# transform every source hold into dot-% space
moved = []
for holdN, nm, px, py in src:
    z = w * complex(px, -py if flip < 0 else py) + t
    moved.append((holdN, nm, z.real, z.imag))

# greedy 1:1 closest-first assignment: each dot -> one hold, each hold -> one dot
pairs = []
for di, (dx, dy) in enumerate(dots):
    for hi, (holdN, nm, mx, my) in enumerate(moved):
        pairs.append((math.hypot(dx - mx, dy - my), di, hi))
pairs.sort(key=lambda p: p[0])

dot_used, hold_used = {}, {}
assign = {}     # holdN -> (dot_x, dot_y, dist, name)
for dist, di, hi in pairs:
    if di in dot_used or hi in hold_used:
        continue
    dot_used[di] = hi
    hold_used[hi] = di
    holdN, nm, _, _ = moved[hi]
    assign[holdN] = (dots[di][0], dots[di][1], dist, nm)
    if len(hold_used) == min(len(moved), len(dots)):
        break

dists = sorted(a[2] for a in assign.values())
print(f"  holds matched to a dot : {len(assign)}")
print(f"  match distance  median {dists[len(dists)//2]:.2f}%  "
      f"90th {dists[int(len(dists)*0.9)]:.2f}%  max {dists[-1]:.2f}%")
print()

# ---- hand-made fixes ----
positions = {n: (a[0], a[1]) for n, a in assign.items()}
for n, same_as in SAME_HOLD.items():
    if n in positions:
        print(f"  SAME_HOLD: hold{n} already has its own dot; left alone")
    elif same_as not in positions:
        raise SystemExit(f"SAME_HOLD: hold{same_as} has no dot, so hold{n} can't share it")
    else:
        positions[n] = positions[same_as]
        print(f"  SAME_HOLD: hold{n} drawn on hold{same_as}'s dot")
unplaced = sorted(n for n, _, _, _ in src if n not in positions)
print(f"  no position (expected: hold218): {', '.join(f'hold{n}' for n in unplaced) or 'none'}")
print()

# Matched holds in number order, then the SAME_HOLD entries (the order the
# committed file has always had), so a re-run leaves it byte-for-byte unchanged.
order = sorted(n for n in positions if n not in SAME_HOLD) + [n for n in SAME_HOLD if n in positions]
hold_map = {f"hold{n}": {"x": round(positions[n][0], 2), "y": round(positions[n][1], 2)}
            for n in order}
with open(os.path.join(APP, "hold_map.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(hold_map, f, indent=2)
    f.write("\n")

# ---- validation against the known problem ----
example = [53, 34, 49, 108, 235, 206, 242]
print("VALIDATION  joe smells 2.0 -> hold / grid / assigned dot %xy / dist:")
for n in example:
    if n in assign:
        x, y, d, nm = assign[n]
        print(f"  hold{n:<4} {nm:<4} ({x:5.1f}, {y:5.1f})   dist {d:4.2f}%")
    else:
        print(f"  hold{n:<4} -- no dot assigned")
print()
print(f"Wrote app/hold_map.json ({len(hold_map)} holds)")
