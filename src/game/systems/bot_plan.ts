// Race-level planning shared by the Normal and Hard bots: wear projection and pit-stop timing.
import { FUEL_LOAD_MIN, FUEL_LOAD_STEP, MOVE_CYCLE, PIT_LANE } from '../constants';
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
// v3 adds the medium compound and the fuel load: every grid load, the lightest first (a tie in moves goes to the
// lighter car: fuel above 70 costs a point of pace, and a tank nobody empties is only weight).
const FUEL_LOADS = Array.from(
  { length: (100 - FUEL_LOAD_MIN) / FUEL_LOAD_STEP + 1 },
  (_item, i) => FUEL_LOAD_MIN + i * FUEL_LOAD_STEP
);
export const SETUP_CHOICES_V3: readonly CarSetup[] = (['medium', 'hard', 'soft'] as const).flatMap(
  (compound) =>
    (['medium', 'low', 'high'] as const).flatMap((wing) =>
      FUEL_LOADS.map((fuelLoad) => ({ compound, psi: { ...NEUTRAL_PSI }, wing, fuelLoad }))
    )
);

// v3's resource model: wear by move size and a fuel load. The bots' pace plan only exists there; v1 and v2 keep the
// closed-form projection they were tuned on.
function sized(resources: ResourceRules): boolean {
  return resources.features.fuelLoad;
}

/** The setups a bot picks from on this version's rules. */
export function setupChoicesOf(resources: ResourceRules): readonly CarSetup[] {
  return sized(resources) ? SETUP_CHOICES_V3 : SETUP_CHOICES;
}

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

type Wearing = Pick<Car, 'tire' | 'fuel' | 'setup'>;

/** The move sizes a cycle of `budget` points is spent in, the larger ones first: 36 is 8,7,7,7,7 and 42 is 9,9,8,8,8. */
export function cycleSizes(budget: number): number[] {
  const base = Math.floor(budget / MOVE_CYCLE.moves);
  const larger = budget - base * MOVE_CYCLE.moves;
  return Array.from({ length: MOVE_CYCLE.moves }, (_item, i) => base + (i < larger ? 1 : 0));
}

// Per-cell wear averaged over the moves of a cycle at this car's budget: the pace it mostly runs at. The same as
// wearPerCell where the size of a move changes nothing (v1 and v2).
export function expectedWearPerCell(
  car: Wearing,
  resources: ResourceRules
): { tire: number; fuel: number } {
  const base = wearPerCell(car.setup, resources);
  const sizes = cycleSizes(resources.cycleBudget(car));
  const mean = (kind: 'tire' | 'fuel') =>
    sizes.reduce((sum, size) => sum + resources.sizeFactor(size)[kind], 0) / sizes.length;
  return { tire: base.tire * mean('tire'), fuel: base.fuel * mean('fuel') };
}

// Cells of racing left before tire or fuel hits 0; `safety` shaves the projection for planning.
export function cellsUntilEmpty(
  tire: number,
  fuel: number,
  setup: CarSetup,
  resources: ResourceRules,
  safety = SAFETY
): number {
  const wear = expectedWearPerCell({ tire, fuel, setup }, resources);
  return Math.min(tire / wear.tire, fuel / wear.fuel) * safety;
}

// Wear of the lane factors and the 8 -> 7 steps of a lap is not modelled; the pace plan keeps this much in hand.
const PACE_MARGIN = 1.02;
// Nothing below a 7 wears less per cell, so a car that cannot finish at 7 cannot finish by slowing down more.
const SLOWEST_SIZE = 7;

/**
 * The largest move size at which the car still reaches the flag (`cells` away) on the tire and fuel it has, or null
 * when even the conservative 7 falls short and the car has to stop. `reserve` is the share of the distance the driver
 * keeps in hand (negative: it counts on running low).
 */
export function sustainableSize(
  car: Wearing,
  cells: number,
  resources: ResourceRules,
  reserve = 0
): number | null {
  const base = wearPerCell(car.setup, resources);
  const need = cells * PACE_MARGIN * (1 + reserve);
  for (let size = resources.moveCap(car); size >= SLOWEST_SIZE; size -= 1) {
    const factor = resources.sizeFactor(size);
    if (need * base.tire * factor.tire <= car.tire && need * base.fuel * factor.fuel <= car.fuel) {
      return size;
    }
  }
  return null;
}

// What a stop costs a car in turns, measured on the setup sweep (`npx tsx tools/bot_bench.ts --setups`): the lost
// turn, the single-step pit lane and the laps' worth of rhythm. PIT_LANE_CELLS (about 5 turns of racing) is what
// the stop timing is weighed with; this is what a whole race on a setup is projected with.
const PIT_STOP_MOVES = 8;

