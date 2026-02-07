import type { TrackCell } from "../types/track";
import type { CarSetup } from "../types/car";
import type { TrackIndex } from "./trackIndex";
import { INNER_MAIN_LANE, MIDDLE_MAIN_LANE, OUTER_MAIN_LANE, PIT_LANE } from "../constants";
import { computeMoveSpend } from "./moveBudgetSystem";

export interface TargetInfo {
  distance: number;
  moveSpend?: number;
  tireCost: number;
  fuelCost: number;
  isPitTrigger: boolean;
}

export interface MovementOptions {
  allowPitExitSkip?: boolean;
  disallowPitBoxTargets?: boolean;
}

export interface MovementCostRates {
  tireRate: number;
  fuelRate: number;
}

export interface MovementCostContext extends MovementCostRates {
  setup: CarSetup;
}

function laneFactor(laneIndex: number, factors: { inner: number; middle: number; outer: number }): number {
  if (laneIndex === INNER_MAIN_LANE) return factors.inner;
  if (laneIndex === MIDDLE_MAIN_LANE) return factors.middle;
  if (laneIndex === OUTER_MAIN_LANE) return factors.outer;
  return 1;
}

function computeCosts(distance: number, laneIndex: number, costs: MovementCostContext): { tireCost: number; fuelCost: number } {
  const aeroFactor = 1 + (costs.setup.wingFrontDeg + costs.setup.wingRearDeg) * 0.01;
  const psi = costs.setup.psi;
  const psiFactor =
    1 +
    (Math.abs(psi.fl - 32) + Math.abs(psi.fr - 32) + Math.abs(psi.rl - 32) + Math.abs(psi.rr - 32)) * 0.002;
  const tireLaneFactor = laneFactor(laneIndex, { inner: 1.05, middle: 1.0, outer: 0.98 });
  const fuelLaneFactor = laneFactor(laneIndex, { inner: 0.98, middle: 1.0, outer: 1.03 });

  const tireCost = Math.round(distance * costs.tireRate * aeroFactor * psiFactor * tireLaneFactor);
  const fuelCost = Math.round(distance * costs.fuelRate * aeroFactor * fuelLaneFactor);

  return { tireCost, fuelCost };
}

