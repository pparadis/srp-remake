import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import bigOval from '../../../public/tracks/oval32_3lanes.json';
import { parseTrack } from '../../validation/track_schema';
import { must } from '../must';
import type { RulesVersion } from '../rules/ids';
import type { TrackData } from '../types/track';
import { lapAhead, rankPosition } from '../systems/track_index';
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceContext
} from './race_engine';

// Reachability: a rule that is never exercised in play passes every test that builds its own position, and the player
// never sees it (drafting did exactly that, issue #98: 0 of 498 turns began in a draft). So these play whole races with
// bots only, nobody placing cars, and count how often each rule with an effect the player can see comes up.
//
// The bands are wide on purpose: they fail when a rule becomes unreachable or runs all the time, not on balance noise.
// The numbers are printed so a drift inside the band is still visible in the test output.
const ctx = createRaceContext(track as unknown as TrackData);
// The bigger oval (#175): the same rules must come up there too, on twice the cells a lap.
const bigCtx = createRaceContext(parseTrack(bigOval));
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
  /** a pit-lane move that goes over a car (#249, v4) */
  pitLanePasses: number;
  /** turns that began on the cell before the pit entry with the entry taken (#249: the jam that blocked a stop) */
  blockedEntries: number;
}

function play(
  ctx: RaceContext,
  carCounts: number[],
  seeds: number[],
  laps: number,
  rules?: RulesVersion
): Reach {
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
    pitStops: 0,
    pitLanePasses: 0,
    blockedEntries: 0
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
        seed,
        rules
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
        const entry = from.next
          .map((id) => ctx.cellMap.get(id)!)
          .find((c) => c.tags?.includes('PIT_ENTRY'));
        if (entry && state.cars.some((c) => c.cellId === entry.id)) reach.blockedEntries += 1;
        const towBefore = (car.draftTurns ?? 0) >= 1;
        const result = applyAction(ctx, state, action);
        if (!result.ok) {
          applyAction(ctx, state, { type: 'skip' });
          continue;
        }
        if (action.type === 'pit') reach.pitStops += 1;
        if ((action.type === 'move' || action.type === 'pit') && from.laneIndex === 0) {
          const target = ctx.cellMap.get(action.targetCellId);
          const ahead = target ? lapAhead(ctx.trackIndex, from, target) : 0;
          if (
            state.cars.some((c) => {
              const other = ctx.cellMap.get(c.cellId)!;
              const d = lapAhead(ctx.trackIndex, from, other);
              return c.carId !== car.carId && other.laneIndex === 0 && d > 0 && d < ahead;
            })
          ) {
            reach.pitLanePasses += 1;
          }
        }
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

describe('pit lane passing (#249)', () => {
  const seeds = [1, 2, 3];
  it('v4 passes in the pit lane more often than v3', () => {
    const v3 = play(bigCtx, [8], seeds, 12, 'v3');
    const v4 = play(bigCtx, [8], seeds, 12, 'v4');
    console.log(
      `pit lane, 12 laps, 8 cars: v3 blocked entries ${v3.blockedEntries}, passes ${v3.pitLanePasses}; ` +
        `v4 blocked entries ${v4.blockedEntries}, passes ${v4.pitLanePasses}`
    );
    expect(v4.pitLanePasses, 'v4 pit lane passes').toBeGreaterThan(v3.pitLanePasses);
  }, 60_000);
});

describe.each([
  { name: 'the oval', raceCtx: ctx },
  { name: 'the big oval', raceCtx: bigCtx }
])('rules come up in play on $name', ({ name, raceCtx }) => {
  // 3 laps; 4 and 8 cars (a thin field and a crowded one); 10 seeds: more than the 4 that once hid a failure.
  const seeds = Array.from({ length: 10 }, (_slot, i) => i + 1);
  const reach = play(raceCtx, [4, 8], seeds, 3);

  it('prints what the bots did, so a drift inside the bands is visible', () => {
    console.log(
      `${name}: reach over ${reach.races} races, ${reach.moves} moves: ` +
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
    const long = play(raceCtx, [4], [1, 2, 3, 4], 12);
    console.log(
      `${name}: reach over ${long.races} 12-lap races: pit stops ${(long.pitStops / long.races).toFixed(1)}/race`
    );
    expect(long.pitStops / long.races, 'pit stops per race').toBeGreaterThanOrEqual(1);
  }, 30_000); // four 12-lap races: about 1.3 s plain, over 5 s with coverage on
});

// Rules v3 (#148): tire and fuel have to matter at any race length. Bot-only races again, the lineup a field would be
// (hard, normal, easy, normal), each car's resources read the moment it crosses the line.
interface ResourceReach {
  cars: number;
  finishFuel: number[];
  finishTire: number[];
  moves: number;
  /** moves of 7 move points or less, made with tire and fuel in hand (a crawl at the empty cap is not a choice) */
  conservative: number;
  softMoves: number;
  softNines: number;
  /** cars that made at least one move on an empty tire or tank */
  crawled: number;
  pitStops: number;
  races: number;
}

function playResources(laps: number, seeds: number[]): ResourceReach {
  const reach: ResourceReach = {
    cars: 0,
    finishFuel: [],
    finishTire: [],
    moves: 0,
    conservative: 0,
    softMoves: 0,
    softNines: 0,
    crawled: 0,
    pitStops: 0,
    races: seeds.length
  };
  for (const seed of seeds) {
    const state = createRace(
      ctx,
      LEVELS_V3.map((botLevel, i) => ({ isBot: true, ownerId: `B${i}`, botLevel })),
      laps,
      seed,
      'v3'
    );
    reach.cars += state.cars.length;
    const crawlers = new Set<number>();
    for (let turn = 0; turn < laps * 600 && state.cars.length > 0; turn += 1) {
      const car = getActiveCar(state);
      const action = decideBotAction(ctx, state).action;
      const info =
        action.type === 'move'
          ? computeTargets(ctx, state, car).get(action.targetCellId)
          : undefined;
      const empty = car.tire === 0 || car.fuel === 0;
      const compound = car.setup.compound;
      if (!applyAction(ctx, state, action).ok) throw new Error('bot action refused');
      if (action.type === 'pit') reach.pitStops += 1;
      if (info) {
        const points = info.moveSpend ?? info.distance;
        if (empty) {
          crawlers.add(car.carId);
        } else {
          reach.moves += 1;
          if (points <= 7) reach.conservative += 1;
          if (compound === 'soft') {
            reach.softMoves += 1;
            if (points >= 9) reach.softNines += 1;
          }
        }
      }
      if (state.winnerCarId !== null) {
        // a finisher leaves the track; the others play on to their own flag
        const done = must(
          state.cars.find((c) => c.carId === state.winnerCarId),
          'winner'
        );
        reach.finishFuel.push(done.fuel);
        reach.finishTire.push(done.tire);
        const at = state.turn.order.indexOf(done.carId);
        state.turn.order.splice(at, 1);
        state.turn.index = state.turn.order.length > 0 ? at % state.turn.order.length : 0;
        state.cars = state.cars.filter((c) => c.carId !== done.carId);
        state.winnerCarId = null;
      }
    }
    reach.crawled += crawlers.size;
  }
  return reach;
}

const LEVELS_V3 = ['hard', 'normal', 'easy', 'normal'] as const;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

describe('rules v3: tire and fuel matter in play', () => {
  const seeds = Array.from({ length: 8 }, (_slot, i) => i + 1);
  const five = playResources(5, seeds);
  const six = playResources(6, seeds.slice(0, 4));
  const twelve = playResources(12, seeds.slice(0, 4));

  it('prints what the bots did', () => {
    const line = (laps: number, r: ResourceReach) =>
      `${laps} laps: fuel at the flag ${median(r.finishFuel)}, tire ${median(r.finishTire)}, ` +
      `moves of 7 or less ${pct(r.conservative, r.moves).toFixed(0)}%, soft 9s ${pct(r.softNines, r.softMoves).toFixed(0)}% of ${r.softMoves}, ` +
      `cars that crawled ${r.crawled}/${r.cars}, stops ${(r.pitStops / r.races).toFixed(1)}/race`;
    console.log([line(5, five), line(6, six), line(12, twelve)].join('\n'));
    expect(five.cars).toBe(32);
  });

  it('a 5-lap race ends with little fuel and tire left', () => {
    expect(median(five.finishFuel), 'median fuel at the flag').toBeLessThanOrEqual(15);
    expect(median(five.finishTire), 'median tire at the flag').toBeLessThanOrEqual(30);
  });

  it('the size of a move is a decision: some are 7 or less, and soft cars play 9s', () => {
    expect(pct(five.conservative, five.moves), 'moves of 7 or less, %').toBeGreaterThanOrEqual(15);
    expect(five.softMoves, 'soft cars on the grid').toBeGreaterThan(0);
    expect(five.softNines, 'soft 9s').toBeGreaterThan(0);
  });

  it('a car runs dry in some races, but in fewer than half of the cars', () => {
    expect(five.crawled, 'cars that crawled').toBeGreaterThan(0);
    expect(five.crawled / five.cars, 'share of cars that crawled').toBeLessThan(0.5);
    expect(twelve.crawled / twelve.cars, 'share, 12 laps').toBeLessThan(0.75);
  });

  it('there is no stop up to 6 laps and at least one in a 12-lap race', () => {
    expect(five.pitStops, 'stops, 5 laps').toBe(0);
    expect(six.pitStops, 'stops, 6 laps').toBe(0);
    expect(twelve.pitStops / twelve.races, 'stops per 12-lap race').toBeGreaterThanOrEqual(1);
  });
});

// Rules v4 (#138): the play order is re-sorted by the standings every round. Bot-only races, on both ovals.
describe.each([
  { name: 'the oval', raceCtx: ctx },
  { name: 'the big oval', raceCtx: bigCtx }
])('v4: the leader plays first, on $name', ({ name, raceCtx }) => {
  it('re-sorts the order in play, and the leader leads each round', () => {
    let rounds = 0;
    let reordered = 0;
    let unsorted = 0;
    for (const cars of [4, 8]) {
      for (let seed = 1; seed <= 6; seed += 1) {
        const state = createRace(
          raceCtx,
          Array.from({ length: cars }, (_slot, i) => ({
            isBot: true,
            ownerId: `B${i}`,
            botLevel: LEVELS[i % LEVELS.length]!
          })),
          3,
          seed,
          'v4'
        );
        const progress = (carId: number) => {
          const car = state.cars.find((c) => c.carId === carId)!;
          return (
            (car.lapCount ?? 0) * raceCtx.trackIndex.spineLen +
            rankPosition(raceCtx.trackIndex, raceCtx.cellMap.get(car.cellId)!)
          );
        };
        for (let turn = 0; turn < 120 * cars && state.winnerCarId === null; turn += 1) {
          const order = [...state.turn.order];
          if (!applyAction(raceCtx, state, decideBotAction(raceCtx, state).action).ok) break;
          if (state.turn.index !== 0) continue;
          rounds += 1;
          if (state.turn.order.some((id, i) => id !== order[i])) reordered += 1;
          // a pit penalty can skip the first car, so check the order itself, not who is on turn
          const p = state.turn.order.map(progress);
          if (p.some((v, i) => i > 0 && v > p[i - 1]!)) unsorted += 1;
        }
      }
    }
    console.log(`${name}: v4 re-sorted the order in ${reordered} of ${rounds} rounds`);
    expect(unsorted, 'rounds that did not start in standing order').toBe(0);
    expect(reordered / rounds, 'rounds where the order changed').toBeGreaterThan(0.05);
    expect(reordered / rounds, 'rounds where the order changed').toBeLessThan(1);
  }, 60_000);
});
