import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fpsText, startFpsMeter, type FpsStats } from "./fpsMeter";

// A game whose emitter just keeps the listeners, so a test can fire frames by hand.
function fakeGame() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    game: {
      events: {
        on: (event: string, fn: () => void) => (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn),
        off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn)
      }
    },
    frame: () => listeners.get("postrender")?.forEach((fn) => fn()),
    count: () => listeners.get("postrender")?.size ?? 0
  };
}

describe("fps meter", () => {
  let clock = 0;
  const now = () => clock;
  // moves the fake clock and the fake timers together, so a one-second tick sees the time it fires at
  const to = (t: number) => {
    const delta = t - clock;
    clock = t;
    vi.advanceTimersByTime(delta);
  };
  beforeEach(() => {
    clock = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the frames drawn in the last second and the longest gap between two", () => {
    const { game, frame } = fakeGame();
    const stats: FpsStats[] = [];
    startFpsMeter((s) => stats.push(s), game, window, now);
    // 58 frames: 57 gaps of 16 ms and one of 40 ms
    let t = 0;
    for (let i = 0; i < 58; i += 1) {
      t += i === 30 ? 40 : 16;
      to(t);
      frame();
    }
    to(1000);
    expect(stats).toEqual([{ fps: 58, worstMs: 40 }]);
    expect(fpsText(stats[0]!)).toBe("fps 58 \u00b7 worst frame 40 ms");
  });

  it("starts each second afresh, and counts the gap that spans two seconds", () => {
    const { game, frame } = fakeGame();
    const stats: FpsStats[] = [];
    startFpsMeter((s) => stats.push(s), game, window, now);
    to(900);
    frame();
    to(1000); // second 1 ends: one frame
    to(1500);
    frame(); // 600 ms after the last frame, in the next window
    to(2000);
    expect(stats).toEqual([
      { fps: 1, worstMs: 0 },
      { fps: 1, worstMs: 600 }
    ]);
  });

  it("says how long a stall has lasted when no frame came at all", () => {
    const { game, frame } = fakeGame();
    const stats: FpsStats[] = [];
    startFpsMeter((s) => stats.push(s), game, window, now);
    to(500);
    frame();
    to(1000); // second 1
    to(2000); // second 2: nothing drawn
    expect(stats[1]).toEqual({ fps: 0, worstMs: 1500 });
  });

  it("stops listening and ticking", () => {
    const { game, count } = fakeGame();
    const stats: FpsStats[] = [];
    const stop = startFpsMeter((s) => stats.push(s), game, window, now);
    expect(count()).toBe(1);
    stop();
    expect(count()).toBe(0);
    to(3000);
    expect(stats).toEqual([]);
  });
});
