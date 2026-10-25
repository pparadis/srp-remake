import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';
import track from '../../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  type RaceSeat
} from '../../src/game/race/race_engine';
import { logAction, replayRace, startRaceLog, type RaceLog } from '../../src/game/race/race_log';
import type { TrackData } from '../../src/game/types/track';
import {
  MemoryRaceStore,
  PgRaceStore,
  raceId,
  scrubLog,
  type NewRace,
  type RaceStore
} from '../src/race_store.js';

const ctx = createRaceContext(track as unknown as TrackData);
const SEATS: RaceSeat[] = [
  { isBot: false, ownerId: 'player-uuid-1' },
  { isBot: true, ownerId: 'BOT2', botLevel: 'hard', style: 'pusher' },
  { isBot: true, ownerId: 'BOT3', botLevel: 'easy' }
];

function finishedRace(seed: number, laps = 3): NewRace {
  const state = createRace(ctx, SEATS, laps, seed, 'v3');
  const log = startRaceLog(SEATS, laps, seed, 'v3');
  while (state.winnerCarId === null) {
    const car = state.cars[state.turn.order[state.turn.index]! - 1]!;
    const action = decideBotAction(ctx, state, car.isBot ? undefined : 'autopilot').action;
    applyAction(ctx, state, action);
    logAction(log, action);
  }
  return { source: 'online', trackId: 'oval16_3lanes', log, winnerCarId: state.winnerCarId };
}

test('scrubLog drops the owner ids and the bench override, and the race still replays to the same end', () => {
  const race = finishedRace(1);
  const scrubbed = scrubLog(race.log);
  assert.deepEqual(scrubbed.seats, [
    { isBot: false, ownerId: 'P1' },
    { isBot: true, ownerId: 'BOT2', botLevel: 'hard' },
    { isBot: true, ownerId: 'BOT3', botLevel: 'easy' }
  ]);
  // the first log is untouched, and the scrubbed one ends on the same race (owner ids apart)
  assert.equal(race.log.seats[0]!.ownerId, 'player-uuid-1');
  const strip = (log: RaceLog) =>
    replayRace(ctx, log)
      .at(-1)!
      .cars.map(({ ownerId: _ownerId, style: _style, ...car }) => car);
  assert.deepEqual(strip(scrubbed), strip(race.log));
});

test('the race id follows the log: same race, same id; another seed, another id', () => {
  const a = finishedRace(1);
  assert.equal(raceId(scrubLog(a.log)), raceId(scrubLog(finishedRace(1).log)));
  assert.notEqual(raceId(scrubLog(a.log)), raceId(scrubLog(finishedRace(2).log)));
});

// The same behaviour from both stores: memory, and Postgres (pg-mem stands in for Neon).
const stores: Array<[string, () => RaceStore]> = [
  ['memory', () => new MemoryRaceStore(3)],
  [
    'postgres (pg-mem)',
    () => {
      const memory = newDb().adapters.createPg();
      return new PgRaceStore(new memory.Pool());
    }
  ]
];

for (const [name, make] of stores) {
  test(`${name}: stores a race once, lists it newest first and gives it back whole`, async (t) => {
    const store = make();
    t.after(() => store.close());
    const first = await store.insert(finishedRace(1));
    assert.equal(first.duplicate, false);
    assert.equal((await store.insert(finishedRace(1))).duplicate, true);
    const second = await store.insert({ ...finishedRace(2), source: 'solo' });

    const list = await store.list(10);
    assert.deepEqual(
      list.map((race) => race.id),
      [second.id, first.id]
    );
    assert.equal(list[0]!.source, 'solo');
    assert.deepEqual(
      { cars: list[1]!.cars, laps: list[1]!.laps, rules: list[1]!.rulesVersion },
      { cars: 3, laps: 3, rules: 'v3' }
    );
    assert.ok(Math.abs(list[1]!.finishedAt - Date.now()) < 60_000);
    assert.equal((await store.list(1)).length, 1);

    const whole = await store.get(first.id);
    assert.deepEqual(whole?.log, scrubLog(finishedRace(1).log));
    assert.equal(whole?.winnerCarId, finishedRace(1).winnerCarId);
    assert.equal(await store.get('nope'), null);
  });

  test(`${name}: keeps no name or id of a player`, async (t) => {
    const store = make();
    t.after(() => store.close());
    const { id } = await store.insert(finishedRace(1));
    assert.ok(!JSON.stringify(await store.get(id)).includes('player-uuid-1'));
  });
}

test('memory: only the newest races are kept', async () => {
  const store = new MemoryRaceStore(2);
  for (const seed of [1, 2, 3]) await store.insert(finishedRace(seed));
  assert.equal((await store.list(10)).length, 2);
});

