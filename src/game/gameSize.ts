/** What `keepGameSizeInSync` needs of a Phaser game (a narrow shape, so it is testable without Phaser). */
export interface SizedGame {
  scale: {
    gameSize: { width: number; height: number };
    getParentBounds: () => boolean;
    refresh: () => void;
  };
  events: { once: (event: string, fn: () => void) => void };
}

// Phaser's RESIZE mode follows its container, but on a touch device it can end up at the old size after a rotation
// and stay there: the `orientationchange` handler calls refresh() with the old cached parent size, refresh() ends by
// reading the new container size into that cache without applying it, and the 500 ms check (ScaleManager.step) then
// compares the container with the already updated cache and sees no change. Started in portrait and turned to
// landscape, the game stayed 390x844 in an 844x390 window and the track was laid out for a tall screen.

/**
 * Applies the container's size to the game whenever the two differ, whatever Phaser's own bookkeeping says.
 * Stops watching when the game is destroyed.
 */
export function keepGameSizeInSync(
  game: SizedGame,
  parent: Element,
  destroyEvent = "destroy"
): void {
  const observer = new ResizeObserver(() => {
    const { scale } = game;
    const rect = parent.getBoundingClientRect();
    // Phaser floors the size it applies (autoRound), so compare against the floored container size
    if (
      Math.floor(rect.width) === scale.gameSize.width &&
      Math.floor(rect.height) === scale.gameSize.height
    )
      return;
    scale.getParentBounds(); // read the container into Phaser's parent size...
    scale.refresh(); // ...and apply it: resizes the canvas and emits RESIZE, so the scene refits the track
  });
  observer.observe(parent);
  game.events.once(destroyEvent, () => observer.disconnect());
}
