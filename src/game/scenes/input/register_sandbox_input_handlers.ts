import type Phaser from 'phaser';
import type { TrackCell } from '../../types/track';
import { isTypingTarget } from '../../../ui/typing';
import { onKeyDown } from './onKeyDown';

interface RegisterSandboxInputHandlersParams {
  scene: Phaser.Scene;
  isEditing: () => boolean;
  carIdOfToken: (obj: Phaser.GameObjects.GameObject) => number | null;
  // Token and halo follow the pointer while dragging.
  moveToken: (carId: number, x: number, y: number) => void;
  findNearestCell: (x: number, y: number, maxDist: number) => TrackCell | null;
  onSelect: (carId: number) => void;
  onDrop: (carId: number, cell: TrackCell | null) => void;
  onToggleEditing: () => void;
  snapDist: number;
}

// Sandbox edit mode: press a car to make it the one to play, drag any car to any cell (the engine's rules do not apply).
export function registerSandboxInputHandlers(params: RegisterSandboxInputHandlersParams): void {
  const {
    scene,
    isEditing,
    carIdOfToken,
    moveToken,
    findNearestCell,
    onSelect,
    onDrop,
    onToggleEditing,
    snapDist
  } = params;

  scene.input.on(
    'gameobjectdown',
    (_pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      const carId = isEditing() ? carIdOfToken(obj) : null;
      if (carId !== null) onSelect(carId);
    }
  );

  scene.input.on(
    'drag',
    (_pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      const carId = isEditing() ? carIdOfToken(obj) : null;
      if (carId !== null) moveToken(carId, x, y);
    }
  );

  scene.input.on(
    'dragend',
    (_pointer: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      const carId = isEditing() ? carIdOfToken(obj) : null;
      if (carId === null) return;
      const token = obj as Phaser.GameObjects.Container;
      onDrop(carId, findNearestCell(token.x, token.y, snapDist));
    }
  );

  // The canvas swallows the press, so a panel field would keep the focus (and the "E" key) after a click on the board.
  scene.input.on('pointerdown', () => {
    if (isTypingTarget()) (document.activeElement as HTMLElement).blur();
  });

  // onKeyDown skips keys typed in a panel field, so an "e" typed there is not a toggle
  onKeyDown(scene, 'E', () => onToggleEditing());
}
