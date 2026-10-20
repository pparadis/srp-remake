// Race-level planning shared by the Normal and Hard bots: wear projection and pit-stop timing.
import { MOVE_CYCLE, PIT_LANE } from '../constants';
import { must } from '../must';
import type { ResourceRules } from '../rules/resource_rules';
import type { Car, CarSetup } from '../types/car';
import type { TrackCell } from '../types/track';
import { setupFactors } from './movement_system';
import type { Personality } from './bot_style';
import { trackFwd, type TrackIndex } from './track_index';

// 32 psi everywhere costs nothing extra; compound and wing are the real choice (see bestSetup).
const NEUTRAL_PSI = { fl: 32, fr: 32, rl: 32, rr: 32 } as const;
// Every compound and wing level a car can run, in the order bestSetup breaks ties (the plain one first).
export const SETUP_CHOICES: readonly CarSetup[] = (['hard', 'soft'] as const).flatMap((compound) =>
  (['medium', 'low', 'high'] as const).map((wing) => ({ compound, psi: { ...NEUTRAL_PSI }, wing }))
);

// A pit stop costs about this many cells of racing: the lost turn plus the slow single-step pit
// lane (entry, box, exit use several moves that each cover 1-5 cells instead of ~8). The lap is
// not lost: the start line crosses the pit lane, so a lap crossed there counts.
export const PIT_LANE_CELLS = 40;
// With an empty tire or tank a car moves 4 instead of ~8 per turn, so every cell it still has to
// cover that way costs a whole cell of lost time.
const EMPTY_SLOWDOWN = 1;
const SAFETY = 0.95;

export interface BotPlanContext {
  raceLaps: number;
  // The race's tire, fuel and move-size rules: the wear math below asks them.
  resources: ResourceRules;
  spineLen: number;
  // Lane-1 forwardIndex per zone: pit cells are ranked by the main-lane cell beside them.
  lane1FwdByZone: Map<number, number>;
  // forwardIndex of the lane-1 cell that leads into PIT_ENTRY (the only place a stop can start).
  feederFwd: number | null;
  // Who is driving and what it sees; absent in the HUD advice and in unit tests (neutral bot).
  style?: Personality;
  // Hard: also reads the field (see HARD_ADAPT).
  adapt?: boolean;
  // Race seed, for Easy's dice.
  seed?: number;
  // The other cars: lane-1 equivalent position and lane (the pit lane for cars in it).
  rivals?: RivalView[];
}

interface RivalView {
  fwd: number;
  lane: number;
}

const feederCache = new WeakMap<TrackIndex, number | null>();

export function buildPlanContext(
  trackIndex: TrackIndex,
  raceLaps: number,
  resources: ResourceRules
): BotPlanContext {
  let feederFwd = feederCache.get(trackIndex);
  if (feederFwd === undefined) {
    feederFwd = null;
    for (const cell of trackIndex.cellMap.values()) {
      if (cell.laneIndex !== 1) continue;
      const leadsToEntry = cell.next.some((id) =>
        (trackIndex.cellMap.get(id)?.tags ?? []).includes('PIT_ENTRY')
      );
      if (leadsToEntry) feederFwd = cell.forwardIndex;
    }
    feederCache.set(trackIndex, feederFwd);
  }
  return {
    raceLaps,
    resources,
    spineLen: trackIndex.spineLen,
    lane1FwdByZone: trackIndex.lane1FwdByZone,
    feederFwd
  };
}

export function wearPerCell(
  setup: CarSetup,
  resources: ResourceRules
): { tire: number; fuel: number } {
  const { aeroTire, aeroFuel, psiFactor } = setupFactors(setup);
  const { tireRate, fuelRate } = resources.wearRates(setup);
  return { tire: tireRate * aeroTire * psiFactor, fuel: fuelRate * aeroFuel };
}

export function progressOf(car: Car, cell: TrackCell, plan: BotPlanContext): number {
  return (car.lapCount ?? 0) * plan.spineLen + trackFwd(cell, plan.lane1FwdByZone);
}

export function isFinalLap(car: Car, plan: BotPlanContext): boolean {
  return (car.lapCount ?? 0) >= plan.raceLaps - 1;
}

// Cells of racing left before tire or fuel hits 0; `safety` shaves the projection for planning.
export function cellsUntilEmpty(
  tire: number,
  fuel: number,
  setup: CarSetup,
  resources: ResourceRules,
  safety = SAFETY
): number {
  const wear = wearPerCell(setup, resources);
  return Math.min(tire / wear.tire, fuel / wear.fuel) * safety;
}

// What a stop costs a car in turns, measured on the setup sweep (`npx tsx tools/bot_bench.ts --setups`): the lost
// turn, the single-step pit lane and the laps' worth of rhythm. PIT_LANE_CELLS (about 5 turns of racing) is what
// the stop timing is weighed with; this is what a whole race on a setup is projected with.
const PIT_STOP_MOVES = 8;

