#!/usr/bin/env python3
"""ProjectBoard bring-up: WS2801 LED strip test over SPI.

Run on the Pi:  python3 /boot/firmware/projectboard/led_test.py
First stop the listener, or its idle pattern overwrites the test at once:
                sudo systemctl stop pb-listener   (sudo systemctl start pb-listener after)
Options:        --brightness 0.10   (0-0.5, default 10%)
                --pixels 248        (how many "all on" lights)
                --relays-on         (hold both relays on while the test runs)

Settings come from Gareth's original code (reference/original-pi-codebase/dtb):
  DisplayProblem.py:23-25   WS2801 on SPI port 0, device 0 -> /dev/spidev0.0
  Adafruit_WS2801 1.0.1     1 MHz, SPI mode 0, MSB first, 3 bytes per pixel R,G,B
                            (the library is on his SD image, not in dtb/)
  DisplayProblem.py:22      num_pixels = 1200, the buffer it clocks out; the
                            hold -> LED formula only uses 1-247 (0 is never a hold)
  relay.py                  BCM 23/24 (BOARD 16/18), driven LOW = on

Needs only python3-spidev (plus python3-gpiozero for --relays-on).
Ctrl+C, closing the SSH session or any error turns every LED off.
"""
import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import spidev

SPI_BUS = 0
SPI_DEVICE = 0
SPI_HZ = 1_000_000
SPI_MODE = 0
BOARD_PIXELS = 248      # indices 0-247
CLEAR_PIXELS = 1200     # every frame is this long, so "off" clears past the end of the board
LATCH_S = 0.002         # WS2801 latches once the clock idles >= 500 us; Gareth's library waits 2 ms
MAX_BRIGHTNESS = 0.5    # 248 pixels at full white is ~15 A; the LED brick is 5 V 10 A
RELAY_PINS = (23, 24)   # BCM, active-low

RED, GREEN, BLUE, WHITE = (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)


class Strip:
    def __init__(self, brightness):
        self.brightness = brightness
        self.spi = spidev.SpiDev()
        self.spi.open(SPI_BUS, SPI_DEVICE)
        self.spi.max_speed_hz = SPI_HZ
        self.spi.mode = SPI_MODE
        try:
            self.spi.lsbfirst = False
        except OSError:
            pass  # MSB first is the default anyway

    def show(self, pixels):
        """pixels: {index: (r, g, b)} at full scale. Everything else is sent as off."""
        buf = bytearray(CLEAR_PIXELS * 3)
        for i, rgb in pixels.items():
            if 0 <= i < CLEAR_PIXELS:
                buf[i * 3:i * 3 + 3] = bytes(round(c * self.brightness) for c in rgb)
        if hasattr(self.spi, "writebytes2"):
            self.spi.writebytes2(buf)
        else:
            self.spi.writebytes(list(buf))  # 3600 bytes, under spidev's 4096 limit
        time.sleep(LATCH_S)

    def off(self):
        self.show({})

    def close(self):
        self.spi.close()


class Relays:
    """Both relays on for the length of the test, off afterwards (active-low, as in relay.py)."""

    def __init__(self):
        os.chdir(tempfile.gettempdir())  # lgpio writes small files into the current folder
        from gpiozero import OutputDevice
        self.devices = [OutputDevice(pin, active_high=False, initial_value=False)
                        for pin in RELAY_PINS]
        for d in self.devices:
            d.on()
        print("Relays on: BCM 23 and 24 driven LOW.")

    def close(self):
        for d in self.devices:
            d.off()
            d.close()
        leave_pins_high()
        print("Relays off: BCM 23 and 24 driven HIGH.")


def leave_pins_high():
    """Keep the relay pins driven HIGH (off) after exit, rather than floating as inputs."""
    if shutil.which("pinctrl"):
        for pin in RELAY_PINS:
            subprocess.run(["pinctrl", "set", str(pin), "op", "dh"], check=False)


def ask_int(prompt, default, lo, hi):
    while True:
        text = input(f"{prompt} [{default}]: ").strip()
        if not text:
            return default
        try:
            value = int(text)
        except ValueError:
            print("  Type a whole number.")
            continue
        if lo <= value <= hi:
            return value
        print(f"  Between {lo} and {hi}.")


