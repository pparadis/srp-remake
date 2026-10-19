import { describe, expect, it } from 'vitest';
import { FrameGovernor } from './frame_governor';

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
    expect(limit._limitRate).toBe(0);
    clock.t = 300;
    governor.tick(false);
    expect(limit._limitRate).toBe(0); // still inside the hold
    clock.t = 700;
    governor.tick(false);
    expect(limit._limitRate).toBeCloseTo(1000 / 15);
  });

  it('stays at full rate while busy, and holds a little after', () => {
    const { limit, clock, governor } = setup();
    for (clock.t = 100; clock.t < 5000; clock.t += 100) {
      governor.tick(true);
      expect(limit._limitRate).toBe(0);
    }
    clock.t = 5400;
    governor.tick(false);
    expect(limit._limitRate).toBe(0);
    clock.t = 5700;
    governor.tick(false);
    expect(limit._limitRate).toBeGreaterThan(0);
  });

  it('an input event goes back to full rate at once, and watching stops when asked', () => {
    const { limit, clock, governor } = setup();
    const stop = governor.watch(window);
    clock.t = 1000;
    governor.tick(false);
    expect(limit._limitRate).toBeGreaterThan(0);
    window.dispatchEvent(new Event('pointermove'));
    expect(limit._limitRate).toBe(0);

    clock.t = 3000;
    governor.tick(false);
    window.dispatchEvent(new CustomEvent('srp:backend-lobby-state'));
    expect(limit._limitRate).toBe(0);

    clock.t = 5000;
    governor.tick(false);
    stop();
    window.dispatchEvent(new Event('pointermove'));
    expect(limit._limitRate).toBeGreaterThan(0);
  });
});
