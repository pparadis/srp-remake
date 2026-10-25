import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplyResult } from '../../src/game/race/race_engine';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { createApp } from '../src/server.js';
import type { PublicLobby } from '../src/types.js';

const CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45
};

test('force-skip: 409 when the autopilot turn is refused, not a 200 with nothing played', async (t) => {
  class RefusingStore extends LobbyStore {
    override applyTurnAction(): ApplyResult {
      return { ok: false, reason: 'invalid_target' };
    }
  }
  const app = await createApp(CONFIG, { logger: false, lobbyStore: new RefusingStore() });
  t.after(async () => {
    await app.close();
  });
  const post = (lobbyId: string, path: string, payload: object) =>
    app.inject({ method: 'POST', url: `/api/v1/lobbies/${lobbyId}/${path}`, payload });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { totalCars: 1, humanCars: 1, botCars: 0, turnTimerSec: 0 } }
  });
  const { lobby, playerToken } = created.json() as { lobby: PublicLobby; playerToken: string };
  await post(lobby.lobbyId, 'start', { playerToken });

  const res = await post(lobby.lobbyId, 'force-skip', { playerToken });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /nothing was skipped/);
});
