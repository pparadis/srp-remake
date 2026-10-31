// Frame-rate probe (#232, #79): plays a solo race in a HEADED browser and logs the `P` readout (`fps` and `worst frame`,
// the `hud-fps` line) through idle, a car drag, a wheel zoom, a pan and a turn with glides. Needs a display.
// Usage: node tools/fps_probe.mjs [--browser chrome|chromium|firefox ...] [--runs 3] [--idle 8] [--phase 6] [--json]
// With --runs the samples of every run are pooled, so one odd run (a cold start, a busy desktop) shows as a low min.
// Serves the Vite dev server (the app's `__srp` hook and the adaptive frame rate, which the test build caps at 10 fps).
// The dev server's own JS is unminified; the render cost, which is what this measures, is Phaser's.
import { spawn } from 'node:child_process';
import { chromium, firefox } from '@playwright/test';

const args = process.argv.slice(2);
function opt(name, d) {
  const i = args.indexOf(name);
  return i < 0 ? d : args.splice(i, 2)[1];
}
const idleS = Number(opt('--idle', 8));
const phaseS = Number(opt('--phase', 6));
const runs = Number(opt('--runs', 1));
const json = args.includes('--json');
const browsers = [];
for (let b; (b = opt('--browser', null));) browsers.push(b);
if (!browsers.length) browsers.push('chrome', 'firefox');
const port = 5800 + Math.floor(Math.random() * 100);
const VIEWPORT = { width: 1280, height: 800 };

const LAUNCH = {
  chrome: () => chromium.launch({ channel: 'chrome', headless: false }),
  chromium: () => chromium.launch({ headless: false }),
  firefox: () => firefox.launch({ headless: false })
};

function median(a) {
  return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
}

// every change of the readout line, tagged with the phase running at that moment (runs in the page)
function collector() {
  const line = document.querySelector('[data-testid="hud-fps"]');
  window.__fpsLog = [];
  window.__phase = 'start';
  new MutationObserver(() => {
    const m = /fps (\d+) · worst frame (\d+) ms/.exec(line.textContent ?? '');
    if (m) {
      window.__fpsLog.push({ phase: window.__phase, fps: Number(m[1]), worstMs: Number(m[2]) });
    }
  }).observe(line, { childList: true, characterData: true, subtree: true });
}

async function run(name) {
  const browser = await LAUNCH[name]();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(`http://localhost:${port}/?seed=0&rules=v3&fps`);
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      const e = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : 'no webgl';
    });
    await page.getByTestId('home-quick').click();
    await page.getByTestId('lobby-bots').selectOption('3');
    await page.getByTestId('lobby-laps').fill('1');
    await page.getByTestId('lobby-laps').press('Tab');
    await page.getByTestId('lobby-start').click();
    await page.waitForFunction(() => window.__srp?.state().cars.length > 0);
    // v3 and v4 open the grid setup on the first turn, over the board the probe drags on
    await page
      .getByTestId('setup-cancel')
      .click({ timeout: 3000 })
      .catch(() => {});
    await page.waitForFunction(() => window.__srp.status().canControl, undefined, {
      timeout: 60_000
    });
    await page.evaluate(collector);
    const phase = (label) => page.evaluate((l) => (window.__phase = l), label);
    const plan = () =>
      page.evaluate(() => {
        const s = window.__srp.state();
        const car = s.cars.find((c) => c.carId === s.activeCarId);
        const far = s.movement.validTargets
          .filter((x) => !x.isPitTrigger)
          .sort((a, b) => b.distance - a.distance)[0];
        return {
          from: window.__srp.cellScreenPos(car.cellId),
          to: window.__srp.cellScreenPos(far.cellId)
        };
      });
    // moves the pointer in a circle (a stream of pointermove events, like a finger) for `seconds`
    async function circle(cx, cy, seconds, r = 70) {
      const end = Date.now() + seconds * 1000;
      for (let a = 0; Date.now() < end; a += 0.15) {
        await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
        await page.waitForTimeout(8);
      }
    }

    // idle: let the 600 ms full-rate hold lapse first
    await page.mouse.move(VIEWPORT.width - 5, VIEWPORT.height - 5);
    await page.waitForTimeout(2000);
    await phase('idle');
    await page.waitForTimeout(idleS * 1000);

    // drag: lift the car and wave it about, then put it back on its own cell (no move is taken)
    const { from } = await plan();
    await phase('drag');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await circle(from.x, from.y, phaseS, 60);
    await page.mouse.move(from.x, from.y);
    await page.mouse.up();

    // wheel zoom in then out, over the car
    await phase('wheel zoom');
    await page.mouse.move(from.x, from.y);
    const wheelSteps = Math.round((phaseS * 1000) / 150);
    for (let i = 0; i < wheelSteps; i++) {
      await page.mouse.wheel(0, i < wheelSteps / 2 ? -240 : 240);
      await page.waitForTimeout(150);
    }

    // pan: zoom in, then drag the empty board about
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -240);
    await page.waitForTimeout(800);
    await phase('pan (zoomed)');
    const cx = VIEWPORT.width / 2;
    const cy = VIEWPORT.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await circle(cx, cy, phaseS, 120);
    await page.mouse.up();
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 240);
    await page.waitForTimeout(800);

    // a turn: the player's move and the three bots' glides after it
    const t = await plan();
    await phase('turn + glides');
    await page.mouse.move(t.from.x, t.from.y);
    await page.mouse.down();
    await page.mouse.move(t.to.x, t.to.y, { steps: 8 });
    await page.mouse.up();
    // until the glides end (the player cannot act while cars move), at most `phaseS` + 30 s
    await page.waitForFunction(() => !window.__srp.status().canControl, undefined, {
      timeout: 5000
    });
    await page.waitForFunction(() => window.__srp.status().canControl, undefined, {
      timeout: 30_000
    });
    await phase('end');

    return {
      version: browser.version(),
      renderer,
      log: await page.evaluate(() => window.__fpsLog)
    };
  } finally {
    await browser.close();
  }
}

const server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
  stdio: 'ignore',
  detached: true
});
try {
  await new Promise((r) => setTimeout(r, 4000));
  const results = [];
  for (const b of browsers) {
    const log = [];
    let info;
    for (let i = 0; i < runs; i++) {
      info = await run(b);
      log.push(...info.log);
    }
    const rows = ['idle', 'drag', 'wheel zoom', 'pan (zoomed)', 'turn + glides'].map((phase) => {
      const s = log.filter((x) => x.phase === phase);
      return {
        phase,
        samples: s.length,
        fpsMin: Math.min(...s.map((x) => x.fps)),
        fpsMedian: median(s.map((x) => x.fps)),
        worstMsMax: Math.max(...s.map((x) => x.worstMs)),
        worstMsMedian: median(s.map((x) => x.worstMs))
      };
    });
    results.push({ browser: b, runs, version: info.version, renderer: info.renderer, rows, log });
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      console.log(`\n${r.browser} ${r.version}, ${r.runs} run(s)  GL: ${r.renderer}`);
      console.log('phase'.padEnd(16) + 'samples  fps min/median  worst frame ms max/median');
      for (const x of r.rows) {
        console.log(
          x.phase.padEnd(16) +
            String(x.samples).padEnd(9) +
            `${x.fpsMin}/${x.fpsMedian}`.padEnd(16) +
            `${x.worstMsMax}/${x.worstMsMedian}`
        );
      }
    }
  }
} finally {
  process.kill(-server.pid);
}
