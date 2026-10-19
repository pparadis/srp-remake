import { describe, expect, it } from 'vitest';
import { badgeTexture } from './baked_textures';

// The number badge is a 12-unit texture with an 11-unit disc: a two-digit number (cars 10 and 11) at the one-digit font
// ran over the disc's edge onto the car's windscreen. A fake canvas context records what is drawn.
function bakeBadge(carId: number) {
  const calls: { text: string; font: string; maxWidth: number | undefined }[] = [];
  const ctx = {
    font: '',
    scale: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    fillText(text: string, _x: number, _y: number, maxWidth?: number) {
      calls.push({ text, font: this.font, maxWidth });
    }
  };
  const scene = {
    textures: {
      exists: () => false,
      createCanvas: () => ({ getContext: () => ctx, refresh: () => {} })
    }
  };
  badgeTexture(scene as never, carId);
  return calls[0]!;
}

describe('badgeTexture', () => {
  it('draws one digit at 9px with no width cap', () => {
    expect(bakeBadge(7)).toEqual({ text: '7', font: '9px monospace', maxWidth: undefined });
  });

  it('draws two digits smaller and capped to fit inside the disc (cars 10 and 11)', () => {
    for (const id of [10, 11]) {
      const call = bakeBadge(id);
      expect(call.text).toBe(String(id));
      expect(call.font).toBe('8px monospace');
      expect(call.maxWidth).toBeLessThan(11); // the disc is 11 across
    }
  });
});
