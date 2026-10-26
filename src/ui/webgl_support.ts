// The game renders with WebGL only (#232, #237), so a browser without it cannot play. Asked before the game chunk loads,
// so the player gets a sentence on the home screen instead of a Phaser error box or a blank board.

export const NO_WEBGL_MESSAGE =
  'This game needs WebGL, which this browser or device does not offer.';

/** Whether a canvas can get a WebGL context. `makeCanvas` is for tests. */
export function webglSupported(
  makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')
): boolean {
  try {
    const canvas = makeCanvas();
    return (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) !== null;
  } catch {
    return false;
  }
}
