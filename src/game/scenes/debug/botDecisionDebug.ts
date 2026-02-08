import type { Car } from "../../types/car";
import type { TargetInfo } from "../../systems/movementSystem";
import type { BotDecisionTrace } from "../../systems/botSystem";

export interface BotDecisionLogEntry {
  seq: number;
  turnIndex: number;
  carId: number;
  fromCellId: string;
  state: Car["state"];
  tire: number;
  fuel: number;
  pitServiced: boolean;
  validTargets: Array<{
    cellId: string;
    distance: number;
    tireCost: number;
    fuelCost: number;
    isPitTrigger: boolean;
  }>;
  action: {
    type: "skip" | "pit" | "move";
    targetCellId?: string;
    moveSpend?: number;
    note?: string;
  };
  trace: {
    lowResources: boolean;
    heuristics: { lowResourceThreshold: number; pitBonus: number; pitPenalty: number };
    selectedCellId: string | null;
    candidates: Array<{
      cellId: string;
      score: number;
      distance: number;
      tireCost: number;
      fuelCost: number;
      isPitTrigger: boolean;
    }>;
  } | null;
}

export type BotDecisionShortLogEntry = Omit<BotDecisionLogEntry, "validTargets" | "trace">;

export interface BotDecisionSnapshot {
  version: string;
  gitSha: string;
  trackId: string;
  botDecisionCount: number;
  shortMode: boolean;
  botDecisions: Array<BotDecisionLogEntry | BotDecisionShortLogEntry>;
}

export function serializeBotTargets(targets: Map<string, TargetInfo>): BotDecisionLogEntry["validTargets"] {
  return Array.from(targets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cellId, info]) => ({
      cellId,
      distance: info.distance,
      tireCost: info.tireCost,
      fuelCost: info.fuelCost,
      isPitTrigger: info.isPitTrigger
    }));
}

export function serializeBotTrace(trace: BotDecisionTrace | null): BotDecisionLogEntry["trace"] {
  if (!trace) return null;
  return {
    lowResources: trace.lowResources,
    heuristics: { ...trace.heuristics },
    selectedCellId: trace.selectedCellId,
    candidates: trace.candidates.map((candidate) => ({
      cellId: candidate.cellId,
      score: candidate.score,
      distance: candidate.info.distance,
      tireCost: candidate.info.tireCost,
      fuelCost: candidate.info.fuelCost,
      isPitTrigger: candidate.info.isPitTrigger
    }))
  };
}

export function appendBotDecisionEntry(
  log: BotDecisionLogEntry[],
  logLimit: number,
  seq: number,
  turnIndex: number,
  activeCar: Pick<Car, "carId" | "cellId" | "state" | "tire" | "fuel" | "pitServiced">,
  entry: Omit<BotDecisionLogEntry, "seq" | "turnIndex" | "carId" | "fromCellId" | "state" | "tire" | "fuel" | "pitServiced">,
  fromCellId?: string
): number {
  log.push({
    seq,
    turnIndex,
    carId: activeCar.carId,
    fromCellId: fromCellId ?? activeCar.cellId,
    state: activeCar.state,
    tire: activeCar.tire,
    fuel: activeCar.fuel,
    pitServiced: activeCar.pitServiced,
    ...entry
  });
  if (log.length > logLimit) {
    log.shift();
  }
  return seq + 1;
}

export function toShortBotDecisionLogEntry(entry: BotDecisionLogEntry): BotDecisionShortLogEntry {
  const { validTargets: _validTargets, trace: _trace, ...shortEntry } = entry;
  return shortEntry;
}

export function buildBotDecisionSnapshot(
  buildInfo: { version: string; gitSha: string },
  trackId: string,
  log: BotDecisionLogEntry[],
  shortMode = false
): BotDecisionSnapshot {
  return {
    version: buildInfo.version,
    gitSha: buildInfo.gitSha,
    trackId,
    botDecisionCount: log.length,
    shortMode,
    botDecisions: shortMode ? log.map((entry) => toShortBotDecisionLogEntry(entry)) : log
  };
}
