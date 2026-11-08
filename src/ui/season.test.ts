/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { isGrid } from '../game/race/race_engine';
import {
  SEASON_CALENDAR,
  SEASON_KEY,
  champion,
  clearSeason,
  forfeitUnfinished,
  isSeasonFinished,
  loadOnlineSeason,
  loadSeason,
  newSeason,
  nextRaceIndex,
  recordResult,
  rememberOnlineSeason,
  renameDrivers,
  saveSeason,
  seasonGrid,
  seasonStandings,
  startSeasonRace,
  type Season
} from './season';

const season = (seed = 42, bots = 3) => newSeason(seed, bots, 'normal', 'v4', 1000);
// A season with `orders` already run
function played(orders: number[][], bots = 3): Season {
  return orders.reduce((s, order, i) => recordResult(s, i, order, `saved-${i}`), season(42, bots));
}

describe('a new season (#273)', () => {
  it('is fixed by its seed: the calendar, the names, the styles and the race seeds', () => {
    expect(season()).toEqual(season());
    expect(season(43)).not.toEqual(season());
    const s = season();
    expect(s.races.map(({ trackId, raceLaps }) => ({ trackId, raceLaps }))).toEqual(
      SEASON_CALENDAR.map(({ trackId, raceLaps }) => ({ trackId, raceLaps }))
    );
    expect(s.races.map((r) => r.reversedGrid ?? false)).toEqual([false, false, true, false]);
    expect(new Set(s.races.map((r) => r.seed)).size).toBe(4);
    expect(s.races.every((r) => r.seed >= 1)).toBe(true);
    expect(s.drivers[0]).toEqual({ carId: 1, name: 'You', human: true });
  });

  it('gives every bot its own name, and the first five bots their own style', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const bots = newSeason(seed, 10, 'hard', 'v4').drivers.filter((d) => !d.human);
      expect(new Set(bots.map((d) => d.name)).size).toBe(10);
      expect(new Set(bots.slice(0, 5).map((d) => d.style)).size).toBe(5);
    }
  });

  it('carries the cars, the level and the rules it was started with', () => {
    expect(newSeason(5, 2, 'hard', 'v3')).toMatchObject({ botLevel: 'hard', rulesVersion: 'v3' });
    expect(newSeason(5, 2, 'hard', 'v3').drivers).toHaveLength(3);
  });
});

describe('standings (#273)', () => {
  it('scores the F1 table and ranks by points', () => {
    const rows = seasonStandings(played([[2, 1, 3, 4]]));
    expect(rows.map((r) => [r.driver.carId, r.points, r.rank])).toEqual([
      [2, 25, 1],
      [1, 18, 2],
      [3, 15, 3],
      [4, 12, 4]
    ]);
    expect(rows[0]?.places).toEqual([1, null, null, null]);
  });

  const order = (orders: number[][]) =>
    seasonStandings(played(orders, 5)).map((r) => r.driver.carId);

  it('breaks a tie in points by the most wins', () => {
    // car 1: P1 + P6 = 33, car 2: P2 + P3 = 33
    const rows = seasonStandings(
      played(
        [
          [1, 2, 3, 4, 5, 6],
          [4, 5, 2, 3, 6, 1]
        ],
        5
      )
    );
    const points = (carId: number) => rows.find((r) => r.driver.carId === carId)?.points;
    expect([points(1), points(2)]).toEqual([33, 33]);
    expect(
      order([
        [1, 2, 3, 4, 5, 6],
        [4, 5, 2, 3, 6, 1]
      ]).slice(0, 3)
    ).toEqual([4, 1, 2]);
  });

  it('then by count-back: the most second places, and so on', () => {
    // no win for car 1 or car 2, both on 38: car 1 has the second place (P2, P5, P5 against P3, P3, P6)
    const table = order([
      [3, 1, 2, 4, 5, 6],
      [3, 4, 2, 5, 1, 6],
      [3, 4, 5, 6, 1, 2]
    ]);
    expect(table.indexOf(1)).toBeLessThan(table.indexOf(2));
  });

  it('then by the better place in the last race', () => {
    // car 1 and car 2 swap P2 and P3: the same points, the same places, car 2 ahead in the last race
    const table = seasonStandings(
      played([
        [3, 1, 2, 4],
        [3, 2, 1, 4]
      ])
    ).map((r) => r.driver.carId);
    expect(table).toEqual([3, 2, 1, 4]);
  });

  it('is not finished until every race has a result, then names the champion', () => {
    let s = season();
    expect(nextRaceIndex(s)).toBe(0);
    expect(champion(s)).toBeNull();
    for (let i = 0; i < 4; i += 1) s = recordResult(s, i, [3, 1, 2, 4], null);
    expect(isSeasonFinished(s)).toBe(true);
    expect(nextRaceIndex(s)).toBeNull();
    expect(champion(s)?.carId).toBe(3);
  });
});

