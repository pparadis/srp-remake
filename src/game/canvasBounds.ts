/** What `keepCanvasBoundsFresh` needs of a Phaser game (a narrow shape, so it is testable without Phaser). */
export interface BoundsGame {
  /** Unset until the game has booted. */
  canvas: HTMLCanvasElement | undefined;
  scale: { canvasBounds: { x: number; y: number }; updateBounds: () => void };
  events: { once: (event: string, fn: () => void) => void };
}

// Phaser computes a pointer's canvas position from the page position and its cached canvas bounds, once, when the
// DOM event arrives. It re-reads those bounds only every 500 ms (ScaleManager.step), so an event that lands right
// after the canvas moved (a new race laid out, a phone turned) places the pointer where the canvas was, and it stays
// there until the next event: a press then misses the token (issue #41: pointer y -284 while the mouse was at 440).
const EVENTS = [
  "mousedown",
  "mousemove",
  "mouseup",
  "touchstart",
  "touchmove",
  "touchend"
] as const;

/**
 * Re-measures the canvas before Phaser sees each mouse or touch event, when it moved since Phaser last looked.
 * Listens on `window` in the capture phase, which runs before Phaser's own listeners; stops when the game is destroyed.
 */
export function keepCanvasBoundsFresh(game: BoundsGame, destroyEvent = "destroy"): void {
  const check = () => {
    if (!game.canvas) return;
    const rect = game.canvas.getBoundingClientRect();
    const bounds = game.scale.canvasBounds;
    // the same page coordinates ScaleManager.updateBounds() stores
    const x = rect.left + (window.pageXOffset || 0) - (document.documentElement.clientLeft || 0);
    const y = rect.top + (window.pageYOffset || 0) - (document.documentElement.clientTop || 0);
    if (x !== bounds.x || y !== bounds.y) game.scale.updateBounds();
  };
  for (const name of EVENTS) window.addEventListener(name, check, { capture: true, passive: true });
  game.events.once(destroyEvent, () => {
    for (const name of EVENTS) window.removeEventListener(name, check, { capture: true });
  });
}