test('postgres: a database that fails at first is asked again, and the schema is made once', async () => {
  let calls = 0;
  const queries: string[] = [];
  const memory = newDb().adapters.createPg();
  const pool = new memory.Pool();
  const flaky = {
    query: ((text: string, values?: unknown[]) => {
      queries.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('the database is waking up'));
      return pool.query(text, values);
    }) as typeof pool.query,
    end: () => pool.end()
  };
  const store = new PgRaceStore(flaky);
  await assert.rejects(store.insert(finishedRace(1)), /waking up/);
  assert.equal((await store.insert(finishedRace(1))).duplicate, false);
  await store.list(1);
  assert.equal(queries.filter((q) => q.startsWith('create table')).length, 2); // the failed try, then the real one
});

test('postgres: only the newest races are kept, the oldest go first', async (t) => {
  const store = new PgRaceStore(new (newDb().adapters.createPg().Pool)(), null, 2);
  t.after(() => store.close());
  const ids: string[] = [];
  for (const seed of [1, 2, 3]) ids.push((await store.insert(finishedRace(seed))).id);
  assert.deepEqual(
    (await store.list(10)).map((race) => race.id),
    [ids[2], ids[1]]
  );
  assert.equal(await store.get(ids[0]!), null);
});

const perDeviceStores: Array<[string, () => RaceStore]> = [
  ['memory', () => new MemoryRaceStore(500, 2)],
  [
    'postgres (pg-mem)',
    () => new PgRaceStore(new (newDb().adapters.createPg().Pool)(), null, 2000, 2)
  ]
];

for (const [name, make] of perDeviceStores) {
  test(`${name}: a device keeps its newest races only, and nobody else loses one`, async (t) => {
    const store = make();
    t.after(() => store.close());
    const mine = (seed: number) => store.insert({ ...finishedRace(seed), device: 'aaaa' });
    const online = await store.insert(finishedRace(10)); // no device: the server's own
    const theirs = await store.insert({ ...finishedRace(11), device: 'bbbb' });
    const ids: string[] = [];
    for (const seed of [1, 2, 3]) ids.push((await mine(seed)).id);

    const kept = (await store.list(10)).map((race) => race.id);
    assert.deepEqual(kept.sort(), [online.id, theirs.id, ids[1]!, ids[2]!].sort());
    assert.equal(await store.get(ids[0]!), null);
    // the same race again is a duplicate and costs nothing
    assert.equal((await mine(3)).duplicate, true);
    assert.equal((await store.list(10)).length, 4);
  });
}

// Over its limit, the history drops the oldest race of the owner holding the most (a race with no device is its own owner).
const limitedStores = (limit: number): Array<[string, () => RaceStore]> => [
  ['memory', () => new MemoryRaceStore(limit)],
  [
    'postgres (pg-mem)',
    () => new PgRaceStore(new (newDb().adapters.createPg().Pool)(), null, limit)
  ]
];
const insertFrom = (store: RaceStore, device: string | undefined, seed: number) =>
  store.insert({ ...finishedRace(seed), ...(device ? { device } : {}) }).then(({ id }) => id);
const keptIds = async (store: RaceStore) => (await store.list(10)).map((race) => race.id).sort();

for (const [name, make] of limitedStores(5)) {
  test(`${name}: a device that floods the history loses its own races, not other people's`, async (t) => {
    const store = make();
    t.after(() => store.close());
    const online = await insertFrom(store, undefined, 10);
    const x = await insertFrom(store, 'xxxx', 11);
    const y = await insertFrom(store, 'yyyy', 12);
    const flood: string[] = [];
    for (const seed of [1, 2, 3, 4]) flood.push(await insertFrom(store, 'ffff', seed));
    assert.deepEqual(await keptIds(store), [online, x, y, flood[2]!, flood[3]!].sort());
  });
}

for (const [name, make] of limitedStores(3)) {
  test(`${name}: when nobody holds more than one, the oldest goes, a race with no device included`, async (t) => {
    const store = make();
    t.after(() => store.close());
    await insertFrom(store, undefined, 1);
    const a = await insertFrom(store, 'aaaa', 2);
    const online = await insertFrom(store, undefined, 3);
    const b = await insertFrom(store, 'bbbb', 4); // the one just stored is never the one that goes
    assert.deepEqual(await keptIds(store), [a, online, b].sort());
  });
}

for (const [name, make] of limitedStores(4)) {
  test(`${name}: a tie goes to the owner whose oldest race is the oldest`, async (t) => {
    const store = make();
    t.after(() => store.close());
    await insertFrom(store, 'bbbb', 1);
    const a1 = await insertFrom(store, 'aaaa', 2);
    const a2 = await insertFrom(store, 'aaaa', 3);
    const b2 = await insertFrom(store, 'bbbb', 4);
    const c = await insertFrom(store, 'cccc', 5); // a and b hold two each; b's first race is older than a's
    assert.deepEqual(await keptIds(store), [a1, a2, b2, c].sort());
  });
}
