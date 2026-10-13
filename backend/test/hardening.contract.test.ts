import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { BackendConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createApp, redactTokens } from "../src/server.js";
import { playRaceToEnd } from "./helpers.js";

// A partial config, like the other contract tests: the rate limit is off unless a test turns it on.
const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

type App = Awaited<ReturnType<typeof createApp>>;

// `fakeTime` mocks Date and setInterval from before the app starts, so the reaper's interval is the fake one.
async function startApp(
  t: test.TestContext,
  config: Partial<BackendConfig> = {},
  { listen = false, fakeTime = false } = {}
): Promise<App> {
  if (fakeTime) mock.timers.enable({ apis: ["setInterval", "Date"] });
  const app = await createApp({ ...TEST_CONFIG, ...config }, { logger: false });
  if (listen) await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    mock.timers.reset();
    await app.close();
  });
  return app;
}

async function createLobby(app: App, remoteAddress?: string, settings: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings },
    ...(remoteAddress ? { remoteAddress } : {})
  });
  return res;
}

async function lobbyOf(app: App, settings: Record<string, unknown> = {}) {
  const res = await createLobby(app, undefined, settings);
  assert.equal(res.statusCode, 201);
  const body = res.json() as { lobby: { lobbyId: string }; playerToken: string };
  return { lobbyId: body.lobby.lobbyId, token: body.playerToken };
}

async function readStatus(app: App, lobbyId: string, token: string) {
  const res = await app.inject({ method: "GET", url: `/api/v1/lobbies/${lobbyId}?playerToken=${token}` });
  return res.statusCode;
}

async function lobbyConnected(app: App, lobbyId: string, token: string): Promise<boolean> {
  const res = await app.inject({ method: "GET", url: `/api/v1/lobbies/${lobbyId}?playerToken=${token}` });
  const { lobby } = res.json() as { lobby: { players: { isHost: boolean; connected: boolean }[] } };
  return lobby.players.some((p) => p.isHost && p.connected);
}

function openSocket(app: App, lobbyId: string, token: string): Promise<WebSocket> {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Server is not listening.");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${token}`);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error("socket did not open")));
  });
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.addEventListener("close", () => resolve()));
}

test("redactTokens hides the player token in the websocket and lobby read urls", () => {
  assert.equal(
    redactTokens("/ws?lobbyId=a&playerToken=b"),
    "/ws?lobbyId=a&playerToken=[redacted]"
  );
  assert.equal(
    redactTokens("/api/v1/lobbies/a?playerToken=secret&x=1"),
    "/api/v1/lobbies/a?playerToken=[redacted]&x=1"
  );
  assert.equal(redactTokens("/health"), "/health");
});