def ask_float(prompt, default):
    while True:
        text = input(f"{prompt} [{default}]: ").strip()
        if not text:
            return default
        try:
            return max(0.0, float(text))
        except ValueError:
            print("  Type a number.")


def colour_check(strip):
    index = ask_int("Pixel to test", 0, 0, CLEAR_PIXELS - 1)
    seen = []
    for name, rgb in (("RED", RED), ("GREEN", GREEN), ("BLUE", BLUE)):
        strip.show({index: rgb})
        answer = input(f"Pixel {index} sent {name}. What colour do you see "
                       "(Enter if it matches, or type it; 'none' if dark)? ").strip()
        seen.append((name, answer or name))
    strip.off()
    print("Sent -> seen: " + ", ".join(f"{s} -> {a}" for s, a in seen))
    if all(a.upper() == s for s, a in seen):
        print("Colour order is R, G, B, as in Gareth's code.")
    else:
        print("Colour order differs (or the pixel is dark): note what you saw.")


def walk(strip, pixels):
    start = ask_int("Start index", 0, 0, CLEAR_PIXELS - 1)
    end = ask_int("End index", pixels - 1, start, CLEAR_PIXELS - 1)
    delay = ask_float("Seconds per step (0 = press Enter for each)", 0.3)
    for i in range(start, end + 1):
        strip.show({i: WHITE})
        if delay:
            print(f"  LED {i}")
            time.sleep(delay)
        else:
            input(f"  LED {i}  (Enter for next)")
    strip.off()
    print("Walk finished, all off.")


def all_on(strip, pixels):
    strip.show({i: WHITE for i in range(pixels)})
    amps = pixels * 3 * 0.020 * strip.brightness
    print(f"Pixels 0-{pixels - 1} on dim white at {strip.brightness:.0%} "
          f"(about {amps:.1f} A if each channel draws 20 mA at full). "
          "They stay on until you choose 4 or quit.")


def stop(signum, frame):
    raise SystemExit(f"\nSignal {signum}: stopping.")


def main():
    parser = argparse.ArgumentParser(description="WS2801 bring-up test (SPI0 CE0, 1 MHz, mode 0).")
    parser.add_argument("--brightness", type=float, default=0.10,
                        help=f"0-{MAX_BRIGHTNESS}, default 0.10 (10%%)")
    parser.add_argument("--pixels", type=int, default=BOARD_PIXELS,
                        help=f"pixels lit by 'all on' and walked by default (default {BOARD_PIXELS})")
    parser.add_argument("--relays-on", action="store_true",
                        help="hold both relays on (BCM 23/24 LOW) while the test runs")
    args = parser.parse_args()
    if not 0 < args.brightness <= MAX_BRIGHTNESS:
        parser.error(f"--brightness must be above 0 and at most {MAX_BRIGHTNESS}")
    if not 1 <= args.pixels <= CLEAR_PIXELS:
        parser.error(f"--pixels must be 1-{CLEAR_PIXELS}")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)  # the SSH session closing

    strip = Strip(args.brightness)
    relays = None
    try:
        strip.off()
        if args.relays_on:
            relays = Relays()
        print(f"WS2801 on /dev/spidev{SPI_BUS}.{SPI_DEVICE}, {SPI_HZ // 1000} kHz, mode {SPI_MODE}, "
              f"brightness {args.brightness:.0%}. Ctrl+C at any time turns everything off.")
        while True:
            print("\n  1  Colour check: one pixel red, then green, then blue"
                  "\n  2  Walk one pixel along the strip"
                  f"\n  3  All {args.pixels} on, dim white"
                  "\n  4  All off"
                  "\n  q  Quit (all off)")
            choice = input("> ").strip().lower()
            if choice == "1":
                colour_check(strip)
            elif choice == "2":
                walk(strip, args.pixels)
            elif choice == "3":
                all_on(strip, args.pixels)
            elif choice == "4":
                strip.off()
                print("All off.")
            elif choice == "q":
                break
    except (KeyboardInterrupt, EOFError):
        print("\nStopping.")
    finally:
        strip.off()
        strip.close()
        print(f"All {CLEAR_PIXELS} LEDs sent off.")
        if relays:
            relays.close()


if __name__ == "__main__":
    main()
