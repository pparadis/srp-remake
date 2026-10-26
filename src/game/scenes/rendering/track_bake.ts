// How sharp the baked track texture can be. Phaser-free, so the limits are testable.

// The baked track is one texture; iOS refuses a canvas over 16 777 216 px, so keep well under (2x the big oval is 7M).
export const MAX_TRACK_TEXTURE_PIXELS = 14_000_000;

/**
 * Texture pixels per world unit for a track `w` x `h` units big: the screen's scale, less where the whole texture would
 * pass the pixel budget or `maxTextureSize` (WebGL's limit for one side of a texture, often 4096 on a phone; unknown =
 * no limit). A little less sharp, not blank.
 */
export function trackBakeScale(params: {
  w: number;
  h: number;
  renderScale: number;
  maxTextureSize?: number | undefined;
}): number {
  const { w, h, renderScale, maxTextureSize = Infinity } = params;
  return Math.min(
    renderScale,
    Math.sqrt(MAX_TRACK_TEXTURE_PIXELS / (w * h)),
    maxTextureSize / Math.max(w, h)
  );
}
