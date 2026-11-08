import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSeason, SEASON_CALENDAR, type Season } from '../../src/ui/season';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { MemoryRaceStore, type RaceStore } from '../src/race_store.js';
import { createApp } from '../src/server.js';
import type { PublicLobby } from '../src/types.js';
import { playRaceToEnd } from './helpers.js';

// A lobby's championship (#273): the host switches `season`, the server keeps the standings, the same seats race the
// calendar, and a season is picked up again by its id.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};
const SETTINGS = { totalCars: 3, humanCars: 1, botCars: 2, turnTimerSec: 0, season: true };

async function start(t: test.TestContext, raceStore: RaceStore = new MemoryRaceStore()) {
  const lobbyStore = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore, raceStore });
  t.after(() => app.close());
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/v1${url}`, payload });
  const create = async (extra: object = {}) => {
    const res = await post('/lobbies', { name: 'Host', settings: SETTINGS, ...extra });
    return { res, ...(res.json() as { lobby: PublicLobby; playerToken: string }) };
  };
  const begin = async (lobbyId: string, playerToken: string) => {
    const res = await post(`/lobbies/${lobbyId}/start`, { playerToken });
    assert.equal(res.statusCode, 200);
    return (res.json() as { lobby: PublicLobby }).lobby;
  };
  return { app, lobbyStore, raceStore, post, create, begin };
}

test('a championship lobby races the calendar: race 1 is pinned, its result is scored and kept', async (t) => {
  const { lobbyStore, raceStore, post, create, begin, app } = await start(t);
  const { lobby, playerToken } = await create();
  const started = await begin(lobby.lobbyId, playerToken);
  const season = started.season!;
  assert.deepEqual(
    [started.settings.trackId, started.settings.raceLaps],
    [SEASON_CALENDAR[0]!.trackId, SEASON_CALENDAR[0]!.raceLaps]
  );
  assert.equal(started.raceState!.seed, season.races[0]!.seed);
  assert.deepEqual(
    season.drivers.map((d) => [d.carId, d.human]),
    [
      [1, true],
      [2, false],
      [3, false]
    ]
  );
  assert.equal(season.drivers[0]!.name, 'Host');
  assert.ok(season.races[0]!.started);

  await playRaceToEnd(app, lobby.lobbyId, playerToken, 'season');
  const after = lobbyStore.getLobby(lobby.lobbyId)!.season!;
  assert.equal(after.races[0]!.result?.order.length, 3);
  assert.ok(after.races[0]!.result?.savedRaceId); // the recap of it is stored
  // persisted under its id, and what is stored is a season the page can read
  await new Promise((resolve) => setImmediate(resolve));
  const stored = parseSeason(await raceStore.loadSeason(season.id));
  assert.deepEqual(stored, after);

  // the next race: the lobby shows its track, and the seats and the points stay
  const reset = await post(`/lobbies/${lobby.lobbyId}/reset`, { playerToken });
  assert.equal(reset.statusCode, 200);
  const waiting = (reset.json() as { lobby: PublicLobby }).lobby;
  assert.equal(waiting.settings.trackId, SEASON_CALENDAR[1]!.trackId);
  // the cars, the bots and the track are fixed from now on; the timer is not
  const patch = (settings: object) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/lobbies/${lobby.lobbyId}/settings`,
      payload: { playerToken, settings }
    });
  assert.equal((await patch({ botLevel: 'easy' })).statusCode, 409);
  assert.equal((await patch({ botCars: 1, totalCars: 2 })).statusCode, 409);
  assert.equal((await patch({ season: false })).statusCode, 409);
  assert.equal((await patch({ turnTimerSec: 30 })).statusCode, 200);
  const second = await begin(lobby.lobbyId, playerToken);
  assert.equal(second.season!.id, season.id);
  assert.deepEqual(
    second.season!.drivers.map((d) => d.name),
    season.drivers.map((d) => d.name)
  );
  assert.equal(second.raceState!.seed, season.races[1]!.seed);
});

test('a championship is resumed by its id: 404 unknown, 409 live, retired or finished, 503 store down', async (t) => {
  const { create, begin, lobbyStore, raceStore, post } = await start(t);
  const { lobby, playerToken } = await create();
  const season = (await begin(lobby.lobbyId, playerToken)).season!;
  await new Promise((resolve) => setImmediate(resolve));
  const resume = (id: string) => post('/lobbies', { name: 'Back', resumeSeasonId: id });

  assert.equal((await resume('nope')).statusCode, 404);
  assert.equal((await resume(season.id)).statusCode, 409); // a live lobby already holds it

  // the lobby goes away (host leaves): the same id now resumes, the running race counted as a forfeit
  lobbyStore.forfeitSeason(lobby.lobbyId);
  await raceStore.saveSeason(lobbyStore.getLobby(lobby.lobbyId)!.season!);
  lobbyStore.deleteLobby(lobby.lobbyId);
  const res = await resume(season.id);
  assert.equal(res.statusCode, 201);
  const resumed = (res.json() as { lobby: PublicLobby }).lobby;
  assert.equal(resumed.season!.races[0]!.result?.forfeit, true);
  assert.equal(resumed.settings.season, true);
  assert.equal(resumed.settings.trackId, SEASON_CALENDAR[1]!.trackId);
  assert.equal(resumed.status, 'WAITING');

  const done: Season = {
    ...season,
    id: 'finished',
    races: season.races.map((race) => ({
      ...race,
      result: { order: [1, 2, 3], savedRaceId: null }
    }))
  };
  await raceStore.saveSeason(done);
  assert.equal((await resume('finished')).statusCode, 409);
  await raceStore.saveSeason({ ...season, id: 'old', rulesVersion: 'v2' } as unknown as Season);
  assert.equal((await resume('old')).statusCode, 409);

  const down = await start(t, {
    insert: () => Promise.reject(new Error('asleep')),
    list: () => Promise.reject(new Error('asleep')),
    get: () => Promise.reject(new Error('asleep')),
    saveSeason: () => Promise.reject(new Error('asleep')),
    loadSeason: () => Promise.reject(new Error('asleep')),
    close: () => Promise.resolve()
  });
  assert.equal(
    (await down.post('/lobbies', { name: 'Back', resumeSeasonId: 'any' })).statusCode,
    503
  );
});
