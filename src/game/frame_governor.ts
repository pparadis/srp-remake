// Adaptive frame rate (#82): a turn-based board has nothing to redraw while a player thinks, and the Canvas renderer
// still repaints it 60 times a second (about half the CPU of a race page, tools/cpuProbe.mjs). The game starts with an
// fps limit (`startGame`), so Phaser's loop skips frames below `_limitRate`; this lowers it to 1 ms (a frame per
// animation frame, as the browser gives them) while something moves or the player is acting, and back to `idleFps`
// once nothing has for `HOLD_MS`. Phaser has no public call to change the limit at runtime.

/** The part of Phaser's TimeStep that is changed. */
export interface FrameLimit {
  _limitRate: number;
}

/**
 * Phaser's loop has `_limitRate` (internal: not in its typings), a number from its constructor on. Not `setFPSLimit`
 * (4.2): it restarts the rAF loop, and called from inside a step (`tick` runs in UPDATE) it leaves two loops running.
 */
export function isFrameLimit(loop: object): loop is FrameLimit {
  return '_limitRate' in loop && typeof loop._limitRate === 'number';
}

/** How long the full rate lasts after the last input or the last moving thing (hover trails, the end of a glide). */
const HOLD_MS = 600;

/** Input that must repaint at once: the first frame after it has to be a full-rate one, not one idle frame late. */
const WAKE_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'wheel',
  'keydown',
  'touchstart',
  'touchmove',
  'resize',
  // the page's own events that change the board: server state, the HUD's buttons, the sandbox panel, the cars toggle
  'srp:backend-lobby-state',
  'srp:backend-turn-applied',
  'srp:hud-command',
  'srp:sandbox-command',
  'srp:toggle-cars-moves'
];

/** Frames per second while something moves (0: as often as the browser paints) and while nothing does. */
export interface FrameRates {
  active: number;
  idle: number;
}

// The e2e build (`vite build --mode test`) keeps its own low cap (see `startGame`): many headless pages at once.
export const TEST_FPS = 10;
export const FRAME_RATES: FrameRates =
  import.meta.env.MODE === 'test' ? { active: TEST_FPS, idle: TEST_FPS } : { active: 0, idle: 15 };

/**
 * No cap is 1 ms, never 0: Phaser 4 keeps `delta % _limitRate` after a step, and `x % 0` is NaN, which stops the loop
 * for good (#232: the board froze on "The other cars are moving" until a refocus reset the delta). 1 ms still steps on
 * every animation frame of any screen up to 1000 Hz.
 */
const NO_CAP_MS = 1;

function rate(fps: number): number {
  return fps > 0 ? 1000 / fps : NO_CAP_MS;
}

export class FrameGovernor {
  private activeUntil = 0;
  private readonly limit: FrameLimit;
  private readonly rates: FrameRates;
  private readonly now: () => number;

  constructor(
    limit: FrameLimit,
    rates: FrameRates = FRAME_RATES,
    now: () => number = () => performance.now()
  ) {
    this.limit = limit;
    this.rates = rates;
    this.now = now;
    this.poke();
  }

  /** Full rate from now, for HOLD_MS. */
  poke() {
    this.activeUntil = this.now() + HOLD_MS;
    this.limit._limitRate = rate(this.rates.active);
  }

  /** Once per game step: `busy` (a tween, confetti, the pit modal) keeps the full rate, otherwise it times out. */
  tick(busy: boolean) {
    if (busy) this.poke();
    else if (this.now() >= this.activeUntil) this.limit._limitRate = rate(this.rates.idle);
  }

  /** Pokes on every input event of the page, until the returned function is called. */
  watch(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const poke = () => this.poke();
    for (const type of WAKE_EVENTS) {
      target.addEventListener(type, poke, { capture: true, passive: true });
    }
    return () => {
      for (const type of WAKE_EVENTS) target.removeEventListener(type, poke, { capture: true });
    };
  }
}
