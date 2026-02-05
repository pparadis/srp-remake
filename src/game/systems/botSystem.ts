import type { Car } from "../types/car";
import type { TargetInfo } from "./movementSystem";

export interface BotPick {
  cellId: string;
  info: TargetInfo;
}

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
