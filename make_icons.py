"""
make_icons.py

Generates the PWA's PNG icons from the same geometry as icon.svg, so every
platform gets a real raster icon instead of the SVG (iOS ignores an SVG
apple-touch-icon and falls back to a page screenshot on the home screen).

    python make_icons.py      ->  icon-192.png, icon-512.png,
                                  icon-maskable-512.png, apple-touch-icon.png

Needs Pillow. The outputs are committed (see the !icon-*.png /
!apple-touch-icon.png exceptions in .gitignore); re-run this only when the icon
design changes, and keep it in step with icon.svg by hand.

The glyph (from icon.svg, in a 512x512 viewBox)
-----------------------------------------------
    <rect width="512" height="512" rx="104" fill="#0a0a0a"/>
    <path d="M132 168 L256 356 L380 168" stroke="#ec4899" stroke-width="56"
          stroke-linejoin="round" stroke-linecap="round" fill="none"/>
    <circle cx="256" cy="132" r="26" fill="#ec4899"/>

The stroked path is drawn as two thick quads plus a disc at each of its three
points, which is exactly a round-capped, round-joined polyline. Everything is
drawn at SS x the target size and downsampled with LANCZOS for antialiasing.

The four outputs
----------------
  icon-192.png / icon-512.png   manifest purpose "any": rounded square with
                                transparent corners, identical to icon.svg.
  icon-maskable-512.png         manifest purpose "maskable": full-bleed square
                                (the launcher applies its own mask), glyph shrunk
                                to sit well inside the 80%-diameter safe zone.
  apple-touch-icon.png          180x180, full-bleed square (iOS rounds the corners
                                itself, and fills any transparency with black).
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

BG = (0x0A, 0x0A, 0x0A, 255)    # #0a0a0a — matches manifest background/theme colour
PINK = (0xEC, 0x48, 0x99, 255)  # #ec4899 — the app's accent

VIEW = 512       # icon.svg viewBox size
SS = 8           # supersampling factor

# icon.svg geometry, in viewBox units
RECT_RX = 104
PATH = [(132, 168), (256, 356), (380, 168)]
STROKE = 56
DOT = (256, 132, 26)   # cx, cy, r

# Maskable safe zone: a centred circle 80% of the icon's width (W3C / Chrome).
SAFE_RADIUS = 0.4 * VIEW
MASKABLE_GLYPH_SCALE = 0.8


def glyph_radius(scale):
    """Furthest point of the glyph from the icon centre, in viewBox units."""
    c = VIEW / 2
    ends = max(math.hypot(x - c, y - c) + STROKE / 2 for x, y in PATH)
    dot = math.hypot(DOT[0] - c, DOT[1] - c) + DOT[2]
    return max(ends, dot) * scale


def draw_icon(size, *, rounded, glyph_scale=1.0):
    big = size * SS
    k = big / VIEW
    c = VIEW / 2

    def pt(x, y):
        # scale the glyph about the icon centre, then into supersampled pixels
        return ((c + (x - c) * glyph_scale) * k, (c + (y - c) * glyph_scale) * k)

    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=RECT_RX * k, fill=BG)
    else:
        d.rectangle([0, 0, big, big], fill=BG)

    half = STROKE / 2 * glyph_scale * k
    pts = [pt(x, y) for x, y in PATH]
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        length = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / length * half, (bx - ax) / length * half
        d.polygon([(ax + nx, ay + ny), (bx + nx, by + ny),
                   (bx - nx, by - ny), (ax - nx, ay - ny)], fill=PINK)
    for x, y in pts:  # round caps at the ends, round join at the vertex
        d.ellipse([x - half, y - half, x + half, y + half], fill=PINK)

    dx, dy = pt(DOT[0], DOT[1])
    r = DOT[2] * glyph_scale * k
    d.ellipse([dx - r, dy - r, dx + r, dy + r], fill=PINK)

    return img.resize((size, size), Image.LANCZOS)


def main():
    assert glyph_radius(MASKABLE_GLYPH_SCALE) <= SAFE_RADIUS, 'maskable glyph escapes the safe zone'

    outputs = {
        'icon-192.png':          draw_icon(192, rounded=True),
        'icon-512.png':          draw_icon(512, rounded=True),
        'icon-maskable-512.png': draw_icon(512, rounded=False, glyph_scale=MASKABLE_GLYPH_SCALE),
        # iOS has no alpha on home-screen icons, so this one is opaque RGB
        'apple-touch-icon.png':  draw_icon(180, rounded=False).convert('RGB'),
    }
    for name, img in outputs.items():
        img.save(HERE / name, optimize=True)
        print(f'make_icons.py: wrote {name} ({img.width}x{img.height})')

    print(f'make_icons.py: maskable glyph reaches {glyph_radius(MASKABLE_GLYPH_SCALE) / (VIEW / 2):.0%} '
          f'of the half-width (safe zone {SAFE_RADIUS / (VIEW / 2):.0%})')


if __name__ == '__main__':
    main()
