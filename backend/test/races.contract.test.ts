import assert from 'node:assert/strict';
import test from 'node:test';
import track from '../../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  type RaceSeat
} from '../../src/game/race/race_engine';
import { logAction, startRaceLog, type RaceLog } from '../../src/game/race/race_log';
import type { TrackData } from '../../src/game/types/track';
import type { BackendConfig } from '../src/config.js';
import { MemoryRaceStore, type RaceStore } from '../src/race_store.js';
import { createApp } from '../src/server.js';
import { playRaceToEnd } from './helpers.js';

// The race history (#170): solo races uploaded by their players, online races stored by the server, all anonymous.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};
const ctx = createRaceContext(track as unknown as TrackData);

function soloLog(laps = 2, seed = 4): RaceLog {
  const seats: RaceSeat[] = [
    { isBot: false, ownerId: 'P1' },
    { isBot: true, ownerId: 'BOT1', botLevel: 'normal' }
  ];
  const state = createRace(ctx, seats, laps, seed, 'v3');
  const log = startRaceLog(seats, laps, seed, 'v3');
  while (state.winnerCarId === null) {
    const car = state.cars[state.turn.order[state.turn.index]! - 1]!;
    const action = decideBotAction(ctx, state, car.isBot ? undefined : 'autopilot').action;
    applyAction(ctx, state, action);
    logAction(log, action);
  }
  return log;
}

async function start(
  t: test.TestContext,
  raceStore: RaceStore = new MemoryRaceStore(),
  config: Partial<BackendConfig> = {}
) {
  const app = await createApp({ ...TEST_CONFIG, ...config }, { logger: false, raceStore });
  t.after(() => app.close());
  const mint = async () =>
    (
      (await app.inject({ method: 'POST', url: '/api/v1/devices' })).json() as {
        deviceToken: string;
      }
    ).deviceToken;
  const device = await mint();
  // `token`: another device's, or none at all (null)
  const upload = (payload: unknown, token: string | null = device) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/races',
      payload: payload as object,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
  return { app, raceStore, upload, mint };
}