// v3: the moves a car takes to cover `cells` by playing the pace plan, cycle by cycle. Each move is the largest size
// the cycle budget, the cap and sustainableSize allow; a car that cannot reach the flag runs flat out and stops once
// its next move would empty it (PIT_STOP_MOVES, then the tires are fresh and the tank is topped up to the load).
function playedMoves(
  setup: CarSetup,
  cells: number,
  resources: ResourceRules,
  carFuel: number
): number {
  const car = servicedCar({ tire: 0, fuel: carFuel, setup }, setup, resources);
  const base = wearPerCell(setup, resources);
  let left = cells;
  let moves = 0;
  let spent = 0;
  let inCycle = 0;
  while (left > 0 && moves < 2000) {
    const budgetLeft = Math.max(0, resources.cycleBudget(car) - spent);
    const cap = resources.moveCap(car);
    const sustain = sustainableSize(car, left, resources);
    const size = Math.max(1, Math.min(cap, budgetLeft, sustain ?? cap));
    const stopDue =
      sustain === null &&
      left > STOP_MIN_CELLS &&
      cellsUntilEmpty(car.tire, car.fuel, setup, resources, 1) < size;
    if (stopDue) {
      Object.assign(car, servicedCar(car, setup, resources));
      moves += PIT_STOP_MOVES;
      spent = 0;
      inCycle = 0;
      continue;
    }
    const walked = Math.min(size, left);
    const factor = resources.sizeFactor(size);
    car.tire = Math.max(0, car.tire - walked * base.tire * factor.tire);
    car.fuel = Math.max(0, car.fuel - walked * base.fuel * factor.fuel);
    left -= walked;
    moves += 1;
    spent += size;
    inCycle += 1;
    if (inCycle === MOVE_CYCLE.moves) {
      inCycle = 0;
      spent = 0;
    }
  }
  return moves;
}

// Too close to the flag for a stop to pay: the bots' pit lane costs more than a few cells of crawling.
const STOP_MIN_CELLS = 14;

// Moves a fresh car on `setup` needs to cover `cells`: it either crawls the part past its tires and tank at the
// empty-resource speed, or stops (as often as it takes) and loses PIT_STOP_MOVES per stop.
export function projectedMoves(
  setup: CarSetup,
  cells: number,
  resources: ResourceRules,
  carFuel = 0
): number {
  if (sized(resources)) return playedMoves(setup, cells, resources, carFuel);
  const pace = Math.min(
    resources.cycleBudget({ tire: 100, fuel: 100, setup }) / MOVE_CYCLE.moves,
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
// The search plays a race per choice (117 in v3) and the Hard bot asks it for every rival of every candidate: answers
// are kept per rules object (one per race length) and per whole cell and whole fuel.
const bestSetups = new WeakMap<ResourceRules, Map<string, CarSetup>>();

// `carFuel` is what the tank holds when the setup is fitted (a stop only tops up to the fuel load, never empties).
export function bestSetup(cells: number, resources: ResourceRules, carFuel = 0): CarSetup {
  let known = bestSetups.get(resources);
  if (!known) bestSetups.set(resources, (known = new Map()));
  const key = `${Math.round(cells)}|${Math.round(carFuel)}`;
  const kept = known.get(key);
  if (kept) return structuredClone(kept);
  const found = searchBestSetup(Math.round(cells), resources, Math.round(carFuel));
  known.set(key, found);
  return structuredClone(found);
}

function searchBestSetup(cells: number, resources: ResourceRules, carFuel: number): CarSetup {
  const choices = setupChoicesOf(resources);
  let best = must(choices[0], 'setup choice');
  let bestMoves = projectedMoves(best, cells, resources, carFuel);
  for (const choice of choices.slice(1)) {
    const moves = projectedMoves(choice, cells, resources, carFuel);
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
    plan.resources,
    car.fuel
  );
}

/** What the car holds after a stop that fits `setup`: fresh tires and the tank topped up to the fuel load. */
export function servicedCar(car: Wearing, setup: CarSetup, resources: ResourceRules): Wearing {
  const serviced = { tire: car.tire, fuel: car.fuel, setup: car.setup };
  resources.pitService(serviced, structuredClone(setup));
  return serviced;
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
  const stopSetup = bestSetup(remaining - toFeeder, plan.resources, car.fuel);
  const serviced = servicedCar(car, stopSetup, plan.resources);
  const fresh = cellsUntilEmpty(serviced.tire, serviced.fuel, stopSetup, plan.resources);
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
  const wear = expectedWearPerCell(car, plan.resources);
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  const worth = (units: number, perCell: number) =>
    (units / perCell) * SAFETY < remaining ? Math.max(1, (10 * EMPTY_SLOWDOWN) / perCell) : 1;
  return { tire: worth(car.tire, wear.tire), fuel: worth(car.fuel, wear.fuel) };
}

/**
 * The largest move size this car should play now (v3): the one it can keep up to the flag. A car that cannot finish
 * even at 7 and can still stop runs flat out to the stop; one that cannot stop saves what it has. Where the size of
 * a move changes nothing (v1 and v2) it is the car's cap, so nothing is penalised.
 */
export function sustainablePace(car: Car, cell: TrackCell, plan: BotPlanContext): number {
  const { resources } = plan;
  const cap = resources.moveCap(car);
  if (!sized(resources)) return cap;
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  if (remaining <= 0) return cap;
  const size = sustainableSize(car, remaining, resources, plan.style?.paceReserve ?? 0);
  if (size !== null) return size;
  const canStop = !car.pitServiced && !isFinalLap(car, plan) && plan.feederFwd !== null;
  return canStop ? cap : Math.min(cap, SLOWEST_SIZE);
}
