// Headless, deterministic bot races used by tools/bot_bench.ts and the bot tests.
// One policy per grid slot; rotating the line-up gives every policy every grid slot (and every
// starting tire), so pole position and the default setups are not a bias. Each race has a seed
// (it decides the bots' personalities); results can be cut by policy, personality or grid slot.
import { must } from '../must';
import { SETUP_CHOICES } from '../systems/bot_plan';
import { trackFwd } from '../systems/track_index';
import type { CarSetup } from '../types/car';
import { getRemainingBudget } from '../systems/move_budget_system';
import { rulesOf, type RulesVersion } from '../rules/versions';
import type { BotPolicy } from '../systems/bot_system';
import {
  gridSlots,
  personalityFor,
  personalityOf,
  type PersonalityKey
} from '../systems/bot_style';
import {
  applyAction,
  computeTargets,
  createRace,
  decideBotAction,
  getActiveCar,
  type RaceAction,
  type RaceContext,
  type RaceState
} from './race_engine';

// Scripted drivers standing in for a human who found a fixed strategy: always the inner lane,
// and either the even spend 9-8-8-8-7 or the biggest move it can make ("greedy").
type ScriptedPolicy = 'scripted' | 'greedy';
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
  // Turns the car played to cover the distance (the pit stop and the skips included), less the part of the last
  // turn it did not need: it crossed the line `overshoot` cells in, of a move of `moveSpend`. A fraction, so that
  // a 2.5% pace difference shows in a race of 11 turns.
  moves: number;
}

interface BenchRaceResult {
  finishers: BenchFinisher[];
  // Times a car got ahead of another in the standings during the race (position swaps, not passes by lap count).
  overtakes: number;
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
    policy === 'greedy'
      ? 99
      : Math.min(
          SCRIPT[car.moveCycle.index] ?? 7,
          getRemainingBudget(car.moveCycle, rulesOf(state).resources.cycleBudget(car.setup))
        );
  let best: { id: string; score: number } | null = null;
  for (const [id, info] of computeTargets(ctx, state, car)) {
    if (info.isPitTrigger) continue;
    const spend = info.moveSpend ?? info.distance;
    // inwards is better: 50 for lane 1, 25 for lane 2 (so it works its way in from the outer lane)
    const inner = Math.max(0, 4 - must(ctx.cellMap.get(id), 'target cell').laneIndex) * 25 - 25;
    const score =
      (policy === 'greedy' ? spend * 10 : -Math.abs(Math.min(want, 9) - spend) * 10) +
      inner +
      info.distance * 0.1;
    if (!best || score > best.score) best = { id, score };
  }
  if (best) return { type: 'move', targetCellId: best.id };
  // Only pit boxes reachable (it never plans a stop, but a skip would be rejected): take the box.
  const [id] = computeTargets(ctx, state, car).keys();
  return id
    ? {
        type: 'pit',
        targetCellId: id,
        setup: structuredClone(must(SETUP_CHOICES[0], 'setup choice'))
      }
    : { type: 'skip' };
}

