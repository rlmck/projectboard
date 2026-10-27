#!/usr/bin/env python3
"""Preview Glisten, the board's idle animation, on the laptop.

Runs the Pi's own code (pi/listener/renderer.py driving pi/listener/glisten.py,
with a fake clock and a fake strip) through a scripted minute and writes
tools/glisten-preview.html: one standalone file (the frames inside it) that
plays on a 19 x 13 board, row 1 at the bottom and column A on the left.
Double-click it to open it; it needs nothing else.

    python tools/glisten_preview.py [--seed N] [--seconds S] [--out FILE]

The minute: a problem is lit (0 s), Glisten crossfades in after a shortened
timeout (4 s), a cast cuts in (38 s), Glisten again (42 s), night fades it out
(55 s). Colours are the LEDs' PWM values shown through the screen's gamma, so
dim and bright look about as they will on the wall.
"""
import argparse
import base64
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import glisten  # noqa: E402
import renderer  # noqa: E402

FPS = 30
IDLE_AFTER = 4.0
PROBLEM = {'finish_hold': 'hold238', 'intermediate_holds': ['hold180', 'hold145', 'hold121', 'hold86', 'hold62'],
           'start_holds': ['hold29', 'hold31']}          # made up, stored inverted like the real ones


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class Strip:
    def write(self, leds, pixels=None):
        pass                     # the renderer keeps what's showing in .shown


def record(seconds, seed, cfg):
    clock = Clock()
    r = renderer.Renderer(Strip(), dict(cfg, IDLE_AFTER_S=str(IDLE_AFTER)), False,
                          log=lambda m: print(' ', m), warn=lambda m: print(' ', m), err=lambda m: print(' ', m),
                          clock=clock, seed=seed)
    leds, _ = board.frame(PROBLEM)
    cast, _, _ = board.scale(leds, float(cfg.get('BRIGHTNESS') or 0.5), float(cfg.get('POWER_BUDGET_MA') or 8000),
                             float(cfg.get('MA_PER_CHANNEL') or 20))
    script = {0.0: lambda: r.cast(cast), 38.0: lambda: r.cast(cast), 55.0: lambda: r.set_night(True)}
    frames, labels, mas = bytearray(), [], []
    disp = [int(round(255 * (v / 255) ** (1 / glisten.GAMMA))) for v in range(256)]
    for k in range(int(seconds * FPS)):
        clock.t = k / FPS
        for at in [a for a in script if a <= clock.t]:
            script.pop(at)()
        r.step(clock.t)
        shown = r.shown
        for c in range(glisten.CELLS):                     # cell order = hold number - 1
            rgb = shown.get(glisten.LED[c], (0, 0, 0))
            frames += bytes(disp[v] for v in rgb)
        label = {renderer.CAST: 'a problem lit', renderer.NIGHT: 'night'}.get(r.state, 'Glisten')
        if r.fade:
            label += ' (fading in)' if r.state == renderer.IDLE else ' (fading out)'
        labels.append(label)
        mas.append(int(round(sum(v / 255 * float(cfg.get('MA_PER_CHANNEL') or 20)
                                 for rgb in shown.values() for v in rgb))))
    capped = r.anim.capped_frames if r.anim else 0
    return frames, labels, mas, capped


def hold_cells():
    try:
        with open(os.path.join(ROOT, 'app', 'hold_map.json'), encoding='utf-8') as f:
            m = json.load(f)
        return sorted(board.hold_number(h) - 1 for h in m if board.hold_number(h))
    except OSError:
        return []


PAGE = r'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glisten preview</title>
<style>
  :root { --bg: #0a0a0a; --panel: #161616; --line: #2a2a2a; --text: #e8e8e8; --muted: #8a8a8a; --accent: #ec4899; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif;
         display: flex; flex-direction: column; align-items: center; padding: 16px; gap: 12px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; }
  .sub { color: var(--muted); margin: 0; text-align: center; max-width: 720px; }
  canvas { width: min(100%, 760px); height: auto; border-radius: 10px; background: #15120e; }
  .bar { display: flex; align-items: center; gap: 12px; width: min(100%, 760px); }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px;
           font: inherit; font-weight: 600; cursor: pointer; min-width: 84px; }
  input[type=range] { flex: 1; accent-color: var(--accent); }
  .readout { display: flex; justify-content: space-between; width: min(100%, 760px); color: var(--muted);
             font-variant-numeric: tabular-nums; }
  .state { color: var(--text); }
