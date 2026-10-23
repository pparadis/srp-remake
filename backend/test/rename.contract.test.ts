import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

// Renaming a player in the lobby (#78): PATCH /lobbies/:id/player.
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

type App = Awaited<ReturnType<typeof createApp>>;

async function startApp(t: test.TestContext, config: Partial<BackendConfig> = {}): Promise<App> {
  const app = await createApp({ ...TEST_CONFIG, ...config }, { logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  return app;
}

// A two-human lobby with the host and one guest seated.
async function seated(app: App) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { totalCars: 2, humanCars: 2, botCars: 0 } }
  });
  const host = created.json() as { lobby: { lobbyId: string }; playerToken: string };
  const lobbyId = host.lobby.lobbyId;
  const joined = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobbyId}/join`,
    payload: { name: 'Guest' }
  });
  const guest = joined.json() as { playerId: string; playerToken: string };
  return {
    lobbyId,
    hostToken: host.playerToken,
    guestToken: guest.playerToken,
    guestId: guest.playerId
  };
}

const rename = (app: App, lobbyId: string, playerToken: string, name: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/lobbies/${lobbyId}/player`,
    payload: { playerToken, name }
  });

test('a rename answers with the new lobby and is broadcast to the other socket', async (t) => {
  const app = await startApp(t);
  const { lobbyId, hostToken, guestToken, guestId } = await seated(app);

  const address = app.server.address() as { port: number };
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${hostToken}`
  );
  const states: Array<{ players: Array<{ playerId: string; name: string }> }> = [];
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(String(message.data)) as {
      event: string;
      payload: (typeof states)[number];
    };
    if (data.event === 'lobby.state') states.push(data.payload);
  });
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));
  t.after(() => ws.close());

  const res = await rename(app, lobbyId, guestToken, '  Speedy  ');
  assert.equal(res.statusCode, 200);
  const lobby = (res.json() as { lobby: { players: Array<{ playerId: string; name: string }> } })
    .lobby;
  assert.equal(lobby.players.find((p) => p.playerId === guestId)?.name, 'Speedy');

  for (
    let i = 0;
    i < 200 && !states.some((s) => s.players.some((p) => p.name === 'Speedy'));
    i += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    states.some((s) => s.players.some((p) => p.playerId === guestId && p.name === 'Speedy'))
  );
});

test('an empty or 33-character name is refused, 32 is fine', async (t) => {
  const app = await startApp(t);
  const { lobbyId, guestToken } = await seated(app);
  assert.equal((await rename(app, lobbyId, guestToken, '')).statusCode, 400);
  assert.equal((await rename(app, lobbyId, guestToken, '   ')).statusCode, 400);
  assert.equal((await rename(app, lobbyId, guestToken, 'x'.repeat(33))).statusCode, 400);
  assert.equal((await rename(app, lobbyId, guestToken, 'x'.repeat(32))).statusCode, 200);
});

test('a bad token is 401 and an unknown lobby 404', async (t) => {
  const app = await startApp(t);
  const { lobbyId } = await seated(app);
  assert.equal((await rename(app, lobbyId, 'not-a-token', 'Nope')).statusCode, 401);
  assert.equal((await rename(app, 'NOLOBBY', 'not-a-token', 'Nope')).statusCode, 404);
});

test('once the race has started a rename is 409 and the name stays', async (t) => {
  const app = await startApp(t);
  const { lobbyId, hostToken, guestToken, guestId } = await seated(app);
  const started = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobbyId}/start`,
    payload: { playerToken: hostToken }
  });
  assert.equal(started.statusCode, 200);

  assert.equal((await rename(app, lobbyId, guestToken, 'Late')).statusCode, 409);
  const read = await app.inject({
    method: 'GET',
    url: `/api/v1/lobbies/${lobbyId}?playerToken=${guestToken}`
  });
  const lobby = (read.json() as { lobby: { players: Array<{ playerId: string; name: string }> } })
    .lobby;
  assert.equal(lobby.players.find((p) => p.playerId === guestId)?.name, 'Guest');
});

test('the rate limit applies: the 61st rename in a minute is 429', async (t) => {
  const app = await startApp(t, { RATE_LIMIT_ENABLED: true });
  const { lobbyId, guestToken } = await seated(app);
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await rename(app, lobbyId, guestToken, `Name${i}`)).statusCode, 200);
  }
  assert.equal((await rename(app, lobbyId, guestToken, 'Too many')).statusCode, 429);
});
