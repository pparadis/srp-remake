import type Phaser from "phaser";

export interface ApplyCarsMovesVisibilityParams {
  showCarsAndMoves: boolean;
  activeHaloTween: Phaser.Tweens.Tween | null;
  setActiveHaloTween: (tween: Phaser.Tweens.Tween | null) => void;
  gTargets: Phaser.GameObjects.Graphics;
  clearTargetCostLabels: () => void;
  carTokens: Map<number, Phaser.GameObjects.Container>;
  activeHalos: Map<number, Phaser.GameObjects.Ellipse>;
  setDraggable: (token: Phaser.GameObjects.Container, isDraggable: boolean) => void;
  updateActiveCarVisuals: () => void;
  drawTargets: () => void;
}

export function applyCarsMovesVisibility(params: ApplyCarsMovesVisibilityParams): void {
  const {
    showCarsAndMoves,
    activeHaloTween,
    setActiveHaloTween,
    gTargets,
    clearTargetCostLabels,
    carTokens,
    activeHalos,
    setDraggable,
    updateActiveCarVisuals,
    drawTargets
  } = params;

  if (!showCarsAndMoves) {
    if (activeHaloTween) {
      activeHaloTween.stop();
      setActiveHaloTween(null);
    }
    gTargets.clear();
    clearTargetCostLabels();
    for (const token of carTokens.values()) {
      token.setVisible(false);
      setDraggable(token, false);
    }
    for (const halo of activeHalos.values()) {
      halo.setVisible(false);
    }
    return;
  }

  for (const token of carTokens.values()) {
    token.setVisible(true);
  }
  updateActiveCarVisuals();
  drawTargets();
}