test('a race on retired rules (v2) is refused, and an old row still lists and downloads (#254)', async (t) => {
  const store = new MemoryRaceStore();
  const { app, upload } = await start(t, store);
  assert.equal((await upload({ log: { ...soloLog(), rulesVersion: 'v2' } })).statusCode, 400);
  // a row stored before the retirement: the history still gives it, the page decides it cannot replay it
  const old = { ...soloLog(), rulesVersion: 'v2' } as unknown as RaceLog;
  const { id } = await store.insert({
    source: 'online',
    trackId: 'oval16_3lanes',
    log: old,
    winnerCarId: 1
  });
  const list = (await app.inject({ method: 'GET', url: '/api/v1/races' })).json() as {
    races: Array<{ id: string; rulesVersion: string }>;
  };
  assert.deepEqual(
    list.races.map((r) => [r.id, r.rulesVersion]),
    [[id, 'v2']]
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/races/${id}` })).statusCode, 200);
});

test('a finished solo race is stored once, listed and given back, with no owner ids', async (t) => {
  const { app, upload } = await start(t);
  const log = soloLog();
  const first = await upload({ log });
  assert.equal(first.statusCode, 201);
  const { id, duplicate } = first.json() as { id: string; duplicate: boolean };
  assert.equal(duplicate, false);

  const again = await upload({ log });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { id, duplicate: true });

  const list = (await app.inject({ method: 'GET', url: '/api/v1/races' })).json() as {
    races: Array<{ id: string; source: string; laps: number; cars: number }>;
  };
  assert.equal(list.races.length, 1);
  assert.deepEqual(
    {
      id: list.races[0]!.id,
      source: list.races[0]!.source,
      laps: list.races[0]!.laps,
      cars: list.races[0]!.cars
    },
    { id, source: 'solo', laps: 2, cars: 2 }
  );

  const whole = (await app.inject({ method: 'GET', url: `/api/v1/races/${id}` })).json() as {
    log: RaceLog;
  };
  assert.equal(whole.log.actions.length, log.actions.length);
  assert.deepEqual(
    whole.log.seats.map((seat) => seat.ownerId),
    ['P1', 'BOT2']
  );
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/races/nope' })).statusCode, 404);
});

test('a log the engine refuses, an unfinished race or an unknown track is turned down (400)', async (t) => {
  const { upload } = await start(t);
  const log = soloLog();
  const broken = { ...log, actions: [{ type: 'move', targetCellId: 'Z99_L9_99' }, ...log.actions] };
  assert.equal((await upload({ log: broken })).statusCode, 400);
  assert.equal(
    (await upload({ log: { ...log, actions: log.actions.slice(0, 5) } })).statusCode,
    400
  );
  assert.equal((await upload({ trackId: 'nowhere', log })).statusCode, 400);
  // a log from other rules does not replay on this one
  assert.equal((await upload({ log: { ...log, seed: log.seed + 1 } })).statusCode, 400);
});

test('malformed or oversized uploads are refused before any replay', async (t) => {
  const { upload } = await start(t);
  const log = soloLog();
  assert.equal((await upload({})).statusCode, 400);
  assert.equal((await upload({ log: { ...log, rulesVersion: 'v9' } })).statusCode, 400);
  assert.equal((await upload({ log: { ...log, raceLaps: 500 } })).statusCode, 400);
  const many = Array.from({ length: 2001 }, () => ({ type: 'skip' }));
  assert.equal((await upload({ log: { ...log, actions: many } })).statusCode, 400);
  const huge = { ...log, seats: [{ isBot: false, ownerId: 'x'.repeat(200 * 1024) }] };
  assert.equal((await upload({ log: huge })).statusCode, 413);
});

test('an online race is stored by the server when it finishes, under its own source and without player ids', async (t) => {
  const { app, raceStore } = await start(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: {
      name: 'Host',
      settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 2, turnTimerSec: 0 }
    }
  });
  const { lobby, playerId, playerToken } = created.json() as {
    lobby: { lobbyId: string };
    playerId: string;
    playerToken: string;
  };
  await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobby.lobbyId}/start`,
    payload: { playerToken }
  });
  assert.equal((await raceStore.list(10)).length, 0, 'nothing is stored mid-race');
  await playRaceToEnd(app, lobby.lobbyId, playerToken, 'hist');

  for (let i = 0; i < 100 && (await raceStore.list(10)).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [summary] = await raceStore.list(10);
  assert.equal(summary?.source, 'online');
  const whole = await raceStore.get(summary!.id);
  assert.ok(!JSON.stringify(whole).includes(playerId));
  assert.ok(!JSON.stringify(whole).includes('Host'));
});

