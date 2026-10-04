import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { RaceState } from "../src/types.js";
import { legalMove, playRaceToEnd } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

type WsEvent = {
  event: string;
  payload: unknown;
};

async function createListeningTestApp() {
  const app = await createApp(TEST_CONFIG, {
    logger: false
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
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;

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
      action: legalMove(startState)
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
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "sync-host-cmd-1",
      revision: 0,
      action: legalMove(startState)
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

test("websocket broadcasts backend bot turns after human submit", async (t) => {
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
        totalCars: 3,
        humanCars: 1,
        botCars: 2,
        raceLaps: 5
      }
    }
  });
  assert.equal(createdRes.statusCode, 201);
  const createdBody = createdRes.json() as {
    lobby: { lobbyId: string };
    playerId: string;
    playerToken: string;
  };

  const wsState = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitForWsOpen(wsState.ws);

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "host-cmd-with-bots-1",
      revision: 0,
      action: legalMove(startState)
    }
  });
  assert.equal(turnRes.statusCode, 200);

  await waitFor(() => wsState.events.filter((e) => e.event === "turn.applied").length >= 3, 3000);
  await waitFor(
    () =>
      wsState.events.some(
        (e) =>
          e.event === "race.state" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          "revision" in e.payload &&
          (e.payload as { revision: unknown }).revision === 3
      ),
    3000
  );

  const appliedPayloads = wsState.events
    .filter((e) => e.event === "turn.applied")
    .map((e) => e.payload as { revision?: unknown; playerId?: unknown; source?: unknown });
  const firstThree = appliedPayloads.slice(0, 3);
  assert.deepEqual(
    firstThree.map((payload) => payload.revision),
    [1, 2, 3]
  );
  assert.equal(firstThree[0]?.playerId, createdBody.playerId);
  assert.equal(firstThree[1]?.source, "bot");
  assert.equal(firstThree[2]?.source, "bot");
  assert.match(String(firstThree[1]?.playerId), /^BOT\d+$/);
  assert.match(String(firstThree[2]?.playerId), /^BOT\d+$/);

  wsState.ws.close(1000, "done");
  await waitForClose(wsState.ws);
});

test("reconnect websocket receives hydration race.state snapshot", async (t) => {
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

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  // Reconnect as a guest: a host disconnect ends the lobby by design.
  const first = connectAndCollect(app, createdBody.lobby.lobbyId, joinBody.playerToken);
  await waitForWsOpen(first.ws);
  await waitFor(() => first.events.some((e) => e.event === "race.state"), 3000);
  first.ws.close(1000, "reconnect");
  await waitForClose(first.ws);

  const second = connectAndCollect(app, createdBody.lobby.lobbyId, joinBody.playerToken);
  await waitForWsOpen(second.ws);
  await waitFor(() => second.events.some((e) => e.event === "lobby.state"), 3000);
  await waitFor(() => second.events.some((e) => e.event === "race.state"), 3000);
  second.ws.close(1000, "done");
  await waitForClose(second.ws);
});

test("websocket announces race.ended with the winner after the final turn", async (t) => {
  const app = await createListeningTestApp();
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: {
      name: "Host",
      settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1 }
    }
  });
  const createdBody = createdRes.json() as { lobby: { lobbyId: string }; playerToken: string };
  const { ws, events } = connectAndCollect(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitForWsOpen(ws);

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  const finished = await playRaceToEnd(app, createdBody.lobby.lobbyId, createdBody.playerToken);
  await waitFor(() => events.some((e) => e.event === "race.ended"), 3000);

  const ended = events.find((e) => e.event === "race.ended")?.payload as {
    reason: string;
    winnerCarId: number;
    lobby: { status: string };
  };
  assert.equal(ended.reason, "race_finished");
  assert.equal(ended.winnerCarId, finished.raceState.winnerCarId);
  assert.equal(ended.lobby.status, "FINISHED");
  // The final board state is broadcast before the race is closed.
  const endedIndex = events.findIndex((e) => e.event === "race.ended");
  assert.ok(events.slice(0, endedIndex).some((e) => e.event === "race.state"));

  ws.close(1000, "done");
  await waitForClose(ws);
});

