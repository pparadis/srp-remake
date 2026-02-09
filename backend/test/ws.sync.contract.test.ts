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
  DEDUPE_TTL_SECONDS: 120,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  ADMIN_DEBUG_ENABLED: false,
  ADMIN_DEBUG_TOKEN: ""
};

type WsEvent = {
  event: string;
  payload: unknown;
};

async function createListeningTestApp() {
  const app = await createApp(TEST_CONFIG, {
    logger: false,
    dedupeStore: new MemoryDedupeStore<TurnCommandResult>(),
    redis: null
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return app;
}

function wsBaseUrl(app: Awaited<ReturnType<typeof createListeningTestApp>>): string {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP address.");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function connectAndCollect(
  app: Awaited<ReturnType<typeof createListeningTestApp>>,
  lobbyId: string,
  playerToken: string
): { ws: WebSocket; events: WsEvent[] } {
  const events: WsEvent[] = [];
  const ws = new WebSocket(
    `${wsBaseUrl(app)}/ws?lobbyId=${encodeURIComponent(lobbyId)}&playerToken=${encodeURIComponent(playerToken)}`
  );

  ws.addEventListener("message", (raw) => {
    try {
      const parsed = JSON.parse(String(raw.data)) as Partial<WsEvent>;
      if (typeof parsed.event === "string") {
        events.push({ event: parsed.event, payload: parsed.payload });
      }
    } catch {
      // Ignore non-JSON messages.
    }
  });

  return { ws, events };
}

async function waitForWsOpen(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open.")), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      // Rely on timeout/open for deterministic behavior in this test.
    });
  });
}

async function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket close.")), timeoutMs);
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for condition.");
}

test("websocket ordering: race.started before race.state, turn.applied before race.state", async (t) => {
  const app = await createListeningTestApp();
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

  const { ws, events } = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitForWsOpen(ws);

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  await waitFor(() => events.some((e) => e.event === "race.started"), 3000);
  await waitFor(() => events.some((e) => e.event === "race.state"), 3000);

  const startIndex = events.findIndex((e) => e.event === "race.started");
  const startStateIndex = events.findIndex((e) => e.event === "race.state");
  assert.ok(startIndex >= 0);
  assert.ok(startStateIndex >= 0);
  assert.ok(startIndex < startStateIndex);

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "ordering-host-cmd-1",
      revision: 0,
      action: { type: "skip" }
    }
  });
  assert.equal(turnRes.statusCode, 200);

  await waitFor(() => events.some((e) => e.event === "turn.applied"), 3000);
  const appliedIndex = events.findIndex((e) => e.event === "turn.applied");
  const stateAfterAppliedIndex = events.findIndex((e, idx) => idx > appliedIndex && e.event === "race.state");
  assert.ok(appliedIndex >= 0);
  assert.ok(stateAfterAppliedIndex > appliedIndex);

  ws.close(1000, "done");
  await waitForClose(ws);
});

test("two clients receive same turn.applied revision", async (t) => {
  const app = await createListeningTestApp();
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: {
      name: "Host",
      settings: {
        totalCars: 2,
        humanCars: 2,
        botCars: 0,
        raceLaps: 5
      }
    }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as {
    lobby: { lobbyId: string };
    playerToken: string;
  };

  const joinRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/join`,
    payload: { name: "Guest" }
  });
  assert.equal(joinRes.statusCode, 200);
  const joinBody = joinRes.json() as { playerToken: string };

  const hostWsState = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  const guestWsState = connectAndCollect(app, createdBody.lobby.lobbyId, joinBody.playerToken);
  await Promise.all([waitForWsOpen(hostWsState.ws), waitForWsOpen(guestWsState.ws)]);

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "sync-host-cmd-1",
      revision: 0,
      action: { type: "skip" }
    }
  });
  assert.equal(turnRes.statusCode, 200);

  await waitFor(() => hostWsState.events.some((e) => e.event === "turn.applied"), 3000);
  await waitFor(() => guestWsState.events.some((e) => e.event === "turn.applied"), 3000);

  const hostApplied = hostWsState.events.find((e) => e.event === "turn.applied")?.payload as {
    revision: number;
  };
  const guestApplied = guestWsState.events.find((e) => e.event === "turn.applied")?.payload as {
    revision: number;
  };

  assert.equal(hostApplied.revision, 1);
  assert.equal(guestApplied.revision, 1);

  hostWsState.ws.close(1000, "done");
  guestWsState.ws.close(1000, "done");
  await Promise.all([waitForClose(hostWsState.ws), waitForClose(guestWsState.ws)]);
});

test("reconnect websocket receives hydration race.state snapshot", async (t) => {
  const app = await createListeningTestApp();
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

  const first = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitForWsOpen(first.ws);
  await waitFor(() => first.events.some((e) => e.event === "race.state"), 3000);
  first.ws.close(1000, "reconnect");
  await waitForClose(first.ws);

  const second = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitForWsOpen(second.ws);
  await waitFor(() => second.events.some((e) => e.event === "lobby.state"), 3000);
  await waitFor(() => second.events.some((e) => e.event === "race.state"), 3000);
  second.ws.close(1000, "done");
  await waitForClose(second.ws);
});
