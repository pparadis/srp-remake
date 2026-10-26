import { describe, expect, it } from 'vitest';
import { webglSupported } from './webgl_support';

const canvasWith = (getContext: (id: string) => unknown) =>
  ({ getContext }) as unknown as HTMLCanvasElement;

describe('webglSupported', () => {
  it('is true when the canvas gives a webgl2 or a webgl context', () => {
    expect(webglSupported(() => canvasWith((id) => (id === 'webgl2' ? {} : null)))).toBe(true);
    expect(webglSupported(() => canvasWith((id) => (id === 'webgl' ? {} : null)))).toBe(true);
  });

  it('is false when neither is available, or the browser throws', () => {
    expect(webglSupported(() => canvasWith(() => null))).toBe(false);
    expect(
      webglSupported(() =>
        canvasWith(() => {
          throw new Error('blocked');
        })
      )
    ).toBe(false);
  });
});