export function computeValidTargets(
  trackIndex: TrackIndex,
  startCellId: string,
  occupied: Set<string>,
  maxSteps: number,
  options: MovementOptions = {},
  costs: MovementCostContext
): Map<string, TargetInfo> {
  const { track, cellMap, spineLen } = trackIndex;
  const startCell = cellMap.get(startCellId);
  if (!startCell) return new Map();
  const startIsPitLane = startCell.laneIndex === PIT_LANE;
  const effectiveMaxSteps = startIsPitLane ? 1 : maxSteps;

  const dist = new Map<string, number>();
  const queue: string[] = [];
  let queueIndex = 0;

  dist.set(startCellId, 0);
  queue.push(startCellId);

  while (queueIndex < queue.length) {
    const currentId = queue[queueIndex++]!;
    const currentDist = dist.get(currentId) ?? 0;
    if (currentDist >= effectiveMaxSteps) continue;

    const current = cellMap.get(currentId);
    if (!current) continue;
    for (const nextId of current.next) {
      const nextCell = cellMap.get(nextId);
      if (!nextCell) continue;
      if (occupied.has(nextId) && nextId !== startCellId) continue;
      const nextTags = nextCell.tags ?? [];
      const isPitEntry = nextTags.includes("PIT_ENTRY");
      const isPitLane = nextCell.laneIndex === PIT_LANE;

      if (isPitEntry && current.laneIndex !== INNER_MAIN_LANE) continue;
      if (isPitLane && !isPitEntry && current.laneIndex !== PIT_LANE) continue;
      if (dist.has(nextId)) continue;
      dist.set(nextId, currentDist + 1);
      queue.push(nextId);
    }
  }

  let pitBoxAdjacent = false;
  if (startIsPitLane) {
    for (const [id, d] of dist.entries()) {
      if (d !== 1) continue;
      const c = cellMap.get(id);
      if (c && (c.tags ?? []).includes("PIT_BOX")) {
        pitBoxAdjacent = true;
        break;
      }
    }
  }

  if (startIsPitLane && pitBoxAdjacent) {
    const visited = new Set<string>();
    let current: TrackCell | undefined = startCell;
    let steps = 0;
    const maxWalk = track.cells.length + 1;
    while (current && !visited.has(current.id) && steps < maxWalk) {
      visited.add(current.id);
      const nextSame: TrackCell | undefined = current.next
        .map((id) => cellMap.get(id))
        .find((c) => c && c.laneIndex === PIT_LANE);
      if (!nextSame) break;
      steps += 1;
      if ((nextSame.tags ?? []).includes("PIT_BOX")) {
        const prev = dist.get(nextSame.id);
        if (prev == null || steps < prev) dist.set(nextSame.id, steps);
      }
      current = nextSame;
    }
  }

  const blockerDeltasByLane = new Map<number, number[]>();
  if (!startIsPitLane) {
    for (const occId of occupied) {
      if (occId === startCellId) continue;
      const occ = cellMap.get(occId);
      if (!occ || occ.laneIndex === PIT_LANE) continue;
      const delta = (occ.forwardIndex - startCell.forwardIndex + spineLen) % spineLen;
      if (delta <= 0) continue;
      const deltas = blockerDeltasByLane.get(occ.laneIndex) ?? [];
      deltas.push(delta);
      deltas.sort((a, b) => a - b);
      if (deltas.length > 2) deltas.length = 2;
      blockerDeltasByLane.set(occ.laneIndex, deltas);
    }
  }

  const targets = new Map<string, TargetInfo>();
  for (const [cellId, d] of dist.entries()) {
    if (d <= 0) continue;
    if (occupied.has(cellId)) continue;
    const cell = cellMap.get(cellId);
    if (!cell) continue;
    const isPitEntryTarget = (cell.tags ?? []).includes("PIT_ENTRY");
    const isPitBox = (cell.tags ?? []).includes("PIT_BOX");
    if (d > effectiveMaxSteps) {
      if (!(startIsPitLane && pitBoxAdjacent && isPitBox)) continue;
    }
    if (startIsPitLane && cell.laneIndex === PIT_LANE && d > 1) {
      if (!pitBoxAdjacent || !isPitBox) continue;
    }
    if (!startIsPitLane && cell.laneIndex !== PIT_LANE && Math.abs(cell.laneIndex - startCell.laneIndex) > 1)
      continue;
    const targetDelta = (cell.forwardIndex - startCell.forwardIndex + spineLen) % spineLen;
    if (!startIsPitLane && cell.laneIndex !== PIT_LANE) {
      const blockers = blockerDeltasByLane.get(cell.laneIndex) ?? [];
      const blockDelta = cell.laneIndex === startCell.laneIndex
        ? blockers[0]
        : (blockers[1] ?? blockers[0]);
      if (blockDelta != null && targetDelta > blockDelta) continue;
    }
    if (!startIsPitLane && cell.laneIndex !== startCell.laneIndex && targetDelta === 0 && !isPitEntryTarget) continue;
    if (!startIsPitLane && cell.laneIndex === PIT_LANE) {
      if (!isPitEntryTarget) continue;
      if (d !== 1) continue;
    }
    const moveSpend = computeMoveSpend(d, startCell.laneIndex, cell.laneIndex, targetDelta);
    if (moveSpend > maxSteps) continue;
    if (options.disallowPitBoxTargets && (cell.tags ?? []).includes("PIT_BOX")) continue;

    const { tireCost, fuelCost } = computeCosts(d, cell.laneIndex, costs);
    targets.set(cellId, {
      distance: d,
      moveSpend,
      tireCost,
      fuelCost,
      isPitTrigger: (cell.tags ?? []).includes("PIT_BOX")
    });
  }

  if (options.allowPitExitSkip && startIsPitLane && (startCell.tags ?? []).includes("PIT_BOX")) {
    const lastPitBoxZone = trackIndex.pitBoxMaxZone;
    if (lastPitBoxZone == null) return targets;
    const exitZone = lastPitBoxZone + 1;
    const exitCellId = trackIndex.pitLaneByZone.get(exitZone);
    if (exitCellId && !occupied.has(exitCellId)) {
      const exitCell = cellMap.get(exitCellId);
      if (exitCell) {
        const distance = Math.max(1, exitZone - startCell.zoneIndex);
        const { tireCost, fuelCost } = computeCosts(distance, exitCell.laneIndex, costs);
        const moveSpend = computeMoveSpend(distance, startCell.laneIndex, exitCell.laneIndex, distance);
        if (moveSpend <= maxSteps) {
          targets.set(exitCellId, {
            distance,
            moveSpend,
            tireCost,
            fuelCost,
            isPitTrigger: false
          });
        }
      }
    }
  }

  return targets;
}
