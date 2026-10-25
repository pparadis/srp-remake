import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { bearer, legalMove, playRaceToEnd, readLobby } from './helpers.js';

// The player token in a header (#194 step 3): every lobby route reads `Authorization: Bearer`. The body or query field
// still works for one release, for a page loaded before the deploy; the WebSocket keeps its query (a browser sets no
// header on one, see ws.sync.contract.test.ts).
const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

type App = Awaited<ReturnType<typeof createApp>>;
type How = 'header' | 'legacy';

async function start(t: test.TestContext): Promise<App> {
  const app = await createApp(TEST_CONFIG, { logger: false });
  t.after(() => app.close());
  return app;
}

async function createLobby(app: App) {
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
  return { lobbyId: lobby.lobbyId, token: playerToken, base: `/api/v1/lobbies/${lobby.lobbyId}` };
}

// The same call in the new form (a bearer token) or the old one (the token in the query of a GET, in the body otherwise).
function call(
  app: App,
  how: How,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string,
  payload?: Record<string, unknown>
) {
  if (how === 'header') {
    return app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });
  }
  if (method === 'GET') return app.inject({ method, url: `${url}?playerToken=${token}` });
  return app.inject({ method, url, payload: { ...payload, playerToken: token } });
}

// Every lobby route once, in the order a lobby lives: read, rename, settings, chat, reconnect, start, recap (not yet),
// force-skip, a turn, the rest of the race, reset.
async function walkEveryRoute(app: App, how: How) {
  const { lobbyId, token, base } = await createLobby(app);
  const expect = (label: string, res: { statusCode: number; body: string }, status: number) =>
    assert.equal(res.statusCode, status, `${how}: ${label} -> ${res.statusCode} ${res.body}`);

  expect('read the lobby', await call(app, how, 'GET', base, token), 200);
  expect('rename', await call(app, how, 'PATCH', `${base}/player`, token, { name: 'Ann' }), 200);
  expect(
    'settings',
    await call(app, how, 'PATCH', `${base}/settings`, token, { settings: { raceLaps: 1 } }),
    200
  );
  expect('chat', await call(app, how, 'POST', `${base}/chat`, token, { text: 'hi' }), 201);
  const rejoined = await call(app, how, 'POST', `${base}/join`, token, { name: 'Ann' });
  expect('reconnect', rejoined, 200);
  assert.equal((rejoined.json() as { isReconnect: boolean }).isReconnect, true);

  expect('start', await call(app, how, 'POST', `${base}/start`, token), 200);
  expect('recap before a winner', await call(app, how, 'GET', `${base}/recap`, token), 409);
  expect('force-skip', await call(app, how, 'POST', `${base}/force-skip`, token), 200);

  const lobby = await readLobby(app, lobbyId, token);
  const turn = await call(app, how, 'POST', `${base}/turns`, token, {
    clientCommandId: `${how}-turn`,
    revision: lobby.revision,
    action: legalMove(lobby.raceState)
  });
  expect('a turn', turn, 200);

  await playRaceToEnd(app, lobbyId, token, `${how}-rest`);
  expect('recap after the finish', await call(app, how, 'GET', `${base}/recap`, token), 200);
  const reset = await call(app, how, 'POST', `${base}/reset`, token);
  expect('reset', reset, 200);
  assert.equal((reset.json() as { lobby: { status: string } }).lobby.status, 'WAITING');
}

test('every lobby route reads the player token from Authorization: Bearer, with no body where it needs none', async (t) => {
  await walkEveryRoute(await start(t), 'header');
});

test('the old body and query forms still work for one release, on every route', async (t) => {
  await walkEveryRoute(await start(t), 'legacy');
});

test('the header wins over the body, and a wrong header is not rescued by a right body', async (t) => {
  const app = await start(t);
  const { token, base } = await createLobby(app);
  const wrong = 'not-a-real-token';
  const rename = (headers: Record<string, string>, bodyToken: string) =>
    app.inject({
      method: 'PATCH',
      url: `${base}/player`,
      headers,
      payload: { playerToken: bodyToken, name: 'Ann' }
    });
  assert.equal((await rename(bearer(token), wrong)).statusCode, 200);
  assert.equal((await rename(bearer(wrong), token)).statusCode, 401);
});

test('no token, a token that is too long or another scheme is a 401, not a 400', async (t) => {
  const app = await start(t);
  const { base } = await createLobby(app);
  const refused = [
    await app.inject({ method: 'GET', url: base }),
    await app.inject({ method: 'GET', url: `${base}/recap` }),
    await app.inject({ method: 'POST', url: `${base}/start` }),
    await app.inject({ method: 'POST', url: `${base}/reset` }),
    await app.inject({ method: 'POST', url: `${base}/force-skip` }),
    await app.inject({ method: 'POST', url: `${base}/chat`, payload: { text: 'hi' } }),
    await app.inject({ method: 'PATCH', url: `${base}/player`, payload: { name: 'Ann' } }),
    await app.inject({ method: 'GET', url: base, headers: bearer('x'.repeat(65)) }),
    await app.inject({ method: 'GET', url: base, headers: { authorization: 'Basic abc' } })
  ];
  assert.deepEqual(
    refused.map((res) => res.statusCode),
    refused.map(() => 401)
  );
});

test("a token that is not this lobby's is a 401 on every route (the header gives it no more rights)", async (t) => {
  const app = await start(t);
  const { base } = await createLobby(app);
  const other = await createLobby(app);
  const routes: Array<['GET' | 'POST' | 'PATCH', string, Record<string, unknown>?]> = [
    ['GET', base],
    ['GET', `${base}/recap`],
    ['PATCH', `${base}/player`, { name: 'Ann' }],
    ['PATCH', `${base}/settings`, { settings: { raceLaps: 2 } }],
    ['POST', `${base}/chat`, { text: 'hi' }],
    ['POST', `${base}/start`],
    // not /reset: the store answers 409 "only a finished race can be reset" before it looks at the token
    ['POST', `${base}/force-skip`],
    ['POST', `${base}/turns`, { clientCommandId: 'c', revision: 0, action: { type: 'skip' } }]
  ];
  for (const [method, url, payload] of routes) {
    const res = await call(app, 'header', method, url, other.token, payload);
    assert.equal(res.statusCode, 401, `${method} ${url} -> ${res.statusCode} ${res.body}`);
  }
});
