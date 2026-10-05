import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { RaceState } from "../src/types.js";
import { legalMove } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

async function createTestApp() {
  return createApp(TEST_CONFIG, {
    logger: false
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

test("supports CORS preflight on v1 endpoints", async (t) => {
  const app = await createTestApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/lobbies",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type"
    }
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(String(res.headers["access-control-allow-methods"] ?? ""), /POST/);
});

test("runs bot turns on backend", async (t) => {
  const app = await createTestApp();
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
    playerToken: string;
  };

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;
  const hostMove = legalMove(startState);

  const turnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "host-turn-with-bots",
      revision: 0,
      action: hostMove
    }
  });
  assert.equal(turnRes.statusCode, 200);
  const turnBody = turnRes.json() as { ok: true; revision: number };
  assert.equal(turnBody.ok, true);
  assert.equal(turnBody.revision, 1);

  const readRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=${encodeURIComponent(createdBody.playerToken)}`
  });
  assert.equal(readRes.statusCode, 200);
  const readBody = readRes.json() as {
    lobby: {
      revision: number;
      raceState: RaceState;
    };
  };
  const raceState = readBody.lobby.raceState;
  assert.equal(readBody.lobby.revision, 3);
  assert.equal(raceState.turnIndex, 3);
  assert.equal(raceState.activeSeatIndex, 0);
  // The host's move was validated and applied, and both bots drove for real.
  assert.equal(raceState.cars[0]?.cellId, hostMove.type === "move" ? hostMove.targetCellId : "");
  for (const seat of [0, 1, 2]) {
    assert.notEqual(raceState.cars[seat]?.cellId, startState.cars[seat]?.cellId);
    assert.ok((raceState.cars[seat]?.tire ?? 100) < 100);
  }
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

test("supports authenticated lobby read contract", async (t) => {
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
    playerId: string;
    playerToken: string;
  };

  const readRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=${encodeURIComponent(createdBody.playerToken)}`
  });
  assert.equal(readRes.statusCode, 200);
  const readBody = readRes.json() as {
    lobby: { lobbyId: string; raceState?: unknown };
    playerId: string;
  };
  assert.equal(readBody.lobby.lobbyId, createdBody.lobby.lobbyId);
  assert.equal(readBody.playerId, createdBody.playerId);
  assert.equal(readBody.lobby.raceState, undefined);

  const badTokenRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=invalid`
  });
  assert.equal(badTokenRes.statusCode, 401);
});

test("builds and exposes authoritative race state on start/reconnect", async (t) => {
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
    playerId: string;
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

  const joinRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/join`,
    payload: { name: "Guest" }
  });
  assert.equal(joinRes.statusCode, 200);
  const joinBody = joinRes.json() as {
    playerId: string;
    playerToken: string;
  };

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const startBody = startRes.json() as {
    lobby: {
      raceState: {
        trackId: string;
        raceLaps: number;
        turnIndex: number;
        activeSeatIndex: number;
        winnerCarId: number | null;
        cars: RaceState["cars"];
      };
    };
  };
  assert.equal(startBody.lobby.raceState.trackId, "oval16_3lanes");
  assert.equal(startBody.lobby.raceState.raceLaps, 7);
  assert.equal(startBody.lobby.raceState.turnIndex, 0);
  assert.equal(startBody.lobby.raceState.activeSeatIndex, 0);
  assert.equal(startBody.lobby.raceState.cars.length, 4);
  assert.equal(startBody.lobby.raceState.winnerCarId, null);
  const [hostCar, guestCar] = startBody.lobby.raceState.cars;
  assert.deepEqual(
    [hostCar?.carId, hostCar?.seatIndex, hostCar?.playerId, hostCar?.name, hostCar?.isBot, hostCar?.lapCount],
    [1, 0, createdBody.playerId, "Host", false, 0]
  );
  assert.deepEqual(
    [guestCar?.carId, guestCar?.seatIndex, guestCar?.playerId, guestCar?.name, guestCar?.isBot, guestCar?.lapCount],
    [2, 1, joinBody.playerId, "Guest", false, 0]
  );
  // Full car state for rendering: fresh tires/fuel, on the grid, nothing spent.
  assert.deepEqual(
    [hostCar?.tire, hostCar?.fuel, hostCar?.state, hostCar?.pitServiced, hostCar?.pitTurnsRemaining],
    [100, 100, "ACTIVE", false, 0]
  );
  assert.equal(hostCar?.cellId, "Z01_L1_00");
  assert.deepEqual(hostCar?.moveCycle, { index: 0, spent: [0, 0, 0, 0, 0] });
  assert.equal(startBody.lobby.raceState.cars[2]?.isBot, true);
  assert.equal(startBody.lobby.raceState.cars[2]?.playerId, null);
  assert.equal(startBody.lobby.raceState.cars[3]?.isBot, true);
  assert.equal(startBody.lobby.raceState.cars[3]?.playerId, null);

  const readRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=${encodeURIComponent(joinBody.playerToken)}`
  });
  assert.equal(readRes.statusCode, 200);
  const readBody = readRes.json() as { lobby: { raceState?: unknown } };
  assert.ok(readBody.lobby.raceState);

  const reconnectRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/join`,
    payload: {
      playerToken: joinBody.playerToken
    }
  });
  assert.equal(reconnectRes.statusCode, 200);
  const reconnectBody = reconnectRes.json() as {
    isReconnect: boolean;
    lobby: { raceState?: unknown };
  };
  assert.equal(reconnectBody.isReconnect, true);
  assert.ok(reconnectBody.lobby.raceState);
});

