// Bot benchmark: `npx tsx tools/botBench.ts [--laps 3,5,8] [--lineup hard,normal,easy,autopilot]`.
// Plays deterministic headless races and prints win rate, average finishing position (lower is
// better) and mean decision time per policy.
import { readFileSync } from "node:fs";
import { runBench } from "../src/game/race/botBench";
import { createRaceContext } from "../src/game/race/raceEngine";
import type { BotPolicy } from "../src/game/systems/botSystem";
import type { TrackData } from "../src/game/types/track";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const track = JSON.parse(
  readFileSync(new URL("../public/tracks/oval16_3lanes.json", import.meta.url), "utf8")
) as TrackData;
const ctx = createRaceContext(track);
const lineup = arg("lineup", "hard,normal,easy,autopilot").split(",") as BotPolicy[];
const laps = arg("laps", "3,4,5,6").split(",").map(Number);

const started = performance.now();
const { races, stats } = runBench(ctx, { lineup, laps });
console.log(`${races} races (${lineup.join(", ")}; laps ${laps.join("/")}) in ${((performance.now() - started) / 1000).toFixed(1)} s`);
console.log("policy      wins  win rate  avg finish  avg moves  ms/decision");
for (const [policy, s] of [...stats].sort((a, b) => a[1].avgFinish - b[1].avgFinish)) {
  console.log(
    `${policy.padEnd(10)} ${String(s.wins).padStart(5)}  ${(s.winRate * 100).toFixed(0).padStart(6)}%  ${s.avgFinish.toFixed(2).padStart(10)}  ${s.avgMoves.toFixed(1).padStart(9)}  ${s.meanDecisionMs.toFixed(3).padStart(10)}`
  );
}
