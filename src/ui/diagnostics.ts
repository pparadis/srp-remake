// What went wrong on a phone, shown on the page: a phone has no console to read. The error box only appears when an
// uncaught error or rejected promise reaches the window (the game chunk is imported and started inside a promise, so a
// failure there would otherwise leave a blank race screen and nothing else). The probe line is opt-in (`?hidpi`).

const MAX_STACK_LINES = 6;

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? '').split('\n').slice(0, MAX_STACK_LINES).join('\n');
    return stack.includes(error.message) ? stack : `${error.name}: ${error.message}\n${stack}`;
  }
  return String(error);
}

/** Shows every uncaught error and unhandled rejection in `box` (unhides it), newest last. */
export function showUncaughtErrors(box: HTMLElement, win: Window = window): void {
  const show = (text: string) => {
    box.hidden = false;
    box.textContent = box.textContent ? `${box.textContent}\n\n${text}` : text;
  };
  win.addEventListener('error', (event) => {
    const where = event.filename
      ? ` (${event.filename.split('/').pop()}:${event.lineno}:${event.colno})`
      : '';
    show(event.error ? describe(event.error) : `${event.message}${where}`);
  });
  win.addEventListener('unhandledrejection', (event) =>
    show(`Unhandled rejection: ${describe(event.reason)}`)
  );
}

/** What the probe reads of a Phaser game (a narrow shape, so it is testable without Phaser). */
export interface ProbedGame {
  canvas?: HTMLCanvasElement;
  scene: { isActive: (key: string) => boolean };
}

/** One line on the canvas the browser really draws: density, canvas and CSS size, and whether the race scene runs. */
export function renderProbeText(game: ProbedGame, dpr: number): string {
  const canvas = game.canvas;
  const css = canvas?.getBoundingClientRect();
  const size = canvas ? `canvas ${canvas.width}x${canvas.height}` : 'no canvas';
  const box = css ? ` css ${Math.round(css.width)}x${Math.round(css.height)}` : '';
  const scenes = ['BootScene', 'RaceScene'].map(
    (key) => `${key} ${game.scene.isActive(key) ? 'on' : 'off'}`
  );
  return `dpr ${dpr} · ${size}${box} · ${scenes.join(' · ')}`;
}

/** Refreshes `line` with `renderProbeText` every second until the returned function is called. */
export function startRenderProbe(
  line: HTMLElement,
  game: ProbedGame,
  win: Window = window
): () => void {
  const update = () => {
    line.hidden = false;
    line.textContent = renderProbeText(game, win.devicePixelRatio || 1);
  };
  update();
  const timer = win.setInterval(update, 1000);
  return () => {
    win.clearInterval(timer);
    line.hidden = true;
  };
}
