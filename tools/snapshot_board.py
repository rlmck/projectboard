"""Copy the live board into app/ as the offline fallback.

The app draws the board from the live Supabase `board_config` row: the photo
(`board.jpg` in Storage), the hold map, the mirror map and the published hold
outlines. The files in app/ are what it falls back to when that row can't be
fetched (offline, or Supabase down). This writes all four from ONE read of the
live row, so they always belong to the same board version:

    app/board-fallback.jpg   the live photo, re-encoded as a JPEG (quality 85)
    app/hold_map.json        the live hold map, plus __meta.board_updated_at
    app/mirror_map.json      the live mirror map
    app/hold_shapes.json     the live published outlines (their own __meta
                             already carries board_updated_at and smooth)

The app strips hold_map.json's __meta when it loads it, and draws the bundled
outlines offline only when both files carry the same board_updated_at.

Run it after anything changes on the live board (a new photo or map, or newly
published outlines), then bump CACHE in app/sw.js and deploy:

    python tools/snapshot_board.py

Reads public data with the anon key only; needs Pillow.
"""
import io
import json
import os
import sys
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(os.path.dirname(HERE), "app")
SUPA_URL = "https://uqirowyfqwiceyjznosl.supabase.co"
ANON_KEY = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxaXJvd3lmcXdp"
            "Y2V5anpub3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODMwMzAsImV4cCI6MjA5NDg1OTAzMH0."
            "gOxEeiW9Ej1ol_w2qyAT2wvPGf8N8ECAwuJ4lO6GDpA")
JPEG_QUALITY = 85


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def write_json(name, data, indent=2):
    # indent=None for the outlines: one line, as register_shapes.py writes them
    # (indented, every coordinate gets its own line and the file grows 2.5x).
    path = os.path.join(APP, name)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=indent, ensure_ascii=False)
        if indent:
            f.write("\n")
    print(f"  {name}: {len([k for k in data if k != '__meta'])} holds")


def main():
    h = {"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"}
    rows = json.loads(get(f"{SUPA_URL}/rest/v1/board_config?wall=eq.HangoutPortland&select=*", h).decode())
    if not rows:
        sys.exit("No board_config row for HangoutPortland.")
    row = rows[0]
    version = row.get("updated_at")
    hold_map, mirror_map, shapes = row.get("hold_map"), row.get("mirror_map"), row.get("hold_shapes")
    missing = [n for n, v in (("updated_at", version), ("image_path", row.get("image_path")),
                              ("hold_map", hold_map), ("mirror_map", mirror_map), ("hold_shapes", shapes)) if not v]
    if missing:
        sys.exit("The live row is missing " + ", ".join(missing) + "; nothing written.")
    shape_ver = (shapes.get("__meta") or {}).get("board_updated_at")
    if shape_ver != version:
        sys.exit(f"The published outlines belong to board {shape_ver}, not the live board {version}. "
                 "Re-trace and publish them first; nothing written.")

    img_url = f"{SUPA_URL}/storage/v1/object/public/board/{row['image_path']}?v={urllib.request.quote(version)}"
    img = Image.open(io.BytesIO(get(img_url))).convert("RGB")

    print(f"Live board {version} ({row['image_path']}, {img.size[0]}x{img.size[1]}) -> app/")
    jpg = os.path.join(APP, "board-fallback.jpg")
    img.save(jpg, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    print(f"  board-fallback.jpg: {os.path.getsize(jpg) // 1024} KB")
    write_json("hold_map.json", {"__meta": {"board_updated_at": version, "source": "tools/snapshot_board.py"},
                                 **hold_map})
    write_json("mirror_map.json", mirror_map)
    write_json("hold_shapes.json", shapes, indent=None)
    print("Done. Bump CACHE in app/sw.js, then deploy.")


if __name__ == "__main__":
    main()
