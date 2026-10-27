// The game renders with WebGL only (#232, #237), so a browser without it cannot play. Asked before the game chunk loads,
// and before a lobby is created or joined, so the player gets a sentence on the home screen instead of a Phaser error
// box, a blank board or a seat in a race they cannot watch.

export const NO_WEBGL_MESSAGE =
  'This game needs WebGL, which this browser or device does not offer.';

/** Whether this canvas gets a WebGL context. 'webgl' because that is the one Phaser 4 asks for. */
export function canvasHasWebgl(canvas: () => HTMLCanvasElement): boolean {
  try {
    return canvas().getContext('webgl') !== null;
  } catch {
    return false;
  }
}

let cached: boolean | undefined;

/**
 * The page's answer, kept: it cannot change while the page is open, and each probe would leave a live context behind
 * (browsers allow about 16 and drop the oldest, which could be the game's).
 */
export function webglSupported(): boolean {
  cached ??= canvasHasWebgl(() => document.createElement('canvas'));
  return cached;
}
