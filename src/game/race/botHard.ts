// Hard bot: one round of lookahead with an opponent model (and the `adaptive` style, see botStyle.ts).
// For the best few candidates (by the Normal score) it plays the move on a copy of the race, lets
// every other car answer with the Normal policy until it is this car's turn again, and scores the
// position it finds itself in. No runtime import of raceEngine (it passes its functions in), so
// the two modules do not form an import cycle.
import { PIT_LANE } from "../constants";
import {
  buildPlanContext,
  crawlCost,
  forwardGain,
  IDEAL_PIT_SETUP,
  PIT_LANE_CELLS,
  progressOf,
  type BotPlanContext
} from "../systems/botPlan";
import type { BotDecisionTrace } from "../systems/botSystem";
import type { TargetInfo } from "../systems/movementSystem";
import { getCurrentCarId } from "../systems/turnSystem";
import type { Car } from "../types/car";
import type {
  ApplyResult,
  BotTurnDecision,
  RaceAction,
  RaceContext,
  RaceState
} from "./raceEngine";

export const HARD_CANDIDATES = 8;

// Value weights of a simulated position, in cells of progress.
const VALUE = {
  win: 1e6,
  // how much each cell of a rival's progress counts against us (blocking shows up here)
  rival: 0.1,
  // weight of the Normal score's non-progress part (its points are a tenth of a cell)
  normalExtra: 0.1
} as const;

export interface HardDeps {
  applyAction(ctx: RaceContext, state: RaceState, action: RaceAction): ApplyResult;
  computeTargets(ctx: RaceContext, state: RaceState, car: Car): Map<string, TargetInfo>;
  // The Normal policy for whoever is active in `state`.
  decideNormal(ctx: RaceContext, state: RaceState): BotTurnDecision;
}

function actionFor(car: Car, cellId: string, info: TargetInfo): RaceAction {
  // Same test as the bot system: a PIT_BOX target on an unserviced car is a stop.
  return info.isPitTrigger && !car.pitServiced
    ? { type: "pit", targetCellId: cellId, setup: structuredClone(IDEAL_PIT_SETUP) }
    : { type: "move", targetCellId: cellId };
}

function carById(state: RaceState, carId: number): Car {
  return state.cars.find((c) => c.carId === carId)!;
}

function valueOf(
  ctx: RaceContext,
  sim: RaceState,
  meId: number,
  plan: BotPlanContext
): number {
  const me = carById(sim, meId);
  const myCell = ctx.cellMap.get(me.cellId)!;
  const mine = progressOf(me, myCell, plan);
  if (sim.winnerCarId === meId) return VALUE.win + mine;
  if (sim.winnerCarId !== null) return -VALUE.win + mine;

  let rivalSum = 0;
  let rivals = 0;
  for (const car of sim.cars) {
    if (car.carId === meId) continue;
    rivalSum += progressOf(car, ctx.cellMap.get(car.cellId)!, plan);
    rivals += 1;
  }
  const rivalTerm = rivals > 0 ? (rivalSum / rivals) * VALUE.rival : 0;
  let crawl = crawlCost(me, myCell, plan);
  if (myCell.laneIndex === PIT_LANE && !me.pitServiced) {
    // A stop under way: count the fresh tires and tank it is about to get, less the pit moves left.
    const fresh = { ...me, tire: 100, fuel: 100, setup: IDEAL_PIT_SETUP };
    crawl = Math.min(crawl, crawlCost(fresh, myCell, plan) + PIT_LANE_CELLS);
  }
  return mine - rivalTerm - crawl;
}

function simulateRound(
  ctx: RaceContext,
  state: RaceState,
  meId: number,
  action: RaceAction,
  deps: HardDeps
): RaceState | null {
  const sim = structuredClone(state);
  if (!deps.applyAction(ctx, sim, action).ok) return null;
  let guard = sim.cars.length * 2;
  while (sim.winnerCarId === null && getCurrentCarId(sim.turn) !== meId && guard > 0) {
    guard -= 1;
    const reply = deps.decideNormal(ctx, sim);
    if (!deps.applyAction(ctx, sim, reply.action).ok) break;
  }
  return sim;
}

export function decideHardBotAction(
  ctx: RaceContext,
  state: RaceState,
  car: Car,
  normal: BotTurnDecision,
  deps: HardDeps
): BotTurnDecision {
  const trace = normal.trace;
  if (!trace || trace.candidates.length <= 1 || normal.action.type === "skip") return normal;

  const plan = buildPlanContext(ctx.trackIndex, state.raceLaps);
  const fromCell = ctx.cellMap.get(car.cellId);
  const top = [...trace.candidates]
    .sort((a, b) => b.score - a.score || a.cellId.localeCompare(b.cellId))
    .slice(0, HARD_CANDIDATES);

  const evaluated: BotDecisionTrace["candidates"] = [];
  let best: { cellId: string; value: number } | null = null;
  for (const candidate of top) {
    const sim = simulateRound(ctx, state, car.carId, actionFor(car, candidate.cellId, candidate.info), deps);
    if (!sim) continue;
    // What the Normal score knows beyond progress (budget cycle, resource worth, pit plan) is
    // kept, scaled to cells; the simulation adds what only the next round can show.
    const extra = candidate.score - forwardGain(fromCell, ctx.cellMap.get(candidate.cellId), candidate.info.distance, plan) * 10;
    const value = valueOf(ctx, sim, car.carId, plan) + VALUE.normalExtra * extra;
    evaluated.push({ cellId: candidate.cellId, info: candidate.info, score: value });
    if (!best || value > best.value) best = { cellId: candidate.cellId, value };
  }
  if (!best) return normal;

  const info = trace.candidates.find((c) => c.cellId === best.cellId)!.info;
  return {
    action: actionFor(car, best.cellId, info),
    trace: { ...trace, candidates: evaluated, selectedCellId: best.cellId },
    targets: normal.targets
  };
}
