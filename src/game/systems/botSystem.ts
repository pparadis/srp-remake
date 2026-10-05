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

// "autopilot" is what the server plays for an AFK player: deliberately mediocre, so engaged
// players always do better. It never pits and never takes more than a median-distance move.
export type BotPolicy = "normal" | "autopilot";

export function evaluateAutopilotTargets(
  targets: Map<string, TargetInfo>,
  car: Car,
  cellMap: Map<string, TrackCell>
): BotDecisionTrace {
  const heuristics = { ...DEFAULTS };
  const entries = Array.from(targets.entries()).sort(([a], [b]) => a.localeCompare(b));
  // ponytail: if only pit boxes are reachable we still pick one (a skip would be rejected as
  // moves_available and stall the race); the autopilot only avoids pitting when it has a choice.
  const nonPit = entries.filter(([, info]) => !info.isPitTrigger);
  const pool = nonPit.length > 0 ? nonPit : entries;
  const distances = pool.map(([, info]) => info.distance).sort((a, b) => a - b);
  const median = distances[Math.floor((distances.length - 1) / 2)] ?? 0;
  const fromLane = cellMap.get(car.cellId)?.laneIndex;
  const inPool = new Set(pool.map(([cellId]) => cellId));

  let selectedCellId: string | null = null;
  let bestScore = -Infinity;
  const candidates: BotCandidateScore[] = [];
  for (const [cellId, info] of entries) {
    // Closest to the median first, then the current lane, then the shorter move.
    const score = inPool.has(cellId)
      ? -Math.abs(info.distance - median) * 1000 +
        (cellMap.get(cellId)?.laneIndex === fromLane ? 100 : 0) -
        info.distance
      : -1e9;
    candidates.push({ cellId, info, score });
    if (score > bestScore) {
      bestScore = score;
      selectedCellId = cellId;
    }
  }
  return {
    lowResources: car.tire <= DEFAULTS.lowResourceThreshold || car.fuel <= DEFAULTS.lowResourceThreshold,
    heuristics,
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
  cellMap: Map<string, TrackCell>,
  policy: BotPolicy = "normal"
): BotDecisionResult {
  const trace =
    policy === "autopilot"
      ? evaluateAutopilotTargets(targets, car, cellMap)
      : evaluateBotTargets(targets, car);
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
  cellMap: Map<string, TrackCell>,
  policy: BotPolicy = "normal"
): BotAction {
  return decideBotActionWithTrace(targets, car, cellMap, policy).action;
}
