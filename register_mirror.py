"""
register_mirror.py

Builds mirror_map.json: holdN -> mirror-partner holdN for The Hangout symmetry
board, so the PWA can show (and the Pi can later cast) the left/right-mirrored
version of a problem.

Why this isn't arithmetic
-------------------------
The board is hand-set and staggered, so the A-S grid "columns" are NOT vertical
mirror lines: the physical mirror of E1 is labelled O2, not O1. A naive column
flip (A<->S) leaves 28 holds with no partner and disagrees with the real layout
about half the time. So mirroring is a lookup table, exactly as Gareth's original
DTB code did it (SettingsFolder/MirrorDic.txt, applied on the Pi).

Source of truth: Gareth's hand-built, board-TESTED table
--------------------------------------------------------
Converted into holdN space, Gareth's MirrorDic is a clean reciprocal involution
for 184 of the 189 holds. We trust those outright — geometric x-reflection is
itself unreliable on a staggered board (a hold's structural mirror often isn't at
its reflected x), so second-guessing the tested table with geometry does more
harm than good in the sparse rows.

The repair
----------
Exactly five holds aren't reciprocal in Gareth's table:
  * a 4-hold tangled knot in the DENSE E3/E4/O4/O6 region (holds 43,62,72,110),
    where geometry IS reliable (true partners sit ~1% from the x-reflection); and
  * I12 (hold218), whose grid mirror K12 isn't a real hold at all.
We repair only the knot: pull each broken hold's geometric mirror-neighbour into a
small set and re-pair that set by geometric distance. I12 has no partner, so it
maps to itself (mirroring leaves it in place rather than dropping it).

Inputs:
  reference/original-pi-codebase/dtb/dtb/SettingsFolder/MirrorDic.txt  (grid->grid)
  reference/original-pi-codebase/dtb/dtb/SettingsFolder/holdlist.csv   (names[N]=grid of holdN)
  hold_map.json   (holdN -> {x,y} %, for the geometric repair + axis)

Output:
  mirror_map.json  (holdN -> holdM string; self for centre / no-partner holds)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference", "original-pi-codebase", "dtb", "dtb", "SettingsFolder")

# The 189 real holds (ground truth from the DTB layout) — same list app.js uses.
VALID = [1,3,4,5,7,8,10,12,14,16,17,19,20,22,23,24,25,27,28,30,31,32,33,34,35,36,
         38,39,41,42,43,44,45,46,47,48,49,50,51,53,54,55,58,59,60,61,62,63,64,65,
         69,70,71,72,73,74,75,76,79,80,81,82,83,85,86,87,89,90,91,92,93,94,95,96,
         97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,
         116,117,118,119,120,121,122,123,125,126,127,128,129,130,131,132,133,134,
         135,136,137,138,139,140,141,143,145,146,147,148,149,150,151,152,154,155,
         156,157,158,160,161,162,163,164,165,166,167,168,169,171,172,174,175,176,
         177,178,179,180,185,186,188,189,190,191,192,194,195,196,198,199,202,203,
         205,206,207,208,212,213,216,218,219,221,222,230,231,233,234,235,236,237,
         239,242,243,244,245,246]
VSET = set(VALID)

# Holds on the symmetry axis (the J column) whose mean x defines the reflection axis.
AXIS_HOLDS = [10, 48, 86, 105, 143, 162, 219]


def grid_name(n):
    """holdN -> grid name: hold1->A1, hold19->S1, hold20->A2, hold243->O13."""
    return chr(65 + (n - 1) % 19) + str((n - 1) // 19 + 1)


def load_gareth_map():
    """Convert Gareth's grid-name MirrorDic into holdN -> holdN (valid targets only)."""
    with open(os.path.join(REF, "MirrorDic.txt"), encoding="utf-8") as f:
        md = json.load(f)
    with open(os.path.join(REF, "holdlist.csv"), encoding="utf-8") as f:
        names = [ln.strip() for ln in f if ln.strip()]   # names[N] = grid of holdN
    name_to_hold = {nm: i for i, nm in enumerate(names)}
    g = {}
    for n in VALID:
        tgt = md.get(grid_name(n))
        tn = name_to_hold.get(tgt) if tgt else None
        if tn in VSET:
            g[n] = tn
    return g


