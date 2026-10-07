// Headless, deterministic bot races used by tools/botBench.ts and the bot tests.
// One policy per grid slot; rotating the line-up gives every policy every grid slot (and every
// starting tire), so pole position and the default setups are not a bias. Each race has a seed
// (it decides the bots' personalities); results can be cut by policy, personality or grid slot.
import { IDEAL_PIT_SETUP } from "../systems/botPlan";
import { getRemainingBudget } from "../systems/moveBudgetSystem";
import type { BotPolicy } from "../systems/botSystem";
import { gridSlots, personalityFor, personalityOf, type PersonalityKey } from "../systems/botStyle";
import {
  applyAction,
  computeTargets,
  createRace,
  decideBotAction,
  getActiveCar,
  type RaceAction,
  type RaceContext,
  type RaceState
} from "./raceEngine";

// Scripted drivers standing in for a human who found a fixed strategy: always the inner lane,
// and either the even spend 9-8-8-8-7 or the biggest move it can make ("greedy").
type ScriptedPolicy = "scripted" | "greedy";
export type BenchPolicy = BotPolicy | ScriptedPolicy;
const SCRIPT = [9, 8, 8, 8, 7];

interface BenchFinisher {
  policy: BenchPolicy;
  // 0-based seat in the line-up (carId - 1).
  slot: number;
  // 0-based starting grid slot the seed gave it (0 = pole).
  grid: number;
  // Personality of a bot (null for the autopilot and the scripted drivers).
  style: PersonalityKey | null;
  // 1-based finishing place.
  place: number;
}

interface BenchRaceResult {
  finishers: BenchFinisher[];
  // Policy of each finisher, best first (index 0 won).
  order: BenchPolicy[];
  decisionMs: Partial<Record<BenchPolicy, { totalMs: number; count: number }>>;
}

interface Stat {
  races: number;
  wins: number;
  winRate: number;
  avgFinish: number;
}

interface PolicyStats extends Stat {
  // Mean turns a car of this policy needed to cover the race distance (lower is faster).
  avgMoves: number;
  decisions: number;
  meanDecisionMs: number;
}

function scriptedAction(ctx: RaceContext, state: RaceState, policy: ScriptedPolicy): RaceAction {
  const car = getActiveCar(state);
  const want =
    policy === "greedy" ? 99 : Math.min(SCRIPT[car.moveCycle.index] ?? 7, getRemainingBudget(car.moveCycle));
  let best: { id: string; score: number } | null = null;
  for (const [id, info] of computeTargets(ctx, state, car)) {
    if (info.isPitTrigger) continue;
    const spend = info.moveSpend ?? info.distance;
    // inwards is better: 50 for lane 1, 25 for lane 2 (so it works its way in from the outer lane)
    const inner = Math.max(0, 4 - ctx.cellMap.get(id)!.laneIndex) * 25 - 25;
    const score = (policy === "greedy" ? spend * 10 : -Math.abs(Math.min(want, 9) - spend) * 10) + inner + info.distance * 0.1;
    if (!best || score > best.score) best = { id, score };
  }
  if (best) return { type: "move", targetCellId: best.id };
  // Only pit boxes reachable (it never plans a stop, but a skip would be rejected): take the box.
  const [id] = computeTargets(ctx, state, car).keys();
  return id ? { type: "pit", targetCellId: id, setup: structuredClone(IDEAL_PIT_SETUP) } : { type: "skip" };
}

