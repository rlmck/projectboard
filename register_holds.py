"""
register_holds.py

We now have the authoritative, hand-calibrated layout of every hold from the
original DTB system (reference/.../dicholdlist.txt) -- each grid name -> real
pixel position on the original 800x750 wall photo, with [-30,-30] = no hold.

This labelled layout and your 187 hand-placed dots on ProjectBoard.png are the
SAME physical board. So we register (align) the labelled layout onto your dots
with a similarity transform (scale + rotation + translation, optional flip)
using ICP, then give each dot the hold ID of the nearest labelled hold.

Output: hold_map.json  (hold ID -> {x,y} %, positions are YOUR dots, labels are
the ground-truth hold IDs).
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference", "original-pi-codebase", "dtb")

# ---- authoritative labelled layout ----
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

# ---- your dots ----
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

print("=== registration (labelled layout -> your dots) ===")
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

hold_map = {f"hold{n}": {"x": round(assign[n][0], 2), "y": round(assign[n][1], 2)}
            for n in sorted(assign)}
with open(os.path.join(HERE, "hold_map.json"), "w", encoding="utf-8") as f:
    json.dump(hold_map, f, indent=2)

dists = sorted(a[2] for a in assign.values())
print(f"  holds matched to a dot : {len(hold_map)}")
print(f"  match distance  median {dists[len(dists)//2]:.2f}%  "
      f"90th {dists[int(len(dists)*0.9)]:.2f}%  max {dists[-1]:.2f}%")
print()

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
print(f"Wrote hold_map.json ({len(hold_map)} holds)")
