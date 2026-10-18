import { describe, expect, it } from 'vitest';
import { GLIDE, glideCap, glideDuration } from './glide';

describe('glideDuration', () => {
  it('grows with the move and stays between the minimum and the cap', () => {
    expect(glideDuration(1)).toBe(185);
    expect(glideDuration(4)).toBe(320);
    expect(glideDuration(9)).toBe(520);
    expect(glideDuration(0)).toBe(GLIDE.minMs);
    expect(glideDuration(30)).toBe(GLIDE.maxMs);
    expect(glideDuration(9, 300)).toBe(300);
    expect(glideDuration(1, 100)).toBe(GLIDE.minMs);
  });
});

describe('glideCap', () => {
  it('lets a lone move take its time and squeezes a crowded round into about a second and a half', () => {
    expect(glideCap(0)).toBe(GLIDE.maxMs);
    expect(glideCap(1)).toBe(GLIDE.maxMs);
    expect(glideCap(3)).toBe(500);
    expect(glideCap(5)).toBe(300);
    expect(glideCap(50)).toBe(GLIDE.minMs);
    for (const n of [2, 3, 4, 5, 6]) expect(n * glideCap(n)).toBeLessThanOrEqual(GLIDE.roundMs);
  });
});
