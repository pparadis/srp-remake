import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import type { TargetInfo } from "./movementSystem";
import { recordMove } from "./moveBudgetSystem";
import { PIT_LANE } from "../constants";

function clamp01to100(value: number) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * True when a move from `fromCell` to `targetCell` crosses the start line, which spans every lane.
 * Main lanes: forwardIndex wraps. Pit lane: the move starts before the PIT_LINE cell and lands on or
 * beyond it (pit forwardIndex rises along the pit lane, so a jump to a box over the line counts); the
 * move from lane 1 onto the pit entry and the pit exit onto lane 1 never count.
 */
export function crossesStartLine(fromCell: TrackCell, targetCell: TrackCell, pitLineFwd: number | null): boolean {
  if (fromCell.laneIndex !== PIT_LANE && targetCell.laneIndex !== PIT_LANE) {
    return fromCell.forwardIndex > targetCell.forwardIndex;
  }
  return (
    pitLineFwd !== null &&
    fromCell.laneIndex === PIT_LANE &&
    targetCell.laneIndex === PIT_LANE &&
    fromCell.forwardIndex < pitLineFwd &&
    targetCell.forwardIndex >= pitLineFwd
  );
}

export function applyMove(
  car: Car,
  fromCell: TrackCell,
  targetCell: TrackCell,
  info: TargetInfo,
  moveSpend: number,
  pitLineFwd: number | null = null
) {
  if (crossesStartLine(fromCell, targetCell, pitLineFwd)) car.lapCount = (car.lapCount ?? 0) + 1;
  car.cellId = targetCell.id;
  car.pitExitBoost = false;
  if (targetCell.laneIndex !== PIT_LANE) {
    car.pitServiced = false;
  }
  car.tire = clamp01to100(car.tire - info.tireCost);
  car.fuel = clamp01to100(car.fuel - info.fuelCost);
  recordMove(car.moveCycle, moveSpend);
}
