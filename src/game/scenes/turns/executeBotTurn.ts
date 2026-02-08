import { applyMove } from "../../systems/moveCommitSystem";
import { recordMove } from "../../systems/moveBudgetSystem";
import { applyPitStop } from "../../systems/pitSystem";
import { decideBotActionWithTrace } from "../../systems/botSystem";
import type { TargetInfo } from "../../systems/movementSystem";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import {
  type BotDecisionAppendEntry,
  serializeBotTargets,
  serializeBotTrace
} from "../debug/botDecisionDebug";

export interface ExecuteBotTurnParams {
  activeCar: Car;
  cellMap: Map<string, TrackCell>;
  computeTargetsForCar: (car: Car) => Map<string, TargetInfo>;
  appendBotDecision: (entry: BotDecisionAppendEntry, fromCellId?: string) => void;
  addLog: (line: string) => void;
  onPitStop: (cell: TrackCell) => void;
}

export function executeBotTurn(params: ExecuteBotTurnParams): TrackCell | null {
  const { activeCar, cellMap, computeTargetsForCar, appendBotDecision, addLog, onPitStop } = params;

  if (activeCar.state !== "ACTIVE") {
    appendBotDecision({
      validTargets: [],
      action: { type: "skip", note: "inactive" },
      trace: null
    });
    recordMove(activeCar.moveCycle, 0);
    addLog(`Car ${activeCar.carId} skipped (inactive).`);
    return null;
  }

  const targets = computeTargetsForCar(activeCar);
  const targetSnapshot = serializeBotTargets(targets);
  const decision = decideBotActionWithTrace(targets, activeCar, cellMap);
  const action = decision.action;
  const trace = serializeBotTrace(decision.trace);

  if (action.type === "skip") {
    appendBotDecision({
      validTargets: targetSnapshot,
      action: { type: "skip", note: "no-target" },
      trace
    });
    recordMove(activeCar.moveCycle, 0);
    addLog(`Car ${activeCar.carId} skipped (no moves).`);
    return null;
  }

  const fromCell = cellMap.get(activeCar.cellId);
  if (!fromCell) {
    appendBotDecision({
      validTargets: targetSnapshot,
      action: { type: "skip", note: "invalid-origin-cell" },
      trace
    });
    recordMove(activeCar.moveCycle, 0);
    addLog(`Car ${activeCar.carId} skipped (invalid target).`);
    return null;
  }

  if (action.type === "pit") {
    applyPitStop(activeCar, action.target.id, activeCar.setup);
    recordMove(activeCar.moveCycle, action.info.distance);
    appendBotDecision({
      validTargets: targetSnapshot,
      action: { type: "pit", targetCellId: action.target.id, moveSpend: action.info.distance },
      trace
    }, fromCell.id);
    onPitStop(action.target);
    return action.target;
  }

  applyMove(activeCar, fromCell, action.target, action.info, action.moveSpend);
  appendBotDecision({
    validTargets: targetSnapshot,
    action: { type: "move", targetCellId: action.target.id, moveSpend: action.moveSpend },
    trace
  }, fromCell.id);
  addLog(`Car ${activeCar.carId} moved to ${action.target.id}.`);
  return action.target;
}
