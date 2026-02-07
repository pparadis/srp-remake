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

export interface BotCandidateScore {
  cellId: string;
  info: TargetInfo;
  score: number;
}

export interface BotDecisionTrace {
  lowResources: boolean;
  heuristics: Required<BotHeuristicOptions>;
  candidates: BotCandidateScore[];
  selectedCellId: string | null;
}

export interface BotDecisionResult {
  action: BotAction;
  trace: BotDecisionTrace;
}

const DEFAULTS: Required<BotHeuristicOptions> = {
  lowResourceThreshold: 25,
  pitBonus: 5,
  pitPenalty: 2
};

export function evaluateBotTargets(
  targets: Map<string, TargetInfo>,
  car: Car,
  options: BotHeuristicOptions = {}
): BotDecisionTrace {
  const { lowResourceThreshold, pitBonus, pitPenalty } = { ...DEFAULTS, ...options };
  const lowResources = car.tire <= lowResourceThreshold || car.fuel <= lowResourceThreshold;

  if (targets.size === 0) {
    return {
      lowResources,
      heuristics: { lowResourceThreshold, pitBonus, pitPenalty },
      candidates: [],
      selectedCellId: null
    };
  }

  let selectedCellId: string | null = null;
  let bestScore = -Infinity;

  const entries = Array.from(targets.entries()).sort(([a], [b]) => a.localeCompare(b));
  const candidates: BotCandidateScore[] = [];
  for (const [cellId, info] of entries) {
    let score = info.distance * 10 - (info.tireCost + info.fuelCost);
    if (info.isPitTrigger) {
      score += lowResources ? pitBonus : -pitPenalty;
    }
    candidates.push({ cellId, info, score });
    if (score > bestScore) {
      bestScore = score;
      selectedCellId = cellId;
    }
  }

  return {
    lowResources,
    heuristics: { lowResourceThreshold, pitBonus, pitPenalty },
    candidates,
    selectedCellId
  };
}

export function pickBotMove(
  targets: Map<string, TargetInfo>,
  car: Car,
  options: BotHeuristicOptions = {}
): BotPick | null {
  const trace = evaluateBotTargets(targets, car, options);
  if (!trace.selectedCellId) return null;
  const selected = trace.candidates.find((candidate) => candidate.cellId === trace.selectedCellId);
  if (!selected) return null;
  return { cellId: selected.cellId, info: selected.info };
}

export function decideBotActionWithTrace(
  targets: Map<string, TargetInfo>,
  car: Car,
  cellMap: Map<string, TrackCell>
): BotDecisionResult {
  const trace = evaluateBotTargets(targets, car);
  if (!trace.selectedCellId) return { action: { type: "skip" }, trace };
  const selected = trace.candidates.find((candidate) => candidate.cellId === trace.selectedCellId);
  if (!selected) return { action: { type: "skip" }, trace };

  const targetCell = cellMap.get(selected.cellId);
  if (!targetCell) return { action: { type: "skip" }, trace };
  if (selected.info.isPitTrigger && shouldOpenPitModal(car, targetCell)) {
    return { action: { type: "pit", target: targetCell, info: selected.info }, trace };
  }
  const fromCell = cellMap.get(car.cellId);
  if (!fromCell) return { action: { type: "skip" }, trace };
  const moveSpend = selected.info.moveSpend
    ?? computeMoveSpend(selected.info.distance, fromCell.laneIndex, targetCell.laneIndex);
  return { action: { type: "move", target: targetCell, info: selected.info, moveSpend }, trace };
}

export function decideBotAction(
  targets: Map<string, TargetInfo>,
  car: Car,
  cellMap: Map<string, TrackCell>
): BotAction {
  return decideBotActionWithTrace(targets, car, cellMap).action;
}
