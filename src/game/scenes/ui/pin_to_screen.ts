interface Scrollable {
  setScrollFactor(x: number, y?: number): unknown;
}

function isScrollable(obj: object): obj is Scrollable {
  return 'setScrollFactor' in obj && typeof obj.setScrollFactor === 'function';
}

/** Fixes a game object to the screen, so the zoomed camera does not move it. Objects without a scroll factor stay. */
export function pinToScreen(obj: object) {
  if (isScrollable(obj)) obj.setScrollFactor(0);
}
