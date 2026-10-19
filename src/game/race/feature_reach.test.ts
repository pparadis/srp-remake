import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import type { TrackData } from '../types/track';
import { lapAhead } from '../systems/track_index';
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar
} from './race_engine';

// Reachability: a rule that is never exercised in play passes every test that builds its own position, and the player
// never sees it (drafting did exactly that, issue #98: 0 of 498 turns began in a draft). So these play whole races with
// bots only, nobody placing cars, and count how often each rule with an effect the player can see comes up.
//
// The bands are wide on purpose: they fail when a rule becomes unreachable or runs all the time, not on balance noise.
// The numbers are printed so a drift inside the band is still visible in the test output.
const ctx = createRaceContext(track as unknown as TrackData);
const LEVELS = ['hard', 'normal', 'easy'] as const;

interface Reach {
  races: number;
  moves: number;
  /** the car started the move in a tow (it ended its last move 1-2 cells behind a car) */
  inTow: number;
  /** the car ended the move 1-2 cells behind a car */
  endedTucked: number;
  slingshots: number;
  squeezes: number;
  /** a same-lane pass round a blocker, or a zig-zag: a route with 2 or more lane changes */
  multiLaneChange: number;
  laneChanges: number;
  /** the move passes 2 or more cars: they stand between the start and the target, in the start or the target lane (#102) */
  passesTwoOrMore: number;
  pitStops: number;
}

function play(carCounts: number[], seeds: number[], laps: number): Reach {
  const reach: Reach = {
    races: 0,
    moves: 0,
    inTow: 0,
    endedTucked: 0,
    slingshots: 0,
    squeezes: 0,
    multiLaneChange: 0,
    laneChanges: 0,
    passesTwoOrMore: 0,
    pitStops: 0
  };
  for (const cars of carCounts) {
    for (const seed of seeds) {
      const state = createRace(
        ctx,
        Array.from({ length: cars }, (_slot, i) => ({
          isBot: true,
          ownerId: `B${i}`,
          botLevel: LEVELS[i % LEVELS.length]!
        })),
        laps,
        seed
      );
      reach.races += 1;
      for (let turn = 0; turn < 120 * cars && state.winnerCarId === null; turn += 1) {
        const car = getActiveCar(state);
        const action = decideBotAction(ctx, state).action;
        const info =
          action.type === 'move'
            ? computeTargets(ctx, state, car).get(action.targetCellId)
            : undefined;
        const from = ctx.cellMap.get(car.cellId)!;
        const towBefore = (car.draftTurns ?? 0) >= 1;
        const result = applyAction(ctx, state, action);
        if (!result.ok) {
          applyAction(ctx, state, { type: 'skip' });
          continue;
        }
        if (action.type === 'pit') reach.pitStops += 1;
        if (action.type !== 'move' || !info) continue;
        reach.moves += 1;
        if (towBefore) reach.inTow += 1;
        if ((car.draftTurns ?? 0) >= 1) reach.endedTucked += 1;
        if (info.squeezePassed) reach.squeezes += 1;
        if ((info.laneChanges ?? 0) >= 2) reach.multiLaneChange += 1;
        const to = ctx.cellMap.get(action.targetCellId)!;
        if (to.laneIndex !== from.laneIndex) reach.laneChanges += 1;
        if (!info.squeezePassed) {
          const ahead = lapAhead(ctx.trackIndex, from, to);
          const passed = state.cars.filter((c) => {
            if (c.carId === car.carId) return false;
            const other = ctx.cellMap.get(c.cellId)!;
            if (other.laneIndex !== from.laneIndex && other.laneIndex !== to.laneIndex) {
              return false;
            }
            const d = lapAhead(ctx.trackIndex, from, other);
            return d > 0 && d < ahead;
          }).length;
          if (passed >= 2) reach.passesTwoOrMore += 1;
        }
      }
      reach.slingshots += state.cars.reduce((sum, c) => sum + (c.slingshots ?? 0), 0);
    }
  }
  return reach;
}

const pct = (n: number, of: number) => (of === 0 ? 0 : (100 * n) / of);

describe('rules come up in play', () => {
  // 3 laps; 4 and 8 cars (a thin field and a crowded one); 10 seeds: more than the 4 that once hid a failure.
  const seeds = Array.from({ length: 10 }, (_slot, i) => i + 1);
  const reach = play([4, 8], seeds, 3);

  it('prints what the bots did, so a drift inside the bands is visible', () => {
    console.log(
      `reach over ${reach.races} races, ${reach.moves} moves: ` +
        `in tow ${pct(reach.inTow, reach.moves).toFixed(1)}%, ended tucked ${pct(reach.endedTucked, reach.moves).toFixed(1)}%, ` +
        `slingshots ${(reach.slingshots / reach.races).toFixed(1)}/race, squeezes ${reach.squeezes}, ` +
        `multi lane change ${reach.multiLaneChange}, passes 2+ cars ${reach.passesTwoOrMore}, lane changes ${pct(reach.laneChanges, reach.moves).toFixed(1)}%, ` +
        `pit stops ${(reach.pitStops / reach.races).toFixed(1)}/race`
    );
    expect(reach.moves).toBeGreaterThan(500);
  });

  it('drafting: a real share of moves start in a tow, and the slingshot is played', () => {
    // Before #98 this was 0.4% of turns and 0 slingshots: the rule was judged at a moment no car could satisfy it.
    expect(pct(reach.inTow, reach.moves), 'moves that started in a tow, %').toBeGreaterThanOrEqual(
      10
    );
    expect(pct(reach.inTow, reach.moves), 'moves that started in a tow, %').toBeLessThanOrEqual(95);
    expect(
      pct(reach.endedTucked, reach.moves),
      'moves that ended tucked in, %'
    ).toBeGreaterThanOrEqual(10);
    expect(reach.slingshots / reach.races, 'slingshots per race').toBeGreaterThanOrEqual(1);
  });

  it('lane changes and multi-lane-change routes come up', () => {
    expect(pct(reach.laneChanges, reach.moves), 'moves that change lane, %').toBeGreaterThanOrEqual(
      5
    );
    expect(reach.multiLaneChange, 'go-rounds and zig-zags').toBeGreaterThan(0);
  });

  it('a move may pass two or more cars (#102), and it is not the usual move', () => {
    // Before #102 a lane change stopped at the second car of its lane and a go-around at the second of the start lane.
    expect(reach.passesTwoOrMore, 'moves that pass 2+ cars').toBeGreaterThan(0);
    expect(
      pct(reach.passesTwoOrMore, reach.moves),
      'moves that pass 2+ cars, %'
    ).toBeLessThanOrEqual(50);
  });

  it('pit stops come up in a race long enough to need one (3 laps is a sprint with no stop)', () => {
    const long = play([4], [1, 2, 3, 4], 12);
    console.log(
      `reach over ${long.races} 12-lap races: pit stops ${(long.pitStops / long.races).toFixed(1)}/race`
    );
    expect(long.pitStops / long.races, 'pit stops per race').toBeGreaterThanOrEqual(1);
  });
});
