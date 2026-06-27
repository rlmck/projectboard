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

Deps: pip install numpy opencv-python-headless   (dev-only; not shipped)
Run:  python register_shapes.py            # writes hold_shapes.json + preview.png
"""
import json, os, sys, urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SUPA_URL = "https://uqirowyfqwiceyjznosl.supabase.co"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6"
        "InVxaXJvd3lmcXdpY2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAs"
        "ImV4cCI6MjA5NDg1OTAzMH0.gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA")

RMAX = 80                # max hold radius (px) — leak guard + background-marker distance
AREA_FLOOR = 25          # drop specks smaller than this (px^2)
EPS_FRAC = 0.006         # approxPolyDP epsilon as a fraction of perimeter (smaller = smoother)


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(req, timeout=20).read()


def load_board():
    """Return (bgr_image, hold_map dict). Live board_config first, bundled fallback."""
    img_bytes, hold_map = None, None
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
    except Exception as e:
        print(f"(live board_config unavailable: {e}; falling back to bundled)")

    if img_bytes is None:
        with open(os.path.join(HERE, "ProjectBoard.png"), "rb") as f:
            img_bytes = f.read()
        print("bundled image: ProjectBoard.png")
    if hold_map is None:
        hold_map = json.load(open(os.path.join(HERE, "hold_map.json")))
        print("bundled map: hold_map.json")

    img = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    return img, hold_map


def detect(img, hold_map):
    H, W = img.shape[:2]
    holds = list(hold_map.items())
    centers = {h: (int(round(p["x"] / 100 * W)), int(round(p["y"] / 100 * H)))
               for h, p in holds}

    # --- build watershed markers ---
    markers = np.zeros((H, W), np.int32)
    pts = np.ones((H, W), np.uint8)
    for (cx, cy) in centers.values():
        pts[cy, cx] = 0
    dist = cv2.distanceTransform((pts * 255).astype(np.uint8), cv2.DIST_L2, 5)
    BG = len(holds) + 1
    markers[dist > RMAX] = BG                       # confidently-background
    markers[0, :] = BG; markers[-1, :] = BG
    markers[:, 0] = BG; markers[:, -1] = BG
    for i, (h, _) in enumerate(holds, start=1):     # foreground discs
        cx, cy = centers[h]
        cv2.circle(markers, (cx, cy), 3, i, -1)

    ws = markers.copy()
    cv2.watershed(img, ws)

    out, fails = {}, []
    disc_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    for i, (h, _) in enumerate(holds, start=1):
        cx, cy = centers[h]
        m = (ws == i).astype(np.uint8)
        guard = np.zeros((H, W), np.uint8)
        cv2.circle(guard, (cx, cy), RMAX, 1, -1)
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
        if pick is None or cv2.contourArea(pick) < AREA_FLOOR:
            fails.append(h)
            continue
        peri = cv2.arcLength(pick, True)
        poly = cv2.approxPolyDP(pick, EPS_FRAC * peri, True).reshape(-1, 2)
        if len(poly) < 3:
            fails.append(h)
            continue
        out[h] = [[round(x / W * 100, 2), round(y / H * 100, 2)] for x, y in poly]

    # holds sharing an exact map position (e.g. hold242/hold243) lose their marker
    # to the duplicate — give them the partner's polygon so both still render.
    by_pos = {}
    for h, (cx, cy) in centers.items():
        by_pos.setdefault((cx, cy), []).append(h)
    for group in by_pos.values():
        if len(group) > 1:
            have = next((g for g in group if g in out), None)
            if have:
                for g in group:
                    out.setdefault(g, out[have])

    fails = [h for h in hold_map if h not in out]
    return out, fails, centers, (W, H)


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
    img, hold_map = load_board()
    out, fails, centers, (W, H) = detect(img, hold_map)
    json.dump(out, open(os.path.join(HERE, "hold_shapes.json"), "w"))
    write_preview(img, out, centers, os.path.join(HERE, "shapes_preview.png"))
    print(f"\n{len(out)}/{len(hold_map)} holds traced -> hold_shapes.json")
    print("preview -> shapes_preview.png")
    if fails:
        print(f"NOT traced ({len(fails)}): {', '.join(sorted(fails))}")
        print("  fix these by hand in trace_holds.html (Import the JSON, edit, Export).")


if __name__ == "__main__":
    main()
