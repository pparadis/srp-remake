import type Phaser from 'phaser';
// The loop alone: the whole of Phaser needs a canvas jsdom does not have
// @ts-expect-error: Phaser's source files have no typings of their own
import TimeStepClass from '../../node_modules/phaser/src/core/TimeStep.js';
import { describe, expect, it } from 'vitest';
import { FrameGovernor, isFrameLimit, type FrameLimit } from './frame_governor';

/** The full rate's `_limitRate`: 1 ms, never 0. */
const FULL = 1;

function setup() {
  const limit = { _limitRate: 1000 / 15 };
  const clock = { t: 0 };
  const governor = new FrameGovernor(limit, { active: 0, idle: 15 }, () => clock.t);
  return { limit, clock, governor };
}

describe('FrameGovernor', () => {
  it("keeps one rate when both are the same (the e2e build's cap)", () => {
    const limit = { _limitRate: 0 };
    const governor = new FrameGovernor(limit, { active: 10, idle: 10 }, () => 5000);
    expect(limit._limitRate).toBe(100);
    governor.tick(false);
    expect(limit._limitRate).toBe(100);
  });

  it('starts at full rate and drops to the idle rate once nothing has happened for a moment', () => {
    const { limit, clock, governor } = setup();
    expect(limit._limitRate).toBe(FULL);
    clock.t = 300;
    governor.tick(false);
    expect(limit._limitRate).toBe(FULL); // still inside the hold
    clock.t = 700;
    governor.tick(false);
    expect(limit._limitRate).toBeCloseTo(1000 / 15);
  });

  it('stays at full rate while busy, and holds a little after', () => {
    const { limit, clock, governor } = setup();
    for (clock.t = 100; clock.t < 5000; clock.t += 100) {
      governor.tick(true);
      expect(limit._limitRate).toBe(FULL);
    }
    clock.t = 5400;
    governor.tick(false);
    expect(limit._limitRate).toBe(FULL);
    clock.t = 5700;
    governor.tick(false);
    expect(limit._limitRate).toBeGreaterThan(0);
  });

  it('an input event goes back to full rate at once, and watching stops when asked', () => {
    const { limit, clock, governor } = setup();
    const stop = governor.watch(window);
    clock.t = 1000;
    governor.tick(false);
    expect(limit._limitRate).toBeGreaterThan(FULL);
    window.dispatchEvent(new Event('pointermove'));
    expect(limit._limitRate).toBe(FULL);

    clock.t = 3000;
    governor.tick(false);
    window.dispatchEvent(new CustomEvent('srp:backend-lobby-state'));
    expect(limit._limitRate).toBe(FULL);

    clock.t = 5000;
    governor.tick(false);
    stop();
    window.dispatchEvent(new Event('pointermove'));
    expect(limit._limitRate).toBeGreaterThan(FULL);
  });

  it("keeps Phaser's real loop stepping on every frame at full rate, and after going idle and back", () => {
    // #232: Phaser 4 keeps `delta % _limitRate`, so a rate of 0 made the delta NaN and the game never stepped again
    const timeStep = TimeStepClass as typeof Phaser.Core.TimeStep;
    const loop = new timeStep({} as Phaser.Game, { limit: 15, smoothStep: false });
    const clock = { t: 0 };
    const governor = new FrameGovernor(
      loop as unknown as FrameLimit,
      { active: 0, idle: 15 },
      () => clock.t
    );
    let steps = 0;
    loop.callback = () => (steps += 1);
    const frames = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock.t += 1000 / 60;
        loop.stepLimitFPS(clock.t);
      }
    };
    frames(30);
    expect(steps).toBe(30);
    frames(60); // idle: about 15 a second
    governor.poke();
    steps = 0;
    frames(30);
    expect(steps).toBe(30);
  });
});

describe('isFrameLimit', () => {
  it('accepts a loop with a numeric _limitRate (0 is no limit) and refuses the rest', () => {
    expect(isFrameLimit({ _limitRate: 0 })).toBe(true);
    expect(isFrameLimit({ _limitRate: 1000 / 15 })).toBe(true);
    expect(isFrameLimit({})).toBe(false);
    expect(isFrameLimit({ _limitRate: '66' })).toBe(false);
  });
});
