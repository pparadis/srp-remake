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

export function applyMove(
  car: Car,
  fromCell: TrackCell,
  targetCell: TrackCell,
  info: TargetInfo,
  moveSpend: number
) {
  const crossesStart =
    fromCell.laneIndex !== PIT_LANE &&
    targetCell.laneIndex !== PIT_LANE &&
    fromCell.forwardIndex > targetCell.forwardIndex;
  if (crossesStart) {
    car.lapCount = (car.lapCount ?? 0) + 1;
  }
  car.cellId = targetCell.id;
  car.pitExitBoost = false;
  if (targetCell.laneIndex !== PIT_LANE) {
    car.pitServiced = false;
  }
  car.tire = clamp01to100(car.tire - info.tireCost);
  car.fuel = clamp01to100(car.fuel - info.fuelCost);
  recordMove(car.moveCycle, moveSpend);
}
