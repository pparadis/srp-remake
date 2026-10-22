// Phaser 3.90 has no `resolution` option, so on a high-density screen (a phone) a canvas the size of its CSS box is
// stretched by the browser and looks blurry. With `?hidpi` in the URL the game is `renderScale()` times bigger than its
// container in canvas pixels and shown at 1 / renderScale() (Scale NONE + `zoom`), so it is drawn at the screen's real
// resolution. On by default since #157 (`?hidpi=0` turns it off): when it was first turned on (#58) the race scene
// never started on an iPhone 17, but later (#88) it ran there at 2x. Capped at 3, the iPhone's density: the track
// bakes to about 3264x1854, far under iOS's canvas limit (~16M px).
const MAX_RENDER_SCALE = 3;

let enabled = false;

/** Set by `startGame` before the game is built (main.ts reads `?hidpi` once at page load: the router drops the query). */
export function setHidpi(on: boolean): void {
  enabled = on;
}

/** Canvas pixels per CSS pixel: 1 unless `?hidpi`. Scene layout in canvas pixels multiplies CSS sizes by this. */
export function renderScale(): number {
  if (!enabled) return 1;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(1, dpr));
}

/** Text is rasterised to its own canvas, at this resolution (Phaser's default of 1 would stay blurry). */
export function textResolution(): number {
  return renderScale();
}
