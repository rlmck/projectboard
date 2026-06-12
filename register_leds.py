"""
register_leds.py

Extracts the board's hold -> physical WS2801 LED-index wiring map from Gareth's
original DTB code, into our own data file (led_map.json), so the rebuilt board
listener (our own SD card, our own code — only the hardware is inherited) lights
the correct LEDs without depending on any of Gareth's files at runtime.

This is the ONE genuinely physical artifact we inherit: the order in which the
247 LEDs are soldered along the board. Everything else (problems, mirror map) we
own in Supabase; this we must reproduce exactly or every cast lights the right
number of LEDs in the wrong places.

Where it comes from
-------------------
Gareth's SearchingByProblemNameV2.py turns a hold's index in holdlist.csv
(== our holdN: A0=0, A1=1, B1=2, ... S1=19, A2=20, ... S13=247) into a
"WS2801Position", then Display4.py lights it with `pixels.set_pixel(WS2801Position, ...)`
— used directly, no offset, so WS2801Position IS the 0-indexed strip index
(index 0 = the phantom A0 cell; real holds are 1..247).

His maths (de-noised — one always-false branch removed) reduces to:
    col = (holdN-1) % 19      # 0=A (left) .. 18=S (right)
    row = (holdN-1) // 19     # 0=row1 (BOTTOM) .. 12=row13 (top)
    led = row + col*13 + 1                if col is even   (column wired bottom->top)
    led = (13 - row) + col*13             if col is odd    (column wired top->bottom)
i.e. a column-major serpentine: column A occupies LEDs 1..13, B 14..26 (reversed),
C 27..39, ... S 235..247. To be safe this script PORTS Gareth's exact branchy
code and asserts it agrees with the clean formula for every hold 1..247.

Output: led_map.json  (holdN -> LED strip index, 1..247, for all 247 grid cells)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
COLUMNS = 19   # A..S
ROWS = 13      # 1..13

# The 189 cells that carry a real climbing hold (same list as app.js / the other
# generators) — the only ids that ever appear in a problem. The other cells still
# have an LED in the grid; they're just never lit.
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


def grid_name(n):
    return chr(65 + (n - 1) % 19) + str((n - 1) // 19 + 1)


def led_clean(n):
    """Our de-noised formula: holdN -> 0-indexed WS2801 strip index."""
    col = (n - 1) % COLUMNS
    row = (n - 1) // COLUMNS
    if col % 2 == 0:
        return row + col * ROWS + 1            # column wired bottom -> top
    return (ROWS - row) + col * ROWS           # column wired top -> bottom


def led_gareth(position):
    """Faithful port of SearchingByProblemNameV2.py's x/y/WS2801 logic (the
    always-false `== int` branch dropped). Kept verbose to mirror the original,
    so the assert below proves our clean formula reproduces his working code."""
    columns, rows = COLUMNS, ROWS
    calc_position = position
    # --- xposition (0-indexed column) ---
    xposition = 0
    if calc_position > columns:
        while calc_position > columns:
            calc_position = calc_position - columns
            xposition = calc_position - 1
    else:
        xposition = position - 1
    # --- yposition (0-indexed row) ---
    calc_position = position
    if calc_position > columns:
        if (calc_position / columns) == int(calc_position / columns):   # exact multiple of 19
            yposition = (calc_position // columns) - 1
        else:
            yposition = int(calc_position // columns)
    else:
        yposition = 0
    # --- serpentine ---
    if xposition % 2 == 0:
        return yposition + (xposition * rows) + 1
    return (rows - yposition) + (xposition * rows)


def main():
    led = {}
    for n in range(1, COLUMNS * ROWS + 1):     # all 247 grid cells
        c, g = led_clean(n), led_gareth(n)
        assert c == g, f"formula disagrees with Gareth at hold{n} ({grid_name(n)}): clean={c} gareth={g}"
        led[n] = c

    # Invariants: bijection onto 1..247, and every real hold is covered.
    assert sorted(led.values()) == list(range(1, COLUMNS * ROWS + 1)), "LED indices are not a clean 1..247 bijection"
    assert all(n in led for n in VALID), "a real hold is missing from the LED map"

    out = {f"hold{n}": led[n] for n in range(1, COLUMNS * ROWS + 1)}
    with open(os.path.join(HERE, "led_map.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # ---- report ----
    print(f"holds mapped: {len(out)} (all {COLUMNS}x{ROWS} cells)   real holds: {len(VALID)}")
    print("verified: clean formula == Gareth's ported logic for all 247 cells")
    print("strip index 0 = A0 (phantom, unused); real holds use 1..247")
    print("\nwiring per column (column-major serpentine):")
    for c in range(COLUMNS):
        col_letter = chr(65 + c)
        lo = c * ROWS + 1
        hi = c * ROWS + ROWS
        direction = "bottom->top" if c % 2 == 0 else "top->bottom (reversed)"
        print(f"  col {col_letter}: LEDs {lo:3d}..{hi:3d}   {direction}")
    print("\nspot checks:")
    for n in [1, 2, 10, 19, 20, 53, 247]:
        print(f"  hold{n:<4} {grid_name(n):<4} -> LED {out['hold'+str(n)]}")
    print(f"\nWrote led_map.json ({len(out)} cells)")


if __name__ == "__main__":
    main()
