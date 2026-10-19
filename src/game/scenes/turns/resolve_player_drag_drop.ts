import type Phaser from 'phaser';
import { type MoveValidationResult } from '../../systems/move_validation_system';
import type { Car } from '../../types/car';
import type { TrackCell } from '../../types/track';

interface ResolvePlayerDragDropParams {
  activeCar: Car;
  token: Phaser.GameObjects.Container;
  origin: { x: number; y: number };
  nearestCell: TrackCell | null;
  validation: MoveValidationResult;
  cellMap: Map<string, TrackCell>;
  activeHalo: Phaser.GameObjects.Ellipse | null;
  onOpenPitModal: (cell: TrackCell, origin: { x: number; y: number }) => void;
  onMove: (targetCellId: string) => void;
  /** The board glides the token to the target instead of snapping it there: from its own cell (a tap) or from where it was dropped. */
  glideMove?: boolean;
  /** A refused drop: the board glides the token back to its own cell. Without it the token is put back at once. */
  onReturn?: () => void;
}

// Decides what a drop means. It never changes the car: a move is handed to
// `onMove` (the race engine applies it), a pit stop opens the setup modal first.
export function resolvePlayerDragDrop(params: ResolvePlayerDragDropParams): void {
  const { activeCar, token, origin, nearestCell, validation, cellMap, activeHalo } = params;

  if (validation.ok && nearestCell && validation.info && validation.moveSpend != null) {
    if (validation.isPitStop) {
      token.setPosition(nearestCell.pos.x, nearestCell.pos.y);
      params.onOpenPitModal(nearestCell, origin);
      return;
    }
    if (!params.glideMove) token.setPosition(nearestCell.pos.x, nearestCell.pos.y);
    params.onMove(nearestCell.id);
    return;
  }

  const currentCell = cellMap.get(activeCar.cellId);
  if (currentCell && params.onReturn) {
    params.onReturn();
    return;
  }
  if (currentCell) {
    token.setPosition(currentCell.pos.x, currentCell.pos.y);
    if (activeHalo) activeHalo.setPosition(currentCell.pos.x, currentCell.pos.y);
    return;
  }

  token.setPosition(origin.x, origin.y);
  if (activeHalo) activeHalo.setPosition(origin.x, origin.y);
}
