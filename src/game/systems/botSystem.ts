import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import type { TargetInfo } from "./movementSystem";
import { computeMoveSpend } from "./moveBudgetSystem";
import { shouldOpenPitModal } from "./pitSystem";

export interface BotPick {
  cellId: string;
  info: TargetInfo;
}

export type BotAction =
  | { type: "skip" }
  | { type: "pit"; target: TrackCell; info: TargetInfo }
  | { type: "move"; target: TrackCell; info: TargetInfo; moveSpend: number };

export interface BotHeuristicOptions {
  lowResourceThreshold?: number;
  pitBonus?: number;
  pitPenalty?: number;
}

const DEFAULTS: Required<BotHeuristicOptions> = {
  lowResourceThreshold: 25,
  pitBonus: 5,
  pitPenalty: 2
};

export function pickBotMove(
  targets: Map<string, TargetInfo>,
  car: Car,
  options: BotHeuristicOptions = {}
): BotPick | null {
  if (targets.size === 0) return null;
  const { lowResourceThreshold, pitBonus, pitPenalty } = { ...DEFAULTS, ...options };
  const lowResources = car.tire <= lowResourceThreshold || car.fuel <= lowResourceThreshold;

  let best: BotPick | null = null;
  let bestScore = -Infinity;

  const entries = Array.from(targets.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [cellId, info] of entries) {
    let score = info.distance * 10 - (info.tireCost + info.fuelCost);
    if (info.isPitTrigger) {
      score += lowResources ? pitBonus : -pitPenalty;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { cellId, info };
    }
  }

  return best;
}

export function decideBotAction(
  targets: Map<string, TargetInfo>,
  car: Car,
  cellMap: Map<string, TrackCell>
): BotAction {
  const pick = pickBotMove(targets, car);
  if (!pick) return { type: "skip" };
  const targetCell = cellMap.get(pick.cellId);
  if (!targetCell) return { type: "skip" };
  if (pick.info.isPitTrigger && shouldOpenPitModal(car, targetCell)) {
    return { type: "pit", target: targetCell, info: pick.info };
  }
  const moveSpend = computeMoveSpend(pick.info.distance, targetCell.laneIndex);
  return { type: "move", target: targetCell, info: pick.info, moveSpend };
}
