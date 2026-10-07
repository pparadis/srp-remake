// CPU probe: total CPU seconds (user+system, browser process tree) for an idle solo race with 3 bots plus a few turns.
// Usage: node tools/cpuProbe.mjs [--runs 3] [--idle 10] label:ENV=VAL,ENV=VAL ...   (no variants = baseline only)
// Reads /proc, so Linux only. CPU seconds are comparable across runs; wall time and load average are not.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? Number(args.splice(args.indexOf(name), 2)[1]) : d);
const runs = opt("--runs", 3);
const idleS = opt("--idle", 10);
const variants = args.length ? args : ["baseline:"];
const TICKS = Number(execFileSync("getconf", ["CLK_TCK"]).toString());
const port = 5400 + Math.floor(Math.random() * 400);

function procTable() {
  const t = new Map();
  for (const d of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try {
      const raw = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = raw.slice(raw.lastIndexOf(")") + 2).split(" "); // f[0]=state f[1]=ppid ... f[11]=utime f[12]=stime
      t.set(Number(d), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]) });
    } catch {
      // process vanished between readdir and read
    }
  }
  return t;
}
function treeTicks(root) {
  const t = procTable();
  // roots: our direct children that are a browser (not the vite preview server)
  const ids = new Set(
    [...t]
      .filter(
        ([pid, p]) =>
          p.ppid === root && /chrom|headless/i.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"))
      )
      .map(([pid]) => pid)
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, p] of t) if (!ids.has(pid) && ids.has(p.ppid)) (ids.add(pid), (grew = true));
  }
  let sum = 0;
  for (const pid of ids) sum += t.get(pid).ticks;
  return sum;
}

async function measure(url) {
  const browser = await chromium.launch();
  try {
    const pid = process.pid; // Playwright 1.63 has no browser.process(): count everything under this node process, excluding itself
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByTestId("home-quick").click();
    await page.getByTestId("lobby-bots").selectOption("3");
    await page.getByTestId("lobby-laps").fill("1");
    await page.getByTestId("lobby-laps").press("Tab");
    await page.getByTestId("lobby-start").click();
    await page.waitForFunction(() => window.__srp?.state().cars.length > 0);
    const start = treeTicks(pid),
      t0 = Date.now();
    await page.waitForTimeout(idleS * 1000);
    for (let i = 0; i < 3; i++) {
      await page.waitForFunction(() => window.__srp.status().canControl, undefined, {
        timeout: 60_000
      });
      const plan = await page.evaluate(() => {
        const s = window.__srp.state();
        const car = s.cars.find((c) => c.carId === s.activeCarId);
        const t = s.movement.validTargets
          .filter((x) => !x.isPitTrigger)
          .sort((a, b) => b.distance - a.distance)[0];
        return {
          cellId: car.cellId,
          carId: car.carId,
          from: window.__srp.cellScreenPos(car.cellId),
          to: window.__srp.cellScreenPos(t.cellId)
        };
      });
      await page.mouse.move(plan.from.x, plan.from.y);
      await page.mouse.down();
      await page.mouse.move(plan.to.x, plan.to.y, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(
        ({ carId, cellId }) =>
          window.__srp.state().cars.find((c) => c.carId === carId).cellId !== cellId,
        plan,
        { timeout: 10_000 }
      );
    }
    console.error(`  wall ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return (treeTicks(pid) - start) / TICKS;
  } finally {
    await browser.close();
  }
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const results = [];
for (const v of variants) {
  const [label, envStr = ""] = v.split(":");
  const out = mkdtempSync(join(tmpdir(), "srp-probe-"));
  const env = {
    ...process.env,
    VITE_BASE_PATH: "/",
    VITE_BACKEND_API_BASE_URL: "http://localhost:3001",
    VITE_BACKEND_WS_BASE_URL: ""
  };
  for (const kv of envStr.split(",").filter(Boolean)) env[kv.split("=")[0]] = kv.split("=")[1];
  execFileSync("npx", ["vite", "build", "--mode", "test", "--outDir", out, "--emptyOutDir"], {
    env,
    stdio: "ignore"
  });
  const server = spawn(
    "npx",
    ["vite", "preview", "--outDir", out, "--port", String(port), "--strictPort"],
    { env, stdio: "ignore", detached: true }
  );
  try {
    await new Promise((r) => setTimeout(r, 3000));
    const secs = [];
    for (let i = 0; i < runs; i++) secs.push(await measure(`http://localhost:${port}`));
    results.push({ label, median: median(secs), all: secs.map((s) => s.toFixed(1)).join(" ") });
  } finally {
    process.kill(-server.pid);
    rmSync(out, { recursive: true, force: true });
  }
}
const base = results[0].median;
for (const r of results)
  console.log(
    `${r.label.padEnd(18)} median ${r.median.toFixed(1)} s  (${((r.median / base) * 100).toFixed(0)}% of first)  runs: ${r.all}`
  );
