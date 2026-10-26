#!/usr/bin/env python3
"""The WS2801 strip, and the command-line tools that replace show_problem.py.

    leds.py --off                       clear the whole strip (leds-off-at-boot runs this)
    leds.py --show "Good Bug" [--mirror] light one problem from Supabase
    add --dry-run to print the LEDs instead of writing SPI; --config FILE for another config

Contract 6.4: SPI0 CE0 (/dev/spidev0.0), 1 MHz, mode 0, MSB first, 3 bytes per
pixel in R, G, B order. Every write covers STRIP_PIXELS pixels, so anything
past the board's 247 is cleared too. Pixel 0 (behind the board) is never lit.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board  # noqa: E402
import mode as modecfg  # noqa: E402


class Strip:
    def __init__(self, pixels=1200):
        self.pixels = pixels

    def write(self, leds):
        """leds: {index: (r, g, b)} as ints 0-255; every other pixel is set off."""
        import spidev
        buf = bytearray(self.pixels * 3)
        for i, rgb in leds.items():
            if 1 <= i < self.pixels:
                buf[i * 3:i * 3 + 3] = bytes(rgb)
        s = spidev.SpiDev()
        try:
            s.open(0, 0)
            s.max_speed_hz = 1_000_000
            s.mode = 0
            s.writebytes2(buf)
            time.sleep(0.002)       # WS2801 latches after 500 us of clock low
        finally:
            s.close()

    def clear(self):
        self.write({})


class FakeStrip(Strip):
    """--dry-run: prints what it would light."""
    def write(self, leds):
        print('  [dry-run] LEDs:', ', '.join('%d=%s' % (i, rgb) for i, rgb in sorted(leds.items())) or 'all off',
              flush=True)


def make_strip(cfg, dry_run=False):
    pixels = int(cfg.get('STRIP_PIXELS') or 1200)
    return FakeStrip(pixels) if dry_run else Strip(pixels)


def main(argv):
    dry = '--dry-run' in argv
    path = argv[argv.index('--config') + 1] if '--config' in argv else None
    if '--off' in argv:
        # Runs at sysinit, before anything else: no config needed, defaults are fine.
        try:
            cfg = modecfg.load_config(path)
        except OSError:
            cfg = dict(modecfg.DEFAULTS)
        make_strip(cfg, dry).clear()
        print('strip cleared')
        return 0
    if '--show' in argv:
        import supa
        cfg = modecfg.load_config(path)
        name = argv[argv.index('--show') + 1]
        row = supa.fetch_problem(cfg, name)
        if not row:
            print('no problem called %r' % name)
            return 1
        mirror = '--mirror' in argv
        mm = board.check_mirror_map(supa.fetch_mirror_map(cfg)) if mirror else None
        leds, dropped = board.frame(row, mirror, mm)
        out, cap, ma = board.scale(leds, cfg['BRIGHTNESS'], float(cfg['POWER_BUDGET_MA']),
                                   float(cfg['MA_PER_CHANNEL']))
        make_strip(cfg, dry).write(out)
        print('lit %r%s: %d LEDs, ~%d mA%s%s' % (row['name'], ' mirrored' if mirror else '', len(out), ma,
                                                 ', capped x%.2f' % cap if cap < 1 else '',
                                                 ', dropped %s' % dropped if dropped else ''))
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
