import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { createRaceContext } from '../race/race_engine';
import { resources } from '../rules/v2/resources';
import type { Car, CarSetup } from '../types/car';
import type { TrackData } from '../types/track';
import {
  bestSetup as bestSetupFor,
  buildPlanContext,
  cellsToFeeder,
  cycleSizes,
  forwardGain,
  SETUP_CHOICES,
  isFinalLap,
  progressOf,
  resourceWeights,
  servicedCar,
  stopIsDue,
  sustainablePace,
  sustainableSize,
  wearPerCell as wearPerCellFor
} from './bot_plan';
import { resourceRulesFor } from './resource_system';

const ctx = createRaceContext(track as unknown as TrackData);
const cell = (id: string) => ctx.cellMap.get(id)!;
const plan = (laps: number) => buildPlanContext(ctx.trackIndex, laps, resources);
const bestSetup = (cells: number) => bestSetupFor(cells, resources);
const wearPerCell = (setup: CarSetup) => wearPerCellFor(setup, resources);

function car(overrides: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: 'BOT1',
    isBot: true,
    cellId: 'Z01_L1_00',
    lapCount: 0,
    tire: 100,
    fuel: 100,
    setup: { compound: 'soft', psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wing: 'medium' as const },
    state: 'ACTIVE',
    pitTurnsRemaining: 0,
    pitExitBoost: false,
    pitServiced: false,
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] },
    ...overrides
  };
}

describe('plan context', () => {
  it('finds the one lane-1 cell a stop can start from', () => {
    expect(plan(5)).toMatchObject({ raceLaps: 5, spineLen: 28, feederFwd: 26 });
    expect(cellsToFeeder(cell('Z19_L1_00'), plan(5))).toBe(8);
    expect(cellsToFeeder(cell('Z27_L1_00'), plan(5))).toBe(0);
    expect(cellsToFeeder(cell('Z28_L1_00'), plan(5))).toBe(27);
  });

  it('knows the final lap', () => {
    expect(isFinalLap(car({ lapCount: 3 }), plan(5))).toBe(false);
    expect(isFinalLap(car({ lapCount: 4 }), plan(5))).toBe(true);
  });
});

describe('wear and ideal setup', () => {
  it('Low wing wears more than Medium and High wear less, on tires and fuel', () => {
    const at = (wing: 'low' | 'medium' | 'high') => wearPerCell({ ...SETUP_CHOICES[0]!, wing });
    expect(at('low').tire).toBeGreaterThan(at('medium').tire);
    expect(at('low').fuel).toBeGreaterThan(at('medium').fuel);
    expect(at('high').tire).toBeLessThan(at('medium').tire);
    expect(at('high').fuel).toBeLessThan(at('medium').fuel);
    expect(at('medium').fuel).toBeCloseTo(0.45, 5);
  });

  it('the soft compound wears tires faster than hard', () => {
    const soft = wearPerCell({ ...SETUP_CHOICES[0]!, compound: 'soft' });
    expect(soft.tire).toBeGreaterThan(wearPerCell(SETUP_CHOICES[0]!).tire);
  });
});

describe('forwardGain', () => {
  it('counts forwardIndex, not cells, on main lanes', () => {
    // Z10_L3 is 9 cells past Z01_L3 but only 8 forwardIndex ahead.
    expect(forwardGain(cell('Z01_L3_00'), cell('Z10_L3_00'), 9, plan(5))).toBe(8);
    expect(forwardGain(cell('Z01_L1_00'), cell('Z10_L1_00'), 9, plan(5))).toBe(9);
  });
  it('wraps around the line and falls back to distance in the pit lane or without a plan', () => {
    expect(forwardGain(cell('Z27_L1_00'), cell('Z03_L1_00'), 4, plan(5))).toBe(4);
    expect(forwardGain(cell('Z27_L1_00'), cell('Z28_L0_00'), 1, plan(5))).toBe(1);
    expect(forwardGain(cell('Z01_L3_00'), cell('Z10_L3_00'), 9, undefined)).toBe(9);
  });
});

