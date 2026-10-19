// The frame rate the race screen really draws, for the opt-in readout (P key, `?fps`; see issue #79). Phaser-free:
// it only listens to the game's event emitter, so a test drives it with a fake one.

export interface FpsStats {
  /** Frames rendered in the last second. */
  fps: number;
  /** Longest gap between two renders in it, in ms: the jank number. */
  worstMs: number;
}

/** What the meter reads of a Phaser game. */
export interface MeteredGame {
  events: {
    on(event: string, listener: () => void): unknown;
    off(event: string, listener: () => void): unknown;
  };
}

// Phaser.Core.Events.POST_RENDER: emitted after each frame the game draws. Counting it (not requestAnimationFrame)
// shows what the game itself draws, so a frame-rate cap shows up here.
const POST_RENDER = 'postrender';

export function fpsText(stats: FpsStats): string {
  return `fps ${stats.fps} \u00b7 worst frame ${stats.worstMs} ms`;
}

/** Calls `onUpdate` every second with the frames drawn in it, until the returned function is called. */
export function startFpsMeter(
  onUpdate: (stats: FpsStats) => void,
  game: MeteredGame,
  win: Window = window,
  now: () => number = () => performance.now()
): () => void {
  let frames = 0;
  let worst = 0;
  let last: number | null = null;
  let windowStart = now();

  const onFrame = () => {
    const t = now();
    frames += 1;
    if (last !== null) worst = Math.max(worst, t - last);
    last = t;
  };
  game.events.on(POST_RENDER, onFrame);

  const timer = win.setInterval(() => {
    const t = now();
    // a second without a single frame is a stall: say how long it has been, not 0
    if (frames === 0 && last !== null) worst = t - last;
    onUpdate({
      fps: Math.round((frames * 1000) / Math.max(1, t - windowStart)),
      worstMs: Math.round(worst)
    });
    frames = 0;
    worst = 0;
    windowStart = t;
  }, 1000);

  return () => {
    win.clearInterval(timer);
    game.events.off(POST_RENDER, onFrame);
  };
}
