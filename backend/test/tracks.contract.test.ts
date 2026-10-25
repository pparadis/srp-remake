import assert from 'node:assert/strict';
import test from 'node:test';
import { replayRace } from '../../src/game/race/race_log';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { createApp } from '../src/server.js';
import { getRaceContext, knownTrackIds } from '../src/tracks.js';
import { playRaceToEnd } from './helpers.js';

// A lobby races on the track of its settings (#175): the bigger oval is played to the flag, and its log replays on it.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

test('the server knows both ovals', () => {
  assert.deepEqual(knownTrackIds().sort(), ['oval16_3lanes', 'oval32_3lanes']);
  assert.ok(getRaceContext('oval32_3lanes')!.trackIndex.spineLen > 28);
});

test('a lobby on the bigger oval plays to the flag and its log replays there', async (t) => {
  const lobbyStore = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore });
  t.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: {
      name: 'Host',
      settings: {
        trackId: 'oval32_3lanes',
        totalCars: 3,
        humanCars: 1,
        botCars: 2,
        raceLaps: 1,
        turnTimerSec: 0
      }
    }
  });
  assert.equal(created.statusCode, 201);
  const { lobby, playerToken } = created.json() as {
    lobby: { lobbyId: string; settings: { trackId: string } };
    playerToken: string;
  };
  assert.equal(lobby.settings.trackId, 'oval32_3lanes');
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobby.lobbyId}/start`,
    payload: { playerToken }
  });
  assert.equal(started.statusCode, 200);

  const finished = await playRaceToEnd(app, lobby.lobbyId, playerToken, 'big');
  assert.equal(finished.status, 'FINISHED');
  const race = lobbyStore.getLobby(lobby.lobbyId)!.race!;
  assert.deepEqual(replayRace(getRaceContext('oval32_3lanes')!, race.log).at(-1), race.engine);
});

test('the host can change the track while the lobby waits, and an unknown track is refused', async (t) => {
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore: new LobbyStore() });
  t.after(() => app.close());
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { totalCars: 2, humanCars: 1, botCars: 1 } }
  });
  const { lobby, playerToken } = created.json() as {
    lobby: { lobbyId: string; settings: { trackId: string } };
    playerToken: string;
  };
  assert.equal(lobby.settings.trackId, 'oval16_3lanes');

  const changed = await app.inject({
    method: 'PATCH',
    url: `/api/v1/lobbies/${lobby.lobbyId}/settings`,
    payload: { playerToken, settings: { trackId: 'oval32_3lanes' } }
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(
    (changed.json() as { lobby: { settings: { trackId: string } } }).lobby.settings.trackId,
    'oval32_3lanes'
  );

  const refused = await app.inject({
    method: 'PATCH',
    url: `/api/v1/lobbies/${lobby.lobbyId}/settings`,
    payload: { playerToken, settings: { trackId: 'nowhere' } }
  });
  assert.equal(refused.statusCode, 400);
});
