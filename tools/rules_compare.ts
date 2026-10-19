// Compare movement-rules versions on the same deterministic races (#118):
//   npx tsx tools/rulesCompare.ts [--rules v1,v2] [--seeds 12] [--laps 5]
// Per version: the bot benchmark (the bots' ordering, overtakes, race length in turns) and, from bot-only races of 6, 12
// and 16 cars, how often each rule comes up (tows, slingshots, squeezes, lane changes) and which lanes the cars drive.
import { readFileSync } from 'node:fs';
import { runBench, type BenchPolicy } from '../src/game/race/botBench';
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar
} from '../src/game/race/raceEngine';
import { isRulesVersion, RULES, type RulesVersion } from '../src/game/rules/versions';
import type { TrackData } from '../src/game/types/track';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const track = JSON.parse(
  readFileSync(new URL('../public/tracks/oval16_3lanes.json', import.meta.url), 'utf8')
) as TrackData;
const ctx = createRaceContext(track);
const versions = arg('rules', 'v1,v2').split(',');
for (const v of versions) if (!isRulesVersion(v)) throw new Error(`Unknown rules version ${v}`);
const seedCount = Number(arg('seeds', '12'));
const seeds = Array.from({ length: seedCount }, (_item, i) => i + 1);
const laps = Number(arg('laps', '5'));
const LEVELS = ['hard', 'normal', 'easy'] as const;

interface Row {
  [label: string]: number;
}

function reach(version: RulesVersion): Row {
  let moves = 0;
  let inTow = 0;
  let tucked = 0;
  let squeezes = 0;
  let laneChanges = 0;
  let multi = 0;
  let races = 0;
  let turns = 0;
  const lane = [0, 0, 0, 0];
  let slingshots = 0;
  for (const cars of [6, 12, 16]) {
    for (const seed of seeds) {
      const state = createRace(
        ctx,
        Array.from({ length: cars }, (_slot, i) => ({
          isBot: true,
          ownerId: `B${i}`,
          botLevel: LEVELS[i % 3]!
        })),
        laps,
        seed,
        version
      );
      races += 1;
      for (let turn = 0; turn < 120 * cars && state.winnerCarId === null; turn += 1) {
        const car = getActiveCar(state);
        const action = decideBotAction(ctx, state).action;
        const info =
          action.type === 'move'
            ? computeTargets(ctx, state, car).get(action.targetCellId)
            : undefined;
        const from = ctx.cellMap.get(car.cellId)!;
        const towBefore = (car.draftTurns ?? 0) >= 1;
        const r = applyAction(ctx, state, action);
        if (!r.ok) {
          applyAction(ctx, state, { type: 'skip' });
          continue;
        }
        turns += 1;
        if (action.type !== 'move' || !info) continue;
        moves += 1;
        if (towBefore) inTow += 1;
        if ((car.draftTurns ?? 0) >= 1) tucked += 1;
        if (info.squeezePassed) squeezes += 1;
        if ((info.laneChanges ?? 0) >= 2) multi += 1;
        const to = ctx.cellMap.get(action.targetCellId)!;
        if (to.laneIndex !== from.laneIndex) laneChanges += 1;
        lane[to.laneIndex] = (lane[to.laneIndex] ?? 0) + 1;
      }
      slingshots += state.cars.reduce((sum, c) => sum + (c.slingshots ?? 0), 0);
    }
  }
  const pct = (n: number) => (100 * n) / Math.max(1, moves);
  const mainLaneMoves = lane[1]! + lane[2]! + lane[3]!;
  return {
    'turns per race': turns / races,
    'moves in a tow %': pct(inTow),
    'moves ending tucked in %': pct(tucked),
    'slingshots per race': slingshots / races,
    'squeezes (total)': squeezes,
    'lane changes %': pct(laneChanges),
    '2+ lane changes in a move': multi,
    'landed on lane 1 %': (100 * lane[1]!) / Math.max(1, mainLaneMoves),
    'landed on lane 2 %': (100 * lane[2]!) / Math.max(1, mainLaneMoves),
    'landed on lane 3 %': (100 * lane[3]!) / Math.max(1, mainLaneMoves)
  };
}

function bench(version: RulesVersion): Row {
  const lineup: BenchPolicy[] = ['hard', 'normal', 'easy', 'autopilot'];
  const r = runBench(ctx, { lineup, laps: [5, 8, 12], seeds: [1, 2, 3, 4], rulesVersion: version });
  const row: Row = { 'bench races': r.races, 'overtakes per race': r.overtakesPerRace };
  for (const p of lineup) row[`avg finish ${p}`] = r.stats.get(p)!.avgFinish;
  for (const p of lineup) row[`turns to finish ${p}`] = r.stats.get(p)!.avgMoves;
  return row;
}

const results = new Map<RulesVersion, Row>();
for (const v of versions as RulesVersion[]) {
  console.error(`${v} (${RULES[v].status})...`);
  results.set(v, { ...bench(v), ...reach(v) });
}
const labels = [...results.values()][0]!;
const width = Math.max(...Object.keys(labels).map((l) => l.length));
console.log(`${''.padEnd(width)}  ${versions.map((v) => `${v}`.padStart(9)).join(' ')}`);
for (const label of Object.keys(labels)) {
  const cells = versions.map((v) =>
    (results.get(v as RulesVersion)![label] ?? NaN)
      .toFixed(Number.isInteger(labels[label]) ? 0 : 2)
      .padStart(9)
  );
  console.log(`${label.padEnd(width)}  ${cells.join(' ')}`);
}
