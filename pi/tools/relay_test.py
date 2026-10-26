#!/usr/bin/env python3
"""ProjectBoard bring-up: relay test on BCM 23 and BCM 24.

Run on the Pi:  python3 /boot/firmware/projectboard/relay_test.py

Polarity comes from Gareth's relay.py: it drives BOARD 16 and 18 (BCM 23 and 24)
LOW with the comment "Turn on", so the relays are active-low: LOW = on, HIGH = off.
(His relayoff.py is an identical copy, so it never switched them off.)

Starts with both relays off, toggles one per keypress, and turns both off on exit
(q, Ctrl+C, the SSH session closing or an error). Needs only python3-gpiozero.
"""
import os
import shutil
import signal
import subprocess
import sys
import tempfile

os.chdir(tempfile.gettempdir())  # lgpio writes small files into the current folder
from gpiozero import OutputDevice  # noqa: E402

RELAYS = {"1": 23, "2": 24}        # key -> BCM pin
BOARD_PIN = {23: 16, 24: 18}


def getkey():
    """One keypress without Enter (Ctrl+C still works); falls back to a line."""
    if not sys.stdin.isatty():
        line = sys.stdin.readline()
        if not line:
            raise EOFError
        return line.strip()[:1]
    import termios
    import tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def status(relays):
    for key, dev in relays.items():
        pin = RELAYS[key]
        state = "ON  (pin LOW) " if dev.value else "off (pin HIGH)"
        print(f"  Relay {key}  BCM {pin} / BOARD {BOARD_PIN[pin]}:  {state}")


def leave_pins_high():
    """Keep the pins driven HIGH (off) after exit, rather than floating as inputs."""
    if shutil.which("pinctrl"):
        for pin in RELAYS.values():
            subprocess.run(["pinctrl", "set", str(pin), "op", "dh"], check=False)


def stop(signum, frame):
    raise SystemExit(f"\nSignal {signum}: stopping.")


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)  # the SSH session closing

    # active_high=False: on() drives the pin LOW. initial_value=False: start off (HIGH).
    relays = {key: OutputDevice(pin, active_high=False, initial_value=False)
              for key, pin in RELAYS.items()}
    try:
        print("Both relays start OFF (pins driven HIGH). Listen for a click on each toggle.")
        while True:
            status(relays)
            print("Press 1 or 2 to toggle that relay, 0 for both off, q to quit.")
            key = getkey().lower()
            if key in relays:
                relays[key].toggle()
                print(f"\nRelay {key} toggled.")
            elif key == "0":
                for dev in relays.values():
                    dev.off()
                print("\nBoth off.")
            elif key == "q":
                break
    except (KeyboardInterrupt, EOFError):
        print("\nStopping.")
    finally:
        for dev in relays.values():
            dev.off()
            dev.close()
        leave_pins_high()
        print("Both relays off (BCM 23 and 24 driven HIGH).")


if __name__ == "__main__":
    main()