test("reset returns a finished lobby to waiting for everyone, and it can race again", async (t) => {
  const app = await createListeningTestApp();
  t.after(() => app.close());

  const created = (
    await app.inject({
      method: "POST",
      url: "/api/v1/lobbies",
      payload: { name: "Host", settings: { totalCars: 3, humanCars: 2, botCars: 1, raceLaps: 1 } }
    })
  ).json() as { lobby: { lobbyId: string }; playerToken: string };
  const lobbyId = created.lobby.lobbyId;
  const joined = (
    await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/join`, payload: { name: "Guest" } })
  ).json() as { playerToken: string };
  const url = (action: string) => `/api/v1/lobbies/${lobbyId}/${action}`;
  const hostBody = { playerToken: created.playerToken };
  const readUrl = `/api/v1/lobbies/${lobbyId}?playerToken=${created.playerToken}`;

  const guest = connectAndCollect(app, lobbyId, joined.playerToken);
  const host = connectAndCollect(app, lobbyId, created.playerToken);
  await waitForWsOpen(guest.ws);
  await waitForWsOpen(host.ws);

  // The two humans take turns, so each submits when its seat is active.
  const tokens = [created.playerToken, joined.playerToken];
  await app.inject({ method: "POST", url: url("start"), payload: hostBody });
  for (let i = 0; i < 600; i += 1) {
    const lobby = (
      await app.inject({ method: "GET", url: readUrl })
    ).json() as { lobby: { status: string; revision: number; raceState: RaceState } };
    if (lobby.lobby.status === "FINISHED") break;
    const seat = lobby.lobby.raceState.activeSeatIndex;
    await app.inject({
      method: "POST",
      url: url("turns"),
      payload: {
        playerToken: tokens[seat],
        clientCommandId: `r1-${i}`,
        revision: lobby.lobby.revision,
        action: legalMove(lobby.lobby.raceState)
      }
    });
  }
  await waitFor(() => guest.events.some((e) => e.event === "race.ended"), 3000);

  const guestReset = await app.inject({ method: "POST", url: url("reset"), payload: { playerToken: joined.playerToken } });
  assert.equal(guestReset.statusCode, 403);

  const mark = guest.events.length;
  const reset = await app.inject({ method: "POST", url: url("reset"), payload: hostBody });
  assert.equal(reset.statusCode, 200);
  const resetLobby = (reset.json() as { lobby: Record<string, unknown> & { players: Array<{ connected: boolean }> } }).lobby;
  assert.equal(resetLobby.status, "WAITING");
  assert.equal(resetLobby.raceState, undefined);
  assert.equal(resetLobby.terminationReason, undefined);
  assert.deepEqual(resetLobby.players.map((p) => p.connected), [true, true]);

  // Both sockets stay open and hear about it.
  await waitFor(() => guest.events.slice(mark).some((e) => e.event === "lobby.state"), 3000);
  await waitFor(() => host.events.some((e, i) => i > 0 && e.event === "lobby.state" && (e.payload as { status: string }).status === "WAITING"), 3000);
  const waiting = guest.events.slice(mark).find((e) => e.event === "lobby.state")!.payload as { status: string };
  assert.equal(waiting.status, "WAITING");
  assert.equal(guest.ws.readyState, 1);

  // Settings are kept; the same players race again to a finish.
  const restart = await app.inject({ method: "POST", url: url("start"), payload: hostBody });
  assert.equal(restart.statusCode, 200);
  assert.equal((restart.json() as { lobby: { status: string } }).lobby.status, "IN_RACE");
  for (let i = 0; i < 600; i += 1) {
    const lobby = (
      await app.inject({ method: "GET", url: readUrl })
    ).json() as { lobby: { status: string; revision: number; raceState: RaceState } };
    if (lobby.lobby.status === "FINISHED") break;
    await app.inject({
      method: "POST",
      url: url("turns"),
      payload: {
        playerToken: tokens[lobby.lobby.raceState.activeSeatIndex],
        clientCommandId: `r2-${i}`,
        revision: lobby.lobby.revision,
        action: legalMove(lobby.lobby.raceState)
      }
    });
  }
  const end = await app.inject({ method: "GET", url: readUrl });
  assert.equal((end.json() as { lobby: { status: string } }).lobby.status, "FINISHED");

  guest.ws.close(1000, "done");
  await waitForClose(guest.ws);
  host.ws.close(1000, "done");
  await waitForClose(host.ws);
});
