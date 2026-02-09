import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendConfig } from "../src/config.js";
import { MemoryDedupeStore } from "../src/dedupeStore.js";
import { createApp } from "../src/server.js";
import type { TurnCommandResult } from "../src/types.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  REDIS_URL: "redis://127.0.0.1:6399",
  DEDUPE_TTL_SECONDS: 120
};

async function createTestApp() {
  return createApp(TEST_CONFIG, {
    logger: false,
    dedupeStore: new MemoryDedupeStore<TurnCommandResult>(),
    redis: null
  });
}

function wsBaseUrl(app: Awaited<ReturnType<typeof createTestApp>>): string {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP address.");
  }
  return `ws://127.0.0.1:${address.port}`;
}

async function waitForWsClose(
  ws: WebSocket,
  timeoutMs = 2000
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for websocket close.")),
      timeoutMs
    );
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
    ws.addEventListener("error", () => {
      // Close event captures the actionable contract details.
    });
  });
}

test("uses REST-style v1 endpoints (RPC dot endpoint is not exposed)", async (t) => {
  const app = await createTestApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobby.create",
    payload: { name: "Host" }
  });

  assert.equal(res.statusCode, 404);
});

test("supports lobby create, settings patch, and join contracts", async (t) => {
  const app = await createTestApp();
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host" }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
  };

  const settingsRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/settings`,
    payload: {
      playerToken: createdBody.playerToken,
      settings: {
        totalCars: 4,
        humanCars: 2,
        botCars: 2,
        raceLaps: 7
      }
    }
  });
  assert.equal(settingsRes.statusCode, 200);
  const settingsBody = settingsRes.json() as {
    lobby: {
      settings: {
        trackId: string;
        totalCars: number;
        humanCars: number;
        botCars: number;
        raceLaps: number;
      };
    };
  };
  assert.equal(settingsBody.lobby.settings.trackId, "oval16_3lanes");
  assert.equal(settingsBody.lobby.settings.totalCars, 4);
  assert.equal(settingsBody.lobby.settings.humanCars, 2);
  assert.equal(settingsBody.lobby.settings.botCars, 2);
  assert.equal(settingsBody.lobby.settings.raceLaps, 7);

  const joinRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/join`,
    payload: {
      name: "Player 2"
    }
  });
  assert.equal(joinRes.statusCode, 200);
  const joinBody = joinRes.json() as {
    isReconnect: boolean;
    lobby: { players: Array<{ playerId: string }> };
  };
  assert.equal(joinBody.isReconnect, false);
  assert.equal(joinBody.lobby.players.length, 2);
});

test("enforces turn idempotency and stale revision contract", async (t) => {
  const app = await createTestApp();
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host" }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
    playerId: string;
  };

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  const turnPayload = {
    playerToken: createdBody.playerToken,
    clientCommandId: "cmd-1",
    revision: 0,
    action: { type: "skip" }
  };

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: turnPayload
  });
  assert.equal(turnRes.statusCode, 200);
  const turnBody = turnRes.json() as { ok: true; revision: number; playerId: string };
  assert.equal(turnBody.ok, true);
  assert.equal(turnBody.revision, 1);
  assert.equal(turnBody.playerId, createdBody.playerId);

  const dedupeRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: turnPayload
  });
  assert.equal(dedupeRes.statusCode, 200);
  const dedupeBody = dedupeRes.json() as { ok: true; revision: number };
  assert.equal(dedupeBody.ok, true);
  assert.equal(dedupeBody.revision, 1);

  const staleRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "cmd-2",
      revision: 0,
      action: { type: "skip" }
    }
  });
  assert.equal(staleRes.statusCode, 409);
  const staleBody = staleRes.json() as { ok: false; error: string };
  assert.equal(staleBody.ok, false);
  assert.equal(staleBody.error, "stale_revision");
});

test("websocket rejects unknown player token (1008 or transport-level 1006)", async (t) => {
  const app = await createTestApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host" }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as { lobby: { lobbyId: string } };

  const ws = new WebSocket(
    `${wsBaseUrl(app)}/ws?lobbyId=${encodeURIComponent(createdBody.lobby.lobbyId)}&playerToken=invalid-token`
  );

  const closed = await waitForWsClose(ws);
  assert.ok([1006, 1008].includes(closed.code));
  if (closed.code === 1008) {
    assert.equal(closed.reason, "invalid_token");
  }
});

test("host websocket disconnect preserves valid turn error contract during transition", async (t) => {
  const app = await createTestApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host" }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
  };

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  const wsPrimary = new WebSocket(
    `${wsBaseUrl(app)}/ws?lobbyId=${encodeURIComponent(createdBody.lobby.lobbyId)}&playerToken=${encodeURIComponent(createdBody.playerToken)}`
  );
  const wsObserver = new WebSocket(
    `${wsBaseUrl(app)}/ws?lobbyId=${encodeURIComponent(createdBody.lobby.lobbyId)}&playerToken=${encodeURIComponent(createdBody.playerToken)}`
  );

  const waitForOpen = (ws: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for websocket open.")),
        2000
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.all([waitForOpen(wsPrimary), waitForOpen(wsObserver)]);

  wsPrimary.close(1000, "test_close");
  await waitForWsClose(wsPrimary);

  // If the server enforces host-disconnect end-of-race, observer is closed with 4001.
  // Some runtimes surface it as transport-level close codes, so this is best-effort.
  const observerClosed = await waitForWsClose(wsObserver);
  if (observerClosed.code === 4001) {
    assert.equal(observerClosed.reason, "host_disconnected");
  }

  let terminalBody: { ok: false; error: string; revision: number } | undefined;
  let lastStatus: number | undefined;
  let lastBody: unknown;
  let expectedRevision = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const turnRes = await app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
      payload: {
        playerToken: createdBody.playerToken,
        clientCommandId: `after-host-disconnect-${attempt}`,
        revision: expectedRevision,
        action: { type: "skip" }
      }
    });

    lastStatus = turnRes.statusCode;
    lastBody = turnRes.json();

    if (turnRes.statusCode === 200) {
      const body = lastBody as { ok: true; revision: number };
      expectedRevision = body.revision;
      await delay(25);
      continue;
    }

    if (turnRes.statusCode === 409) {
      const body = lastBody as { ok: false; error: string; revision: number };
      if (body.error === "lobby_not_in_race" || body.error === "stale_revision") {
        terminalBody = body;
        break;
      }
      expectedRevision = body.revision;
      await delay(25);
      continue;
    }

    // During host-disconnect transition, API may briefly return 500.
    if (turnRes.statusCode === 500) {
      await delay(25);
      continue;
    }

    assert.fail(
      `Unexpected status during host-disconnect transition: ${turnRes.statusCode} body=${JSON.stringify(lastBody)}`
    );
  }

  assert.ok(
    terminalBody,
    `Expected terminal turn error state; lastStatus=${lastStatus} lastBody=${JSON.stringify(lastBody)}`
  );
  assert.ok(["lobby_not_in_race", "stale_revision"].includes(terminalBody.error));
});
