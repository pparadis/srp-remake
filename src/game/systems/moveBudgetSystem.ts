import { MOVE_CYCLE, PIT_LANE, SOFT_PACE_BONUS, WING_EFFECTS } from "../constants";
import type { CarSetup } from "../types/car";

export interface MoveCycle {
  index: number;
  spent: number[];
}

export function createMoveCycle(size: number = MOVE_CYCLE.moves): MoveCycle {
  return { index: 0, spent: Array.from({ length: size }, () => 0) };
}

export function recordMove(cycle: MoveCycle, distance: number) {
  cycle.spent[cycle.index] = distance;
  cycle.index += 1;
  if (cycle.index >= cycle.spent.length) {
    cycle.index = 0;
    cycle.spent.fill(0);
    return true;
  }
  return false;
}

// The distance budget a move cycle holds for this setup: Low wing and the soft compound add, High wing takes.
export function cycleBudget(setup: Pick<CarSetup, "compound" | "wing">): number {
  return MOVE_CYCLE.budget + WING_EFFECTS[setup.wing].pace + (setup.compound === "soft" ? SOFT_PACE_BONUS : 0);
}

export function getRemainingBudget(cycle: MoveCycle, total: number = MOVE_CYCLE.budget) {
  const spent = cycle.spent.reduce((sum, v) => sum + v, 0);
  return Math.max(0, total - spent);
}

function isMainLane(laneIndex: number) {
  return laneIndex !== PIT_LANE;
}

export function computeMoveSpend(
  distance: number,
  startLaneIndex: number,
  targetLaneIndex: number,
  targetForwardDelta = distance
) {
  if (targetLaneIndex === PIT_LANE) return 1;
  const laneChangeSurcharge = (
    isMainLane(startLaneIndex) &&
    isMainLane(targetLaneIndex) &&
    startLaneIndex !== targetLaneIndex &&
    targetForwardDelta >= distance
  ) ? 1 : 0;
  return distance + laneChangeSurcharge;
}