def main():
    gareth = load_gareth_map()
    with open(os.path.join(HERE, "hold_map.json"), encoding="utf-8") as f:
        hm = json.load(f)
    pos = {int(k[4:]): (v["x"], v["y"]) for k, v in hm.items()}   # holdN -> (x,y)
    axis = sum(pos[n][0] for n in AXIS_HOLDS) / len(AXIS_HOLDS)

    def dist(a, b):
        """How far b is from a's x-reflection (None if either lacks a position)."""
        if a not in pos or b not in pos:
            return None
        ax, ay = pos[a]; bx, by = pos[b]
        return ((bx - (2 * axis - ax)) ** 2 + (by - ay) ** 2) ** 0.5

    def geo_nearest(n):
        """Nearest positioned valid hold to n's x-reflection."""
        best, bestd = None, 1e9
        for m in VALID:
            if m == n or m not in pos:
                continue
            d = dist(n, m)
            if d < bestd:
                bestd, best = d, m
        return best

    # Broken = not a reciprocal Gareth pair (includes the no-partner holds).
    def reciprocal(n):
        m = gareth.get(n)
        return m is not None and gareth.get(m) == n
    broken = [n for n in VALID if not reciprocal(n)]

    # Re-solve set: the broken holds plus each one's geometric mirror-neighbour
    # (which drags the knot's true partners — e.g. 81/91 — out of their tangled
    # Gareth pairing). Stays local: broken holds live in one dense region.
    resolve = set(broken)
    for b in broken:
        if b in pos:
            resolve.add(geo_nearest(b))

    partner = {}
    # 1) Keep Gareth's reciprocal pairs for holds untouched by the repair.
    for n in VALID:
        if n in resolve:
            continue
        m = gareth.get(n)
        if m is not None and m not in resolve and gareth.get(m) == n:
            partner[n] = m
    # 2) Re-pair the resolve set by geometric distance (closest-first 1:1).
    cand = []
    rp = [n for n in resolve if n in pos]
    for i, a in enumerate(rp):
        for b in rp[i + 1:]:
            cand.append((dist(a, b), a, b))
    cand.sort(key=lambda t: t[0])
    for _, a, b in cand:
        if a in partner or b in partner:
            continue
        partner[a] = b; partner[b] = a
    # 3) Anything still unmatched (e.g. I12) maps to itself.
    for n in VALID:
        partner.setdefault(n, n)

    # ---- invariants ----
    assert all(partner[partner[n]] == n for n in VALID), "not an involution!"
    assert set(partner) == VSET, "every valid hold must have an entry"

    out = {f"hold{n}": f"hold{partner[n]}" for n in sorted(VALID)}
    with open(os.path.join(HERE, "mirror_map.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # ---- report ----
    centre = sorted(n for n in VALID if partner[n] == n)
    changed = sorted(n for n in gareth if partner[n] != gareth.get(n))
    print(f"axis x = {axis:.2f}")
    print(f"holds: {len(VALID)}   distinct pairs: {sum(1 for n in VALID if partner[n] > n)}"
          f"   self-mirror: {len(centre)}")
    print(f"broken in Gareth (repaired): {[f'hold{n}({grid_name(n)})' for n in broken]}")
    print(f"self-mirror (centre / no-partner): {[f'hold{n}({grid_name(n)})' for n in centre]}")
    print(f"\nrepaired pairings ({len(changed)} holds changed from Gareth):")
    for n in changed:
        gp = gareth.get(n)
        gs = f"hold{gp}({grid_name(gp)})" if gp else "MISSING"
        dch = dist(n, partner[n])
        print(f"  hold{n}({grid_name(n)}): Gareth->{gs}  =>  "
              f"hold{partner[n]}({grid_name(partner[n])})"
              + (f" d={dch:.1f}" if dch is not None else " (self)"))

    big = sorted(((dist(n, partner[n]), n) for n in VALID
                  if partner[n] != n and dist(n, partner[n]) is not None
                  and dist(n, partner[n]) > 6), reverse=True)
    print(f"\nreciprocal pairs kept from Gareth with a >6% geometric gap "
          f"(expected — staggered rows + ICP position noise, NOT errors): {len(big)//2}")
    for d, n in big:
        if partner[n] > n:
            print(f"  hold{n}({grid_name(n)}) <-> hold{partner[n]}({grid_name(partner[n])})  d={d:.1f}")
    print(f"\nWrote mirror_map.json ({len(out)} holds)")


if __name__ == "__main__":
    main()