</style>
</head>
<body>
<h1>Glisten preview</h1>
<p class="sub">__SUB__</p>
<canvas id="c" width="760" height="560"></canvas>
<div class="bar"><button id="play">Pause</button><input id="seek" type="range" min="0" value="0"></div>
<div class="readout"><span class="state" id="state"></span><span id="ma"></span><span id="time"></span></div>
<script>
const FPS = __FPS__, COLS = 19, ROWS = 13, CELLS = COLS * ROWS;
const LABELS = __LABELS__, MA = __MA__, HOLDS = new Set(__HOLDS__);
const raw = atob('__FRAMES__');
const data = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
const N = data.length / (CELLS * 3);
const cv = document.getElementById('c'), cx = cv.getContext('2d');
const seek = document.getElementById('seek'), btn = document.getElementById('play');
seek.max = N - 1;
const PADL = 34, PADB = 30, PAD = 14;
const W = cv.width - PADL - PAD, H = cv.height - PADB - PAD;
const dx = W / COLS, dy = H / ROWS, r = Math.min(dx, dy) * 0.16;
function xy(c) {            // cell = hold number - 1: row 1 at the bottom, column A on the left
  const x = c % COLS, y = Math.floor(c / COLS);
  return [PADL + (x + 0.5) * dx, PAD + (ROWS - 1 - y + 0.5) * dy];
}
function draw(f) {
  cx.globalCompositeOperation = 'source-over';
  cx.fillStyle = '#15120e'; cx.fillRect(0, 0, cv.width, cv.height);
  cx.fillStyle = '#6f6a62'; cx.font = '12px system-ui'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
  for (let x = 0; x < COLS; x++) cx.fillText(String.fromCharCode(65 + x), PADL + (x + 0.5) * dx, cv.height - PADB / 2);
  for (let y = 0; y < ROWS; y++) cx.fillText(y + 1, PADL / 2, PAD + (ROWS - 1 - y + 0.5) * dy);
  for (let c = 0; c < CELLS; c++) {      // holds as dim rings, so the lights read against the wall
    if (!HOLDS.has(c)) continue;
    const [px, py] = xy(c);
    cx.strokeStyle = '#2c2822'; cx.lineWidth = 2;
    cx.beginPath(); cx.arc(px, py, Math.min(dx, dy) * 0.36, 0, 7); cx.stroke();
  }
  cx.globalCompositeOperation = 'lighter';
  const o = f * CELLS * 3;
  for (let c = 0; c < CELLS; c++) {
    const R = data[o + c * 3], G = data[o + c * 3 + 1], B = data[o + c * 3 + 2];
    const [px, py] = xy(c);
    if (R | G | B) {
      const g = cx.createRadialGradient(px, py, 0, px, py, r * 4.2);
      g.addColorStop(0, `rgba(${R},${G},${B},0.9)`);
      g.addColorStop(0.3, `rgba(${R},${G},${B},0.35)`);
      g.addColorStop(1, `rgba(${R},${G},${B},0)`);
      cx.fillStyle = g; cx.beginPath(); cx.arc(px, py, r * 4.2, 0, 7); cx.fill();
    }
    cx.fillStyle = (R | G | B) ? `rgb(${R},${G},${B})` : '#24211c';
    cx.beginPath(); cx.arc(px, py, r, 0, 7); cx.fill();
  }
  document.getElementById('state').textContent = LABELS[f];
  document.getElementById('ma').textContent = '~' + MA[f] + ' mA';
  document.getElementById('time').textContent = (f / FPS).toFixed(1) + ' / ' + (N / FPS).toFixed(0) + ' s';
  seek.value = f;
}
let frame = 0, playing = true, t0 = null, f0 = 0;
function tick(now) {
  if (playing) {
    if (t0 === null) { t0 = now; f0 = frame; }
    frame = (f0 + Math.floor((now - t0) / 1000 * FPS)) % N;
    draw(frame);
  }
  requestAnimationFrame(tick);
}
function toggle() { playing = !playing; t0 = null; btn.textContent = playing ? 'Pause' : 'Play'; }
btn.addEventListener('click', toggle);
document.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); toggle(); } });
seek.addEventListener('input', () => { frame = +seek.value; t0 = null; draw(frame); });
draw(0);
requestAnimationFrame(tick);
</script>
</body>
</html>
'''


def main(argv):
    ap = argparse.ArgumentParser(description='Write tools/glisten-preview.html')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--seconds', type=float, default=60)
    ap.add_argument('--out', default=os.path.join(ROOT, 'tools', 'glisten-preview.html'))
    a = ap.parse_args(argv)
    import mode
    cfg = dict(mode.DEFAULTS)
    local = os.path.join(ROOT, 'pi', 'config.env')
    if os.path.exists(local):
        cfg = mode.load_config(local)          # the IDLE_* settings that would be deployed
    print('recording %d s at %d fps (seed %d)' % (a.seconds, FPS, a.seed))
    frames, labels, mas, capped = record(a.seconds, a.seed, cfg)
    sub = ('The Pi&rsquo;s own code, %d s at %d fps: a problem lit, Glisten after a %d s timeout (20 min on '
           'the wall), a cast cutting in at 38 s, night at 55 s. Space or the button plays and pauses.'
           % (a.seconds, FPS, IDLE_AFTER))
    page = (PAGE.replace('__SUB__', sub).replace('__FPS__', str(FPS))
            .replace('__LABELS__', json.dumps(labels)).replace('__MA__', json.dumps(mas))
            .replace('__HOLDS__', json.dumps(hold_cells()))
            .replace('__FRAMES__', base64.b64encode(bytes(frames)).decode('ascii')))
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(page)
    print('wrote %s (%.1f MB), peak ~%d mA, %d frames capped' % (a.out, os.path.getsize(a.out) / 1e6, max(mas), capped))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