test('a store that is down costs a solo upload a 503 and an online race nothing', async (t) => {
  const down: RaceStore = {
    insert: () => Promise.reject(new Error('database is asleep')),
    list: () => Promise.reject(new Error('database is asleep')),
    get: () => Promise.reject(new Error('database is asleep')),
    close: () => Promise.resolve()
  };
  const { app, upload } = await start(t, down);
  assert.equal((await upload({ log: soloLog() })).statusCode, 503);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/races' })).statusCode, 503);

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: {
      name: 'Host',
      settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1, turnTimerSec: 0 }
    }
  });
  const { lobby, playerToken } = created.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
  };
  await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobby.lobbyId}/start`,
    payload: { playerToken }
  });
  const finished = await playRaceToEnd(app, lobby.lobbyId, playerToken, 'down');
  assert.equal(finished.status, 'FINISHED');
});

test('an upload needs a device token this server signed (401), checked before any replay', async (t) => {
  const { upload, raceStore } = await start(t, undefined, {
    DEVICE_TOKEN_SECRET: 'the-secret-of-this-server-0123456789'
  });
  const other = await start(t, undefined, {
    DEVICE_TOKEN_SECRET: 'the-secret-of-another-one-0123456789'
  });
  const log = soloLog();
  const [id, signature] = (await other.mint()).split('.') as [string, string];
  const refused = [
    await upload({ log }, null),
    await upload({ log }, 'nope'),
    await upload({ log }, `${id}.${signature}`), // signed by another server
    await upload({ log: { ...log, seed: log.seed + 1 } }, null), // would not replay, but never gets there
    await upload({ log }, `${id}.`)
  ];
  assert.deepEqual(
    refused.map((res) => res.statusCode),
    [401, 401, 401, 401, 401]
  );
  assert.equal((await raceStore.list(10)).length, 0);
  assert.equal((await upload({ log })).statusCode, 201);
});

test('the token is read from Authorization: Bearer only, not from the body or the query', async (t) => {
  const { app, mint } = await start(t);
  const deviceToken = await mint();
  const log = soloLog();
  const inBody = await app.inject({
    method: 'POST',
    url: '/api/v1/races',
    payload: { log, deviceToken }
  });
  const inQuery = await app.inject({
    method: 'POST',
    url: `/api/v1/races?deviceToken=${deviceToken}`,
    payload: { log }
  });
  const basic = await app.inject({
    method: 'POST',
    url: '/api/v1/races',
    payload: { log },
    headers: { authorization: `Basic ${deviceToken}` }
  });
  assert.deepEqual([inBody.statusCode, inQuery.statusCode, basic.statusCode], [401, 401, 401]);
});

test('a device holds a bounded share of the history: its next race replaces its own oldest, nobody else is touched', async (t) => {
  const raceStore = new MemoryRaceStore(500, 2);
  const { app, upload, mint } = await start(t, raceStore);
  const other = await mint();
  const otherRace = (await upload({ log: soloLog(1, 90) }, other)).json() as { id: string };
  const ids: string[] = [];
  for (const seed of [1, 2, 3]) {
    ids.push(((await upload({ log: soloLog(1, seed) })).json() as { id: string }).id);
  }
  const kept = (await raceStore.list(10)).map((race) => race.id).sort();
  assert.deepEqual(kept, [otherRace.id, ids[1]!, ids[2]!].sort());
  // the device is not in what the API gives back
  const listed = (await app.inject({ method: 'GET', url: '/api/v1/races' })).body;
  const whole = (await app.inject({ method: 'GET', url: `/api/v1/races/${ids[2]}` })).body;
  for (const body of [listed, whole]) {
    assert.ok(!body.includes('device'));
    assert.ok(!body.includes(other.split('.')[0]!));
  }
});

test('device tokens are minted at 20 a day per IP: the 21st is 429', async (t) => {
  const { app } = await start(t, new MemoryRaceStore(), { RATE_LIMIT_ENABLED: true }); // minted one already
  for (let i = 0; i < 19; i += 1) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices' })).statusCode, 201);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/devices' })).statusCode, 429);
});

test('uploads are rate limited: the 11th in a minute is 429', async (t) => {
  const { upload } = await start(t, new MemoryRaceStore(), { RATE_LIMIT_ENABLED: true });
  const log = soloLog(1);
  for (let i = 0; i < 10; i += 1) {
    assert.ok([200, 201].includes((await upload({ log })).statusCode));
  }
  assert.equal((await upload({ log })).statusCode, 429);
});

test('a mint and an upload are logged with the client address, never the token', async (t) => {
  const lines: string[] = [];
  const app = await createApp(TEST_CONFIG, {
    raceStore: new MemoryRaceStore(),
    logStream: { write: (line) => lines.push(line) }
  });
  t.after(() => app.close());
  const remoteAddress = '203.0.113.9';
  const { deviceToken } = (
    await app.inject({ method: 'POST', url: '/api/v1/devices', remoteAddress })
  ).json() as { deviceToken: string };
  await app.inject({
    method: 'POST',
    url: '/api/v1/races',
    payload: { log: soloLog(1) },
    headers: { authorization: `Bearer ${deviceToken}` },
    remoteAddress
  });
  const events = lines
    .map((line) => JSON.parse(line) as { event?: string; ip?: string; duplicate?: boolean })
    .filter((entry) => entry.event?.startsWith('device.') || entry.event?.startsWith('race.'));
  assert.deepEqual(
    events.map((entry) => [entry.event, entry.ip]),
    [
      ['device.mint', remoteAddress],
      ['race.upload', remoteAddress]
    ]
  );
  assert.equal(events[1]!.duplicate, false);
  assert.ok(!lines.join('').includes(deviceToken));
});
