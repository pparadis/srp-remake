import { PIT_LANE } from "../constants";

export interface MoveCycle {
  index: number;
  spent: number[];
}

export function createMoveCycle(size = 5): MoveCycle {
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

export function getRemainingBudget(cycle: MoveCycle, total = 40) {
  const spent = cycle.spent.reduce((sum, v) => sum + v, 0);
  return Math.max(0, total - spent);
}

export function computeMoveSpend(distance: number, targetLaneIndex: number) {
  return targetLaneIndex === PIT_LANE ? 1 : distance;
}