// Moves a fresh car on `setup` needs to cover `cells`: it either crawls the part past its tires and tank at the
// empty-resource speed, or stops (as often as it takes) and loses PIT_STOP_MOVES per stop.
export function projectedMoves(setup: CarSetup, cells: number, resources: ResourceRules): number {
  const pace = Math.min(
    resources.cycleBudget(setup) / MOVE_CYCLE.moves,
    resources.moveCap({ tire: 100, fuel: 100, setup })
  );
  const untilEmpty = cellsUntilEmpty(100, 100, setup, resources);
  const crawl =
    Math.min(cells, untilEmpty) / pace +
    Math.max(0, cells - untilEmpty) / resources.moveCap({ tire: 0, fuel: 0, setup });
  const stops = Math.max(0, Math.ceil(cells / untilEmpty) - 1);
  const stopping = cells / pace + stops * PIT_STOP_MOVES;
  return Math.min(crawl, stopping);
}

// The compound and wing level that finish `cells` of racing soonest from fresh tires and a full tank.
// Short races want soft and Low wing, a stint that just fits wants High wing to skip a stop.
export function bestSetup(cells: number, resources: ResourceRules): CarSetup {
  let best = must(SETUP_CHOICES[0], 'setup choice');
  let bestMoves = projectedMoves(best, cells, resources);
  for (const choice of SETUP_CHOICES.slice(1)) {
    const moves = projectedMoves(choice, cells, resources);
    if (moves < bestMoves - 1e-9) {
      best = choice;
      bestMoves = moves;
    }
  }
  return structuredClone(best);
}

// The setup a stop should service with: the best one for what the car still has to cover from this cell.
export function pitSetupFor(car: Car, cell: TrackCell, plan: BotPlanContext): CarSetup {
  return bestSetup(
    Math.max(0, plan.raceLaps * plan.spineLen - progressOf(car, cell, plan)),
    plan.resources
  );
}

// Cells the car must still cover and, at the current wear, how many of them it will crawl through
// with an empty tire or tank.
export function projectShortfall(car: Car, cell: TrackCell, plan: BotPlanContext) {
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  const untilEmpty = cellsUntilEmpty(car.tire, car.fuel, car.setup, plan.resources);
  return { remaining, untilEmpty, shortfall: Math.max(0, remaining - untilEmpty) };
}

// Cost in full-speed cells of the empty-tire crawl, the Hard bot's resource term.
export function crawlCost(car: Car, cell: TrackCell, plan: BotPlanContext): number {
  return projectShortfall(car, cell, plan).shortfall * EMPTY_SLOWDOWN;
}

// Cells from the car to the pit-entry feeder cell on lane 1, or null when it cannot enter.
export function cellsToFeeder(cell: TrackCell, plan: BotPlanContext): number | null {
  if (plan.feederFwd === null) return null;
  return (plan.feederFwd - cell.forwardIndex + plan.spineLen) % plan.spineLen;
}

// True when this is the last pass at the pit entry that still beats crawling to the flag:
// stopping costs the pit moves (PIT_LANE_CELLS), so only races long enough to need fresh tires pay for it.
export function stopIsDue(car: Car, cell: TrackCell, plan: BotPlanContext): boolean {
  if (isFinalLap(car, plan) || car.pitServiced) return false;
  const toFeeder = cellsToFeeder(cell, plan);
  if (toFeeder === null) return false;
  const { remaining, untilEmpty, shortfall } = projectShortfall(car, cell, plan);
  if (shortfall === 0) return false;
  const fresh = cellsUntilEmpty(
    100,
    100,
    bestSetup(remaining - toFeeder, plan.resources),
    plan.resources
  );
  const afterStop = Math.max(0, remaining - toFeeder - fresh);
  const gain =
    (shortfall - afterStop) * EMPTY_SLOWDOWN - PIT_LANE_CELLS + (plan.style?.pitGain ?? 0);
  if (gain <= 0) return false;
  // Pit as late as possible, but before the next pass would find the car already empty.
  return untilEmpty - toFeeder < plan.spineLen + 10 + (plan.style?.pitWindow ?? 0);
}

// Progress a move makes along the track. Outer lanes have cells that share a forwardIndex, so
// `distance` (cells walked, and what the move budget charges) over-counts progress there.
export function forwardGain(
  from: TrackCell | undefined,
  to: TrackCell | undefined,
  distance: number,
  plan: BotPlanContext | undefined
): number {
  if (!from || !to || !plan || from.laneIndex === PIT_LANE || to.laneIndex === PIT_LANE) {
    return distance;
  }
  return (to.forwardIndex - from.forwardIndex + plan.spineLen) % plan.spineLen;
}

// Points of score one unit of tire or fuel is worth: 1 normally, but a resource that will run out
// before the flag is worth the crawl it saves (half a cell per cell of range, ten points a cell).
export function resourceWeights(
  car: Car,
  cell: TrackCell,
  plan: BotPlanContext
): { tire: number; fuel: number } {
  const wear = wearPerCell(car.setup, plan.resources);
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  const worth = (units: number, perCell: number) =>
    (units / perCell) * SAFETY < remaining ? Math.max(1, (10 * EMPTY_SLOWDOWN) / perCell) : 1;
  return { tire: worth(car.tire, wear.tire), fuel: worth(car.fuel, wear.fuel) };
}
