import type { TrackCell, TrackData } from "../types/track";

export interface TargetInfo {
  distance: number;
  tireCost: number;
  fuelCost: number;
  isPitTrigger: boolean;
}

type CellMap = Map<string, TrackCell>;

function buildCellMap(track: TrackData): CellMap {
  return new Map(track.cells.map((c) => [c.id, c]));
}

export interface MovementOptions {
  allowPitExitSkip?: boolean;
  disallowPitBoxTargets?: boolean;
}

export function computeValidTargets(
  track: TrackData,
  startCellId: string,
  occupied: Set<string>,
  maxSteps: number,
  options: MovementOptions = {}
): Map<string, TargetInfo> {
  const cellMap = buildCellMap(track);
  const startCell = cellMap.get(startCellId);
  if (!startCell) return new Map();
  const startIsPitLane = startCell.laneIndex === 3;
  const effectiveMaxSteps = startIsPitLane ? 1 : maxSteps;

  const dist = new Map<string, number>();
  const queue: string[] = [];

  dist.set(startCellId, 0);
  queue.push(startCellId);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentDist = dist.get(currentId) ?? 0;
    if (currentDist >= effectiveMaxSteps) continue;

    const current = cellMap.get(currentId);
    if (!current) continue;
    const currentIsPitLane = current.laneIndex === 3;
    if (currentIsPitLane && currentDist > 0) continue;

    for (const nextId of current.next) {
      const nextCell = cellMap.get(nextId);
      if (!nextCell) continue;
      const nextTags = nextCell.tags ?? [];
      const isPitEntry = nextTags.includes("PIT_ENTRY");
      const isPitLane = nextCell.laneIndex === 3;

      if (isPitEntry && current.laneIndex !== 0) continue;
      if (isPitLane && !isPitEntry && current.laneIndex !== 3) continue;
      if (dist.has(nextId)) continue;
      dist.set(nextId, currentDist + 1);
      queue.push(nextId);
    }
  }

  const targets = new Map<string, TargetInfo>();
  for (const [cellId, d] of dist.entries()) {
    if (d <= 0 || d > effectiveMaxSteps) continue;
    if (occupied.has(cellId)) continue;
    const cell = cellMap.get(cellId);
    if (!cell) continue;
    if (options.disallowPitBoxTargets && (cell.tags ?? []).includes("PIT_BOX")) continue;

    targets.set(cellId, {
      distance: d,
      tireCost: d,
      fuelCost: d,
      isPitTrigger: (cell.tags ?? []).includes("PIT_BOX")
    });
  }

  if (options.allowPitExitSkip && startIsPitLane && (startCell.tags ?? []).includes("PIT_BOX")) {
    const lastPitBoxZone = Math.max(
      ...track.cells.filter((c) => (c.tags ?? []).includes("PIT_BOX") && c.laneIndex === 3).map((c) => c.zoneIndex)
    );
    const exitZone = lastPitBoxZone + 1;
    const exitCellId = track.cells.find((c) => c.laneIndex === 3 && c.zoneIndex === exitZone)?.id;
    if (exitCellId && !occupied.has(exitCellId)) {
      const exitCell = cellMap.get(exitCellId);
      if (exitCell) {
        targets.set(exitCellId, {
          distance: exitZone - startCell.zoneIndex,
          tireCost: 0,
          fuelCost: 0,
          isPitTrigger: false
        });
      }
    }
  }

  return targets;
}
