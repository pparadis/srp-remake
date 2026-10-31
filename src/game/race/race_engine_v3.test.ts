import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { resourcesOf, type RulesVersion } from '../rules/versions';
import { recommendedFuel } from '../systems/resource_system';
import type { CarSetup } from '../types/car';
import type { TrackData } from '../types/track';
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  getActiveCar,
  type RaceState
} from './race_engine';

// Rules v3 (#148): the compounds, the fuel load, wear by move size. v1 and v2 are covered by race_engine.test.ts.
const ctx = createRaceContext(track as unknown as TrackData);
const HUMANS = [
  { isBot: false, ownerId: 'P1' },
  { isBot: false, ownerId: 'P2' }
];
const PLAIN_PSI = { fl: 32, fr: 32, rl: 32, rr: 32 };
const setupOf = (over: Partial<CarSetup> = {}): CarSetup => ({
  compound: 'medium',
  psi: PLAIN_PSI,
  wing: 'medium',
  ...over
});
const race = (laps = 5, rulesVersion: RulesVersion = 'v3'): RaceState =>
  createRace(ctx, HUMANS, laps, 0, rulesVersion);
const resourcesFor = (state: RaceState) => resourcesOf(state, ctx.trackIndex);
const biggestMove = (state: RaceState) =>
  Math.max(
    ...[...computeTargets(ctx, state, getActiveCar(state)).values()].map(
      (t) => t.moveSpend ?? t.distance
    )
  );

describe('v3: the car dealt', () => {
  it('gets medium tires, Medium wing and the fuel a race of 8s needs', () => {
    const state = race(5);
    const fuel = recommendedFuel({ raceLaps: 5, spineLen: ctx.trackIndex.spineLen });
    expect(fuel).toBe(95);
    for (const car of state.cars) {
      expect(car.setup).toMatchObject({ compound: 'medium', wing: 'medium', fuelLoad: fuel });
      expect(car.fuel).toBe(fuel);
    }
  });
});

describe('v3: the cap and the budget of a compound', () => {
  const biggestWith = (setup: CarSetup) => {
    const state = race();
    expect(applyAction(ctx, state, { type: 'setup', setup }).ok).toBe(true);
    return biggestMove(state);
  };

  it('caps a move at 8 on hard and medium and at 9 on soft', () => {
    expect(biggestWith(setupOf({ compound: 'hard', fuelLoad: 60 }))).toBe(8);
    expect(biggestWith(setupOf({ compound: 'medium', fuelLoad: 60 }))).toBe(8);
    expect(biggestWith(setupOf({ compound: 'soft', fuelLoad: 60 }))).toBe(9);
  });

  it('holds 36, 39 and 42 move points at Medium wing, Low wing +1 and High wing -1', () => {
    const budget = (setup: CarSetup) => {
      const state = race();
      applyAction(ctx, state, { type: 'setup', setup: { ...setup, fuelLoad: 60 } });
      return resourcesFor(state).cycleBudget(getActiveCar(state));
    };
    expect(budget(setupOf({ compound: 'hard' }))).toBe(36);
    expect(budget(setupOf({ compound: 'medium' }))).toBe(39);
    expect(budget(setupOf({ compound: 'soft' }))).toBe(42);
    expect(budget(setupOf({ compound: 'medium', wing: 'low' }))).toBe(40);
    expect(budget(setupOf({ compound: 'medium', wing: 'high' }))).toBe(38);
  });

  it('is one point lower while the tank holds more than 70', () => {
    const state = race();
    const car = getActiveCar(state);
    const budgetAt = (fuel: number) => {
      car.fuel = fuel;
      return resourcesFor(state).cycleBudget(car);
    };
    expect(budgetAt(100)).toBe(38);
    expect(budgetAt(71)).toBe(38);
    expect(budgetAt(70)).toBe(39);
    expect(budgetAt(40)).toBe(39);
  });
});

describe('v3: wear by move size', () => {
  it('burns more fuel and tire per cell on a 9 than on an 8, and less on a 7', () => {
    const state = race();
    applyAction(ctx, state, { type: 'setup', setup: setupOf({ compound: 'soft', fuelLoad: 60 }) });
    const perCell = new Map<number, { fuel: number; tire: number }>();
    for (const t of computeTargets(ctx, state, getActiveCar(state)).values()) {
      // plain walks only: no lane change, so the price is the cells and the lane factors are the same
      if (t.moveSpend === t.distance && t.laneChanges === undefined) {
        perCell.set(t.distance, { fuel: t.fuelCost / t.distance, tire: t.tireCost / t.distance });
      }
    }
    const [seven, eight, nine] = [7, 8, 9].map((n) => perCell.get(n));
    expect(seven && eight && nine).toBeTruthy();
    expect(seven!.fuel).toBeLessThan(eight!.fuel);
    expect(eight!.fuel).toBeLessThan(nine!.fuel);
    expect(seven!.tire).toBeLessThan(eight!.tire);
    expect(eight!.tire).toBeLessThan(nine!.tire);
  });

  it('takes the cost in tenths off the car', () => {
    const state = race();
    const car = getActiveCar(state);
    const [id, info] = [...computeTargets(ctx, state, car)].sort(([a], [b]) =>
      a.localeCompare(b)
    )[0]!;
    const { fuel, tire } = car;
    expect(applyAction(ctx, state, { type: 'move', targetCellId: id }).ok).toBe(true);
    expect(car.fuel).toBeCloseTo(fuel - info.fuelCost, 5);
    expect(car.tire).toBeCloseTo(tire - info.tireCost, 5);
    expect(Math.round(car.fuel * 10)).toBeCloseTo(car.fuel * 10, 5);
    expect(info.fuelCost).not.toBe(Math.round(info.fuelCost));
  });
});

describe('v3: the fuel load', () => {
  it('sets the fuel at the grid and keeps the load on the setup', () => {
    const state = race();
    expect(applyAction(ctx, state, { type: 'setup', setup: setupOf({ fuelLoad: 60 }) }).ok).toBe(
      true
    );
    expect(getActiveCar(state)).toMatchObject({ fuel: 60, setup: { fuelLoad: 60 } });
  });

  it('is a full tank when the setup names no load', () => {
    const state = race();
    expect(applyAction(ctx, state, { type: 'setup', setup: setupOf() }).ok).toBe(true);
    expect(getActiveCar(state).fuel).toBe(100);
  });

  it('refuses a load that is not a multiple of 5 between 40 and 100', () => {
    for (const fuelLoad of [35, 62, 105, 60.5, Number.NaN]) {
      const state = race();
      expect(applyAction(ctx, state, { type: 'setup', setup: setupOf({ fuelLoad }) })).toEqual({
        ok: false,
        reason: 'invalid_setup'
      });
    }
  });

  const pitWith = (fuel: number, fuelLoad: number) => {
    const state = race();
    const car = getActiveCar(state);
    car.tire = 30;
    car.fuel = fuel;
    car.cellId = 'Z01_L0_00';
    const result = applyAction(ctx, state, {
      type: 'pit',
      targetCellId: 'Z02_L0_00',
      setup: setupOf({ fuelLoad })
    });
    expect(result.ok).toBe(true);
    return car;
  };

  it('a pit stop fits fresh tires and refuels to the load', () => {
    expect(pitWith(20, 80)).toMatchObject({ tire: 100, fuel: 80 });
  });

  it('a pit stop never takes fuel away', () => {
    expect(pitWith(90, 60)).toMatchObject({ tire: 100, fuel: 90 });
  });
});
