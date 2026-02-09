import type Phaser from "phaser";
import { validateMoveAttempt } from "../../systems/moveValidationSystem";
import type { TargetInfo } from "../../systems/movementSystem";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import type { PitModal } from "../ui/PitModal";
import { resolvePlayerDragDrop, type ResolvePlayerDragDropParams } from "../turns/resolvePlayerDragDrop";
import type { BackendTurnAction } from "../../../net/backendApi";

export interface RegisterRaceSceneInputHandlersParams {
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
  makeHudText: (cell: TrackCell | null) => string;
  setHudText: (text: string) => void;
  copyCellId: (cellId: string) => void;
  toggleForwardIndexOverlay: () => void;
  openPitModal: (
    cell: TrackCell,
    origin: { x: number; y: number },
    originCellId: string,
    distance: number
  ) => void;
  addLog: (line: string) => void;
  advanceTurnAndRefresh: () => void;
  onTurnAction?: (action: BackendTurnAction) => void;
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
    makeHudText,
    setHudText,
    copyCellId,
    toggleForwardIndexOverlay,
    openPitModal,
    addLog,
    advanceTurnAndRefresh,
    onTurnAction,
    hoverMaxDist,
    dragSnapDist
  } = params;

  scene.input.on("dragstart", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
    if (isRaceFinished()) return;
    if (pitModal.isActive()) return;
    const token = getActiveToken();
    if (!token || obj !== token) return;
    recomputeTargets();
    drawTargets();
    setDragOrigin({ x: token.x, y: token.y });
  });

  scene.input.on(
    "drag",
    (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      if (isRaceFinished()) return;
      if (pitModal.isActive()) return;
      const token = getActiveToken();
      if (!token || obj !== token) return;
      token.setPosition(x, y);
      const activeCar = getActiveCar();
      const halo = activeHalos.get(activeCar.carId);
      if (halo) halo.setPosition(x, y);
    }
  );

  scene.input.on("dragend", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
    if (isRaceFinished()) return;
    if (pitModal.isActive()) return;
    const token = getActiveToken();
    if (!token || obj !== token) return;
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
    const dropParams: ResolvePlayerDragDropParams = {
      activeCar,
      token,
      origin,
      nearestCell,
      validation,
      cellMap,
      activeHalo: activeHalos.get(activeCar.carId) ?? null,
      onOpenPitModal: (cell, dragOrigin, originCellId, distance) => {
        openPitModal(cell, dragOrigin, originCellId, distance);
      },
      onLog: (line) => addLog(line),
      onAdvanceTurnAndRefresh: () => advanceTurnAndRefresh()
    };
    if (onTurnAction) {
      resolvePlayerDragDrop({
        ...dropParams,
        onTurnAction
      });
    } else {
      resolvePlayerDragDrop(dropParams);
    }
    setDragOrigin(null);
  });

  scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
    const cell = findNearestCell(pointer.worldX, pointer.worldY, hoverMaxDist);
    setHudText(makeHudText(cell));
  });

  scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
    const cell = findNearestCell(pointer.worldX, pointer.worldY, hoverMaxDist);
    if (!cell) return;
    copyCellId(cell.id);
    recomputeTargets();
    drawTargets();
  });

  scene.input.keyboard?.on("keydown-F", () => {
    toggleForwardIndexOverlay();
  });

  setHudText(makeHudText(null));
}