describe('stop planning', () => {
  it('is not due in a race the tires and tank can finish', () => {
    expect(stopIsDue(car({ cellId: 'Z27_L1_00', lapCount: 1 }), cell('Z27_L1_00'), plan(5))).toBe(
      false
    );
  });
  it('is not due when the stop would cost more than the crawl it saves', () => {
    // 6 laps on soft tires: a short crawl at the end is cheaper than the stop.
    const worn = car({ cellId: 'Z27_L1_00', lapCount: 4, tire: 5, fuel: 30 });
    expect(stopIsDue(worn, cell('Z27_L1_00'), plan(6))).toBe(false);
  });
  it('is due on the last pass that still beats crawling, never on the final lap or once serviced', () => {
    const worn = car({ cellId: 'Z27_L1_00', lapCount: 4, tire: 5, fuel: 20 });
    expect(stopIsDue(worn, cell('Z27_L1_00'), plan(12))).toBe(true);
    expect(stopIsDue({ ...worn, lapCount: 11 }, cell('Z27_L1_00'), plan(12))).toBe(false);
    expect(stopIsDue({ ...worn, pitServiced: true }, cell('Z27_L1_00'), plan(12))).toBe(false);
    // plenty left for another lap: wait for a later pass
    expect(stopIsDue({ ...worn, tire: 60, fuel: 60 }, cell('Z27_L1_00'), plan(12))).toBe(false);
  });
});

describe('stop planning breaks even earlier now that the pit lane keeps the lap', () => {
  // A soft-tire car that has covered `lap` laps plus 26 cells arrives at the pit-entry feeder.
  const wear = wearPerCell(car().setup);
  const arrive = (lap: number) => {
    const used = lap * 28 + 26;
    return car({
      cellId: 'Z27_L1_00',
      lapCount: lap,
      tire: 100 - used * wear.tire,
      fuel: 100 - used * wear.fuel
    });
  };
  it('pays off from 9 laps on the plain setup (the tank lasts 7.5 laps; a stop used to pay from 7)', () => {
    expect(stopIsDue(arrive(6), cell('Z27_L1_00'), plan(9))).toBe(true);
    expect(stopIsDue(arrive(6), cell('Z27_L1_00'), plan(8))).toBe(false);
  });
});

describe('resource weights', () => {
  it('are 1 when the resource lasts to the flag and worth the crawl it saves when it does not', () => {
    const fresh = resourceWeights(car(), cell('Z01_L1_00'), plan(3));
    expect(fresh).toEqual({ tire: 1, fuel: 1 });
    const longRace = resourceWeights(car(), cell('Z01_L1_00'), plan(12));
    expect(longRace.tire).toBeGreaterThan(5);
    expect(longRace.fuel).toBeGreaterThan(5);
  });
});

describe('progress of a car in the pit lane', () => {
  const at = (id: string, lapCount: number) =>
    progressOf(car({ cellId: id, lapCount }), cell(id), plan(5));

  it('equals the progress of the lane-1 cell beside it', () => {
    expect(at('Z28_L0_00', 1)).toBe(at('Z28_L1_00', 1));
    expect(at('Z01_L0_00', 2)).toBe(at('Z01_L1_00', 2));
    expect(at('Z05_L0_00', 2)).toBe(at('Z05_L2_00', 2));
  });

  it('a pit stop never makes progress jump: entry -> line cell is one cell, the lap is credited at the line', () => {
    // lapCount rises 1 -> 2 exactly when the car lands on the line cell
    expect(at('Z01_L0_00', 2) - at('Z28_L0_00', 1)).toBe(1);
    expect(at('Z02_L0_00', 2) - at('Z01_L0_00', 2)).toBe(1);
    expect(at('Z07_L1_00', 2) - at('Z06_L0_00', 2)).toBe(1);
  });
});

describe('bestSetup', () => {
  const lengths = Array.from({ length: 24 }, (_item, i) => (i + 1) * 28);

  it('picks Low wing, High wing and Medium wing for some race length each', () => {
    const wings = new Set(lengths.map((cells) => bestSetup(cells).wing));
    expect(wings).toEqual(new Set(['low', 'medium', 'high']));
  });

  it('has no setup that is best at every length', () => {
    const keys = new Set(
      lengths.map((cells) => `${bestSetup(cells).compound}/${bestSetup(cells).wing}`)
    );
    expect(keys.size).toBeGreaterThan(2);
  });

  it('wants soft tires and Low wing for a short sprint, never High wing', () => {
    expect(bestSetup(28)).toMatchObject({ compound: 'soft', wing: 'low' });
  });
});

