import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { createRaceContext } from '../race/race_engine';
import { resources } from './test_resources';
import type { Car } from '../types/car';
import type { TrackData } from '../types/track';
import { buildPlanContext, SETUP_CHOICES, stopIsDue } from './bot_plan';
import { cellsToPitEntry, pitAdvice, stintEstimate as stintEstimateOf } from './strategy';

const ctx = createRaceContext(track as unknown as TrackData);
const cell = (id: string) => ctx.cellMap.get(id)!;
const plan = (laps: number) => buildPlanContext(ctx.trackIndex, laps, resources);
const stintEstimate = (c: Parameters<typeof stintEstimateOf>[0], spineLen: number) =>
  stintEstimateOf(c, spineLen, resources);

function car(over: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: 'P1',
    isBot: false,
    cellId: 'Z01_L1_00',
    lapCount: 0,
    tire: 100,
    fuel: 100,
    setup: { compound: 'soft', psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: 'medium' as const },
    state: 'ACTIVE',
    pitTurnsRemaining: 0,
    pitExitBoost: false,
    pitServiced: false,
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] },
    ...over
  };
}

describe('stintEstimate', () => {
  it('a fresh car has a stint in cells, laps and moves that agree with each other', () => {
    const est = stintEstimate(car(), 28);
    expect(est.cells).toBeGreaterThan(0);
    expect(est.laps).toBeCloseTo(est.cells / 28, 5);
    expect(est.moves).toBeGreaterThan(0);
    expect(est.moves).toBeLessThan(est.cells);
  });

  it('hard lasts longer than soft', () => {
    const hard = car({ setup: { ...car().setup, compound: 'hard' } });
    expect(stintEstimate(hard, 28).cells).toBeGreaterThan(stintEstimate(car(), 28).cells);
  });

  it('Low wing shortens it, and an empty tank is zero', () => {
    const low = car({ setup: { ...car().setup, wing: 'low' } });
    expect(stintEstimate(low, 28).cells).toBeLessThan(stintEstimate(car(), 28).cells);
    expect(stintEstimate(car({ fuel: 0 }), 28)).toEqual({ cells: 0, laps: 0, moves: 0 });
  });
});

describe('cellsToPitEntry', () => {
  it('counts cells to the lane-1 feeder next to PIT_ENTRY', () => {
    expect(cellsToPitEntry(cell('Z19_L1_00'), plan(5))).toBe(8);
    expect(cellsToPitEntry(cell('Z27_L1_00'), plan(5))).toBe(0);
  });
});

describe('pitAdvice', () => {
  const hungry = { tire: 15, fuel: 15 };

  it('needs no stop when the car can finish on what it has', () => {
    expect(pitAdvice(car(), cell('Z01_L1_00'), plan(1))).toBe('no-need');
  });

  it('says ok while a stop is not due yet in a long race', () => {
    expect(pitAdvice(car({ tire: 90 }), cell('Z02_L1_00'), plan(10))).toBe('ok');
  });

  it('advises pit-soon on the last pass and pit-now once the entry is within a move', () => {
    const far = car({ ...hungry, cellId: 'Z05_L1_00', lapCount: 1 });
    expect(pitAdvice(far, cell(far.cellId), plan(8))).toBe('pit-soon');
    const near = car({ ...hungry, cellId: 'Z22_L1_00', lapCount: 1 });
    expect(pitAdvice(near, cell(near.cellId), plan(8))).toBe('pit-now');
  });

  it('never advises a stop on the final lap or after one', () => {
    const last = car({ ...hungry, lapCount: 4, cellId: 'Z22_L1_00' });
    expect(pitAdvice(last, cell(last.cellId), plan(5))).toBe('no-need');
    const done = car({ ...hungry, pitServiced: true, lapCount: 1, cellId: 'Z22_L1_00' });
    expect(pitAdvice(done, cell(done.cellId), plan(5))).toBe('no-need');
  });

  it('agrees with the Normal bot: advice is a stop exactly when stopIsDue', () => {
    for (const laps of [3, 5, 8]) {
      for (const lap of [0, 1, 2]) {
        for (const tire of [100, 60, 30, 10]) {
          for (const id of ['Z01_L1_00', 'Z10_L1_00', 'Z22_L1_00', 'Z27_L1_00']) {
            const c = car({ tire, fuel: tire, lapCount: lap, cellId: id });
            const advice = pitAdvice(c, cell(id), plan(laps));
            const due = stopIsDue(c, cell(id), plan(laps));
            expect(advice === 'pit-soon' || advice === 'pit-now').toBe(due);
          }
        }
      }
    }
  });

  it('a stop with the ideal setup is always cheaper to run than a loaded one', () => {
    expect(stintEstimate(car({ setup: SETUP_CHOICES[0]! }), 28).cells).toBeGreaterThanOrEqual(
      stintEstimate(car(), 28).cells
    );
  });
});