test("input bounds: a 33-char name is 400, a body over 16 KiB is 413, an over-long command id is 400", async (t) => {
  const app = await startApp(t);
  const longName = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "x".repeat(33) } });
  assert.equal(longName.statusCode, 400);
  const blankName = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "   " } });
  assert.equal(blankName.statusCode, 400);
  const maxName = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "x".repeat(32) } });
  assert.equal(maxName.statusCode, 201);

  const huge = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", padding: "x".repeat(17 * 1024) }
  });
  assert.equal(huge.statusCode, 413);

  const { lobbyId, token } = await lobbyOf(app);
  const longCommand = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${lobbyId}/turns`,
    payload: {
      playerToken: token,
      clientCommandId: "c".repeat(65),
      revision: 0,
      action: { type: "skip" }
    }
  });
  assert.equal(longCommand.statusCode, 400);
});

test("a websocket frame over 1 KiB closes the socket", async (t) => {
  const app = await startApp(t, {}, { listen: true });
  const { lobbyId, token } = await lobbyOf(app);
  const ws = await openSocket(app, lobbyId, token);
  const gone = closed(ws);
  ws.send("x".repeat(2048));
  await gone;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test("MAX_LOBBIES: creating a lobby over the cap is 503", async (t) => {
  const app = await startApp(t, { MAX_LOBBIES: 2 });
  await lobbyOf(app);
  await lobbyOf(app);
  const res = await createLobby(app);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { error: "Server is full" });
});

test("an idle lobby with no socket is reaped; one with an open socket is not", async (t) => {
  const app = await startApp(t, { LOBBY_IDLE_SECONDS: 3600 }, { listen: true, fakeTime: true });
  const idle = await lobbyOf(app);
  const watched = await lobbyOf(app);
  const ws = await openSocket(app, watched.lobbyId, watched.token);
  assert.equal(await readStatus(app, idle.lobbyId, idle.token), 200);

  mock.timers.tick(3600_000 + 120_000);

  assert.equal(await readStatus(app, idle.lobbyId, idle.token), 404);
  assert.equal(await readStatus(app, watched.lobbyId, watched.token), 200);
  ws.close();
  await closed(ws);
});

test("a finished lobby is reaped 10 minutes after its last socket closes", async (t) => {
  const app = await startApp(t, {}, { listen: true, fakeTime: true });
  const { lobbyId, token } = await lobbyOf(app, {
    totalCars: 2,
    humanCars: 1,
    botCars: 1,
    raceLaps: 1,
    turnTimerSec: 0
  });
  await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/start`, payload: { playerToken: token } });
  const ws = await openSocket(app, lobbyId, token);
  const lobby = await playRaceToEnd(app, lobbyId, token);
  assert.equal(lobby.status, "FINISHED");

  // Past the linger time, but a socket is still open.
  mock.timers.tick(11 * 60_000);
  assert.equal(await readStatus(app, lobbyId, token), 200);

  // The close is the last activity; a sweep right after it must not reap yet.
  ws.close();
  await closed(ws);
  // The server notices the close a moment later; wait until it has marked the host gone.
  for (let i = 0; i < 100 && (await lobbyConnected(app, lobbyId, token)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  mock.timers.tick(5 * 60_000);
  assert.equal(await readStatus(app, lobbyId, token), 200);
  mock.timers.tick(6 * 60_000);
  assert.equal(await readStatus(app, lobbyId, token), 404);
});

test("rate limit: the 11th lobby per minute from one IP is 429 with Retry-After; another IP is served", async (t) => {
  const app = await startApp(t, { RATE_LIMIT_ENABLED: true });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await createLobby(app, "10.0.0.1")).statusCode, 201);
  }
  const limited = await createLobby(app, "10.0.0.1");
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers["access-control-allow-origin"], "*");
  assert.deepEqual(limited.json(), { error: "rate_limited" });

  assert.equal((await createLobby(app, "10.0.0.2")).statusCode, 201);
  // /health is not limited.
  assert.equal((await app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.1" })).statusCode, 200);
});

