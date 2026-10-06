import { MOVE_BUDGET, PIT_LANE } from "../constants";
import type { BotLevel, Car } from "../types/car";
import type { TrackCell } from "../types/track";
import {
  cellsToFeeder,
  forwardGain,
  isFinalLap,
  resourceWeights,
  stopIsDue,
  wearPerCell,
  type BotPlanContext
} from "./botPlan";
import type { TargetInfo } from "./movementSystem";
import { computeMoveSpend, getRemainingBudget } from "./moveBudgetSystem";
import { shouldOpenPitModal } from "./pitSystem";

export type { BotLevel };

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
export type BotPolicy = "autopilot" | BotLevel;

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

// ---- Easy: the plain score with seeded noise ----------------------------------------------------

const EASY_LOW_RESOURCE_THRESHOLD = 10;
// Chance of taking the best, second and third best move.
const EASY_PICK_WEIGHTS = [0.5, 0.3, 0.2] as const;

// FNV-1a over the state that changes every turn, then mulberry32: deterministic, no Math.random.
function seededUnit(car: Car): number {
  const key = [
    car.carId,
    car.cellId,
    car.lapCount ?? 0,
    car.moveCycle.index,
    car.moveCycle.spent.join(","),
    car.tire,
    car.fuel
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  }
  let t = (h + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function evaluateEasyTargets(targets: Map<string, TargetInfo>, car: Car): BotDecisionTrace {
  const trace = evaluateBotTargets(targets, car, { lowResourceThreshold: EASY_LOW_RESOURCE_THRESHOLD });
  if (trace.candidates.length === 0) return trace;
  const ranked = [...trace.candidates].sort((a, b) => b.score - a.score || a.cellId.localeCompare(b.cellId));
  const top = ranked.slice(0, EASY_PICK_WEIGHTS.length);
  const weights = EASY_PICK_WEIGHTS.slice(0, top.length);
  let roll = seededUnit(car) * weights.reduce((sum, w) => sum + w, 0);
  let pick = top[0]!;
  for (let i = 0; i < top.length; i += 1) {
    roll -= weights[i]!;
    if (roll < 0) {
      pick = top[i]!;
      break;
    }
  }
  return { ...trace, selectedCellId: pick.cellId };
}

// ---- Normal: the plain score plus the move-budget cycle and the pit plan ----------------------

const NORMAL = {
  // per cell of budget that can no longer be spent in the rest of the cycle
  wasteWeight: 10,
  // per point the remaining moves' even share of the budget shrinks
  shareWeight: 2,
  pitBoxBonus: 100,
  pitEntryBonus: 150,
  pitEntryAvoid: 40,
  finalLapPitAvoid: 1000,
  landOnFeederBonus: 80,
  overshootFeederPenalty: 60,
  innerLaneBonus: 6
} as const;

// `plan` carries the race context; without it the pit and final-lap parts are skipped.
export function evaluateNormalTargets(
  targets: Map<string, TargetInfo>,
  car: Car,
  cellMap: Map<string, TrackCell>,
  plan?: BotPlanContext
): BotDecisionTrace {
  const heuristics = { ...DEFAULTS };
  const lowResources = car.tire <= heuristics.lowResourceThreshold || car.fuel <= heuristics.lowResourceThreshold;
  const from = cellMap.get(car.cellId);
  const inPitLane = from?.laneIndex === PIT_LANE;
  const budget = getRemainingBudget(car.moveCycle);
  const movesLeft = car.moveCycle.spent.length - car.moveCycle.index;
  const finalLap = plan ? isFinalLap(car, plan) : false;
  const stopDue = plan && from && !inPitLane ? stopIsDue(car, from, plan) : false;
  const toFeeder = plan && from && !inPitLane ? cellsToFeeder(from, plan) : null;
  const weights = plan && from && !inPitLane ? resourceWeights(car, from, plan) : { tire: 1, fuel: 1 };
  const wear = wearPerCell(car.setup);

  let selectedCellId: string | null = null;
  let bestScore = -Infinity;
  const candidates: BotCandidateScore[] = [];
  const entries = Array.from(targets.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [cellId, info] of entries) {
    const cell = cellMap.get(cellId);
    // Progress along the track (forwardIndex), not cells walked.
    const gain = forwardGain(from, cell, info.distance, plan);
    let score = gain * 10 - (info.tireCost + info.fuelCost);
    // A resource that will run out before the flag is worth more than a point per unit, but only
    // the part of a move's cost above the car's average wear per cell is a real saving or waste
    // (rounding and lane factors); the average itself is paid for any progress.
    score -=
      (weights.tire - 1) * (info.tireCost - info.distance * wear.tire) +
      (weights.fuel - 1) * (info.fuelCost - info.distance * wear.fuel);

    // Budget cycle: unspendable leftovers are lost, and a spend above the even share starves the
    // remaining moves (no room for a lane change or a gap).
    // (pit-lane moves are priced into the stop decision itself).
    if (movesLeft > 1 && cell?.laneIndex !== PIT_LANE) {
      const spend = info.moveSpend ?? info.distance;
      const left = budget - spend;
      const laterMoves = movesLeft - 1;
      score -= Math.max(0, left - MOVE_BUDGET.baseMax * laterMoves) * NORMAL.wasteWeight;
      const evenShare = budget / movesLeft;
      const laterShare = left / laterMoves;
      if (laterShare < evenShare) score -= (evenShare - laterShare) * NORMAL.shareWeight;
    }

    if (info.isPitTrigger) {
      score += lowResources || inPitLane ? NORMAL.pitBoxBonus : -heuristics.pitPenalty;
    } else if (cell && plan) {
      const tags = cell.tags ?? [];
      if (cell.laneIndex === PIT_LANE && !inPitLane && tags.includes("PIT_ENTRY")) {
        if (finalLap) score -= NORMAL.finalLapPitAvoid;
        else score += stopDue ? NORMAL.pitEntryBonus : -NORMAL.pitEntryAvoid;
      } else if (stopDue && from && cell.laneIndex !== PIT_LANE) {
        // Steer for the one cell a stop can start from: lane 1, landing exactly on it.
        if (cell.laneIndex === 1) score += NORMAL.innerLaneBonus;
        if (toFeeder !== null && toFeeder > 0 && toFeeder <= MOVE_BUDGET.baseMax) {
          const delta = (cell.forwardIndex - from.forwardIndex + plan.spineLen) % plan.spineLen;
          if (delta === toFeeder && cell.laneIndex === 1) score += NORMAL.landOnFeederBonus;
          else if (delta > toFeeder) score -= NORMAL.overshootFeederPenalty;
        }
      }
    }

    candidates.push({ cellId, info, score });
    if (score > bestScore) {
      bestScore = score;
      selectedCellId = cellId;
    }
  }
  return { lowResources, heuristics, candidates, selectedCellId };
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
  policy: BotPolicy = "normal",
  plan?: BotPlanContext
): BotDecisionResult {
  // "hard" ranks its candidates with the Normal score; the lookahead lives in raceEngine.
  const trace =
    policy === "autopilot"
      ? evaluateAutopilotTargets(targets, car, cellMap)
      : policy === "easy"
        ? evaluateEasyTargets(targets, car)
        : evaluateNormalTargets(targets, car, cellMap, plan);
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
  policy: BotPolicy = "normal",
  plan?: BotPlanContext
): BotAction {
  return decideBotActionWithTrace(targets, car, cellMap, policy, plan).action;
}
