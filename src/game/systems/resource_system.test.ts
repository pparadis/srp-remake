import { describe, expect, it } from 'vitest';
import type { RaceScale } from '../rules/resource_rules';
import type { Car, CarSetup } from '../types/car';
import {
  capacityCells,
  fuelPerCell,
  isHeavy,
  moveFactor,
  recommendedFuel,
  resourceRulesFor,
  roundWear,
  tirePerCell
} from './resource_system';

const race = (raceLaps: number): RaceScale => ({ raceLaps, spineLen: 28 });
const setup = (over: Partial<CarSetup> = {}): CarSetup => ({
  compound: 'medium',
  psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
  wing: 'medium',
  ...over
});
const car = (over: Partial<Pick<Car, 'tire' | 'fuel' | 'setup'>> = {}) => ({
  tire: 100,
  fuel: 60,
  setup: setup(),
  ...over
});

describe('capacity and rates', () => {
  it('sizes a tank and a tire set to the race, up to one stint of 6 laps', () => {
    expect(capacityCells(race(1))).toBe(28);
    expect(capacityCells(race(5))).toBe(140);
    expect(capacityCells(race(6))).toBe(168);
    expect(capacityCells(race(12))).toBe(168);
  });

  it('a full tank covers 1.1 stints at the normal pace: a race of 8s uses about 91 in 5 laps', () => {
    expect(fuelPerCell(race(5))).toBeCloseTo(0.649, 3);
    expect(fuelPerCell(race(5)) * 140).toBeCloseTo(90.9, 1);
  });

  it('is as tight in a short race and a stop is planned from 8 laps', () => {
    expect(fuelPerCell(race(1)) * 28).toBeCloseTo(90.9, 1);
    expect(fuelPerCell(race(8)) * 8 * 28).toBeGreaterThan(100);
  });

  it('wears the softer compound faster per cell', () => {
    const at = (compound: 'hard' | 'medium' | 'soft') => tirePerCell(race(5), compound);
    expect(at('hard')).toBeLessThan(at('medium'));
    expect(at('medium')).toBeLessThan(at('soft'));
    expect(at('hard') * 140 * 1.4).toBeCloseTo(100, 5);
  });
});

describe('move size and rounding', () => {
  it('a 7 or less is conservative, an 8 normal, a 9 high consumption', () => {
    expect(moveFactor(1)).toEqual({ fuel: 0.85, tire: 0.9 });
    expect(moveFactor(7)).toEqual({ fuel: 0.85, tire: 0.9 });
    expect(moveFactor(8)).toEqual({ fuel: 1, tire: 1 });
    expect(moveFactor(9)).toEqual({ fuel: 1.2, tire: 1.1 });
  });

  it('keeps costs to a tenth', () => {
    expect(roundWear(5.2 * 0.85)).toBe(4.4);
    expect(roundWear(0.04)).toBe(0);
    expect(roundWear(94.8 - 5.2)).toBe(89.6);
  });
});

describe('recommended fuel', () => {
  it('is what a race of 8s needs, rounded up to 5: 95 for any race of 6 laps or less', () => {
    for (const laps of [1, 3, 5, 6]) expect(recommendedFuel(race(laps))).toBe(95);
  });

  it('is a full tank from 7 laps, where a stop is planned anyway', () => {
    expect(recommendedFuel(race(7))).toBe(100);
    expect(recommendedFuel(race(12))).toBe(100);
  });
});

describe('the rules of a race', () => {
  const rules = resourceRulesFor(race(5));

  it('is heavy above 70 fuel only', () => {
    expect(isHeavy({ fuel: 71 })).toBe(true);
    expect(isHeavy({ fuel: 70 })).toBe(false);
  });

  it('caps a move by compound, and at 4 when a tire or the tank is empty', () => {
    expect(rules.moveCap(car({ setup: setup({ compound: 'hard' }) }))).toBe(8);
    expect(rules.moveCap(car({ setup: setup({ compound: 'soft' }) }))).toBe(9);
    expect(rules.moveCap(car({ tire: 0 }))).toBe(4);
    expect(rules.moveCap(car({ fuel: 0 }))).toBe(4);
  });

  it('keeps the budget under cap x 5', () => {
    // soft at Low wing and light: 42 + 1 = 43, under 45; the clamp only bites on a table change
    expect(rules.cycleBudget(car({ setup: setup({ compound: 'soft', wing: 'low' }) }))).toBe(43);
  });

  it('prices a cell from the race, the compound and nothing else', () => {
    const rates = rules.wearRates(setup({ compound: 'hard' }));
    expect(rates.fuelRate).toBe(fuelPerCell(race(5)));
    expect(rates.tireRate).toBe(tirePerCell(race(5), 'hard'));
  });

  it('accepts the loads the grid allows and refuses the others', () => {
    expect(rules.isValidSetup(setup())).toBe(true);
    for (const fuelLoad of [40, 65, 100]) {
      expect(rules.isValidSetup(setup({ fuelLoad }))).toBe(true);
    }
    for (const fuelLoad of [35, 42, 105]) {
      expect(rules.isValidSetup(setup({ fuelLoad }))).toBe(false);
    }
    expect(rules.isValidSetup(setup({ compound: 'wet' as never }))).toBe(false);
  });
});
