import { describe, expect, it } from 'vitest';
import { renderProbeText, showUncaughtErrors, startRenderProbe } from './diagnostics';

describe('showUncaughtErrors', () => {
  it('stays hidden until something goes wrong, then shows each error and rejection', () => {
    const box = document.createElement('pre');
    box.hidden = true;
    const win = new EventTarget() as unknown as Window;
    showUncaughtErrors(box, win);
    expect(box.hidden).toBe(true);

    const error = new TypeError('canvas is null');
    win.dispatchEvent(
      Object.assign(new Event('error'), {
        error,
        message: error.message,
        filename: '',
        lineno: 0,
        colno: 0
      })
    );
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('TypeError: canvas is null');

    win.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('chunk failed to load') })
    );
    expect(box.textContent).toContain('Unhandled rejection: Error: chunk failed to load');
    expect(box.textContent!.indexOf('canvas is null')).toBeLessThan(
      box.textContent!.indexOf('chunk failed')
    );
  });

  it('falls back to the message and place when the event has no error object (a cross-origin script)', () => {
    const box = document.createElement('pre');
    const win = new EventTarget() as unknown as Window;
    showUncaughtErrors(box, win);
    win.dispatchEvent(
      Object.assign(new Event('error'), {
        error: null,
        message: 'Script error.',
        filename: 'https://x/assets/game-ab12.js',
        lineno: 3,
        colno: 9
      })
    );
    expect(box.textContent).toBe('Script error. (game-ab12.js:3:9)');
  });
});

describe('render probe', () => {
  const game = (active: string[]) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1748;
    canvas.height = 804;
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 874, 402);
    return { canvas, scene: { isActive: (key: string) => active.includes(key) } };
  };

  it('says what the browser really draws and which scenes run', () => {
    expect(renderProbeText(game(['RaceScene']), 3)).toBe(
      'dpr 3 · canvas 1748x804 css 874x402 · BootScene off · RaceScene on'
    );
    expect(renderProbeText({ scene: { isActive: () => false } }, 1)).toBe(
      'dpr 1 · no canvas · BootScene off · RaceScene off'
    );
  });

  it('names the renderer the game really runs', () => {
    const noScene = { scene: { isActive: () => false } };
    expect(renderProbeText({ ...noScene, renderer: { type: 2 } }, 1)).toMatch(/^webgl · dpr 1/);
    expect(renderProbeText({ ...noScene, renderer: { type: 1 } }, 1)).toMatch(/^canvas · dpr 1/);
  });

  it('shows the line, and hides it when stopped', () => {
    const line = document.createElement('div');
    line.hidden = true;
    const stop = startRenderProbe(line, game(['BootScene']));
    expect(line.hidden).toBe(false);
    expect(line.textContent).toContain('BootScene on');
    stop();
    expect(line.hidden).toBe(true);
  });
});
