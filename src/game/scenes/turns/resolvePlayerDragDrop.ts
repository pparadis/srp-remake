import type Phaser from "phaser";
import { PIT_LANE } from "../../constants";
import { applyMove } from "../../systems/moveCommitSystem";
import { type MoveValidationResult } from "../../systems/moveValidationSystem";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import type { TargetInfo } from "../../systems/movementSystem";

export interface ResolvePlayerDragDropParams {
  activeCar: Car;
  token: Phaser.GameObjects.Container;
  origin: { x: number; y: number };
  nearestCell: TrackCell | null;
  validation: MoveValidationResult;
  cellMap: Map<string, TrackCell>;
  activeHalo: Phaser.GameObjects.Ellipse | null;
  onOpenPitModal: (cell: TrackCell, origin: { x: number; y: number }, originCellId: string, distance: number) => void;
  onLog: (line: string) => void;
  onAdvanceTurnAndRefresh: () => void;
}

export function resolvePlayerDragDrop(params: ResolvePlayerDragDropParams): void {
  const {
    activeCar,
    token,
    origin,
    nearestCell,
    validation,
    cellMap,
    activeHalo,
    onOpenPitModal,
    onLog,
    onAdvanceTurnAndRefresh
  } = params;

  if (validation.ok && nearestCell && validation.info && validation.moveSpend != null) {
    const info: TargetInfo = validation.info;
    const prevCellId = activeCar.cellId;
    activeCar.cellId = nearestCell.id;
    token.setPosition(nearestCell.pos.x, nearestCell.pos.y);
    activeCar.pitExitBoost = false;
    if (nearestCell.laneIndex !== PIT_LANE) {
      activeCar.pitServiced = false;
    }
    if (validation.isPitStop) {
      onOpenPitModal(nearestCell, origin, prevCellId, validation.moveSpend);
      return;
    }
    const fromCell = cellMap.get(prevCellId);
    if (fromCell) {
      applyMove(activeCar, fromCell, nearestCell, info, validation.moveSpend);
    } else {
      applyMove(activeCar, nearestCell, nearestCell, info, validation.moveSpend);
    }
    onLog(`Car ${activeCar.carId} moved to ${nearestCell.id}.`);
    onAdvanceTurnAndRefresh();
    return;
  }

  const currentCell = cellMap.get(activeCar.cellId);
  if (currentCell) {
    token.setPosition(currentCell.pos.x, currentCell.pos.y);
    if (activeHalo) activeHalo.setPosition(currentCell.pos.x, currentCell.pos.y);
    return;
  }

  token.setPosition(origin.x, origin.y);
  if (activeHalo) activeHalo.setPosition(origin.x, origin.y);
}
