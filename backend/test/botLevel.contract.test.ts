import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { PublicLobby } from "../src/types.js";
import { playRaceToEnd, readLobby } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45,
  TURN_TIMER_TIME_SCALE: 1
};

async function createTestApp(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await createApp(TEST_CONFIG, { logger: false });
  t.after(async () => {
    await app.close();
  });
  return app;
}

type App = Awaited<ReturnType<typeof createTestApp>>;

async function create(app: App, settings?: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", ...(settings ? { settings } : {}) }
  });
  return { res, body: res.json() as { lobby: PublicLobby; playerToken: string } };
}

test("botLevel defaults to normal and round-trips through create, patch, join and read", async (t) => {
  const app = await createTestApp(t);
  const def = await create(app);
  assert.equal(def.body.lobby.settings.botLevel, "normal");

  const { res, body } = await create(app, { botLevel: "hard", botCars: 1, humanCars: 1, totalCars: 2 });
  assert.equal(res.statusCode, 201);
  assert.equal(body.lobby.settings.botLevel, "hard");
  const lobbyId = body.lobby.lobbyId;

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/v1/lobbies/${lobbyId}/settings`,
    payload: { playerToken: body.playerToken, settings: { botLevel: "easy" } }
  });
  assert.equal(patched.statusCode, 200);
  assert.equal((patched.json() as { lobby: PublicLobby }).lobby.settings.botLevel, "easy");

  // A patch without botLevel keeps it.
  const other = await app.inject({
    method: "PATCH",
    url: `/api/v1/lobbies/${lobbyId}/settings`,
    payload: { playerToken: body.playerToken, settings: { raceLaps: 2 } }
  });
  assert.equal((other.json() as { lobby: PublicLobby }).lobby.settings.botLevel, "easy");

  const read = await readLobby(app, lobbyId, body.playerToken);
  assert.equal((read as unknown as PublicLobby).settings.botLevel, "easy");
});

test("an unknown botLevel is rejected with 400 on create and on patch", async (t) => {
  const app = await createTestApp(t);
  for (const bad of ["impossible", "", 3, null]) {
    const created = await create(app, { botLevel: bad });
    assert.equal(created.res.statusCode, 400, `create with ${JSON.stringify(bad)}`);
  }
  const { body } = await create(app);
  const patched = await app.inject({
    method: "PATCH",
    url: `/api/v1/lobbies/${body.lobby.lobbyId}/settings`,
    payload: { playerToken: body.playerToken, settings: { botLevel: "godlike" } }
  });
  assert.equal(patched.statusCode, 400);
  const read = await readLobby(app, body.lobby.lobbyId, body.playerToken);
  assert.equal((read as unknown as PublicLobby).settings.botLevel, "normal");
});

for (const level of ["easy", "normal", "hard"] as const) {
  test(`bots race at the lobby's level: ${level}`, async (t) => {
    const app = await createTestApp(t);
    const { body } = await create(app, { botLevel: level, humanCars: 1, botCars: 2, totalCars: 3, raceLaps: 1 });
    const { lobbyId } = body.lobby;
    const start = await app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${lobbyId}/start`,
      payload: { playerToken: body.playerToken }
    });
    assert.equal(start.statusCode, 200);

    const started = await readLobby(app, lobbyId, body.playerToken);
    const levels = started.raceState.cars.map((c) => (c as { botLevel?: string }).botLevel);
    assert.deepEqual(levels, [undefined, level, level]);

    const done = await playRaceToEnd(app, lobbyId, body.playerToken);
    assert.equal(done.status, "FINISHED");
  });
}
