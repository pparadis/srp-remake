// Phaser 3.90 has no `resolution` option, so on a high-density screen (a phone) a canvas the size of its CSS box is
// stretched by the browser and looks blurry. Instead the game is `renderScale()` times bigger than its container in
// canvas pixels and shown at 1 / renderScale() (Scale `zoom`): everything is drawn at the screen's real resolution.
// Capped at 2: an iPhone's 3x would cost 2.25x the pixels again for little visible gain on this board.
const MAX_RENDER_SCALE = 2;

/** Canvas pixels per CSS pixel (1 on a regular screen). Scene layout in canvas pixels multiplies CSS sizes by this. */
export function renderScale(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(MAX_RENDER_SCALE, Math.max(1, dpr));
}

/** Text is rasterised to its own canvas, at this resolution (Phaser's default of 1 would stay blurry). */
export const TEXT_RESOLUTION = renderScale();