// Plays until every car has covered the distance; the order cars cross the line is the finishing
// order (not a snapshot of the field when the winner finishes). A finished car leaves the track.
// `styles` forces a personality per slot (the seed decides otherwise).
export function playBenchRace(
  ctx: RaceContext,
  policies: BenchPolicy[],
  laps: number,
  seed = 0,
  styles?: Array<PersonalityKey | undefined>
): BenchRaceResult {
  const isScripted = (p: BenchPolicy) => p === "scripted" || p === "greedy";
  const state = createRace(
    ctx,
    policies.map((policy, i) => ({
      isBot: !isScripted(policy),
      ownerId: `BOT${i + 1}`,
      style: styles?.[i]
    })),
    laps,
    seed
  );
  const decisionMs: BenchRaceResult["decisionMs"] = {};
  const finishers: BenchFinisher[] = [];
  const maxTurns = laps * 400 * policies.length;
  for (let turn = 0; turn < maxTurns && state.cars.length > 0; turn += 1) {
    const car = getActiveCar(state);
    const policy = policies[car.carId - 1]!;
    const t0 = performance.now();
    const action = isScripted(policy)
      ? scriptedAction(ctx, state, policy as ScriptedPolicy)
      : decideBotAction(ctx, state, policy as BotPolicy).action;
    const stat = (decisionMs[policy] ??= { totalMs: 0, count: 0 });
    stat.totalMs += performance.now() - t0;
    stat.count += 1;
    const applied = applyAction(ctx, state, action);
    if (!applied.ok) throw new Error(`bench: ${policy} action rejected (${applied.reason} ${JSON.stringify(action)})`);
    if (state.winnerCarId !== null) {
      const finished = state.winnerCarId;
      const p = policies[finished - 1]!;
      const forced = styles?.[finished - 1];
      finishers.push({
        policy: p,
        slot: finished - 1,
        grid: gridSlots(seed, policies.length)[finished - 1]!,
        style: isScripted(p) || p === "autopilot" ? null : p === "hard" ? "adaptive" : (forced ? personalityFor(forced, seed, finished) : personalityOf(seed, finished)).key,
        place: finishers.length + 1
      });
      // Drop the finisher; the next car in the turn order is the one that was about to play.
      const at = state.turn.order.indexOf(finished);
      state.turn.order.splice(at, 1);
      state.turn.index = state.turn.order.length > 0 ? at % state.turn.order.length : 0;
      state.cars = state.cars.filter((c) => c.carId !== finished);
      state.winnerCarId = null;
    }
  }
  if (finishers.length !== policies.length) throw new Error("bench: race did not finish");
  return { finishers, order: finishers.map((f) => f.policy), decisionMs };
}

interface BenchOptions {
  lineup: BenchPolicy[];
  laps: number[];
  // One race per lap count x rotation x seed; default [0] (every bot "balanced").
  seeds?: number[];
  // Forced personality per line-up entry (rotates with it), instead of the seed's.
  styles?: Array<PersonalityKey | undefined>;
}

// Groups finishers by any key into win rate / average finish.
export function statsBy(results: BenchRaceResult[], key: (f: BenchFinisher) => string | null): Map<string, Stat> {
  const sums = new Map<string, { races: number; wins: number; finishSum: number }>();
  for (const result of results) {
    for (const f of result.finishers) {
      const k = key(f);
      if (k === null) continue;
      const s = sums.get(k) ?? { races: 0, wins: 0, finishSum: 0 };
      s.races += 1;
      s.finishSum += f.place;
      if (f.place === 1) s.wins += 1;
      sums.set(k, s);
    }
  }
  return new Map([...sums].map(([k, s]) => [k, { races: s.races, wins: s.wins, winRate: s.wins / s.races, avgFinish: s.finishSum / s.races }]));
}

// Every rotation of the line-up on every lap count and seed.
export function runBench(ctx: RaceContext, { lineup, laps, seeds = [0], styles }: BenchOptions) {
  const results: BenchRaceResult[] = [];
  for (const lapCount of laps) {
    for (const seed of seeds) {
      for (let rotation = 0; rotation < lineup.length; rotation += 1) {
        const at = (slot: number) => (slot + rotation) % lineup.length;
        results.push(playBenchRace(ctx, lineup.map((_, slot) => lineup[at(slot)]!), lapCount, seed, styles && lineup.map((_, slot) => styles[at(slot)])));
      }
    }
  }
  const timing = new Map<BenchPolicy, { totalMs: number; count: number }>();
  for (const r of results) {
    for (const [policy, d] of Object.entries(r.decisionMs) as Array<[BenchPolicy, { totalMs: number; count: number }]>) {
      const t = timing.get(policy) ?? { totalMs: 0, count: 0 };
      t.totalMs += d.totalMs;
      t.count += d.count;
      timing.set(policy, t);
    }
  }
  const stats = new Map<BenchPolicy, PolicyStats>();
  for (const [policy, s] of statsBy(results, (f) => f.policy)) {
    const t = timing.get(policy as BenchPolicy)!;
    stats.set(policy as BenchPolicy, {
      ...s,
      avgMoves: t.count / s.races,
      decisions: t.count,
      meanDecisionMs: t.count > 0 ? t.totalMs / t.count : 0
    });
  }
  return { races: results.length, stats, results };
}