// Rules v3 (#148): the pace plan, the setup search over the fuel load, the stop that tops up.
describe('pace plan on rules v3', () => {
  const v3 = resourceRulesFor({ raceLaps: 5, spineLen: 28 });
  const plan3 = (laps = 5) => buildPlanContext(ctx.trackIndex, laps, v3);
  const mediumCar = (over: Partial<Car> = {}) =>
    car({
      setup: { compound: 'medium', psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: 'medium' },
      ...over
    });

  it('spends a cycle budget in even moves, the larger first', () => {
    expect(cycleSizes(36)).toEqual([8, 7, 7, 7, 7]);
    expect(cycleSizes(39)).toEqual([8, 8, 8, 8, 7]);
    expect(cycleSizes(42)).toEqual([9, 9, 8, 8, 8]);
  });

  const softCar = (over: Partial<Car> = {}) =>
    car({
      setup: { compound: 'soft', psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: 'medium' },
      ...over
    });

  it('plays the biggest move it can keep to the flag: soft cannot keep an 8 over 5 laps, a half-way medium can', () => {
    expect(sustainableSize(softCar({ fuel: 95 }), 140, v3)).toBe(7);
    const half = mediumCar({ tire: 60, fuel: 60 });
    expect(sustainableSize(half, 70, v3)).toBe(8);
    expect(sustainableSize(half, 35, v3)).toBe(8);
  });

  it('plays a 9 only when the tires and the tank have slack for it', () => {
    expect(sustainableSize(softCar(), 30, v3)).toBe(9);
    expect(sustainableSize(softCar(), 140, v3)).toBe(7);
  });

  it('is null when not even a 7 reaches the flag, and the car runs flat out to a stop it can still take', () => {
    const worn = mediumCar({ tire: 40, fuel: 40 });
    expect(sustainableSize(worn, 140, v3)).toBeNull();
    const start = cell('Z01_L1_00');
    expect(sustainablePace(worn, start, plan3())).toBe(8);
    // on the final lap, or after the stop, there is no stop to run to: save what is left
    expect(sustainablePace({ ...worn, pitServiced: true }, start, plan3())).toBe(7);
  });

  it('a driver that counts on running low keeps less in hand, one that saves keeps more', () => {
    const tight = mediumCar({ tire: 80, fuel: 80 });
    const base = sustainableSize(tight, 100, v3);
    expect(sustainableSize(tight, 100, v3, -0.2)).toBeGreaterThanOrEqual(base!);
    expect(sustainableSize(tight, 100, v3, 0.3) ?? 0).toBeLessThanOrEqual(base!);
  });

  it('asks nothing of the pace where the size of a move changes nothing (v1 and v2)', () => {
    expect(sustainablePace(car({ tire: 10, fuel: 10 }), cell('Z01_L1_00'), plan(5))).toBe(9);
  });

  it('searches the fuel load: a lighter tank than a full one for a short race, and never below 40', () => {
    const sprint = bestSetupFor(28, v3);
    expect(sprint.fuelLoad).toBeGreaterThanOrEqual(40);
    expect(sprint.fuelLoad).toBeLessThan(100);
    const full = bestSetupFor(5 * 28, v3);
    expect(full.fuelLoad! % 5).toBe(0);
    expect(v3.isValidSetup(full)).toBe(true);
  });

  it('a stop tops the tank up to the load and never takes fuel away', () => {
    const setup = { ...mediumCar().setup, fuelLoad: 60 };
    expect(servicedCar(mediumCar({ tire: 10, fuel: 20 }), setup, v3)).toMatchObject({
      tire: 100,
      fuel: 60
    });
    expect(servicedCar(mediumCar({ tire: 10, fuel: 90 }), setup, v3)).toMatchObject({
      tire: 100,
      fuel: 90
    });
  });
});
