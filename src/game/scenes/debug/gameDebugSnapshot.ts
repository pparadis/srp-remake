import { PIT_LANE } from "../../constants";
import { getRemainingBudget } from "../../systems/moveBudgetSystem";
import type { TargetInfo } from "../../systems/movementSystem";
import type { Car } from "../../types/car";
import type { TrackCell, TrackData } from "../../types/track";

interface MoveBudgetConfig {
  baseMax: number;
  zeroResourceMax: number;
}

interface MoveRatesConfig {
  softTire: number;
  hardTire: number;
  fuel: number;
}

interface BuildInfo {
  version: string;
  gitSha: string;
}

export interface BuildGameDebugSnapshotParams {
  buildInfo: BuildInfo;
  track: TrackData;
  cellMap: Map<string, TrackCell>;
  cars: Car[];
  activeCar: Car;
  validTargets: Map<string, TargetInfo>;
  botDecisionCount: number;
  moveBudget: MoveBudgetConfig;
  moveRates: MoveRatesConfig;
  disallowPitBoxTargets: boolean;
  spineLane?: number;
}

export function buildGameDebugSnapshot(params: BuildGameDebugSnapshotParams) {
  const {
    buildInfo,
    track,
    cellMap,
    cars,
    activeCar,
    validTargets,
    botDecisionCount,
    moveBudget,
    moveRates,
    disallowPitBoxTargets,
    spineLane = 1
  } = params;

  const spineCells = track.cells.filter((c) => c.laneIndex === spineLane);
  const startFinishIds = track.cells
    .filter((c) => (c.tags ?? []).includes("START_FINISH"))
    .map((c) => c.id);
  const occupiedByCell = Object.fromEntries(cars.map((car) => [car.cellId, car.carId]));
  const serializedCars = cars
    .map((car) => {
      const cell = cellMap.get(car.cellId);
      return {
        carId: car.carId,
        cellId: car.cellId,
        isBot: car.isBot,
        lapCount: car.lapCount ?? 0,
        state: car.state,
        tire: car.tire,
        fuel: car.fuel,
        pitTurnsRemaining: car.pitTurnsRemaining,
        pitExitBoost: car.pitExitBoost,
        pitServiced: car.pitServiced,
        setup: car.setup,
        cell: cell
          ? {
              zoneIndex: cell.zoneIndex,
              laneIndex: cell.laneIndex,
              forwardIndex: cell.forwardIndex,
              tags: cell.tags ?? []
            }
          : null
      };
    })
    .sort((a, b) => a.carId - b.carId);

  const activeCell = cellMap.get(activeCar.cellId);
  const occupied = new Set(cars.map((c) => c.cellId));
  const baseMaxSteps = activeCar.tire === 0 || activeCar.fuel === 0
    ? moveBudget.zeroResourceMax
    : moveBudget.baseMax;
  const remainingBudget = getRemainingBudget(activeCar.moveCycle);
  const maxSteps = Math.min(baseMaxSteps, Math.max(0, remainingBudget));
  const tireRate = activeCar.setup.compound === "soft" ? moveRates.softTire : moveRates.hardTire;
  const fuelRate = moveRates.fuel;
  const inPitLane = activeCell?.laneIndex === PIT_LANE;
  const serializedTargets = Array.from(validTargets.entries()).map(([cellId, info]) => ({
    cellId,
    distance: info.distance,
    moveSpend: info.moveSpend ?? null,
    tireCost: info.tireCost,
    fuelCost: info.fuelCost,
    isPitTrigger: info.isPitTrigger
  }));

  return {
    version: buildInfo.version,
    gitSha: buildInfo.gitSha,
    trackId: track.trackId,
    spineLane,
    spineLength: spineCells.length,
    startFinishIds,
    activeCarId: activeCar.carId,
    movement: {
      maxSteps: inPitLane ? 1 : maxSteps,
      tireRate,
      fuelRate,
      allowPitExitSkip: activeCar.pitExitBoost,
      disallowPitBoxTargets,
      occupied: Array.from(occupied),
      validTargets: serializedTargets
    },
    occupiedByCell,
    cars: serializedCars,
    botDecisionCount
  };
}
