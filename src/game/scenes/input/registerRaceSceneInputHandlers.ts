import type Phaser from "phaser";
import { validateMoveAttempt } from "../../systems/moveValidationSystem";
import type { TargetInfo } from "../../systems/movementSystem";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import type { PitModal } from "../ui/PitModal";
import { resolvePlayerDragDrop } from "../turns/resolvePlayerDragDrop";
import { easeAngle, spriteRotation } from "../rendering/heading";
import { onKeyDown } from "./onKeyDown";

/** How far a pointer may travel between press and release and still count as a tap, in screen pixels. */
const TAP_SLOP_PX = 10;

/** The share of the gap a dragged car turns toward the road each drag event (#110): smooth through a bend. */
const DRAG_TURN = 0.33;

interface RegisterRaceSceneInputHandlersParams {
  scene: Phaser.Scene;
  isRaceFinished: () => boolean;
  pitModal: PitModal;
  getActiveToken: () => Phaser.GameObjects.Container | null;
  getActiveCar: () => Car;
  getDragOrigin: () => { x: number; y: number } | null;
  setDragOrigin: (origin: { x: number; y: number } | null) => void;
  cellMap: Map<string, TrackCell>;
  getValidTargets: () => Map<string, TargetInfo>;
  activeHalos: Map<number, Phaser.GameObjects.Ellipse>;
  findNearestCell: (x: number, y: number, maxDist: number) => TrackCell | null;
  recomputeTargets: () => void;
  drawTargets: () => void;
  setHoverCell: (cell: TrackCell | null) => void;
  copyCellId: (cellId: string) => void;
  /** A press and release on the board without a drag, in world coordinates. */
  onTap?: (x: number, y: number) => void;
  toggleForwardIndexOverlay: () => void;
  openPitModal: (cell: TrackCell, origin: { x: number; y: number }) => void;
  onMove: (targetCellId: string) => void;
  /** A drop that is not a move: the board glides the car back to its own cell (a jump when moves are instant). */
  onReturn: () => void;
  canControlActiveCar?: () => boolean;
  onUnauthorizedControlAttempt?: () => void;
  // Sandbox edit mode: the sandbox handlers own dragging, the rules-checked drag below stands aside.
  isSuspended?: () => boolean;
  hoverMaxDist: number;
  dragSnapDist: number;
}

export function registerRaceSceneInputHandlers(params: RegisterRaceSceneInputHandlersParams): void {
  const {
    scene,
    isRaceFinished,
    pitModal,
    getActiveToken,
    getActiveCar,
    getDragOrigin,
    setDragOrigin,
    cellMap,
    getValidTargets,
    activeHalos,
    findNearestCell,
    recomputeTargets,
    drawTargets,
    setHoverCell,
    copyCellId,
    onTap,
    toggleForwardIndexOverlay,
    openPitModal,
    onMove,
    onReturn,
    canControlActiveCar,
    onUnauthorizedControlAttempt,
    isSuspended,
    hoverMaxDist,
    dragSnapDist
  } = params;

  scene.input.on("dragstart", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
    if (isSuspended?.()) return;
    if (isRaceFinished()) return;
    if (pitModal.isActive()) return;
    const token = getActiveToken();
    if (!token || obj !== token) return;
    if (canControlActiveCar && !canControlActiveCar()) {
      onUnauthorizedControlAttempt?.();
      return;
    }
    recomputeTargets();
    drawTargets();
    setDragOrigin({ x: token.x, y: token.y });
  });

  scene.input.on(
    "drag",
    (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      if (isSuspended?.()) return;
      if (isRaceFinished()) return;
      if (pitModal.isActive()) return;
      const token = getActiveToken();
      if (!token || obj !== token) return;
      if (canControlActiveCar && !canControlActiveCar()) return;
      token.setPosition(x, y);
      const activeCar = getActiveCar();
      const halo = activeHalos.get(activeCar.carId);
      if (halo) halo.setPosition(x, y);
      // Turn with the road under the finger, the direction of travel whichever way it is dragged; off the track the car
      // keeps its rotation.
      const road = findNearestCell(x, y, hoverMaxDist);
      const body = token.first as Phaser.GameObjects.Image;
      if (road && body) body.setRotation(easeAngle(body.rotation, spriteRotation(road, cellMap), DRAG_TURN));
    }
  );

  scene.input.on("dragend", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
    if (isSuspended?.()) return;
    if (isRaceFinished()) return;
    if (pitModal.isActive()) return;
    const token = getActiveToken();
    if (!token || obj !== token) return;
    if (canControlActiveCar && !canControlActiveCar()) {
      onUnauthorizedControlAttempt?.();
      const activeCar = getActiveCar();
      if (cellMap.get(activeCar.cellId)) onReturn();
      setDragOrigin(null);
      return;
    }
    const origin = getDragOrigin() ?? { x: token.x, y: token.y };
    const nearestCell = findNearestCell(token.x, token.y, dragSnapDist);
    const activeCar = getActiveCar();
    const fromCell = cellMap.get(activeCar.cellId) ?? null;
    const validation = validateMoveAttempt(
      activeCar,
      fromCell,
      nearestCell,
      getValidTargets(),
      obj === token
    );
    resolvePlayerDragDrop({
      activeCar,
      token,
      origin,
      nearestCell,
      validation,
      cellMap,
      activeHalo: activeHalos.get(activeCar.carId) ?? null,
      onOpenPitModal: openPitModal,
      onMove,
      onReturn,
      // the board glides the car from where it was dropped onto the cell (#110)
      glideMove: true
    });
    setDragOrigin(null);
  });

  scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
    const cell = findNearestCell(pointer.worldX, pointer.worldY, hoverMaxDist);
    setHoverCell(cell);
  });

  scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
    const cell = findNearestCell(pointer.worldX, pointer.worldY, hoverMaxDist);
    if (!cell) return;
    copyCellId(cell.id);
    recomputeTargets();
    drawTargets();
  });

  // A tap (no drag between press and release) picks a target to confirm: the way to move on a touchscreen.
  scene.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
    if (!onTap || pointer.getDistance() > TAP_SLOP_PX) return;
    if (isSuspended?.() || isRaceFinished() || pitModal.isActive()) return;
    onTap(pointer.worldX, pointer.worldY);
  });

  onKeyDown(scene, "F", () => {
    toggleForwardIndexOverlay();
  });

}
