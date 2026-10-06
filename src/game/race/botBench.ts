// Headless, deterministic bot races used by tools/botBench.ts and botLevels.test.ts.
// One policy per grid slot; rotating the line-up gives every policy every grid slot (and every
// starting tire), so pole position and the default setups are not a bias.
import type { BotPolicy } from "../systems/botSystem";
import { applyAction, createRace, decideBotAction, getActiveCar, type RaceContext } from "./raceEngine";

export interface BenchRaceResult {
  // Policy of each finisher, best first (index 0 won).
  order: BotPolicy[];
  decisionMs: Partial<Record<BotPolicy, { totalMs: number; count: number }>>;
}

export interface PolicyStats {
  races: number;
  wins: number;
  winRate: number;
  avgFinish: number;
  // Mean turns a car of this policy needed to cover the race distance (lower is faster).
  avgMoves: number;
  decisions: number;
  meanDecisionMs: number;
}

// Plays until every car has covered the distance; the order cars cross the line is the finishing
// order (not a snapshot of the field when the winner finishes). A finished car leaves the track.
export function playBenchRace(ctx: RaceContext, policies: BotPolicy[], laps: number): BenchRaceResult {
  const state = createRace(
    ctx,
    policies.map((_, i) => ({ isBot: true, ownerId: `BOT${i + 1}` })),
    laps
  );
  const decisionMs: BenchRaceResult["decisionMs"] = {};
  const order: BotPolicy[] = [];
  const maxTurns = laps * 400 * policies.length;
  for (let turn = 0; turn < maxTurns && state.cars.length > 0; turn += 1) {
    const car = getActiveCar(state);
    const policy = policies[car.carId - 1]!;
    const t0 = performance.now();
    const decision = decideBotAction(ctx, state, policy);
    const stat = (decisionMs[policy] ??= { totalMs: 0, count: 0 });
    stat.totalMs += performance.now() - t0;
    stat.count += 1;
    if (!applyAction(ctx, state, decision.action).ok) throw new Error(`bench: ${policy} action rejected`);
    if (state.winnerCarId !== null) {
      const finished = state.winnerCarId;
      order.push(policies[finished - 1]!);
      // Drop the finisher; the next car in the turn order is the one that was about to play.
      const at = state.turn.order.indexOf(finished);
      state.turn.order.splice(at, 1);
      state.turn.index = state.turn.order.length > 0 ? at % state.turn.order.length : 0;
      state.cars = state.cars.filter((c) => c.carId !== finished);
      state.winnerCarId = null;
    }
  }
  if (order.length !== policies.length) throw new Error("bench: race did not finish");
  return { order, decisionMs };
}

export interface BenchOptions {
  lineup: BotPolicy[];
  laps: number[];
}

// Every rotation of the line-up on every lap count.
export function runBench(ctx: RaceContext, { lineup, laps }: BenchOptions) {
  const stats = new Map<BotPolicy, PolicyStats & { finishSum: number; ms: number }>();
  let races = 0;
  for (const lapCount of laps) {
    for (let rotation = 0; rotation < lineup.length; rotation += 1) {
      const policies = lineup.map((_, slot) => lineup[(slot + rotation) % lineup.length]!);
      const result = playBenchRace(ctx, policies, lapCount);
      races += 1;
      result.order.forEach((policy, place) => {
        const s = stats.get(policy) ?? {
          races: 0, wins: 0, winRate: 0, avgFinish: 0, avgMoves: 0, decisions: 0, meanDecisionMs: 0, finishSum: 0, ms: 0
        };
        s.races += 1;
        s.finishSum += place + 1;
        if (place === 0) s.wins += 1;
        stats.set(policy, s);
      });
      for (const [policy, d] of Object.entries(result.decisionMs) as Array<[BotPolicy, { totalMs: number; count: number }]>) {
        const s = stats.get(policy)!;
        s.ms += d.totalMs;
        s.decisions += d.count;
      }
    }
  }
  const out = new Map<BotPolicy, PolicyStats>();
  for (const [policy, s] of stats) {
    out.set(policy, {
      races: s.races,
      wins: s.wins,
      winRate: s.wins / s.races,
      avgFinish: s.finishSum / s.races,
      avgMoves: s.decisions / s.races,
      decisions: s.decisions,
      meanDecisionMs: s.decisions > 0 ? s.ms / s.decisions : 0
    });
  }
  return { races, stats: out };
}
