"""Put a "PB Console" icon on the Windows desktop (run once, or again after moving the repo):

    python console/desktop_shortcut.py

Double-clicking it opens a Git Bash window that runs `bash console/start.sh` (a fresh
token, the backend, the browser), exactly as typing it would. Closing that window, or
Ctrl+C in it, stops the console. The icon, console/pb-console.ico, is drawn here from
the same shapes as console/static/icon.svg (Pillow, which the tools already use).
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ICO = os.path.join(HERE, 'pb-console.ico')
BASH = r'C:\Program Files\Git\bin\bash.exe'

# icon.svg on a 32-unit grid: a dark rounded square, three holds (start, hold, finish), one pink.
SHAPES = [((10, 22), 3.2, '#22c55e'), ((16, 15), 3.2, '#3b82f6'), ((22, 8), 3.2, '#ef4444'),
          ((23, 22), 2.4, '#ec4899')]


def draw_icon(path):
    big = 1024                       # drawn large, then scaled down per size: smooth edges
    k = big / 32
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=7 * k, fill='#0a0a0a')
    for (x, y), r, colour in SHAPES:
        d.ellipse([(x - r) * k, (y - r) * k, (x + r) * k, (y + r) * k], fill=colour)
    img.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def desktop():
    out = subprocess.run(['powershell', '-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
                         capture_output=True, text=True, check=True).stdout.strip()
    return out


def make_shortcut(lnk):
    repo_posix = '/' + REPO[0].lower() + REPO[2:].replace('\\', '/')        # C:\x -> /c/x for Git Bash
    command = ("cd '%s' && bash console/start.sh; echo; "
               "read -p 'PB Console has stopped. Press Enter to close this window.'" % repo_posix)
    ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:PB_LNK); "
          "$s.TargetPath = $env:PB_BASH; $s.Arguments = $env:PB_ARGS; $s.WorkingDirectory = $env:PB_REPO; "
          "$s.IconLocation = $env:PB_ICO + ',0'; $s.Description = 'Start PB Console (the Project Board admin console)'; "
          "$s.Save()")
    env = dict(os.environ, PB_LNK=lnk, PB_BASH=BASH, PB_ARGS='-l -c "%s"' % command, PB_REPO=REPO, PB_ICO=ICO)
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], env=env, check=True)


def main():
    if not os.path.exists(BASH):
        sys.exit('Git Bash not found at %s' % BASH)
    draw_icon(ICO)
    lnk = os.path.join(desktop(), 'PB Console.lnk')
    make_shortcut(lnk)
    print('icon:     %s\nshortcut: %s' % (ICO, lnk))


if __name__ == '__main__':
    main()
