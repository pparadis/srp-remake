import type { Car, CarSetup } from "../types/car";
import type { TrackCell } from "../types/track";

export function shouldOpenPitModal(car: Car, cell: TrackCell) {
  return (cell.tags ?? []).includes("PIT_BOX") && !car.pitServiced;
}

export function applyPitStop(car: Car, cellId: string, setup: CarSetup | null) {
  car.cellId = cellId;
  car.tire = 100;
  car.fuel = 100;
  if (setup) {
    car.setup = setup;
  }
  car.state = "PITTING";
  car.pitTurnsRemaining = 1;
  car.pitExitBoost = false;
  car.pitServiced = true;
}

export function advancePitPenalty(car: Car) {
  if (car.pitTurnsRemaining <= 0) return false;
  car.pitTurnsRemaining -= 1;
  car.state = car.pitTurnsRemaining > 0 ? "PITTING" : "ACTIVE";
  if (car.pitTurnsRemaining === 0) {
    car.pitExitBoost = true;
  }
  return true;
}

export function shouldDisallowPitBoxTargets(car: Car, _inPitLane: boolean) {
  return car.pitServiced;
}
