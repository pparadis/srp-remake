import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import type { TargetInfo } from "./movementSystem";
import { computeMoveSpend } from "./moveBudgetSystem";
import { shouldOpenPitModal } from "./pitSystem";

export interface MoveValidationResult {
  ok: boolean;
  reason?: "no-cell" | "invalid-target" | "not-your-turn" | "inactive-car";
  info?: TargetInfo;
  moveSpend?: number;
  isPitStop?: boolean;
}

export function validateMoveAttempt(
  car: Car,
  fromCell: TrackCell | null,
  targetCell: TrackCell | null,
  validTargets: Map<string, TargetInfo>,
  canMove: boolean
): MoveValidationResult {
  if (!canMove) return { ok: false, reason: "not-your-turn" };
  if (car.state !== "ACTIVE") return { ok: false, reason: "inactive-car" };
  if (!fromCell) return { ok: false, reason: "no-cell" };
  if (!targetCell) return { ok: false, reason: "no-cell" };
  const info = validTargets.get(targetCell.id);
  if (!info) return { ok: false, reason: "invalid-target" };
  const moveSpend = info.moveSpend ?? computeMoveSpend(info.distance, fromCell.laneIndex, targetCell.laneIndex);
  const isPitStop = shouldOpenPitModal(car, targetCell);
  return { ok: true, info, moveSpend, isPitStop };
}
