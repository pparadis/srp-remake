/** What `keepGameSizeInSync` needs of a Phaser game (a narrow shape, so it is testable without Phaser). */
export interface SizedGame {
  scale: {
    gameSize: { width: number; height: number };
    getParentBounds: () => boolean;
    refresh: () => void;
    resize: (width: number, height: number) => void;
  };
  events: { once: (event: string, fn: () => void) => void };
}

// Phaser's RESIZE mode follows its container, but on a touch device it can end up at the old size after a rotation
// and stay there: the `orientationchange` handler calls refresh() with the old cached parent size, refresh() ends by
// reading the new container size into that cache without applying it, and the 500 ms check (ScaleManager.step) then
// compares the container with the already updated cache and sees no change. Started in portrait and turned to
// landscape, the game stayed 390x844 in an 844x390 window and the track was laid out for a tall screen.
// With `?hidpi` (scale > 1, see hidpi.ts) the game is in NONE mode and nothing in Phaser follows the container: this
// resizes it to the container times `scale`.

/**
 * Applies the container's size (times `scale`) to the game whenever the two differ, whatever Phaser's own
 * bookkeeping says. Stops watching when the game is destroyed.
 */
export function keepGameSizeInSync(
  game: SizedGame,
  parent: Element,
  scale = 1,
  destroyEvent = 'destroy'
): void {
  const observer = new ResizeObserver(() => {
    const rect = parent.getBoundingClientRect();
    // Phaser floors the size it applies (autoRound), so compare against the floored container size
    const width = Math.floor(rect.width * scale);
    const height = Math.floor(rect.height * scale);
    const size = game.scale.gameSize;
    if (width === size.width && height === size.height) return;
    // A hidden container (the race screen is left) has no size: Canvas shrugs, but WebGL cannot make a 0x0 framebuffer
    // ("Framebuffer status: Incomplete Attachment", #232).
    if (width === 0 || height === 0) return;
    if (scale === 1) {
      game.scale.getParentBounds(); // read the container into Phaser's parent size...
      game.scale.refresh(); // ...and apply it: resizes the canvas and emits RESIZE, so the scene refits the track
    } else {
      game.scale.resize(width, height); // resizes the canvas and emits RESIZE, so the scene refits the track
    }
  });
  observer.observe(parent);
  game.events.once(destroyEvent, () => observer.disconnect());
}