describe('recording results (#273)', () => {
  it('ignores a second result for the same race, and an order that is not the drivers', () => {
    const first = recordResult(season(), 0, [2, 1, 3, 4], 'a');
    expect(recordResult(first, 0, [1, 2, 3, 4], 'b')).toBe(first);
    expect(recordResult(season(), 0, [1, 2, 3], 'x')).toEqual(season());
    expect(recordResult(season(), 0, [1, 1, 2, 3], 'x')).toEqual(season());
    expect(recordResult(season(), 9, [1, 2, 3, 4], 'x')).toEqual(season());
    expect(first.races[0]?.result).toEqual({ order: [2, 1, 3, 4], savedRaceId: 'a' });
  });

  it('marks a race started, once it has no result', () => {
    const s = startSeasonRace(season(), 1);
    expect(s.races[1]?.started).toBe(true);
    expect(
      startSeasonRace(recordResult(season(), 0, [1, 2, 3, 4], null), 0).races[0]?.started
    ).toBe(true);
    const done = recordResult(season(), 0, [1, 2, 3, 4], null);
    expect(startSeasonRace(done, 0)).toBe(done);
  });

  it('scores a started race that was not finished as a forfeit: the human last, the bots as they stood', () => {
    // after race 1 the bots stand 2, 3, 4 (the human won), so a forfeited race 2 goes 2, 3, 4, then the human
    let s = recordResult(season(), 0, [1, 2, 3, 4], null);
    s = forfeitUnfinished(startSeasonRace(s, 1));
    expect(s.races[1]?.result).toEqual({ order: [2, 3, 4, 1], savedRaceId: null, forfeit: true });
    // a race that was never started stays open
    expect(forfeitUnfinished(season())).toEqual(season());
    expect(nextRaceIndex(s)).toBe(2);
  });
});

describe('the reversed grid of race 3 (#273)', () => {
  it('puts the leader of the standings last, and only on a race that asks for it', () => {
    const s = played([
      [2, 1, 3, 4],
      [2, 3, 1, 4]
    ]);
    const grid = seasonGrid(s, 2)!;
    expect(isGrid(grid, 4)).toBe(true);
    // standings: car 2 (43), car 1 (33), car 3 (33), car 4 (2 + 2... ) -> leader car 2 starts last (slot 3)
    expect(grid[1]).toBe(3);
    const table = seasonStandings(s).map((r) => r.driver.carId);
    expect(table.map((carId) => grid[carId - 1])).toEqual([3, 2, 1, 0]);
    expect(seasonGrid(s, 0)).toBeUndefined();
    expect(seasonGrid(s, 1)).toBeUndefined();
    expect(seasonGrid(s, 3)).toBeUndefined();
  });
});

describe('the stored season (#273)', () => {
  beforeEach(() => window.localStorage.clear());

  it('round-trips, and a cleared season is gone', () => {
    const s = played([[2, 1, 3, 4]]);
    expect(saveSeason(s)).toBe(true);
    expect(loadSeason()).toEqual({ season: s, retired: false });
    clearSeason();
    expect(loadSeason()).toEqual({ season: null, retired: false });
  });

  it('loads a broken season as none, and drops it', () => {
    for (const raw of [
      'not json',
      '{}',
      '[]',
      'null',
      JSON.stringify({ ...season(), races: [] }),
      JSON.stringify({ ...season(), drivers: [{ carId: 1 }] }),
      JSON.stringify({ ...season(), botLevel: 'x' })
    ]) {
      window.localStorage.setItem(SEASON_KEY, raw);
      expect(loadSeason().season).toBeNull();
    }
    const bad = recordResult(season(), 0, [1, 2, 3, 4], null);
    bad.races[0]!.result!.order = [1, 2, 3];
    window.localStorage.setItem(SEASON_KEY, JSON.stringify(bad));
    expect(loadSeason().season).toBeNull();
  });

  it('drops a season on a rules version that is no longer selectable, and says so', () => {
    window.localStorage.setItem(SEASON_KEY, JSON.stringify({ ...season(), rulesVersion: 'v2' }));
    expect(loadSeason()).toEqual({ season: null, retired: true });
    expect(window.localStorage.getItem(SEASON_KEY)).toBeNull();
  });
});

describe('a lobby season (#273)', () => {
  const lobbySeason = () => newSeason(42, 2, 'normal', 'v4', 1000, 2, 'secret-id');

  it('seats the humans first, then the bots, and keeps the id it was given', () => {
    const s = lobbySeason();
    expect(s.id).toBe('secret-id');
    expect(s.drivers.map((d) => [d.carId, d.human])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false]
    ]);
    expect(s.drivers.slice(0, 2).map((d) => d.name)).toEqual(['Player 1', 'Player 2']);
    // the bots draw the same names and styles as in a solo season of the same seed
    const solo = newSeason(42, 2, 'normal', 'v4', 1000);
    expect(s.drivers.slice(2).map((d) => [d.name, d.style])).toEqual(
      solo.drivers.slice(1).map((d) => [d.name, d.style])
    );
  });

  it('renames the humans by car id and leaves the others alone', () => {
    const named = renameDrivers(lobbySeason(), { 2: 'Guest' });
    expect(named.drivers.map((d) => d.name).slice(0, 3)).toEqual([
      'Player 1',
      'Guest',
      lobbySeason().drivers[2]!.name
    ]);
  });
});

describe('the online championship the browser remembers (#273)', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps the id of a running season, and forgets it when it is over or there is none', () => {
    const running = newSeason(1, 1, 'normal', 'v4', 1, 2, 'abc');
    rememberOnlineSeason(running, 'Race 1 of 4');
    expect(loadOnlineSeason()).toEqual({ id: 'abc', label: 'Race 1 of 4' });
    const over = [0, 1, 2, 3].reduce((s, i) => recordResult(s, i, [1, 2, 3], null), running);
    rememberOnlineSeason(over, 'Champion');
    expect(loadOnlineSeason()).toBeNull();
    rememberOnlineSeason(running, 'Race 1 of 4');
    rememberOnlineSeason(null, '');
    expect(loadOnlineSeason()).toBeNull();
  });

  it('ignores a broken value', () => {
    window.localStorage.setItem('srp:online-season', '{"id":3}');
    expect(loadOnlineSeason()).toBeNull();
    window.localStorage.setItem('srp:online-season', 'not json');
    expect(loadOnlineSeason()).toBeNull();
  });
});
