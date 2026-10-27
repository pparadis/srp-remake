import { describe, expect, it } from 'vitest';
import { canvasHasWebgl } from './webgl_support';

const canvasWith = (getContext: (id: string) => unknown) =>
  ({ getContext }) as unknown as HTMLCanvasElement;

describe('canvasHasWebgl', () => {
  it('is true when the canvas gives a webgl context, and asks for the one Phaser uses', () => {
    const asked: string[] = [];
    expect(
      canvasHasWebgl(() =>
        canvasWith((id) => {
          asked.push(id);
          return {};
        })
      )
    ).toBe(true);
    expect(asked).toEqual(['webgl']);
  });

  it('is false when it is not available, or the browser throws', () => {
    expect(canvasHasWebgl(() => canvasWith(() => null))).toBe(false);
    expect(
      canvasHasWebgl(() =>
        canvasWith(() => {
          throw new Error('blocked');
        })
      )
    ).toBe(false);
  });
});
