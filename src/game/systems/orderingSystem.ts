import type { Car } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";

export interface CarSortKey {
  lapCount: number;
  progressIndex: number;
  carId: number;
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
  progressMap?: Map<string, number>
): Car[] {
  return [...cars].sort((a, b) => {
    const aKey = computeCarSortKey(a, cellMap, progressMap);
    const bKey = computeCarSortKey(b, cellMap, progressMap);
    if (aKey.lapCount !== bKey.lapCount) return bKey.lapCount - aKey.lapCount;
    if (aKey.progressIndex !== bKey.progressIndex) return bKey.progressIndex - aKey.progressIndex;
    return aKey.carId - bKey.carId;
  });
}

function pickLaneStart(cells: TrackCell[]): TrackCell {
  return (
    cells.find((c) => (c.tags ?? []).includes("START_FINISH")) ??
    cells.find((c) => (c.tags ?? []).includes("PIT_ENTRY")) ??
    cells.reduce((best, c) => (c.forwardIndex < best.forwardIndex ? c : best), cells[0])
  );
}

function buildLaneSequence(cells: TrackCell[], byId: Map<string, TrackCell>, laneIndex: number): TrackCell[] {
  const laneCells = cells.filter((c) => c.laneIndex === laneIndex);
  if (laneCells.length === 0) return [];
  const start = pickLaneStart(laneCells);
  const seq: TrackCell[] = [];
  const visited = new Set<string>();
  let current: TrackCell | undefined = start;
  while (current && !visited.has(current.id) && seq.length < laneCells.length) {
    visited.add(current.id);
    seq.push(current);
    const nextSameId: string | undefined = current.next.find((id) => {
      const nextCell = byId.get(id);
      return nextCell && nextCell.laneIndex === laneIndex;
    });
    current = nextSameId ? byId.get(nextSameId) : undefined;
  }
  if (seq.length < laneCells.length) {
    const remaining = laneCells
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => a.forwardIndex - b.forwardIndex);
    seq.push(...remaining);
  }
  return seq;
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
    for (let i = 0; i < seq.length; i += 1) {
      const progress = i / denom;
      const progressIndex = progress * (spineLen - 1);
      progressMap.set(seq[i].id, progressIndex);
    }
  }
  return progressMap;
}
