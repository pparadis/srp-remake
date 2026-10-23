import assert from 'node:assert/strict';
import test from 'node:test';
import { replayRace } from '../../src/game/race/race_log';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { createApp } from '../src/server.js';
import { getRaceContext } from '../src/tracks.js';
import { playRaceToEnd } from './helpers.js';

// GET /lobbies/:id/recap (#169): the finished race as data, for a seated player, and only once somebody has won.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

async function seatedRace(t: test.TestContext) {
  const lobbyStore = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore });
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: {
      name: 'Host',
      settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 2, turnTimerSec: 0 }
    }
  });
  const { lobby, playerToken } = created.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
  };
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobby.lobbyId}/start`,
    payload: { playerToken }
  });
  assert.equal(started.statusCode, 200);
  const recap = (token: string, lobbyId = lobby.lobbyId) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/lobbies/${lobbyId}/recap?playerToken=${encodeURIComponent(token)}`
    });
  return { app, lobbyStore, lobbyId: lobby.lobbyId, token: playerToken, recap };
}

test('the recap is refused (409) while the race is on, and served once it is finished', async (t) => {
  const { app, lobbyStore, lobbyId, token, recap } = await seatedRace(t);
  assert.equal((await recap(token)).statusCode, 409);

  await playRaceToEnd(app, lobbyId, token, 'recap');
  const res = await recap(token);
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    log: Parameters<typeof replayRace>[1];
    names: Record<string, string>;
    trackId: string;
  };
  assert.equal(body.trackId, 'oval16_3lanes');
  assert.deepEqual(Object.keys(body.names).sort(), ['1', '2']);
  assert.ok(Object.values(body.names).includes('Host'));

  // the log that came over the wire replays to the race the server ended with
  const race = lobbyStore.getLobby(lobbyId)!.race!;
  const ctx = getRaceContext('oval16_3lanes')!;
  assert.deepEqual(replayRace(ctx, body.log).at(-1), race.engine);
});

test('a bad token is 401 and an unknown lobby 404, even after the race', async (t) => {
  const { app, lobbyId, token, recap } = await seatedRace(t);
  await playRaceToEnd(app, lobbyId, token, 'recap');
  assert.equal((await recap('not-a-token')).statusCode, 401);
  assert.equal((await recap(token, 'NOLOBBY')).statusCode, 404);
});
