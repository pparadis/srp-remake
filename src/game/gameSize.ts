/** What `keepGameSizeInSync` needs of a Phaser game (a narrow shape, so it is testable without Phaser). */
export interface SizedGame {
  scale: {
    gameSize: { width: number; height: number };
    resize: (width: number, height: number) => void;
  };
  events: { once: (event: string, fn: () => void) => void };
}

// The game uses Phaser's NONE scale mode (see `hidpi.ts`: the canvas is `scale` times its container, shown at 1 / scale),
// so nothing in Phaser follows the container: this does. It also covers a phone rotation, where Phaser's own
// RESIZE mode could stay at the old size (its `orientationchange` handler read the new container size into a cache
// without applying it; started in portrait and turned to landscape, the game stayed 390x844 in an 844x390 window).

/**
 * Resizes the game to the container's size times `scale` whenever the two differ. Stops watching when the game is
 * destroyed.
 */
export function keepGameSizeInSync(
  game: SizedGame,
  parent: Element,
  scale = 1,
  destroyEvent = "destroy"
): void {
  const observer = new ResizeObserver(() => {
    const rect = parent.getBoundingClientRect();
    const width = Math.floor(rect.width * scale);
    const height = Math.floor(rect.height * scale);
    if (width <= 0 || height <= 0) return;
    const size = game.scale.gameSize;
    if (width === size.width && height === size.height) return;
    game.scale.resize(width, height); // resizes the canvas and emits RESIZE, so the scene refits the track
  });
  observer.observe(parent);
  game.events.once(destroyEvent, () => observer.disconnect());
}
