import assert from 'node:assert/strict';
import test from 'node:test';
import { replayRace } from '../../src/game/race/race_log';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { createApp } from '../src/server.js';
import { getRaceContext } from '../src/tracks.js';
import { playRaceToEnd } from './helpers.js';

// The server keeps every accepted action of a race (#169): human turns, bot turns and the host's force-skip. Replaying
// the log must land on the race the server ended with.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

test('the server race log replays to the finished race, force-skip and bots included', async (t) => {
  const lobbyStore = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore });
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: {
      name: 'Host',
      settings: { totalCars: 3, humanCars: 1, botCars: 2, raceLaps: 2, turnTimerSec: 0 }
    }
  });
  assert.equal(created.statusCode, 201);
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

  // the bots before the host have played; the host's first turn goes to the autopilot
  const skipped = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobby.lobbyId}/force-skip`,
    payload: { playerToken }
  });
  assert.equal(skipped.statusCode, 200);

  const finished = await playRaceToEnd(app, lobby.lobbyId, playerToken, 'log');
  assert.equal(finished.status, 'FINISHED');

  const race = lobbyStore.getLobby(lobby.lobbyId)!.race!;
  const ctx = getRaceContext('oval16_3lanes')!;
  assert.ok(race.log.actions.length > 10);
  assert.deepEqual(replayRace(ctx, race.log).at(-1), race.engine);
});
