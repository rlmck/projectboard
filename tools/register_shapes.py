#!/usr/bin/env python3
"""
register_shapes.py — auto-trace accurate hold outlines into hold_shapes.json.

Instead of hand-drawing crude polygons in trace_holds.html, this detects each
hold's real outline straight from the board image and writes the same
hold_shapes.json the app consumes (hold id -> [[x,y], ...] as % of the image).

How it works
------------
The board art draws every hold with a dark outline on a flat background
(pink / white / black). That outline is a strong gradient ridge regardless of
the hold's own colour, so a *marker-controlled watershed* segments all holds in
one pass — even low-contrast ones (cream-on-white, grey-on-black):

  * one foreground marker (small disc) at each hold centre from the live map,
  * background markers wherever a pixel is far from every hold centre,
  * cv2.watershed floods each centre's basin out to the surrounding outline.

Each region's external contour is simplified (approxPolyDP) into a tidy polygon
and converted to image-percentage coords, matching hold_map.json's space.

Source of truth is the LIVE board (Supabase board_config: board.jpg + hold_map),
exactly like the app and trace_holds.html — NOT the bundled ProjectBoard.png,
which has a different framing. Falls back to the bundled image/map if offline.

The board's board_config.updated_at is written into the output as
__meta.board_updated_at. The app refuses to draw these outlines over any other
board (see shapesUsable() in core.js), so a recalibration cleanly retires them
instead of silently misplacing every hold.

Merging: hold_shapes.json is hand-repaired in trace_holds.html, so by default a
re-run KEEPS every outline the file already has and only fills in the missing
ones. Pass --overwrite to replace them with freshly detected ones.

Deps: pip install numpy opencv-python-headless   (dev-only; not shipped)
Run:  python tools/register_shapes.py            # merge into app/hold_shapes.json + preview
      python tools/register_shapes.py --overwrite # replace every outline
The preview (shapes_preview.png) is written next to this script, in tools/.
"""
import argparse, json, os, urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))        # tools/
APP = os.path.join(os.path.dirname(HERE), "app")         # the deployed site
SUPA_URL = "https://uqirowyfqwiceyjznosl.supabase.co"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6"
        "InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAs"
        "ImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA")

# The board image is an admin-uploaded phone photo, so its pixel size varies a
# lot. Every distance below is therefore expressed as a multiple of the board's
# own scale — the median distance between neighbouring hold centres — instead of
# a hard pixel count that only suits one resolution. The fractions reproduce the
# previously hard-coded 80 / 25 / 3 px on the current 1386x1135 board.
RMAX_FRAC = 1.2          # max hold radius: leak guard + background-marker distance
AREA_FLOOR_FRAC = 0.075  # drop specks smaller than (this x spacing)^2
MARKER_FRAC = 0.045      # radius of the foreground marker disc at each hold centre
EPS_FRAC = 0.006         # approxPolyDP epsilon as a fraction of perimeter (smaller = smoother)


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(req, timeout=20).read()


def load_board():
    """Return (bgr_image, hold_map, board_version). Live board_config first, bundled fallback."""
    img_bytes, hold_map, version = None, None, None
    try:
        h = {"apikey": ANON, "Authorization": "Bearer " + ANON}
        row = json.loads(_get(
            f"{SUPA_URL}/rest/v1/board_config?wall=eq.HangoutPortland"
            "&select=image_path,updated_at,hold_map", h).decode())[0]
        if row.get("hold_map"):
            hold_map = row["hold_map"]
        if row.get("image_path"):
            ver = f"?v={row['updated_at']}" if row.get("updated_at") else ""
            img_bytes = _get(
                f"{SUPA_URL}/storage/v1/object/public/board/{row['image_path']}{ver}")
            print(f"live board image: {row['image_path']}")
        if hold_map is not None and img_bytes is not None:
            version = row.get("updated_at")
    except Exception as e:
        print(f"(live board_config unavailable: {e}; falling back to bundled)")

    if img_bytes is None:
        with open(os.path.join(APP, "ProjectBoard.png"), "rb") as f:
            img_bytes = f.read()
        print("bundled image: app/ProjectBoard.png")
    if hold_map is None:
        with open(os.path.join(APP, "hold_map.json")) as f:
            hold_map = json.load(f)
        print("bundled map: app/hold_map.json")

    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit("could not decode the board image")
    return img, hold_map, version


def board_scale(centers):
    """Median distance from a hold centre to its nearest neighbour, in pixels."""
    pts = np.array(list(centers.values()), np.float64)
    if len(pts) < 2:
        return 1.0
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=2)
    np.fill_diagonal(d, np.inf)
    nn = d.min(axis=1)
    nn = nn[nn > 0]                       # ignore exact duplicates (they'd give 0)
    return float(np.median(nn)) if len(nn) else 1.0