// Plays until every car has covered the distance; the order cars cross the line is the finishing
// order (not a snapshot of the field when the winner finishes). A finished car leaves the track.
// `styles` forces a personality per slot (the seed decides otherwise).
export function playBenchRace(
  ctx: RaceContext,
  policies: BenchPolicy[],
  laps: number,
  seed = 0,
  styles?: Array<PersonalityKey | undefined>,
  // Forces a car's setup after the grid setup the bots made (by slot), to sweep compounds and wings.
  setups?: Array<CarSetup | undefined>,
  // The movement rules the race is played on (src/game/rules/versions.ts); the default when omitted.
  rulesVersion?: RulesVersion
): BenchRaceResult {
  const isScripted = (p: BenchPolicy) => p === 'scripted' || p === 'greedy';
  const state = createRace(
    ctx,
    policies.map((policy, i) => ({
      isBot: !isScripted(policy),
      ownerId: `BOT${i + 1}`,
      style: styles?.[i]
    })),
    laps,
    seed,
    rulesVersion
  );
  setups?.forEach((setup, slot) => {
    if (setup) must(state.cars[slot], 'car in the slot').setup = structuredClone(setup);
  });
  const turnsPlayed = new Map<number, number>();
  const decisionMs: BenchRaceResult['decisionMs'] = {};
  const finishers: BenchFinisher[] = [];
  let overtakes = 0;
  const spineLen = ctx.trackIndex.spineLen;
  // Cars ahead first, by laps done then place along the lap (pit cells ranked by the lane-1 cell beside them).
  const standings = () =>
    state.cars
      .map((c) => ({
        id: c.carId,
        progress:
          (c.lapCount ?? 0) * spineLen +
          trackFwd(must(ctx.cellMap.get(c.cellId), 'cell of a car'), ctx.trackIndex.lane1FwdByZone)
      }))
      .sort((a, b) => b.progress - a.progress || a.id - b.id)
      .map((c) => c.id);
  let before = standings();
  const maxTurns = laps * 400 * policies.length;
  for (let turn = 0; turn < maxTurns && state.cars.length > 0; turn += 1) {
    const car = getActiveCar(state);
    const policy = must(policies[car.carId - 1], 'policy of the active car');
    const t0 = performance.now();
    const action = isScripted(policy)
      ? scriptedAction(ctx, state, policy as ScriptedPolicy)
      : decideBotAction(ctx, state, policy as BotPolicy).action;
    const stat = (decisionMs[policy] ??= { totalMs: 0, count: 0 });
    stat.totalMs += performance.now() - t0;
    stat.count += 1;
    turnsPlayed.set(car.carId, (turnsPlayed.get(car.carId) ?? 0) + 1);
    const applied = applyAction(ctx, state, action);
    if (applied.ok) {
      // Pairs whose order flipped since the last turn: the mover got ahead of each car it passed.
      const after = standings();
      const rank = new Map(after.map((id, i) => [id, i]));
      for (let i = 0; i < before.length; i += 1) {
        for (let j = i + 1; j < before.length; j += 1) {
          const a = rank.get(must(before[i], 'car id'));
          const b = rank.get(must(before[j], 'car id'));
          if (a !== undefined && b !== undefined && a > b) overtakes += 1;
        }
      }
      before = after;
    }
    if (!applied.ok) {
      throw new Error(
        `bench: ${policy} action rejected (${applied.reason} ${JSON.stringify(action)})`
      );
    }
    if (state.winnerCarId !== null) {
      const finished = state.winnerCarId;
      const p = must(policies[finished - 1], 'policy of the winner');
      const forced = styles?.[finished - 1];
      finishers.push({
        policy: p,
        slot: finished - 1,
        grid: must(gridSlots(seed, policies.length)[finished - 1], 'grid slot of the winner'),
        style:
          isScripted(p) || p === 'autopilot'
            ? null
            : p === 'hard'
              ? 'adaptive'
              : (forced ? personalityFor(forced, seed, finished) : personalityOf(seed, finished))
                  .key,
        place: finishers.length + 1,
        moves:
          (turnsPlayed.get(finished) ?? 0) - overshootOf(ctx, state, finished, applied.moveSpend)
      });
      // Drop the finisher; the next car in the turn order is the one that was about to play.
      const at = state.turn.order.indexOf(finished);
      state.turn.order.splice(at, 1);
      state.turn.index = state.turn.order.length > 0 ? at % state.turn.order.length : 0;
      state.cars = state.cars.filter((c) => c.carId !== finished);
      state.winnerCarId = null;
    }
  }
  if (finishers.length !== policies.length) throw new Error('bench: race did not finish');
  return { finishers, order: finishers.map((f) => f.policy), decisionMs, overtakes };
}

function overshootOf(ctx: RaceContext, state: RaceState, carId: number, moveSpend: number): number {
  const car = must(
    state.cars.find((c) => c.carId === carId),
    'car'
  );
  const cell = must(ctx.cellMap.get(car.cellId), 'cell of the car');
  // Cells past the line when the last turn ended; a rear-row start (negative) or a pit-lane cell reads 0.
  const past = Math.max(0, trackFwd(cell, ctx.trackIndex.lane1FwdByZone));
  return moveSpend > 0 ? Math.min(1, past / moveSpend) : 0;
}

interface BenchOptions {
  lineup: BenchPolicy[];
  laps: number[];
  // One race per lap count x rotation x seed; default [0] (every bot "balanced").
  seeds?: number[];
  // Forced personality per line-up entry (rotates with it), instead of the seed's.
  styles?: Array<PersonalityKey | undefined>;
  // The movement rules to play on; the default when omitted.
  rulesVersion?: RulesVersion;
}

