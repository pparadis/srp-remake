// What the HUD tells the player about tire and fuel: stint length and pit advice. Phaser-free.
// The wear math and the stop timing are botPlan's, so the advice and the Normal bot agree.
import { MOVE_BUDGET, MOVE_CYCLE } from "../constants";
import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import {
  type BotPlanContext,
  cellsToFeeder,
  cellsUntilEmpty,
  isFinalLap,
  projectShortfall,
  stopIsDue
} from "./botPlan";

export interface StintEstimate {
  /** Cells of racing until tire or fuel reaches 0 (middle lane, no safety margin). */
  cells: number;
  /** Laps of the track, and moves at the average a move cycle allows (40 / 5 = 8 cells). */
  laps: number;
  moves: number;
}

export type PitAdvice = "ok" | "pit-soon" | "pit-now" | "no-need";

type Resources = Pick<Car, "tire" | "fuel" | "setup">;

export function stintEstimate(car: Resources, spineLen: number): StintEstimate {
  const cells = cellsUntilEmpty(car.tire, car.fuel, car.setup, 1);
  return { cells, laps: cells / spineLen, moves: cells / (MOVE_CYCLE.budget / MOVE_CYCLE.moves) };
}

/** Cells until the car stands on the lane-1 cell next to PIT_ENTRY, null when the track has no pit. */
export function cellsToPitEntry(cell: TrackCell, plan: BotPlanContext): number | null {
  return cellsToFeeder(cell, plan);
}

/**
 * ok: no stop needed yet. pit-soon: this is the last lap that still passes the pit entry in time.
 * pit-now: the entry is within one move. no-need: already serviced, last lap (the entry is never taken
 * then) or the car can finish on what it has.
 */
export function pitAdvice(car: Car, cell: TrackCell, plan: BotPlanContext): PitAdvice {
  if (car.pitServiced || isFinalLap(car, plan)) return "no-need";
  const toEntry = cellsToPitEntry(cell, plan);
  if (toEntry === null) return "no-need";
  if (projectShortfall(car, cell, plan).shortfall === 0) return "no-need";
  if (!stopIsDue(car, cell, plan)) return "ok";
  return toEntry < MOVE_BUDGET.baseMax ? "pit-now" : "pit-soon";
}
