import assert from "node:assert/strict";

const baseUrl = process.env.BACKEND_BASE_URL ?? "http://localhost:3001";
const adminDebugToken = process.env.BACKEND_ADMIN_DEBUG_TOKEN ?? "";
const timelineLimit = Number(process.env.REPRO_TIMELINE_LIMIT ?? "40");

function log(step, data) {
  const prefix = `[repro-sync] ${step}`;
  if (data === undefined) {
    console.log(prefix);
    return;
  }
  console.log(prefix, JSON.stringify(data));
}

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let parsed = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  return {
    status: response.status,
    body: parsed
  };
}

function requireStatus(response, expected, label) {
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    expectedStatuses.includes(response.status),
    `${label} expected ${expectedStatuses.join(" or ")}, received ${response.status} body=${JSON.stringify(response.body)}`
  );
}

async function main() {
  log("config", { baseUrl, timelineLimit });

  const health = await request("GET", "/health");
  requireStatus(health, 200, "health");
  log("health", health.body);

  const createLobby = await request("POST", "/api/v1/lobbies", {
    name: "Repro Host",
    settings: {
      totalCars: 2,
      humanCars: 2,
      botCars: 0,
      raceLaps: 3
    }
  });
  requireStatus(createLobby, 201, "create lobby");
  const lobbyId = createLobby.body?.lobby?.lobbyId;
  const hostToken = createLobby.body?.playerToken;
  assert.ok(typeof lobbyId === "string" && lobbyId.length > 0, "create lobby must return lobbyId");
  assert.ok(typeof hostToken === "string" && hostToken.length > 0, "create lobby must return host token");
  log("lobby.created", { lobbyId });

  const joinLobby = await request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/join`, {
    name: "Repro Guest"
  });
  requireStatus(joinLobby, 200, "join lobby");
  const guestToken = joinLobby.body?.playerToken;
  assert.ok(typeof guestToken === "string" && guestToken.length > 0, "join lobby must return guest token");
  log("lobby.joined", { isReconnect: joinLobby.body?.isReconnect === true });

  const startRace = await request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/start`, {
    playerToken: hostToken
  });
  requireStatus(startRace, 200, "start race");
  log("race.started", { revision: startRace.body?.lobby?.revision });

  const readLobby = await request(
    "GET",
    `/api/v1/lobbies/${encodeURIComponent(lobbyId)}?playerToken=${encodeURIComponent(hostToken)}`
  );
  requireStatus(readLobby, 200, "read lobby");
  const revision = readLobby.body?.lobby?.revision;
  const players = readLobby.body?.lobby?.players ?? [];
  const activeSeatIndex = readLobby.body?.lobby?.raceState?.activeSeatIndex;
  assert.equal(typeof revision, "number", "read lobby must return numeric revision");
  assert.equal(typeof activeSeatIndex, "number", "read lobby must return activeSeatIndex");
  const activePlayer = players.find((player) => player.seatIndex === activeSeatIndex);
  assert.ok(activePlayer, "active seat must map to a lobby player");
  const activeToken = activePlayer.isHost ? hostToken : guestToken;
  log("race.active", { activeSeatIndex, activePlayerId: activePlayer.playerId });

  const firstTurnRequest = {
    playerToken: activeToken,
    clientCommandId: "repro-turn-1",
    revision,
    action: { type: "skip" }
  };
  const applyTurn = await request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/turns`, firstTurnRequest);
  requireStatus(applyTurn, 200, "apply turn");
  log("turn.applied", applyTurn.body);

  const dedupeTurn = await request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/turns`, firstTurnRequest);
  requireStatus(dedupeTurn, 200, "dedupe turn");
  log("turn.deduped", dedupeTurn.body);

  const staleTurn = await request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/turns`, {
    playerToken: activeToken,
    clientCommandId: "repro-turn-stale",
    revision,
    action: { type: "skip" }
  });
  requireStatus(staleTurn, 409, "stale turn");
  log("turn.stale", staleTurn.body);

  const timelineHeaders =
    adminDebugToken.length > 0 ? { authorization: `Bearer ${adminDebugToken}` } : {};
  const timeline = await request(
    "GET",
    `/admin/lobbies/${encodeURIComponent(lobbyId)}/timeline?limit=${timelineLimit}`,
    undefined,
    timelineHeaders
  );
  if (timeline.status === 200) {
    log("timeline.summary", {
      count: timeline.body?.count,
      returned: timeline.body?.returned
    });
    log("timeline.tail", timeline.body?.entries ?? []);
  } else {
    log("timeline.unavailable", { status: timeline.status, body: timeline.body });
  }

  log("complete", { lobbyId });
}

main().catch((error) => {
  console.error("[repro-sync] failed", error);
  process.exitCode = 1;
});
