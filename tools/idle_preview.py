#!/usr/bin/env python3
"""Preview every idle pattern side by side on the laptop.

Runs the Pi's own pattern code (pi/listener/patterns, through patterns.Idle
exactly as the renderer does: brightness, gamma, the idle current cap) and
writes tools/idle-preview.html: one standalone file (the frames inside it,
compressed) with every pattern playing on a small 19 x 13 board, row 1 at the
bottom and column A on the left, plus a big view of the one you click. A last
tile, "cycle", runs them all in turn with short slots to show the crossfade.
Double-click the file to open it (any current browser); it needs nothing else.

    python tools/idle_preview.py [--seconds S] [--slot S] [--seed N] [--out FILE]

The teaser shows the real benchmark problems if pi/config.env has the Supabase
settings (one read with the public anon key), and a made-up problem if not.
Colours are the LEDs' PWM values shown through the screen's gamma, so dim and
bright look about as they will on the wall.
"""
import argparse
import base64
import json
import os
import sys
import time
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'pi', 'listener'))
sys.dont_write_bytecode = True
import board  # noqa: E402
import mode  # noqa: E402
import patterns  # noqa: E402
from patterns import common, teaser  # noqa: E402

FPS = 30            # what the Pi runs
KEEP = 2            # keep every 2nd frame (the page blends between them)
MADE_UP = [{'name': 'A made-up problem', 'finish_hold': 'hold238',
            'intermediate_holds': ['hold180', 'hold145', 'hold121', 'hold86', 'hold62'],
            'start_holds': ['hold29', 'hold31']}]