def marker_groups(centers, min_sep):
    """Group holds whose marker discs would overlap (union-find over proximity).

    Markers are stamped as discs, so two holds closer than a disc diameter used
    to overwrite each other's label and the loser silently dropped out. Each
    group now gets ONE marker and shares the resulting polygon — which also
    covers the exact-duplicate case (hold242/hold243 sit on the same pixel).
    """
    items = list(centers.items())
    parent = {h: h for h, _ in items}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i, (h1, p1) in enumerate(items):
        for h2, p2 in items[i + 1:]:
            if (p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2 < min_sep * min_sep:
                ra, rb = find(h1), find(h2)
                if ra != rb:
                    parent[ra] = rb

    groups = {}
    for h, _ in items:
        groups.setdefault(find(h), []).append(h)
    return list(groups.values())


def detect(img, hold_map):
    H, W = img.shape[:2]
    # Percentages come from the calibrate tool and can sit on (or a hair outside)
    # the edge, so clamp before indexing — numpy would raise on W/H and silently
    # wrap a negative round to the opposite edge of the image.
    def clamp(v, hi):
        return max(0, min(int(round(v)), hi - 1))
    centers = {h: (clamp(p["x"] / 100 * W, W), clamp(p["y"] / 100 * H, H))
               for h, p in hold_map.items()}

    scale = board_scale(centers)
    rmax = max(4, int(round(RMAX_FRAC * scale)))
    area_floor = max(9.0, (AREA_FLOOR_FRAC * scale) ** 2)
    marker_r = max(1, int(round(MARKER_FRAC * scale)))
    print(f"board scale: {scale:.1f}px between neighbours "
          f"-> rmax={rmax} area_floor={area_floor:.0f} marker_r={marker_r}")

    groups = marker_groups(centers, 2 * marker_r)
    merged = [g for g in groups if len(g) > 1]
    if merged:
        print(f"{len(merged)} group(s) of holds too close to mark separately: "
              + "; ".join("+".join(sorted(g)) for g in merged))

    # --- build watershed markers ---
    markers = np.zeros((H, W), np.int32)
    pts = np.ones((H, W), np.uint8)
    for (cx, cy) in centers.values():
        pts[cy, cx] = 0
    dist = cv2.distanceTransform((pts * 255).astype(np.uint8), cv2.DIST_L2, 5)
    BG = len(groups) + 1
    markers[dist > rmax] = BG                       # confidently-background
    markers[0, :] = BG; markers[-1, :] = BG
    markers[:, 0] = BG; markers[:, -1] = BG
    group_center = []
    for i, g in enumerate(groups, start=1):         # foreground discs, one per group
        cx = int(round(sum(centers[h][0] for h in g) / len(g)))
        cy = int(round(sum(centers[h][1] for h in g) / len(g)))
        group_center.append((cx, cy))
        cv2.circle(markers, (cx, cy), marker_r, i, -1)

    ws = markers.copy()
    cv2.watershed(img, ws)

    out = {}
    disc_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    for i, g in enumerate(groups, start=1):
        cx, cy = group_center[i - 1]
        m = (ws == i).astype(np.uint8)
        guard = np.zeros((H, W), np.uint8)
        cv2.circle(guard, (cx, cy), rmax, 1, -1)
        m &= guard
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, disc_k)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        pick = None
        for c in sorted(cnts, key=cv2.contourArea, reverse=True):
            if cv2.pointPolygonTest(c, (cx, cy), False) >= 0:
                pick = c
                break
        if pick is None and cnts:
            pick = max(cnts, key=cv2.contourArea)
        if pick is None or cv2.contourArea(pick) < area_floor:
            continue
        peri = cv2.arcLength(pick, True)
        poly = cv2.approxPolyDP(pick, EPS_FRAC * peri, True).reshape(-1, 2)
        if len(poly) < 3:
            continue
        pct = [[round(x / W * 100, 2), round(y / H * 100, 2)] for x, y in poly]
        for h in g:                                 # a merged group shares its polygon
            out[h] = pct

    fails = [h for h in hold_map if h not in out]
    return out, fails, centers


def write_preview(img, out, centers, path):
    H, W = img.shape[:2]
    prev = img.copy()
    for h, pct in out.items():
        p = np.array([[int(x / 100 * W), int(y / 100 * H)] for x, y in pct], np.int32)
        cv2.polylines(prev, [p], True, (0, 255, 255), 2)
    for (cx, cy) in centers.values():
        cv2.circle(prev, (cx, cy), 2, (0, 0, 255), -1)
    cv2.imwrite(path, prev)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="hold_shapes.json",
                    help="output file, relative to app/ (default: hold_shapes.json)")
    ap.add_argument("--overwrite", action="store_true",
                    help="replace existing outlines instead of keeping them (DISCARDS hand edits)")
    args = ap.parse_args()
    out_path = os.path.join(APP, args.out)

    img, hold_map, version = load_board()
    traced, fails, centers = detect(img, hold_map)

    # Existing file wins by default: its outlines may have been hand-repaired in
    # trace_holds.html (and nothing else records that work).
    existing, kept = {}, 0
    if os.path.exists(out_path):
        with open(out_path) as f:
            existing = json.load(f)
        old_version = (existing.get("__meta") or {}).get("board_updated_at")
        if not args.overwrite and old_version and version and old_version != version:
            raise SystemExit(
                f"{args.out} was traced against board {old_version} but the live board is "
                f"{version} — merging would mix two boards. Re-run with --overwrite.")
    result = {}
    for h in hold_map:
        if not args.overwrite and isinstance(existing.get(h), list) and len(existing[h]) >= 3:
            result[h] = existing[h]
            kept += 1
        elif h in traced:
            result[h] = traced[h]
    missing = [h for h in hold_map if h not in result]

    payload = {"__meta": {"board_updated_at": version,
                          "source": "register_shapes.py"}}
    payload.update(result)
    with open(out_path, "w") as f:
        json.dump(payload, f)
    write_preview(img, result, centers, os.path.join(HERE, "shapes_preview.png"))

    print(f"\n{len(result)}/{len(hold_map)} holds in {args.out} "
          f"({kept} kept from the existing file, {len(result) - kept} newly traced)")
    print("preview -> shapes_preview.png")
    if version is None:
        print("WARNING: no live board_config version — the app will NOT use these shapes.")
    if fails:
        print(f"detector missed ({len(fails)}): {', '.join(sorted(fails))}")
    if missing:
        print(f"NOT in the output ({len(missing)}): {', '.join(sorted(missing))}")
        print("  fix these by hand in trace_holds.html (Import the JSON, edit, Export).")


if __name__ == "__main__":
    main()
