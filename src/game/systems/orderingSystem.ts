import type { Car } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";
import { buildLaneSequence } from "./laneSequence";

export interface CarSortKey {
  lapCount: number;
  progressIndex: number;
  carId: number;
}

export interface SortCarsOptions {
  turnOrder?: number[];
  turnIndex?: number;
}

function hasStartedRace(cars: Car[]): boolean {
  return cars.some((car) => {
    if ((car.lapCount ?? 0) !== 0) return true;
    if (car.moveCycle.index !== 0) return true;
    return car.moveCycle.spent.some((value) => value !== 0);
  });
}

function getStartFinishForwardIndex(cellMap: Map<string, TrackCell>): number | null {
  let startFinishForwardIndex: number | null = null;
  for (const cell of cellMap.values()) {
    if (!(cell.tags ?? []).includes("START_FINISH")) continue;
    if (startFinishForwardIndex == null || cell.forwardIndex < startFinishForwardIndex) {
      startFinishForwardIndex = cell.forwardIndex;
    }
  }
  return startFinishForwardIndex;
}

export function getCellForwardIndex(cellId: string, cellMap: Map<string, TrackCell>): number {
  const cell = cellMap.get(cellId);
  return cell ? cell.forwardIndex : -1;
}

export function computeCarSortKey(
  car: Car,
  cellMap: Map<string, TrackCell>,
  progressMap?: Map<string, number>
): CarSortKey {
  const progressIndex = progressMap?.get(car.cellId) ?? getCellForwardIndex(car.cellId, cellMap);
  const lapCount = car.lapCount ?? 0;
  return { lapCount, progressIndex, carId: car.carId };
}

export function sortCarsByProgress(
  cars: Car[],
  cellMap: Map<string, TrackCell>,
  options: SortCarsOptions = {}
): Car[] {
  const turnOrderRank = new Map<number, number>();
  const turnOrder = options.turnOrder ?? [];
  if (turnOrder.length > 0) {
    const start = ((options.turnIndex ?? 0) % turnOrder.length + turnOrder.length) % turnOrder.length;
    for (let i = 0; i < turnOrder.length; i += 1) {
      const carId = turnOrder[(start + i) % turnOrder.length];
      if (carId != null) turnOrderRank.set(carId, i);
    }
  }
  const startFinishForwardIndex = getStartFinishForwardIndex(cellMap);
  const isInitialPlacement =
    turnOrder.length > 0 &&
    (options.turnIndex ?? 0) === 0 &&
    !hasStartedRace(cars);

  return [...cars].sort((a, b) => {
    const aKey = computeCarSortKey(a, cellMap);
    const bKey = computeCarSortKey(b, cellMap);
    if (aKey.lapCount !== bKey.lapCount) return bKey.lapCount - aKey.lapCount;

    if (isInitialPlacement) {
      const aIsBehindStart = startFinishForwardIndex != null &&
        aKey.progressIndex !== startFinishForwardIndex &&
        aKey.progressIndex <= 27;
      const bIsBehindStart = startFinishForwardIndex != null &&
        bKey.progressIndex !== startFinishForwardIndex &&
        bKey.progressIndex <= 27;

      if (aIsBehindStart !== bIsBehindStart) return aIsBehindStart ? 1 : -1;
      if (aIsBehindStart && bIsBehindStart && aKey.progressIndex !== bKey.progressIndex) {
        return bKey.progressIndex - aKey.progressIndex;
      }
    }

    // Lower forwardIndex is ahead in standings order.
    if (aKey.progressIndex !== bKey.progressIndex) return aKey.progressIndex - bKey.progressIndex;

    const aTurnRank = turnOrderRank.get(aKey.carId);
    const bTurnRank = turnOrderRank.get(bKey.carId);
    if (aTurnRank != null && bTurnRank != null && aTurnRank !== bTurnRank) {
      return aTurnRank - bTurnRank;
    }
    if (aTurnRank != null && bTurnRank == null) return -1;
    if (aTurnRank == null && bTurnRank != null) return 1;

    return aKey.carId - bKey.carId;
  });
}

export function buildProgressMap(track: TrackData, spineLane = 1): Map<string, number> {
  const byId = new Map(track.cells.map((c) => [c.id, c]));
  const spineSeq = buildLaneSequence(track.cells, byId, spineLane);
  const spineLen = spineSeq.length > 0
    ? spineSeq.length
    : Math.max(1, Math.max(...track.cells.map((c) => c.forwardIndex)) + 1);

  const progressMap = new Map<string, number>();
  const laneIndices = new Set(track.cells.map((c) => c.laneIndex));
  for (const laneIndex of laneIndices) {
    const seq = buildLaneSequence(track.cells, byId, laneIndex);
    if (seq.length === 0) continue;
    const denom = Math.max(1, seq.length - 1);
    let i = 0;
    for (const cell of seq) {
      const progress = i / denom;
      const progressIndex = progress * (spineLen - 1);
      progressMap.set(cell.id, progressIndex);
      i += 1;
    }
  }
  return progressMap;
}
