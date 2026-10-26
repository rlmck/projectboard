"""The relay hook: power to the LED supplies. NOT BUILT.

The relay module hasn't arrived and what it will switch isn't settled, so this
is a no-op while RELAY_PINS is empty in config. pb-mode is its only caller:
day -> leds_power(True) then clear the strip (a WS2801 can power up showing
random colours), night -> leds_power(False).

When it's built: set each pin with `pinctrl set <pin> op dl|dh`, which holds
after the process exits. Not gpiozero: it releases its pins on exit, and a
released BCM 23/24 falls back to its pull-down, which on an active-low module
means relay ON. Polarity from RELAY_ACTIVE_LOW. See docs/pi4-listener-kiosk-plan.md R4.
"""


def leds_power(on, cfg):
    """Switch the LED supplies. Returns a line for the log, or None if nothing to do."""
    if not (cfg.get('RELAY_PINS') or '').strip():
        return None
    return 'RELAY_PINS is set (%s) but relay control is not built yet: nothing switched' % cfg['RELAY_PINS']
