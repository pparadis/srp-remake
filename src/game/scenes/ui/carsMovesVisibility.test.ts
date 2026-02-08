import type Phaser from "phaser";
import { describe, expect, it, vi } from "vitest";
import { applyCarsMovesVisibility } from "./carsMovesVisibility";

function makeToken(setVisible: ReturnType<typeof vi.fn>): Phaser.GameObjects.Container {
  return {
    setVisible
  } as unknown as Phaser.GameObjects.Container;
}

function makeHalo(setVisible: ReturnType<typeof vi.fn>): Phaser.GameObjects.Ellipse {
  return {
    setVisible
  } as unknown as Phaser.GameObjects.Ellipse;
}

describe("applyCarsMovesVisibility", () => {
  it("hides cars and move markers when toggle is off", () => {
    const stop = vi.fn();
    const clear = vi.fn();
    const setActiveHaloTween = vi.fn();
    const clearTargetCostLabels = vi.fn();
    const setDraggable = vi.fn();
    const updateActiveCarVisuals = vi.fn();
    const drawTargets = vi.fn();
    const tokenAVisible = vi.fn();
    const tokenBVisible = vi.fn();
    const haloAVisible = vi.fn();
    const haloBVisible = vi.fn();
    const tokenA = makeToken(tokenAVisible);
    const tokenB = makeToken(tokenBVisible);
    const haloA = makeHalo(haloAVisible);
    const haloB = makeHalo(haloBVisible);

    applyCarsMovesVisibility({
      showCarsAndMoves: false,
      activeHaloTween: { stop } as unknown as Phaser.Tweens.Tween,
      setActiveHaloTween,
      gTargets: { clear } as unknown as Phaser.GameObjects.Graphics,
      clearTargetCostLabels,
      carTokens: new Map([
        [1, tokenA],
        [2, tokenB]
      ]),
      activeHalos: new Map([
        [1, haloA],
        [2, haloB]
      ]),
      setDraggable,
      updateActiveCarVisuals,
      drawTargets
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(setActiveHaloTween).toHaveBeenCalledWith(null);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clearTargetCostLabels).toHaveBeenCalledTimes(1);
    expect(tokenAVisible).toHaveBeenCalledWith(false);
    expect(tokenBVisible).toHaveBeenCalledWith(false);
    expect(setDraggable).toHaveBeenNthCalledWith(1, tokenA, false);
    expect(setDraggable).toHaveBeenNthCalledWith(2, tokenB, false);
    expect(haloAVisible).toHaveBeenCalledWith(false);
    expect(haloBVisible).toHaveBeenCalledWith(false);
    expect(updateActiveCarVisuals).not.toHaveBeenCalled();
    expect(drawTargets).not.toHaveBeenCalled();
  });

  it("shows cars and redraws targets when toggle is on", () => {
    const clear = vi.fn();
    const tokenAVisible = vi.fn();
    const tokenBVisible = vi.fn();
    const tokenA = makeToken(tokenAVisible);
    const tokenB = makeToken(tokenBVisible);
    const updateActiveCarVisuals = vi.fn();
    const drawTargets = vi.fn();

    applyCarsMovesVisibility({
      showCarsAndMoves: true,
      activeHaloTween: null,
      setActiveHaloTween: vi.fn(),
      gTargets: { clear } as unknown as Phaser.GameObjects.Graphics,
      clearTargetCostLabels: vi.fn(),
      carTokens: new Map([
        [1, tokenA],
        [2, tokenB]
      ]),
      activeHalos: new Map(),
      setDraggable: vi.fn(),
      updateActiveCarVisuals,
      drawTargets
    });

    expect(tokenAVisible).toHaveBeenCalledWith(true);
    expect(tokenBVisible).toHaveBeenCalledWith(true);
    expect(updateActiveCarVisuals).toHaveBeenCalledTimes(1);
    expect(drawTargets).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });
});
