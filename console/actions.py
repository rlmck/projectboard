"""Everything the console can do to the Pi, as a fixed table. Each action checks
its arguments against lists here (and pb-console-helper checks them again on the
Pi), says whether it needs a confirm and the busy guard, and gives the one
remote command it runs. Plus the audit log and the config.env sync.

The page never sends a command, only an action name and its arguments.
"""
import datetime
import difflib
import json
import os
import re
import sys
import threading

from remote import helper_cmd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LAPTOP_CONFIG = os.path.join(REPO, 'pi', 'config.env')
AUDIT = os.path.join(HERE, 'audit.log')

UNITS = ('pb-listener', 'kiosk', 'board-cam', 'pb-netwatch', 'pb-health.timer', 'pb-mode.timer')
VERBS = ('start', 'stop', 'restart')
HHMM = re.compile(r'^([01][0-9]|2[0-3]):[0-5][0-9]$')


class Invalid(Exception):
    pass


def pattern_names():
    """[(name, about)] from the repo's pi/listener/patterns (the same list pb-idle has)."""
    sys.path.insert(0, os.path.join(REPO, 'pi', 'listener'))
    sys.dont_write_bytecode = True
    try:
        import patterns
        return [(n, patterns.PATTERNS[n].about) for n in patterns.NAMES]
    except Exception:
        return [(n, '') for n in ('glisten', 'chase', 'lava', 'breathe', 'aurora', 'rain', 'ripples',
                                  'fireflies', 'teaser', 'wave')]


PATTERNS = [n for n, _ in pattern_names()]
IDLE_CMDS = PATTERNS + ['cycle', 'tour', 'default', 'now', 'off']


class Action:
    """name: the audit name. cmd: the remote command. confirm: needs the page's
    confirm. busy: the 5-minute cast check first. config: writes config.env
    (both copies kept in step). describe: what the confirm dialog says."""

    def __init__(self, name, cmd, describe, confirm=False, busy=False, config=False, timeout=180):
        self.name, self.cmd, self.describe = name, cmd, describe
        self.confirm, self.busy, self.config, self.timeout = confirm, busy, config, timeout


def build(kind, args):
    """An Action from the page's {action, args}, or Invalid."""
    args = args if isinstance(args, dict) else {}
    if kind == 'service':
        unit, verb = args.get('unit'), args.get('verb')
        if unit not in UNITS or verb not in VERBS:
            raise Invalid('service: unit one of %s, verb one of %s' % (', '.join(UNITS), ', '.join(VERBS)))
        what = '%s %s' % (verb.capitalize(), unit)
        if unit == 'pb-listener' and verb != 'start':
            what += ': the board goes dark for a moment' + (' and stays off until you start it' if verb == 'stop' else '')
        if unit == 'kiosk' and verb == 'restart':
            what += ': the wall screen reloads the latest app'
        return Action('service %s %s' % (verb, unit), helper_cmd('unit', verb, unit), what,
                      confirm=True, busy=verb in ('stop', 'restart'))
    if kind == 'reboot':
        return Action('reboot', helper_cmd('reboot'),
                      'Reboot the Pi: the board and the wall screen are off for about 2 minutes',
                      confirm=True, busy=True, timeout=30)
    if kind == 'idle':
        cmd = args.get('cmd')
        if cmd not in IDLE_CMDS:
            raise Invalid('idle: one of %s' % ', '.join(IDLE_CMDS))
        return Action('idle %s' % cmd, 'pb-idle %s' % cmd, 'pb-idle %s' % cmd, timeout=30)
    if kind == 'brightness':
        try:
            v = round(float(args.get('value')), 2)
        except (TypeError, ValueError):
            v = -1
        if not 0.05 <= v <= 1:
            raise Invalid('brightness: a value from 0.05 to 1')
        return Action('brightness %g' % v, 'pb-idle brightness %g' % v, 'brightness x%g' % v, timeout=30)
    if kind == 'night':
        mode = args.get('mode')
        if mode not in ('auto', 'day', 'night'):
            raise Invalid('night: auto, day or night')
        what = {'auto': 'Night mode by the clock (NIGHT_FORCE empty)',
                'day': 'Force day (NIGHT_FORCE=day): LEDs and screen stay on through the night until set back to auto',
                'night': 'Force night (NIGHT_FORCE=night): LEDs off, casts ignored, screen off, until set back to auto'}[mode]
        return Action('night %s' % mode, helper_cmd('night', mode), what + '. Writes config.env on the Pi and pi/config.env here.',
                      confirm=True, config=True)
    if kind == 'night-hours':
        start, end = args.get('start'), args.get('end')
        if not (isinstance(start, str) and isinstance(end, str) and HHMM.match(start) and HHMM.match(end)) or start == end:
            raise Invalid('night-hours: two different HH:MM times')
        return Action('night-hours %s %s' % (start, end), helper_cmd('night-hours', start, end),
                      'Night from %s to %s. Writes config.env on the Pi and pi/config.env here.' % (start, end),
                      confirm=True, config=True)
    if kind == 'screen':
        state = args.get('state')
        if state not in ('on', 'off'):
            raise Invalid('screen: on or off')
        what = ('Turn the wall screen off (stops the kiosk) until "screen on" or a reboot' if state == 'off'
                else 'Turn the wall screen back on (starts the kiosk; not at night)')
        return Action('screen %s' % state, helper_cmd('screen', state), what, confirm=True)
    raise Invalid('no action called %r' % kind)


# -- config.env: the laptop's copy and the Pi's stay the same -----------------

def laptop_config():
    try:
        with open(LAPTOP_CONFIG, 'rb') as f:
            return f.read().decode('utf-8')
    except OSError:
        return None


def config_drift(pi_text):
    """None if the laptop's pi/config.env matches the Pi's (or doesn't exist), else a diff."""
    mine = laptop_config()
    if mine is None or pi_text is None or mine == pi_text:
        return None
    return ''.join(difflib.unified_diff(mine.splitlines(True), pi_text.splitlines(True),
                                        'pi/config.env (laptop)', '/etc/projectboard/config.env (Pi)'))


def save_laptop_config(pi_text):
    """After the Pi's config.env changed: the laptop's copy follows, LF line endings (deploy.sh refuses CRLF)."""
    with open(LAPTOP_CONFIG + '.tmp', 'wb') as f:
        f.write(pi_text.replace('\r\n', '\n').encode('utf-8'))
    os.replace(LAPTOP_CONFIG + '.tmp', LAPTOP_CONFIG)


# -- the audit log -------------------------------------------------------------

_audit_lock = threading.Lock()


def audit(action, result, detail='', ms=None, path=None):
    """One JSON line: time, action, result (ok, failed, refused, cancelled), detail."""
    row = {'time': datetime.datetime.now().isoformat(timespec='seconds'), 'action': action, 'result': result}
    if detail:
        row['detail'] = str(detail)[:500]
    if ms is not None:
        row['ms'] = ms
    with _audit_lock:
        with open(path or AUDIT, 'a', encoding='utf-8') as f:
            f.write(json.dumps(row) + '\n')


def audit_tail(n=50, path=None):
    try:
        with open(path or AUDIT, encoding='utf-8') as f:
            lines = f.readlines()[-n:]
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out
