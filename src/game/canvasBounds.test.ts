import { afterEach, describe, expect, it, vi } from "vitest";
import { keepCanvasBoundsFresh, type BoundsGame } from "./canvasBounds";

// A game whose canvas sits at `rect` while Phaser still caches `cached`.
function fakeGame(rect: { x: number; y: number }, cached: { x: number; y: number }) {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, 1280, 720);
  const destroy: (() => void)[] = [];
  const game: BoundsGame = {
    canvas,
    scale: { canvasBounds: { ...cached }, updateBounds: vi.fn() },
    events: { once: (_name, fn) => destroy.push(fn) }
  };
  return { game, rect, destroy: () => destroy.forEach((fn) => fn()) };
}

describe("keepCanvasBoundsFresh", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => cleanup?.());

  it("re-measures before a mouse or touch event when the canvas moved (issue #41: cached top 724, real top 0)", () => {
    const { game, destroy } = fakeGame({ x: 0, y: 0 }, { x: 0, y: 724 });
    cleanup = destroy;
    keepCanvasBoundsFresh(game);
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(game.scale.updateBounds).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("touchstart"));
    expect(game.scale.updateBounds).toHaveBeenCalledTimes(2); // the fake updateBounds does not update the cache
  });

  it("leaves the bounds alone when the canvas has not moved", () => {
    const { game, destroy } = fakeGame({ x: 0, y: 0 }, { x: 0, y: 0 });
    cleanup = destroy;
    keepCanvasBoundsFresh(game);
    window.dispatchEvent(new MouseEvent("mousedown"));
    expect(game.scale.updateBounds).not.toHaveBeenCalled();
  });

  it("runs before a listener on the canvas", () => {
    const { game, destroy } = fakeGame({ x: 0, y: 0 }, { x: 0, y: 724 });
    cleanup = destroy;
    keepCanvasBoundsFresh(game);
    document.body.append(game.canvas!);
    const order: string[] = [];
    (game.scale.updateBounds as ReturnType<typeof vi.fn>).mockImplementation(() =>
      order.push("bounds")
    );
    game.canvas!.addEventListener("mousedown", () => order.push("phaser"));
    game.canvas!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(order).toEqual(["bounds", "phaser"]);
    game.canvas!.remove();
  });

  it("stops listening once the game is destroyed, and waits for the canvas before that", () => {
    const { game, destroy } = fakeGame({ x: 0, y: 0 }, { x: 0, y: 724 });
    const canvas = game.canvas;
    game.canvas = undefined; // not booted yet
    keepCanvasBoundsFresh(game);
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(game.scale.updateBounds).not.toHaveBeenCalled();
    game.canvas = canvas;
    destroy();
    window.dispatchEvent(new MouseEvent("mousemove"));
    expect(game.scale.updateBounds).not.toHaveBeenCalled();
  });
});
