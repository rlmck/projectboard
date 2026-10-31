#!/usr/bin/env python3
"""make-card.py: add the unattended first-boot setup to a freshly written Raspberry Pi
OS card (31 Oct 2026). Run on the laptop, from the repo root, AFTER Raspberry Pi
Imager has written the card with its customisation (hostname projectboard, user pi,
SSH key, timezone and keyboard; NOT the Wi-Fi):

    python pi/firstboot/make-card.py D:\\            # the card's boot partition (bootfs)
    python pi/firstboot/make-card.py D:\\ --check    # only check what's on it, change nothing

It refuses anything that isn't a Raspberry Pi boot partition written by Imager with
cloud-init files. It writes:

    projectboard/  setup.sh, firstboot.sh, pb-firstboot.service (from the repo)
                   secrets.env      from the laptop's pi/secrets.env (gitignored): WIFI_SSID,
                                    WIFI_PSK, TS_AUTHKEY, RESCUE_PSK, WALL_KEY. Deleted from the
                                    card once the Pi is set up.
                   laptop_key.pub   ~/.ssh/id_ed25519.pub
                   config.env       the laptop's pi/config.env (no secrets: the anon key is public)
                   repo/            the pi/ and app/ files install.sh needs (a fallback if the
                                    Pi can't clone GitHub), with COMMIT naming the commit
    config.txt     dtparam=spi=on under [all]
    cmdline.txt    cfg80211.ieee80211_regdom=GB (the Wi-Fi country from the very first boot)
    user-data      a runcmd that installs and starts pb-firstboot.service

Then it reads every file back and prints a checklist. Guide: pi/firstboot/README.md.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MARK = '# projectboard-firstboot'
RUNCMD = [
    MARK + ' (pi/firstboot/make-card.py): install and start the unattended setup',
    '- [install, -m, "0644", /boot/firmware/projectboard/pb-firstboot.service, /etc/systemd/system/pb-firstboot.service]',
    '- [systemctl, daemon-reload]',
    '- [systemctl, enable, pb-firstboot.service]',
    '- [systemctl, start, --no-block, pb-firstboot.service]',
]
NEEDED = ('WIFI_SSID', 'WIFI_PSK', 'TS_AUTHKEY', 'RESCUE_PSK', 'WALL_KEY')
REPO_FILES_GLOBS = ['pi/install.sh', 'pi/config.env.example', 'pi/listener/*.py', 'pi/listener/patterns/*.py',
                    'pi/ops/*', 'pi/ledmap/pb_ledmap.py', 'pi/ledmap/index.html', 'pi/systemd/*.service',
                    'pi/systemd/*.timer', 'pi/systemd/kiosk.service.d/*', 'pi/conf/*',
                    'app/hold_map.json', 'app/board-fallback.jpg']


def die(msg):
    print('!! ' + msg)
    sys.exit(1)


def read_env(path):
    out = {}
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def lf_bytes(path):
    with open(path, 'rb') as f:
        data = f.read()
    return data if path.endswith('.jpg') else data.replace(b'\r\n', b'\n')


def put(src, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as f:
        f.write(lf_bytes(src))


def repo_files():
    import glob
    files = []
    for g in REPO_FILES_GLOBS:
        hits = sorted(p for p in glob.glob(os.path.join(REPO, g)) if os.path.isfile(p))
        if not hits:
            die('nothing matches %s in the repo' % g)
        files += hits
    return [os.path.relpath(p, REPO).replace('\\', '/') for p in files]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check_only = '--check' in sys.argv
    if len(args) != 1:
        die('usage: python pi/firstboot/make-card.py <boot partition, e.g. D:\\> [--check]')
    boot = args[0]
    for f in ('config.txt', 'cmdline.txt', 'user-data', 'meta-data', 'start4.elf'):
        if not os.path.isfile(os.path.join(boot, f)):
            die('%s has no %s: not a Raspberry Pi OS boot partition written by Imager 2 (cloud-init)' % (boot, f))
    ud_path = os.path.join(boot, 'user-data')
    with open(ud_path, encoding='utf-8') as f:
        ud = f.read()
    if not ud.startswith('#cloud-config'):
        die('user-data does not start with #cloud-config')

    secrets_src = os.path.join(REPO, 'pi', 'secrets.env')
    key_src = os.path.join(os.path.expanduser('~'), '.ssh', 'id_ed25519.pub')
    config_src = os.path.join(REPO, 'pi', 'config.env')
    for p in (secrets_src, key_src, config_src):
        if not os.path.isfile(p):
            die('missing %s' % p)
    secrets = read_env(secrets_src)
    missing = [k for k in NEEDED if not secrets.get(k)]
    if missing:
        die('pi/secrets.env has no value for: %s' % ', '.join(missing))
    if not secrets['TS_AUTHKEY'].startswith('tskey-auth-'):
        die('TS_AUTHKEY in pi/secrets.env should start with tskey-auth-')
    if len(secrets['RESCUE_PSK']) < 8 or len(secrets['WIFI_PSK']) < 8:
        die('a Wi-Fi password in pi/secrets.env is shorter than 8 characters')
    cfg = read_env(config_src)
    for k in ('SUPABASE_URL', 'SUPABASE_ANON_KEY'):
        if not cfg.get(k):
            die('pi/config.env has no %s' % k)

    pb = os.path.join(boot, 'projectboard')
    files = repo_files()
    commit = subprocess.run(['git', '-C', REPO, 'log', '-1', '--format=%h %s'], capture_output=True,
                            text=True).stdout.strip()
    dirty = subprocess.run(['git', '-C', REPO, 'status', '--porcelain', 'pi', 'app'], capture_output=True,
                           text=True).stdout.strip()

    if not check_only:
        if dirty:
            die('pi/ or app/ has uncommitted changes: commit and push first, so the card matches GitHub')
        put(os.path.join(REPO, 'pi', 'setup.sh'), os.path.join(pb, 'setup.sh'))
        put(os.path.join(REPO, 'pi', 'firstboot', 'firstboot.sh'), os.path.join(pb, 'firstboot.sh'))
        put(os.path.join(REPO, 'pi', 'firstboot', 'pb-firstboot.service'), os.path.join(pb, 'pb-firstboot.service'))
        put(secrets_src, os.path.join(pb, 'secrets.env'))
        put(key_src, os.path.join(pb, 'laptop_key.pub'))
        put(config_src, os.path.join(pb, 'config.env'))
        shutil.rmtree(os.path.join(pb, 'repo'), ignore_errors=True)
        for rel in files:
            put(os.path.join(REPO, rel), os.path.join(pb, 'repo', rel))
        with open(os.path.join(pb, 'repo', 'COMMIT'), 'w', newline='\n') as f:
            f.write(commit + '\n')

        # config.txt: SPI on for everything
        cpath = os.path.join(boot, 'config.txt')
        with open(cpath, encoding='utf-8') as f:
            ctext = f.read()
        if not re.search(r'(?m)^\s*dtparam=spi=on\s*$', ctext):
            ctext = ctext.rstrip('\n') + '\n\n[all]\n# ProjectBoard: the LED strip (WS2801 on SPI0)\ndtparam=spi=on\n'
            with open(cpath, 'w', encoding='utf-8', newline='\n') as f:
                f.write(ctext)

        # cmdline.txt: one line; the Wi-Fi country from the first boot
        kpath = os.path.join(boot, 'cmdline.txt')
        with open(kpath, encoding='utf-8') as f:
            ktext = f.read().strip()
        if 'cfg80211.ieee80211_regdom=' not in ktext:
            ktext += ' cfg80211.ieee80211_regdom=GB'
        with open(kpath, 'w', encoding='utf-8', newline='\n') as f:
            f.write(ktext + '\n')

        # user-data: the runcmd (merged into Imager's, if it wrote one)
        if MARK not in ud:
            lines = ud.rstrip('\n').split('\n')
            idx = [i for i, l in enumerate(lines) if re.match(r'^runcmd:\s*$', l)]
            if idx:
                j = idx[0] + 1
                while j < len(lines) and (lines[j].startswith((' ', '-', '#')) or not lines[j].strip()):
                    j += 1
                indent = '  '
                for l in lines[idx[0] + 1:j]:
                    m = re.match(r'^(\s*)-', l)
                    if m:
                        indent = m.group(1)
                        break
                lines[j:j] = [indent + r for r in RUNCMD]
            else:
                lines += ['', 'runcmd:'] + ['  ' + r for r in RUNCMD]
            with open(ud_path, 'w', encoding='utf-8', newline='\n') as f:
                f.write('\n'.join(lines) + '\n')

    # ---- read everything back
    print('Checking %s' % boot)
    problems = []

    def check(ok, what):
        print('   %s  %s' % ('ok  ' if ok else 'FAIL', what))
        if not ok:
            problems.append(what)

    with open(ud_path, encoding='utf-8') as f:
        ud = f.read()
    check(MARK in ud and 'pb-firstboot.service' in ud, 'user-data starts pb-firstboot (runcmd)')
    check(bool(re.search(r'(?m)^hostname:\s*"?projectboard"?\s*$', ud)), 'user-data: hostname projectboard')
    check(bool(re.search(r'(?m)^\s*-?\s*name:\s*"?pi"?\s*$', ud)), 'user-data: user pi')
    with open(key_src, encoding='utf-8') as f:
        key_body = f.read().split()[1]
    check(key_body in ud, "user-data: the laptop's SSH key")
    check('Europe/London' in ud, 'user-data: timezone Europe/London')
    nc = os.path.join(boot, 'network-config')
    if os.path.isfile(nc):
        with open(nc, encoding='utf-8') as f:
            nct = f.read()
        check(not re.search(r'(?m)^\s*wifis:', nct), 'network-config has no Wi-Fi (setup.sh makes hangout-fixed instead)')
    with open(os.path.join(boot, 'config.txt'), encoding='utf-8') as f:
        check(bool(re.search(r'(?m)^\s*dtparam=spi=on\s*$', f.read())), 'config.txt: dtparam=spi=on')
    with open(os.path.join(boot, 'cmdline.txt'), encoding='utf-8') as f:
        kt = f.read()
    check(kt.count('\n') <= 1 and 'cfg80211.ieee80211_regdom=GB' in kt and 'root=' in kt,
          'cmdline.txt: one line, root= and the GB Wi-Fi country')
    for name, src in (('setup.sh', 'pi/setup.sh'), ('firstboot.sh', 'pi/firstboot/firstboot.sh'),
                      ('pb-firstboot.service', 'pi/firstboot/pb-firstboot.service'),
                      ('config.env', 'pi/config.env')):
        p = os.path.join(pb, name)
        same = os.path.isfile(p) and open(p, 'rb').read() == lf_bytes(os.path.join(REPO, src))
        check(same, 'projectboard/%s matches %s' % (name, src))
    sp = os.path.join(pb, 'secrets.env')
    if os.path.isfile(sp):
        s = read_env(sp)
        check(all(s.get(k) == secrets[k] for k in NEEDED), 'projectboard/secrets.env has all five values (not shown)')
    else:
        check(False, 'projectboard/secrets.env')
    check(os.path.isfile(os.path.join(pb, 'laptop_key.pub')), 'projectboard/laptop_key.pub')
    bad = []
    for rel in files:
        p = os.path.join(pb, 'repo', rel)
        if not os.path.isfile(p) or open(p, 'rb').read() != lf_bytes(os.path.join(REPO, rel)):
            bad.append(rel)
    check(not bad, 'projectboard/repo: %d files match the repo%s' % (len(files), (' (differ: %s)' % bad) if bad else ''))
    crlf = [n for n in ('setup.sh', 'firstboot.sh', 'pb-firstboot.service', 'secrets.env', 'config.env')
            if os.path.isfile(os.path.join(pb, n)) and b'\r' in open(os.path.join(pb, n), 'rb').read()]
    check(not crlf, 'no Windows line endings in projectboard/')
    print('   wall key sha256 (for db/36): %s' % hashlib.sha256(secrets['WALL_KEY'].encode()).hexdigest())
    print('   card copy of the code: %s' % commit)
    if problems:
        die('%d problem(s): NOT ready' % len(problems))
    print('READY: every check passed.')


if __name__ == '__main__':
    main()
