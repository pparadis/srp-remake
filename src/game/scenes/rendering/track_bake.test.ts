import { describe, expect, it } from 'vitest';
import { MAX_TRACK_TEXTURE_PIXELS, trackBakeScale } from './track_bake';

describe('trackBakeScale', () => {
  it('is the screen scale when the texture fits', () => {
    expect(trackBakeScale({ w: 1000, h: 800, renderScale: 2, maxTextureSize: 16384 })).toBe(2);
  });

  it('keeps a big track under the pixel budget', () => {
    const k = trackBakeScale({ w: 2400, h: 1800, renderScale: 3 });
    expect(2400 * k * 1800 * k).toBeLessThanOrEqual(MAX_TRACK_TEXTURE_PIXELS + 1);
    expect(k).toBeLessThan(3);
  });

  it('keeps the longer side under the texture size WebGL allows', () => {
    const k = trackBakeScale({ w: 3000, h: 1000, renderScale: 3, maxTextureSize: 4096 });
    expect(3000 * k).toBeLessThanOrEqual(4096);
    expect(k).toBeCloseTo(4096 / 3000);
  });

  it('does not limit by the side when the size is unknown', () => {
    expect(trackBakeScale({ w: 3000, h: 1000, renderScale: 1 })).toBe(1);
  });
});