test("enforces active turn ownership and applies validated moves to the authoritative race state", async (t) => {
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
    playerId: string;
    playerToken: string;
  };

  const settingsRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/settings`,
    payload: {
      playerToken: createdBody.playerToken,
      settings: {
        totalCars: 2,
        humanCars: 2,
        botCars: 0,
        raceLaps: 5
      }
    }
  });
  assert.equal(settingsRes.statusCode, 200);

  const joinRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/join`,
    payload: { name: "Guest" }
  });
  assert.equal(joinRes.statusCode, 200);
  const joinBody = joinRes.json() as {
    playerId: string;
    playerToken: string;
  };

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;
  const hostMove = legalMove(startState);

  const hostTurnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "host-turn-1",
      revision: 0,
      action: hostMove
    }
  });
  assert.equal(hostTurnRes.statusCode, 200);
  const hostTurnBody = hostTurnRes.json() as { ok: true; revision: number };
  assert.equal(hostTurnBody.ok, true);
  assert.equal(hostTurnBody.revision, 1);

  const hostOutOfTurnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "host-turn-2",
      revision: 1,
      action: { type: "skip" }
    }
  });
  assert.equal(hostOutOfTurnRes.statusCode, 409);
  const hostOutOfTurnBody = hostOutOfTurnRes.json() as {
    ok: false;
    error: string;
    revision: number;
  };
  assert.equal(hostOutOfTurnBody.ok, false);
  assert.equal(hostOutOfTurnBody.error, "not_active_player");
  assert.equal(hostOutOfTurnBody.revision, 1);

  const hostOutOfTurnDedupeRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: createdBody.playerToken,
      clientCommandId: "host-turn-2",
      revision: 1,
      action: { type: "skip" }
    }
  });
  assert.equal(hostOutOfTurnDedupeRes.statusCode, 200);
  const hostOutOfTurnDedupeBody = hostOutOfTurnDedupeRes.json() as {
    ok: false;
    error: string;
    revision: number;
  };
  assert.equal(hostOutOfTurnDedupeBody.ok, false);
  assert.equal(hostOutOfTurnDedupeBody.error, "not_active_player");
  assert.equal(hostOutOfTurnDedupeBody.revision, 1);

  const afterHostRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=${encodeURIComponent(joinBody.playerToken)}`
  });
  const guestMove = legalMove((afterHostRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState);

  const guestTurnRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
    payload: {
      playerToken: joinBody.playerToken,
      clientCommandId: "guest-turn-1",
      revision: 1,
      action: guestMove
    }
  });
  assert.equal(guestTurnRes.statusCode, 200);
  const guestTurnBody = guestTurnRes.json() as { ok: true; revision: number };
  assert.equal(guestTurnBody.ok, true);
  assert.equal(guestTurnBody.revision, 2);

  const readRes = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}?playerToken=${encodeURIComponent(createdBody.playerToken)}`
  });
  assert.equal(readRes.statusCode, 200);
  const raceState = (readRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;

  assert.equal(raceState.turnIndex, 2);
  assert.equal(raceState.activeSeatIndex, 0);
  assert.equal(raceState.cars[0]?.cellId, hostMove.type === "move" ? hostMove.targetCellId : "");
  assert.equal(raceState.cars[1]?.cellId, guestMove.type === "move" ? guestMove.targetCellId : "");
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
  const startState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;

  const turnPayload = {
    playerToken: createdBody.playerToken,
    clientCommandId: "cmd-1",
    revision: 0,
    action: legalMove(startState)
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

test("rejects expired player token", async (t) => {
  const app = await createApp(
    {
      ...TEST_CONFIG,
      PLAYER_TOKEN_TTL_SECONDS: 1
    },
    {
      logger: false
    }
  );
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

  await delay(1100);

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 401);
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

test("host websocket disconnect revokes tokens and ends race after the grace period", async (t) => {
  const app = await createApp({ ...TEST_CONFIG, HOST_GRACE_SECONDS: 0.3 }, { logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });

  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings: { totalCars: 2, humanCars: 2, botCars: 0 } }
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
  const guestToken = (joinRes.json() as { playerToken: string }).playerToken;

  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/start`,
    payload: { playerToken: createdBody.playerToken }
  });
  assert.equal(startRes.statusCode, 200);

  const socketUrl = (token: string) =>
    `${wsBaseUrl(app)}/ws?lobbyId=${encodeURIComponent(createdBody.lobby.lobbyId)}&playerToken=${encodeURIComponent(token)}`;
  const wsPrimary = new WebSocket(socketUrl(createdBody.playerToken));
  const wsObserver = new WebSocket(socketUrl(guestToken));

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

  // After the grace period the guest is closed with 4001 (best-effort: some runtimes surface
  // it as a transport-level close code).
  const observerClosed = await waitForWsClose(wsObserver);
  if (observerClosed.code === 4001) {
    assert.equal(observerClosed.reason, "host_disconnected");
  }

  let sawTokenRevoked = false;
  let lastStatus: number | undefined;
  let lastBody: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const turnRes = await app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${createdBody.lobby.lobbyId}/turns`,
      payload: {
        playerToken: createdBody.playerToken,
        clientCommandId: `after-host-disconnect-${attempt}`,
        revision: 0,
        action: { type: "skip" }
      }
    });

    lastStatus = turnRes.statusCode;
    lastBody = turnRes.json();

    if (turnRes.statusCode === 401) {
      sawTokenRevoked = true;
      break;
    }
    if (turnRes.statusCode === 200 || turnRes.statusCode === 409 || turnRes.statusCode === 500) {
      await delay(25);
      continue;
    }

    assert.fail(
      `Unexpected status during host-disconnect transition: ${turnRes.statusCode} body=${JSON.stringify(lastBody)}`
    );
  }

  assert.ok(
    sawTokenRevoked,
    `Expected token revocation after host disconnect; lastStatus=${lastStatus} lastBody=${JSON.stringify(lastBody)}`
  );
});
