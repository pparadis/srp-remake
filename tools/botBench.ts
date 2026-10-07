// Bot benchmark: `npx tsx tools/botBench.ts [--laps 3,5,8] [--lineup hard,normal,easy,autopilot] [--seeds 4]`
// Plays deterministic headless races (every rotation of the line-up on every lap count and seed) and
// prints win rate, average finishing position (lower is better) and mean decision time per policy,
// then per personality and per grid slot. `--strategist` instead runs the scripted human baseline
// (inner lane, 9-8-8-8-7, and the greedy variant) against 3 bots of a level from every grid slot.
// Lineup entries: hard, normal, easy, autopilot, scripted, greedy; `--styles pusher,steady,...` forces
// a personality per line-up entry (it rotates with the line-up).
import { readFileSync } from "node:fs";
import { playBenchRace, runBench, statsBy, type BenchPolicy } from "../src/game/race/botBench";
import { createRaceContext } from "../src/game/race/raceEngine";
import type { PersonalityKey } from "../src/game/systems/botStyle";
import type { TrackData } from "../src/game/types/track";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const track = JSON.parse(
  readFileSync(new URL("../public/tracks/oval16_3lanes.json", import.meta.url), "utf8")
) as TrackData;
const ctx = createRaceContext(track);
const laps = arg("laps", "3,4,5,6").split(",").map(Number);
const seedCount = Number(arg("seeds", "1"));
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
const started = performance.now();
const seconds = () => ((performance.now() - started) / 1000).toFixed(1);

if (process.argv.includes("--strategist")) {
  const level = arg("level", "normal") as BenchPolicy;
  console.log(`scripted strategist (car 1) against 3 x ${level}; laps ${laps.join("/")}, seeds 1..${seedCount}`);
  console.log("variant    laps  wins  win rate  avg finish   (by grid slot: avg finish 1..4)");
  for (const variant of ["scripted", "greedy"] as const) {
    for (const lapCount of laps) {
      const results = seeds.map((seed) => playBenchRace(ctx, [variant, level, level, level], lapCount, seed));
      const me = results.flatMap((r) => r.finishers.filter((f) => f.slot === 0));
      const bySlot = statsBy([{ finishers: me, order: [], decisionMs: {} }], (f) => String(f.grid));
      const wins = me.filter((f) => f.place === 1).length;
      const avg = me.reduce((sum, f) => sum + f.place, 0) / me.length;
      const slots = [0, 1, 2, 3].map((g) => bySlot.get(String(g))?.avgFinish.toFixed(1) ?? "-").join(" ");
      console.log(
        `${variant.padEnd(10)} ${String(lapCount).padStart(4)} ${String(wins).padStart(5)} ${((wins / me.length) * 100).toFixed(0).padStart(8)}% ${avg.toFixed(2).padStart(11)}   ${slots}`
      );
    }
  }
  console.log(`${seconds()} s`);
  process.exit(0);
}

const lineup = arg("lineup", "hard,normal,easy,autopilot").split(",") as BenchPolicy[];
const styleArg = arg("styles", "");
const styles = styleArg ? (styleArg.split(",") as PersonalityKey[]) : undefined;
const { races, stats, results } = runBench(ctx, { lineup, laps, seeds, ...(styles ? { styles } : {}) });
console.log(`${races} races (${lineup.join(", ")}; laps ${laps.join("/")}; ${seedCount} seeds) in ${seconds()} s`);
console.log("policy      wins  win rate  avg finish  avg moves  ms/decision");
for (const [policy, s] of [...stats].sort((a, b) => a[1].avgFinish - b[1].avgFinish)) {
  console.log(
    `${policy.padEnd(10)} ${String(s.wins).padStart(5)}  ${(s.winRate * 100).toFixed(0).padStart(6)}%  ${s.avgFinish.toFixed(2).padStart(10)}  ${s.avgMoves.toFixed(1).padStart(9)}  ${s.meanDecisionMs.toFixed(3).padStart(10)}`
  );
}
console.log("\npersonality  races  win rate  avg finish");
for (const [style, s] of [...statsBy(results, (f) => f.style)].sort((a, b) => a[1].avgFinish - b[1].avgFinish)) {
  console.log(`${style.padEnd(11)} ${String(s.races).padStart(6)}  ${(s.winRate * 100).toFixed(0).padStart(7)}%  ${s.avgFinish.toFixed(2).padStart(10)}`);
}
console.log("\navg finish by grid slot (1 = pole): policy x slot");
for (const policy of stats.keys()) {
  const bySlot = statsBy(results, (f) => (f.policy === policy ? String(f.grid + 1) : null));
  const cols = [...bySlot].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, s]) => s.avgFinish.toFixed(2).padStart(5));
  console.log(`${policy.padEnd(10)} ${cols.join(" ")}`);
}
