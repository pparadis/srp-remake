// Race-level planning shared by the Normal and Hard bots: wear projection and pit-stop timing.
import { MOVE_RATES, PIT_LANE } from "../constants";
import type { Car, CarSetup } from "../types/car";
import type { TrackCell } from "../types/track";
import { setupFactors } from "./movementSystem";
import { trackFwd, type TrackIndex } from "./trackIndex";

// Wings 0 and 32 psi everywhere cost nothing extra, and in the current cost model the hard
// compound wears less than the soft one, so this is the best setup for every race length.
export const IDEAL_PIT_SETUP: CarSetup = {
  compound: "hard",
  psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
  wingFrontDeg: 0,
  wingRearDeg: 0
};

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
  spineLen: number;
  // Lane-1 forwardIndex per zone: pit cells are ranked by the main-lane cell beside them.
  lane1FwdByZone: Map<number, number>;
  // forwardIndex of the lane-1 cell that leads into PIT_ENTRY (the only place a stop can start).
  feederFwd: number | null;
}

const feederCache = new WeakMap<TrackIndex, number | null>();

export function buildPlanContext(trackIndex: TrackIndex, raceLaps: number): BotPlanContext {
  let feederFwd = feederCache.get(trackIndex);
  if (feederFwd === undefined) {
    feederFwd = null;
    for (const cell of trackIndex.cellMap.values()) {
      if (cell.laneIndex !== 1) continue;
      const leadsToEntry = cell.next.some((id) =>
        (trackIndex.cellMap.get(id)?.tags ?? []).includes("PIT_ENTRY")
      );
      if (leadsToEntry) feederFwd = cell.forwardIndex;
    }
    feederCache.set(trackIndex, feederFwd);
  }
  return { raceLaps, spineLen: trackIndex.spineLen, lane1FwdByZone: trackIndex.lane1FwdByZone, feederFwd };
}

export function wearPerCell(setup: CarSetup): { tire: number; fuel: number } {
  const { aeroFactor, psiFactor } = setupFactors(setup);
  const tireRate = setup.compound === "soft" ? MOVE_RATES.softTire : MOVE_RATES.hardTire;
  return { tire: tireRate * aeroFactor * psiFactor, fuel: MOVE_RATES.fuel * aeroFactor };
}

export function progressOf(car: Car, cell: TrackCell, plan: BotPlanContext): number {
  return (car.lapCount ?? 0) * plan.spineLen + trackFwd(cell, plan.lane1FwdByZone);
}

export function isFinalLap(car: Car, plan: BotPlanContext): boolean {
  return (car.lapCount ?? 0) >= plan.raceLaps - 1;
}

// Cells of racing left before tire or fuel hits 0; `safety` shaves the projection for planning.
export function cellsUntilEmpty(tire: number, fuel: number, setup: CarSetup, safety = SAFETY): number {
  const wear = wearPerCell(setup);
  return Math.min(tire / wear.tire, fuel / wear.fuel) * safety;
}

// Cells the car must still cover and, at the current wear, how many of them it will crawl through
// with an empty tire or tank.
export function projectShortfall(car: Car, cell: TrackCell, plan: BotPlanContext) {
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  const untilEmpty = cellsUntilEmpty(car.tire, car.fuel, car.setup);
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
  const fresh = cellsUntilEmpty(100, 100, IDEAL_PIT_SETUP);
  const afterStop = Math.max(0, remaining - toFeeder - fresh);
  const gain = (shortfall - afterStop) * EMPTY_SLOWDOWN - PIT_LANE_CELLS;
  if (gain <= 0) return false;
  // Pit as late as possible, but before the next pass would find the car already empty.
  return untilEmpty - toFeeder < plan.spineLen + 10;
}

// Progress a move makes along the track. Outer lanes have cells that share a forwardIndex, so
// `distance` (cells walked, and what the move budget charges) over-counts progress there.
export function forwardGain(
  from: TrackCell | undefined,
  to: TrackCell | undefined,
  distance: number,
  plan: BotPlanContext | undefined
): number {
  if (!from || !to || !plan || from.laneIndex === PIT_LANE || to.laneIndex === PIT_LANE) return distance;
  return (to.forwardIndex - from.forwardIndex + plan.spineLen) % plan.spineLen;
}

// Points of score one unit of tire or fuel is worth: 1 normally, but a resource that will run out
// before the flag is worth the crawl it saves (half a cell per cell of range, ten points a cell).
export function resourceWeights(car: Car, cell: TrackCell, plan: BotPlanContext): { tire: number; fuel: number } {
  const wear = wearPerCell(car.setup);
  const remaining = plan.raceLaps * plan.spineLen - progressOf(car, cell, plan);
  const worth = (units: number, perCell: number) =>
    (units / perCell) * SAFETY < remaining ? Math.max(1, (10 * EMPTY_SLOWDOWN) / perCell) : 1;
  return { tire: worth(car.tire, wear.tire), fuel: worth(car.fuel, wear.fuel) };
}