// Groups finishers by any key into win rate / average finish.
export function statsBy(
  results: BenchRaceResult[],
  key: (f: BenchFinisher) => string | null
): Map<string, Stat> {
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
  return new Map(
    [...sums].map(([k, s]) => [
      k,
      { races: s.races, wins: s.wins, winRate: s.wins / s.races, avgFinish: s.finishSum / s.races }
    ])
  );
}

// Every rotation of the line-up on every lap count and seed.
export function runBench(
  ctx: RaceContext,
  { lineup, laps, seeds = [0], styles, rulesVersion }: BenchOptions
) {
  const results: BenchRaceResult[] = [];
  for (const lapCount of laps) {
    for (const seed of seeds) {
      for (let rotation = 0; rotation < lineup.length; rotation += 1) {
        const at = (slot: number) => (slot + rotation) % lineup.length;
        results.push(
          playBenchRace(
            ctx,
            lineup.map((_policy, slot) => must(lineup[at(slot)], 'policy in the line-up')),
            lapCount,
            seed,
            styles && lineup.map((_policy, slot) => styles[at(slot)]),
            undefined,
            rulesVersion
          )
        );
      }
    }
  }
  const timing = new Map<BenchPolicy, { totalMs: number; count: number }>();
  for (const r of results) {
    for (const [policy, d] of Object.entries(r.decisionMs) as Array<
      [BenchPolicy, { totalMs: number; count: number }]
    >) {
      const t = timing.get(policy) ?? { totalMs: 0, count: 0 };
      t.totalMs += d.totalMs;
      t.count += d.count;
      timing.set(policy, t);
    }
  }
  const overtakesPerRace =
    results.reduce((sum, r) => sum + r.overtakes, 0) / Math.max(1, results.length);
  const stats = new Map<BenchPolicy, PolicyStats>();
  for (const [policy, s] of statsBy(results, (f) => f.policy)) {
    const t = must(timing.get(policy as BenchPolicy), 'timing of a policy');
    stats.set(policy as BenchPolicy, {
      ...s,
      avgMoves: t.count / s.races,
      decisions: t.count,
      meanDecisionMs: t.count > 0 ? t.totalMs / t.count : 0
    });
  }
  return { races: results.length, stats, results, overtakesPerRace };
}

// Setup sweep: how many turns car 1 needs to finish on each compound and wing, at each race length, with three
// Normal bots (on the grid setup they pick) around it. Fewer is faster. The balance gate of the wing (issue #48):
// every wing level is the fastest at some length, and no one setup is the fastest at every length.
export interface SetupSweepRow {
  laps: number;
  // Mean turns to finish, one entry per SETUP_CHOICES, in that order.
  moves: number[];
  // Index into SETUP_CHOICES of the fastest (the first one on a tie).
  best: number;
}

export function setupSweep(
  ctx: RaceContext,
  { laps, seeds = [1] }: { laps: number[]; seeds?: number[] }
): SetupSweepRow[] {
  return laps.map((lapCount) => {
    const moves = SETUP_CHOICES.map((choice) => {
      let total = 0;
      for (const seed of seeds) {
        const result = playBenchRace(
          ctx,
          ['normal', 'normal', 'normal', 'normal'],
          lapCount,
          seed,
          undefined,
          [choice]
        );
        total += must(
          result.finishers.find((f) => f.slot === 0),
          'finisher in slot 0'
        ).moves;
      }
      return total / seeds.length;
    });
    let best = 0;
    moves.forEach((m, i) => {
      if (m < must(moves[best], 'moves of the best setup') - 1e-9) best = i;
    });
    return { laps: lapCount, moves, best };
  });
}

// The gate on a sweep: which wing levels win somewhere, and whether one setup wins everywhere.
export function setupSweepGate(rows: SetupSweepRow[]) {
  const winners = new Set(rows.map((r) => r.best));
  const choiceOf = (i: number) => must(SETUP_CHOICES[i], 'setup choice');
  const wings = new Set([...winners].map((i) => choiceOf(i).wing));
  return {
    everyWingWinsSomewhere: wings.size === 3,
    noSetupDominates: winners.size > 1,
    winners: [...winners].map((i) => `${choiceOf(i).compound}/${choiceOf(i).wing}`)
  };
}