def record(plan, seconds, seed, cfg, ctx):
    idle = patterns.Idle(plan, 0.0, ctx, log=lambda m: None, err=lambda m: print('  !!', m), seed=seed,
                         brightness=float(cfg.get('IDLE_BRIGHTNESS') or 1.0),
                         max_ma=float(cfg.get('IDLE_MAX_AMPS') or 2.0) * 1000,
                         ma_per_channel=float(cfg.get('MA_PER_CHANNEL') or 20))
    per = float(cfg.get('MA_PER_CHANNEL') or 20)
    disp = [int(round(255 * (v / 255) ** (1 / common.GAMMA))) for v in range(256)]
    out, mas, names, busy = bytearray(), [], [], 0.0
    for k in range(int(seconds * FPS)):
        a = time.perf_counter()
        f = idle.frame(k / FPS)
        busy += time.perf_counter() - a
        mas.append(sum(c for rgb in f.values() for c in rgb) / 255 * per)
        if k % KEEP:
            continue
        for c in range(common.CELLS):                  # cell order = hold number - 1
            rgb = f.get(common.LED[c], (0, 0, 0))
            out += bytes(disp[v] for v in rgb)
        names.append(idle.name)
    n = int(seconds * FPS)
    return out, dict(ms=round(busy / n * 1000, 2), mean_ma=round(sum(mas) / n), peak_ma=round(max(mas)),
                     capped=idle.capped_frames), names


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
<title>Idle patterns</title>
<style>
  :root { --bg: #0a0a0a; --surface: #161616; --surface2: #202020; --border: #2c2c2c; --text: #f5f5f5;
          --muted: #9a9a9a; --accent: #ec4899; --wall: #15120e; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; padding: 16px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 16px; max-width: 900px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 760px); gap: 20px; align-items: start; }
  @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .big { order: -1; } }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .tile { background: var(--surface); border: 2px solid var(--border); border-radius: 10px; padding: 8px;
          cursor: pointer; text-align: left; color: inherit; font: inherit; }
  .tile:hover { border-color: #444; }
  .tile.on { border-color: var(--accent); }
  .tile canvas { width: 100%; height: auto; display: block; border-radius: 6px; background: var(--wall); }
  .tile .name { font-weight: 600; margin: 6px 2px 0; display: flex; justify-content: space-between; gap: 8px; }
  .tile .stat { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; font-size: 12px; }
  .big { position: sticky; top: 16px; background: var(--surface); border: 1px solid var(--border);
         border-radius: 12px; padding: 12px; }
  .big canvas { width: 100%; height: auto; display: block; border-radius: 8px; background: var(--wall); }
  .big h2 { font-size: 20px; margin: 4px 0 2px; }
  .about { color: var(--muted); margin: 0 0 10px; min-height: 2.8em; }
  .bar { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  button.play { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px;
                font: inherit; font-weight: 600; cursor: pointer; min-width: 84px; }
  input[type=range] { flex: 1; accent-color: var(--accent); }
  .readout { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); margin-top: 6px;
             font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  .readout b { color: var(--text); font-weight: 500; }
  .loading { color: var(--muted); }
</style>
</head>
<body>
<h1>Idle patterns</h1>
<p class="sub">__SUB__</p>
<div class="layout">
  <div class="tiles" id="tiles"><p class="loading">Unpacking the frames&hellip;</p></div>
  <div class="big">
    <h2 id="bname"></h2>
    <p class="about" id="babout"></p>
    <canvas id="big" width="760" height="560"></canvas>
    <div class="bar"><button class="play" id="play">Pause</button><input id="seek" type="range" min="0" value="0"></div>
    <div class="readout"><span id="bnow"></span><span id="bstat"></span><span id="btime"></span></div>
  </div>
</div>
<script>
const FPS = __FPS__, COLS = 19, ROWS = 13, CELLS = COLS * ROWS, FRAME = CELLS * 3;
const META = __META__, HOLDS = new Set(__HOLDS__), PACKED = __PACKED__;

async function unpack(b64) {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function board(cv, big) {       // the layout: cell = hold number - 1, row 1 at the bottom, column A on the left
  const padL = big ? 34 : 4, padB = big ? 30 : 4, pad = big ? 14 : 4;
  const W = cv.width - padL - pad, H = cv.height - padB - pad;
  const dx = W / COLS, dy = H / ROWS;
  const xy = c => [padL + (c % COLS + 0.5) * dx, pad + (ROWS - 1 - Math.floor(c / COLS) + 0.5) * dy];
  return { cv, cx: cv.getContext('2d'), big, dx, dy, xy, r: Math.min(dx, dy) * (big ? 0.16 : 0.2), padL, padB, pad };
}

function background(b) {
  const { cx, cv } = b;
  cx.globalCompositeOperation = 'source-over';
  cx.fillStyle = '#15120e'; cx.fillRect(0, 0, cv.width, cv.height);
  if (b.big) {
    cx.fillStyle = '#6f6a62'; cx.font = '12px system-ui'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    for (let x = 0; x < COLS; x++) cx.fillText(String.fromCharCode(65 + x), b.padL + (x + 0.5) * b.dx, cv.height - b.padB / 2);
    for (let y = 0; y < ROWS; y++) cx.fillText(y + 1, b.padL / 2, b.pad + (ROWS - 1 - y + 0.5) * b.dy);
    cx.strokeStyle = '#2c2822'; cx.lineWidth = 2;
    for (const c of HOLDS) { const [px, py] = b.xy(c); cx.beginPath(); cx.arc(px, py, Math.min(b.dx, b.dy) * 0.36, 0, 7); cx.stroke(); }
  }
}

function draw(b, data, f, k) {   // frame f blended k of the way to the next one
  background(b);
  const { cx } = b, n = data.length / FRAME, o = (f % n) * FRAME, o2 = ((f + 1) % n) * FRAME;
  cx.globalCompositeOperation = 'lighter';
  const glow = b.r * (b.big ? 4.2 : 3.2);
  for (let c = 0; c < CELLS; c++) {
    const i = o + c * 3, j = o2 + c * 3;
    const R = Math.round(data[i] + (data[j] - data[i]) * k), G = Math.round(data[i + 1] + (data[j + 1] - data[i + 1]) * k),
          B = Math.round(data[i + 2] + (data[j + 2] - data[i + 2]) * k);
    const [px, py] = b.xy(c);
    if (R | G | B) {
      const g = cx.createRadialGradient(px, py, 0, px, py, glow);
      g.addColorStop(0, `rgba(${R},${G},${B},0.9)`);
      g.addColorStop(0.3, `rgba(${R},${G},${B},0.35)`);
      g.addColorStop(1, `rgba(${R},${G},${B},0)`);
      cx.fillStyle = g; cx.beginPath(); cx.arc(px, py, glow, 0, 7); cx.fill();
    }
    cx.fillStyle = (R | G | B) ? `rgb(${R},${G},${B})` : '#24211c';
    cx.beginPath(); cx.arc(px, py, b.r, 0, 7); cx.fill();
  }
}

const tiles = [], big = board(document.getElementById('big'), true);
const seek = document.getElementById('seek'), btn = document.getElementById('play');
let sel = 0, playing = true, T = 0, last = null;

function choose(i) {
  sel = i;
  tiles.forEach((t, j) => t.el.classList.toggle('on', j === i));
  const m = META[i];
  document.getElementById('bname').textContent = m.name;
  document.getElementById('babout').textContent = m.about;
  document.getElementById('bstat').textContent =
    `~${m.mean_ma} mA mean, ${m.peak_ma} peak${m.capped ? `, ${m.capped} frames capped` : ''} · ${m.ms} ms a frame on this laptop`;
  seek.max = tiles[i].data.length / FRAME - 1;
}

function render() {
  for (const t of tiles) {
    const n = t.data.length / FRAME, p = T * FPS, f = Math.floor(p);
    draw(t.b, t.data, f % n, p - f);
  }
  const t = tiles[sel], n = t.data.length / FRAME, p = T * FPS, f = Math.floor(p) % n;
  draw(big, t.data, f, p - Math.floor(p));
  seek.value = f;
  const now = META[sel].names ? META[sel].names[f] : META[sel].name;
  document.getElementById('bnow').innerHTML = META[sel].names ? `now: <b>${now}</b>` : '';
  document.getElementById('btime').textContent = (f / FPS).toFixed(1) + ' / ' + (n / FPS).toFixed(0) + ' s';
}

function tick(now) {
  if (playing && last !== null) T += (now - last) / 1000;
  last = now;
  render();
  requestAnimationFrame(tick);
}

function toggle() { playing = !playing; btn.textContent = playing ? 'Pause' : 'Play'; }
btn.addEventListener('click', toggle);
document.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowRight') choose((sel + 1) % tiles.length);
  if (e.code === 'ArrowLeft') choose((sel + tiles.length - 1) % tiles.length);
});
seek.addEventListener('input', () => { T = +seek.value / FPS; render(); });

(async () => {
  const wrap = document.getElementById('tiles');
  const datas = await Promise.all(PACKED.map(unpack));
  wrap.innerHTML = '';
  META.forEach((m, i) => {
    const el = document.createElement('button');
    el.className = 'tile';
    const cv = document.createElement('canvas'); cv.width = 380; cv.height = 280;
    const name = document.createElement('div'); name.className = 'name';
    const a = document.createElement('span'); a.textContent = m.name;
    const s = document.createElement('span'); s.className = 'stat'; s.textContent = `~${m.mean_ma} mA`;
    name.append(a, s); el.append(cv, name); wrap.append(el);
    el.addEventListener('click', () => choose(i));
    tiles.push({ el, b: board(cv, false), data: datas[i] });
  });
  choose(0);
  requestAnimationFrame(tick);
})();
</script>
</body>
</html>
'''


def main(argv):
    ap = argparse.ArgumentParser(description='Write tools/idle-preview.html')
    ap.add_argument('--seconds', type=float, default=90, help='seconds of each pattern (default 90)')
    ap.add_argument('--slot', type=float, default=12, help='seconds a pattern in the cycle tile (default 12)')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--out', default=os.path.join(ROOT, 'tools', 'idle-preview.html'))
    a = ap.parse_args(argv)
    cfg = dict(mode.DEFAULTS)
    local = os.path.join(ROOT, 'pi', 'config.env')
    if os.path.exists(local):
        cfg = mode.load_config(local)          # the IDLE_* settings that would be deployed
    rows, where = MADE_UP, 'a made-up problem (no Supabase settings in pi/config.env)'
    if cfg.get('SUPABASE_URL') and cfg.get('SUPABASE_ANON_KEY'):
        import supa
        try:
            rows = supa.fetch_benchmarks(cfg)
            where = 'the %d live benchmarks' % len(rows)
        except Exception as e:
            where = 'a made-up problem (benchmarks not loaded: %s)' % e
    ctx = {'benchmarks': teaser.from_rows(rows)}
    print('teaser: %s' % where)
    meta, packed = [], []
    plans = [(n, patterns.Plan([n]), a.seconds, patterns.PATTERNS[n].about) for n in patterns.NAMES]
    plans.append(('cycle', patterns.Plan(patterns.NAMES, a.slot, 0.0, 'cycle'), a.slot * len(patterns.NAMES),
                  'every pattern in turn, %g s each here (IDLE_CYCLE_MIN on the wall), with the %g s crossfade'
                  % (a.slot, patterns.CROSSFADE)))
    for name, plan, secs, about in plans:
        frames, stats, names = record(plan, secs, a.seed, cfg, ctx)
        m = dict(stats, name=name, about=about)
        if name == 'cycle':
            m['names'] = names
        meta.append(m)
        packed.append(base64.b64encode(zlib.compress(bytes(frames), 9)).decode('ascii'))
        print('  %-10s %3d s  %5.2f ms a frame  ~%4d mA mean, %4d peak%s' % (
            name, secs, stats['ms'], stats['mean_ma'], stats['peak_ma'],
            ', %d frames capped' % stats['capped'] if stats['capped'] else ''))
    sub = ('The Pi&rsquo;s own pattern code, at %d fps, with the brightness and the %g A idle cap from %s. '
           'Click a pattern for the big view; Space plays and pauses, &larr; &rarr; change pattern. '
           'The teaser shows %s.' % (FPS, float(cfg.get('IDLE_MAX_AMPS') or 2.0),
                                     'pi/config.env' if os.path.exists(local) else 'the defaults', where))
    page = (PAGE.replace('__SUB__', sub).replace('__FPS__', str(FPS // KEEP))
            .replace('__META__', json.dumps(meta)).replace('__HOLDS__', json.dumps(hold_cells()))
            .replace('__PACKED__', json.dumps(packed)))
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(page)
    print('wrote %s (%.1f MB)' % (a.out, os.path.getsize(a.out) / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