test("rate limit: the websocket upgrade is limited too", async (t) => {
  const app = await startApp(t, { RATE_LIMIT_ENABLED: true }, { listen: true });
  const { lobbyId, token } = await lobbyOf(app);
  const address = app.server.address() as { port: number };
  const sockets: WebSocket[] = [];
  for (let i = 0; i < 240; i += 1) {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${token}`);
    ws.addEventListener("error", () => undefined);
    sockets.push(ws);
  }
  const extra = new WebSocket(`ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${token}`);
  const opened = await new Promise<boolean>((resolve) => {
    extra.addEventListener("open", () => resolve(true));
    extra.addEventListener("error", () => resolve(false));
  });
  assert.equal(opened, false);
  for (const ws of sockets) ws.close();
});

test("TRUST_PROXY: X-Forwarded-For picks the bucket only when trusted", async (t) => {
  const trusted = await startApp(t, { RATE_LIMIT_ENABLED: true, TRUST_PROXY: true });
  const fromClient = (app: App, forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/lobbies",
      payload: { name: "Host" },
      headers: { "x-forwarded-for": forwardedFor },
      remoteAddress: "10.9.9.9"
    });
  for (let i = 0; i < 10; i += 1) assert.equal((await fromClient(trusted, "1.1.1.1")).statusCode, 201);
  assert.equal((await fromClient(trusted, "1.1.1.1")).statusCode, 429);
  assert.equal((await fromClient(trusted, "2.2.2.2")).statusCode, 201);

  const direct = await startApp(t, { RATE_LIMIT_ENABLED: true, TRUST_PROXY: false });
  for (let i = 0; i < 10; i += 1) assert.equal((await fromClient(direct, `3.3.3.${i}`)).statusCode, 201);
  assert.equal((await fromClient(direct, "4.4.4.4")).statusCode, 429);
});

test("the request log carries the redacted url, never the player token", async (t) => {
  const lines: string[] = [];
  const app = await createApp({ ...TEST_CONFIG }, { logStream: { write: (line) => lines.push(line) } });
  t.after(async () => {
    await app.close();
  });
  const { lobbyId, token } = await lobbyOf(app);
  assert.equal(await readStatus(app, lobbyId, token), 200);

  const log = lines.join("");
  assert.ok(log.includes(`/api/v1/lobbies/${lobbyId}?playerToken=[redacted]`));
  assert.ok(!log.includes(token));
});

test("TRUST_PROXY with a hop count trusts that many proxies from the right", async (t) => {
  const app = await startApp(t, { RATE_LIMIT_ENABLED: true, TRUST_PROXY: 1 });
  const create = (forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/lobbies",
      payload: { name: "Host" },
      headers: { "x-forwarded-for": forwardedFor },
      remoteAddress: "10.9.9.9"
    });
  // One trusted proxy: the client is the last entry, so a faked first entry buys no new bucket.
  for (let i = 0; i < 10; i += 1) assert.equal((await create(`6.6.6.${i}, 5.5.5.5`)).statusCode, 201);
  assert.equal((await create("7.7.7.7, 5.5.5.5")).statusCode, 429);
  assert.equal((await create("7.7.7.7, 5.5.5.6")).statusCode, 201);
});

test("TRUST_PROXY and the other limits are read from the environment", () => {
  const env = { GIT_SHA: "x" };
  const defaults = loadConfig(env);
  assert.equal(defaults.TRUST_PROXY, false);
  assert.equal(defaults.RATE_LIMIT_ENABLED, true);
  assert.equal(defaults.MAX_LOBBIES, 1000);
  assert.equal(defaults.LOBBY_IDLE_SECONDS, 3600);

  assert.equal(loadConfig({ ...env, TRUST_PROXY: "true" }).TRUST_PROXY, true);
  assert.equal(loadConfig({ ...env, TRUST_PROXY: "2" }).TRUST_PROXY, 2);
  assert.equal(loadConfig({ ...env, RATE_LIMIT_ENABLED: "false" }).RATE_LIMIT_ENABLED, false);
  assert.equal(loadConfig({ ...env, MAX_LOBBIES: "5" }).MAX_LOBBIES, 5);
  assert.throws(() => loadConfig({ ...env, TRUST_PROXY: "banana" }));
});

// Each route has its own limit; the limiter runs before validation, so any request counts.
const ROUTE_LIMITS: [method: "GET" | "POST" | "PATCH", url: string, max: number][] = [
  ["GET", "/api/v1/lobbies/x?playerToken=t", 240],
  ["POST", "/api/v1/lobbies/x/join", 30],
  ["PATCH", "/api/v1/lobbies/x/settings", 240],
  ["POST", "/api/v1/lobbies/x/start", 240],
  ["POST", "/api/v1/lobbies/x/reset", 240],
  ["POST", "/api/v1/lobbies/x/force-skip", 240],
  ["POST", "/api/v1/lobbies/x/turns", 240]
];

for (const [method, url, max] of ROUTE_LIMITS) {
  test(`rate limit: ${method} ${url.split("?")[0]} allows ${max} a minute, then 429`, async (t) => {
    const app = await startApp(t, { RATE_LIMIT_ENABLED: true });
    for (let i = 0; i < max; i += 1) {
      const res = await app.inject({ method, url, payload: {} });
      assert.notEqual(res.statusCode, 429, `request ${i + 1} of ${max}`);
    }
    const over = await app.inject({ method, url, payload: {} });
    assert.equal(over.statusCode, 429);
  });
}

test("malformed JSON is a 400, not a 500", async (t) => {
  const app = await startApp(t);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    headers: { "content-type": "application/json" },
    payload: "{not json"
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "bad_request" });
});

test("a reaped lobby leaves the lobby count", async (t) => {
  const app = await startApp(t, { LOBBY_IDLE_SECONDS: 60 }, { fakeTime: true });
  await lobbyOf(app);
  const count = async () => ((await app.inject({ method: "GET", url: "/health" })).json() as { lobbies: number }).lobbies;
  assert.equal(await count(), 1);
  mock.timers.tick(3 * 60_000);
  assert.equal(await count(), 0);
});
