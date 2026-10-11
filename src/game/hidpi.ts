// Phaser 3.90 has no `resolution` option, so on a high-density screen (a phone) a canvas the size of its CSS box is
// stretched by the browser and looks blurry. With `?hidpi` in the URL the game is `renderScale()` times bigger than its
// container in canvas pixels and shown at 1 / renderScale() (Scale NONE + `zoom`), so it is drawn at the screen's real
// resolution. Opt-in while it is tried on iPhone: turned on for everyone (#58), the race scene never started on an
// iPhone 17 and it did not reproduce in Chromium. Capped at 2: 3x would cost 2.25x the pixels again for little gain.
const MAX_RENDER_SCALE = 2;

let enabled = false;

/** Set by `startGame` before the game is built (main.ts reads `?hidpi` once at page load: the router drops the query). */
export function setHidpi(on: boolean): void {
  enabled = on;
}

/** Canvas pixels per CSS pixel: 1 unless `?hidpi`. Scene layout in canvas pixels multiplies CSS sizes by this. */
export function renderScale(): number {
  if (!enabled) return 1;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(1, dpr));
}

/** Text is rasterised to its own canvas, at this resolution (Phaser's default of 1 would stay blurry). */
export function textResolution(): number {
  return renderScale();
}
