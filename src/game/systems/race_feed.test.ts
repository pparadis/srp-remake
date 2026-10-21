import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { createRace, createRaceContext, type RaceState } from '../race/race_engine';
import type { Car } from '../types/car';
import type { TrackData } from '../types/track';
import { feedLines } from './race_feed';

const ctx = createRaceContext(track as unknown as TrackData);
const seats = [1, 2, 3].map((n) => ({ isBot: false, ownerId: `P${n}` }));
const name = (car: Car) => `Car ${car.carId}`;

// A race with the three cars placed on known cells, and a copy of it for "after" to be edited.
function states(cells: [string, string, string] = ['Z05_L1_00', 'Z07_L1_00', 'Z10_L1_00']) {
  const before: RaceState = createRace(ctx, seats, 3, 0);
  before.cars.forEach((car, i) =>
    Object.assign(car, { cellId: cells[i], lapCount: 0, tire: 80, fuel: 80 })
  );
  before.turn = { order: [1, 2, 3], index: 0 };
  return { before, after: structuredClone(before) };
}

const said = (before: RaceState, after: RaceState) => feedLines(ctx, before, after, name);
const texts = (before: RaceState, after: RaceState) => said(before, after).map((l) => l.text);

describe('feedLines', () => {
  it('says a move with its distance and lane change, never a cell id', () => {
    const { before, after } = states();
    after.cars[0]!.cellId = 'Z06_L2_00';
    after.turn.index = 1;
    expect(said(before, after)).toEqual([
      { kind: 'move', carId: 1, text: 'Car 1 +1 cells, lane 1 → 2' }
    ]);
  });

  it('names a slingshot from the counter', () => {
    const { before, after } = states();
    after.cars[0]!.cellId = 'Z06_L1_00';
    after.cars[0]!.slingshots = 1;
    expect(texts(before, after)).toEqual(['Car 1 +1 cells, slingshot']);
  });

  it('says an overtake once, with the places gained', () => {
    const { before, after } = states();
    after.cars[0]!.cellId = 'Z08_L1_00'; // passes car 2 (Z07), stays behind car 3 (Z10)
    after.turn.index = 1;
    const lines = said(before, after);
    expect(lines.map((l) => l.text)).toEqual(['Car 1 +3 cells', 'Car 1 passes Car 2 for P2']);
    expect(lines[1]).toMatchObject({ kind: 'pass', carId: 1 });
  });

  it("says a lap crossed and the final lap, but not the rear row's first crossing", () => {
    // a lap is crossed by a move over the line: the car ends on a low cell with one more lap behind it
    const { before, after } = states(['Z15_L1_00', 'Z07_L1_00', 'Z10_L1_00']);
    after.cars[0]!.cellId = 'Z01_L1_00';
    after.cars[0]!.lapCount = 1;
    expect(texts(before, after)).toContain('Car 1 starts lap 2/3');
    after.cars[0]!.lapCount = 2;
    before.cars[0]!.lapCount = 1;
    expect(texts(before, after)).toContain('Car 1: final lap');

    const rear = states(['Z15_L1_00', 'Z07_L1_00', 'Z10_L1_00']);
    rear.before.cars[0]!.lapCount = -1;
    rear.after.cars[0]!.cellId = 'Z01_L1_00';
    rear.after.cars[0]!.lapCount = 0;
    expect(texts(rear.before, rear.after).some((t) => /lap/.test(t))).toBe(false);
  });

  it('says a pit stop with the setup it took', () => {
    const { before, after } = states();
    before.cars[0]!.fuel = 20;
    Object.assign(after.cars[0]!, {
      cellId: 'Z03_L0_00',
      tire: 100,
      fuel: 100,
      setup: { ...after.cars[0]!.setup, compound: 'soft', wing: 'low' }
    });
    const lines = said(before, after);
    expect(lines[0]).toMatchObject({
      kind: 'pit',
      text: 'Car 1 pits: soft tires, low wing, full tank'
    });
    expect(lines.some((l) => l.kind === 'warn')).toBe(false); // refuelled, not running low
  });

  it('on rules v3 says how far a stop refuelled, and names a grid setup with its fuel load', () => {
    const before: RaceState = createRace(ctx, seats, 3, 0, 'v3');
    before.cars.forEach((car, i) =>
      Object.assign(car, { cellId: ['Z05_L1_00', 'Z07_L1_00', 'Z10_L1_00'][i], lapCount: 0 })
    );
    before.turn = { order: [1, 2, 3], index: 0 };
    const stop = structuredClone(before);
    before.cars[0]!.fuel = 20;
    Object.assign(stop.cars[0]!, {
      cellId: 'Z03_L0_00',
      tire: 100,
      fuel: 80,
      setup: { ...stop.cars[0]!.setup, compound: 'soft', fuelLoad: 80 }
    });
    expect(texts(before, stop)[0]).toBe('Car 1 pits: soft tires, medium wing, refuelled to 80%');

    const grid = structuredClone(before);
    Object.assign(grid.cars[0]!, {
      setup: { ...grid.cars[0]!.setup, compound: 'soft', wing: 'low', fuelLoad: 70 }
    });
    expect(said(before, grid)).toEqual([
      { kind: 'info', carId: 1, text: 'Car 1 sets up: soft tires, low wing, 70% fuel' }
    ]);
    expect(texts(grid, structuredClone(grid))).toEqual([]);
  });

  it('names a grid setup without a fuel load before v3', () => {
    const { before, after } = states();
    Object.assign(after.cars[1]!, {
      setup: { ...after.cars[1]!.setup, compound: 'soft', wing: 'high' }
    });
    expect(texts(before, after)).toEqual(['Car 2 sets up: soft tires, high wing']);
  });

  it('warns once when a resource crosses 20% and once when it runs out', () => {
    const { before, after } = states();
    before.cars[1]!.fuel = 25;
    after.cars[1]!.fuel = 15;
    expect(said(before, after)).toEqual([{ kind: 'warn', carId: 2, text: 'Car 2: fuel 15%' }]);
    expect(texts(after, structuredClone(after))).toEqual([]); // the same state again says nothing
    const later = structuredClone(after);
    later.cars[1]!.fuel = 10;
    expect(texts(after, later)).toEqual([]); // already low: not said again
    const empty = structuredClone(later);
    empty.cars[1]!.fuel = 0;
    empty.cars[1]!.tire = 5;
    expect(texts(later, empty)).toEqual(['Car 2: tire 5%', 'Car 2: out of fuel']);
  });

  it('says a skip only when the turn passed', () => {
    const { before, after } = states();
    expect(texts(before, after)).toEqual([]); // a grid setup is not a turn
    after.turn.index = 1;
    expect(texts(before, after)).toEqual(['Car 1 skips (no moves)']);
  });

  it('says the finish, then the order of the others', () => {
    const { before, after } = states();
    after.cars[1]!.cellId = 'Z08_L1_00';
    after.cars[1]!.lapCount = 3;
    after.winnerCarId = 2;
    const lines = said(before, after).filter((l) => l.kind === 'finish');
    expect(lines.map((l) => l.text)).toEqual(['Car 2 finishes P1', 'Result: P2 Car 3, P3 Car 1']);
    expect(said(after, structuredClone(after))).toEqual([]); // said once
  });
});
