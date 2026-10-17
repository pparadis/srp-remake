// Golden file of a movement-rules version (#118): what the rules answer on a fixed corpus of race positions, so a
// frozen version that drifts fails a test. Each sample is a whole RaceState (positions sampled from seeded bot races,
// plus hand-picked ones on the cells where versions disagree), the targets the active car is offered (with prices),
// and the move it then played with the car's state after it (draft run, wear, lap). The action is recorded, not
// re-decided, so a later bot change cannot move the file.
//
//   npx tsx tools/rulesGolden.ts <out.json> <version>
//
// Freezing a version: generate its file into src/game/rules/golden/, register it in rulesGolden.test.ts and set the
// version's status to "frozen" in src/game/rules/versions.ts. v1 was generated in a checkout of a97293a (the rules
// before #114, tag rules-v1), from an earlier copy of this file with the same samples.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import track from "../public/tracks/oval16_3lanes.json";
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceAction,
  type RaceContext,
  type RaceState
} from "../src/game/race/raceEngine";
import { editCar, placeCar, setActiveCar, type CarEdit } from "../src/game/race/sandbox";
import { carAfter, targetsOf, type Golden, type GoldenSample } from "../src/game/rules/golden";
import { isRulesVersion, type RulesVersion } from "../src/game/rules/versions";
import type { TrackData } from "../src/game/types/track";

const LEVELS = ["hard", "normal", "easy"] as const;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function sample(ctx: RaceContext, name: string, state: RaceState, action: RaceAction): GoldenSample {
  const before = clone(state);
  const targets = targetsOf(ctx, state);
  const carId = getActiveCar(state).carId;
  const played = clone(state);
  const r = applyAction(ctx, played, action);
  if (!r.ok) throw new Error(`${name}: ${action.type} refused (${r.reason})`);
  return { name, state: before, targets, action, after: carAfter(played, carId) };
}

function raceSamples(ctx: RaceContext, version: RulesVersion): GoldenSample[] {
  const out: GoldenSample[] = [];
  for (const cars of [6, 12, 16]) {
    for (const seed of [1, 2, 3, 4]) {
      const state = createRace(
        ctx,
        Array.from({ length: cars }, (_, i) => ({ isBot: true, ownerId: `B${i}`, botLevel: LEVELS[i % 3]! })),
        5,
        seed,
        version
      );
      for (let turn = 0; turn < 120 * cars && state.winnerCarId === null; turn += 1) {
        let action = decideBotAction(ctx, state).action;
        if (turn % 23 === 0 && action.type !== "setup") {
          const probe = clone(state);
          if (!applyAction(ctx, probe, action).ok) action = { type: "skip" };
          out.push(sample(ctx, `race cars=${cars} seed=${seed} turn=${turn}`, state, action));
        }
        if (!applyAction(ctx, state, action).ok) applyAction(ctx, state, { type: "skip" });
      }
    }
  }
  return out;
}

// Positions on the cells where forwardIndex and the lane's cells / lap position disagree (#113, #114).
const HAND: { name: string; start: string; cars: string[]; move: string; edit?: CarEdit }[] = [
  { name: "draft lane 3 bend: right behind on a repeated forwardIndex", start: "Z11_L3_00", cars: ["Z13_L3_00"], move: "Z12_L3_00" },
  { name: "draft lane 2: right behind", start: "Z11_L2_00", cars: ["Z13_L2_00"], move: "Z12_L2_00" },
  { name: "draft lane 3: two behind", start: "Z09_L3_00", cars: ["Z13_L3_00"], move: "Z11_L3_00" },
  { name: "draft lane 3 across the line", start: "Z30_L3_00", cars: ["Z01_L3_00"], move: "Z32_L3_00" },
  { name: "squeeze from lane 2, a row of three ahead", start: "Z06_L2_00", cars: ["Z07_L1_00", "Z07_L2_00", "Z07_L3_00"], move: "Z08_L2_00" },
  { name: "lane change onto lane 3 on the bend", start: "Z05_L2_00", cars: [], move: "Z08_L3_00" },
  { name: "lane change off lane 3 on the bend", start: "Z11_L3_00", cars: [], move: "Z14_L2_00" },
  { name: "blocker in lane 3 on the bend", start: "Z10_L2_00", cars: ["Z13_L3_00"], move: "Z11_L2_00" },
  { name: "pass and return round a lane-2 car", start: "Z04_L2_00", cars: ["Z05_L2_00"], move: "Z07_L2_00" },
  { name: "slingshot run 2 on lane 3", start: "Z09_L3_00", cars: [], move: "Z12_L2_00", edit: { draftTurns: 2 } }
];

function handSamples(ctx: RaceContext, version: RulesVersion): GoldenSample[] {
  return HAND.map((h) => {
    const cells = [h.start, ...h.cars];
    const state = createRace(ctx, cells.map((_, i) => ({ isBot: false, ownerId: `P${i + 1}` })), 5, 0, version);
    cells.forEach((cell, i) => {
      const refused = placeCar(ctx, state, i + 1, cell);
      if (refused) throw new Error(`${h.name}: ${refused}`);
    });
    if (h.edit && editCar(ctx, state, 1, h.edit)) throw new Error(`${h.name}: edit refused`);
    if (!setActiveCar(state, 1)) throw new Error(`${h.name}: car 1 not in play order`);
    // a move that is not offered is recorded as a skip probe: the targets still pin the rule
    const offered = computeTargets(ctx, state, getActiveCar(state)).has(h.move);
    const action: RaceAction = offered ? { type: "move", targetCellId: h.move } : { type: "skip" };
    if (!offered) {
      const probe = clone(state);
      if (!applyAction(ctx, probe, action).ok) return { name: h.name, state: clone(state), targets: targetsOf(ctx, state), action, after: null };
    }
    return sample(ctx, h.name, state, action);
  });
}

export function buildGolden(version: RulesVersion, generatedFrom: string): Golden {
  const data = track as unknown as TrackData;
  const ctx = createRaceContext(data);
  return { version, generatedFrom, trackId: data.trackId, samples: [...handSamples(ctx, version), ...raceSamples(ctx, version)] };
}

const [out, version] = process.argv.slice(2);
if (out && version) {
  if (!isRulesVersion(version)) throw new Error(`Unknown rules version ${version}`);
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
  const golden = buildGolden(version, sha);
  writeFileSync(out, JSON.stringify(golden) + "\n");
  console.log(`${golden.samples.length} samples from ${sha} -> ${out}`);
}
