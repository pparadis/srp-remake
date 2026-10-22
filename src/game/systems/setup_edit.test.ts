import { describe, expect, it } from 'vitest';
import type { CarSetup } from '../types/car';
import { fitToFeatures, nudgeFuel, nudgePsi, nudgeWing } from './setup_edit';

const base = (): CarSetup => ({
  compound: 'medium',
  psi: { fl: 22, fr: 22, rl: 22, rr: 22 },
  wing: 'medium'
});

describe('setup edits', () => {
  it('moves the wing one level and stops at the ends', () => {
    const setup = base();
    nudgeWing(setup, -1);
    expect(setup.wing).toBe('low');
    nudgeWing(setup, -1);
    expect(setup.wing).toBe('low');
    nudgeWing(setup, 1);
    nudgeWing(setup, 1);
    nudgeWing(setup, 1);
    expect(setup.wing).toBe('high');
  });

  it('moves all four pressures together within the limits', () => {
    const setup = base();
    nudgePsi(setup, 1);
    expect(setup.psi).toEqual({ fl: 23, fr: 23, rl: 23, rr: 23 });
    nudgePsi(setup, 100);
    expect(setup.psi.fl).toBe(35);
    nudgePsi(setup, -100);
    expect(setup.psi.rr).toBe(15);
  });

  it('steps the fuel load by 5 from a full tank, between 40 and 100', () => {
    const setup = base();
    nudgeFuel(setup, 1);
    expect(setup.fuelLoad).toBe(100);
    nudgeFuel(setup, -1);
    expect(setup.fuelLoad).toBe(95);
    for (let i = 0; i < 20; i++) nudgeFuel(setup, -1);
    expect(setup.fuelLoad).toBe(40);
  });

  it('trades what the rules do not offer for the closest thing, on a copy', () => {
    const original = base();
    const v2 = fitToFeatures(original, { medium: false, fuelLoad: false, psi: true });
    expect(v2.compound).toBe('hard');
    expect(v2.fuelLoad).toBeUndefined();
    expect(original.compound).toBe('medium');
    expect(fitToFeatures(original, { medium: true, fuelLoad: true, psi: false }).fuelLoad).toBe(
      100
    );
  });
});
