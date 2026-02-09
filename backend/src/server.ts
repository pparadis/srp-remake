import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "redis";
import { z } from "zod";
import { loadConfig, type BackendConfig } from "./config.js";
import { MemoryDedupeStore, RedisDedupeStore, type DedupeStore } from "./dedupeStore.js";
import { LobbyError, LobbyStore, toPublicLobby } from "./lobbyStore.js";
import type { LobbySettings, TurnCommandResult, TurnSubmitAction } from "./types.js";

const WS_OPEN = 1;
const API_V1_PREFIX = "/api/v1";

type LobbySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
};

type TimelineEntry = {
  seq: number;
  at: number;
  event: string;
  context: Record<string, unknown>;
};

type CreateAppOptions = {
  logger?: boolean;
  dedupeStore?: DedupeStore<TurnCommandResult>;
  redis?: ReturnType<typeof createClient> | null;
};

const LobbySettingsPatchSchema = z.object({
  trackId: z.string().min(1).optional(),
  totalCars: z.number().int().min(1).max(11).optional(),
  humanCars: z.number().int().min(0).max(11).optional(),
  botCars: z.number().int().min(0).max(11).optional(),
  raceLaps: z.number().int().min(1).max(999).optional()
});

function toSettingsPatch(
  settings: z.infer<typeof LobbySettingsPatchSchema> | undefined
): Partial<LobbySettings> | undefined {
  if (!settings) {
    return undefined;
  }

  const patch: Partial<LobbySettings> = {};
  if (settings.trackId !== undefined) patch.trackId = settings.trackId;
  if (settings.totalCars !== undefined) patch.totalCars = settings.totalCars;
  if (settings.humanCars !== undefined) patch.humanCars = settings.humanCars;
  if (settings.botCars !== undefined) patch.botCars = settings.botCars;
  if (settings.raceLaps !== undefined) patch.raceLaps = settings.raceLaps;
  return patch;
}

const CreateLobbySchema = z.object({
  name: z.string().min(1),
  settings: LobbySettingsPatchSchema.optional()
});

const JoinLobbySchema = z.object({
  name: z.string().min(1).optional(),
  playerToken: z.string().min(1).optional()
});

const UpdateLobbySchema = z.object({
  playerToken: z.string().min(1),
  settings: LobbySettingsPatchSchema
});

const StartRaceSchema = z.object({
  playerToken: z.string().min(1)
});

const TurnActionSchema = z
  .object({
    type: z.enum(["move", "pit", "skip"]),
    targetCellId: z.string().min(1).optional()
  })
  .transform(
    (action): TurnSubmitAction =>
      action.targetCellId === undefined
        ? { type: action.type }
        : { type: action.type, targetCellId: action.targetCellId }
  );

const SubmitTurnSchema = z.object({
  playerToken: z.string().min(1),
  clientCommandId: z.string().min(1),
  revision: z.number().int().min(0),
  action: TurnActionSchema
});

const LobbyPathSchema = z.object({
  lobbyId: z.string().min(1)
});

const WsQuerySchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: z.string().min(1)
});

const LobbyReadQuerySchema = z.object({
  playerToken: z.string().min(1)
});

const AdminTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional()
});

async function createDedupeStore(redisUrl: string): Promise<{
  dedupeStore: DedupeStore<TurnCommandResult>;
  redis: ReturnType<typeof createClient> | null;
}> {
  const redis = createClient({ url: redisUrl });
  try {
    await redis.connect();
    return { dedupeStore: new RedisDedupeStore<TurnCommandResult>(redis), redis };
  } catch {
    try {
      await redis.disconnect();
    } catch {
      // no-op
    }
    return { dedupeStore: new MemoryDedupeStore<TurnCommandResult>(), redis: null };
  }
}

export async function createApp(config: BackendConfig, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const lobbyStore = new LobbyStore(config.PLAYER_TOKEN_TTL_SECONDS * 1000);
  const { dedupeStore, redis } = options.dedupeStore
    ? { dedupeStore: options.dedupeStore, redis: options.redis ?? null }
    : await createDedupeStore(config.REDIS_URL);
  const socketsByLobby = new Map<string, Set<LobbySocket>>();
  const timelineByLobby = new Map<string, TimelineEntry[]>();
  const timelineMaxEntries = 500;
  let timelineSeq = 1;
  let wsConnectionSeq = 1;
  const allowedOrigins = config.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowAnyOrigin = allowedOrigins.includes("*");

  function resolveAllowOrigin(requestOrigin: string | undefined): string {
    if (allowAnyOrigin) {
      return "*";
    }
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      return requestOrigin;
    }
    return allowedOrigins[0] ?? "*";
  }

  function tokenFingerprint(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return createHash("sha256").update(token).digest("hex").slice(0, 10);
  }

  function summarizeRaceState(lobbyId: string) {
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby?.raceState) return null;
    return {
      turnIndex: lobby.raceState.turnIndex,
      activeSeatIndex: lobby.raceState.activeSeatIndex,
      cars: lobby.raceState.cars.map((car) => ({
        seatIndex: car.seatIndex,
        playerId: car.playerId,
        isBot: car.isBot,
        actionsTaken: car.actionsTaken
      }))
    };
  }

  function recordTimeline(lobbyId: string, event: string, context: Record<string, unknown>) {
    const entry: TimelineEntry = {
      seq: timelineSeq++,
      at: Date.now(),
      event,
      context
    };
    const items = timelineByLobby.get(lobbyId) ?? [];
    items.push(entry);
    if (items.length > timelineMaxEntries) {
      items.splice(0, items.length - timelineMaxEntries);
    }
    timelineByLobby.set(lobbyId, items);
  }

  function logMultiplayer(event: string, context: Record<string, unknown>) {
    app.log.info({ event, ...context }, "multiplayer_event");
    const lobbyId = context.lobbyId;
    if (typeof lobbyId === "string" && lobbyId.length > 0) {
      recordTimeline(lobbyId, event, context);
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    const allowOrigin = resolveAllowOrigin(request.headers.origin);

    // Enable browser frontend access for local and hosted clients.
    reply.header("Access-Control-Allow-Origin", allowOrigin);
    reply.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Accept,Content-Type,Authorization");
    reply.header("Access-Control-Max-Age", "86400");
    if (!allowAnyOrigin) {
      reply.header("Vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  function addSocket(lobbyId: string, socket: LobbySocket) {
    const set = socketsByLobby.get(lobbyId) ?? new Set<LobbySocket>();
    set.add(socket);
    socketsByLobby.set(lobbyId, set);
  }

  function removeSocket(lobbyId: string, socket: LobbySocket) {
    const set = socketsByLobby.get(lobbyId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      socketsByLobby.delete(lobbyId);
    }
  }

  function broadcast(lobbyId: string, event: string, payload: unknown) {
    const set = socketsByLobby.get(lobbyId);
    recordTimeline(lobbyId, `broadcast.${event}`, {
      lobbyId,
      audience: set?.size ?? 0,
      raceSummary: summarizeRaceState(lobbyId)
    });
    if (!set) return;
    const data = JSON.stringify({ event, payload });
    const staleSockets: LobbySocket[] = [];
    for (const socket of set) {
      if (socket.readyState !== WS_OPEN) {
        staleSockets.push(socket);
        continue;
      }

      try {
        socket.send(data);
      } catch {
        staleSockets.push(socket);
      }
    }

    for (const socket of staleSockets) {
      set.delete(socket);
    }
    if (set.size === 0) {
      socketsByLobby.delete(lobbyId);
    }
  }

  function closeLobbySockets(lobbyId: string, closeCode = 4001, reason = "lobby_closed") {
    const set = socketsByLobby.get(lobbyId);
    if (!set) return;
    for (const socket of set) {
      if (socket.readyState === WS_OPEN) {
        try {
          socket.close(closeCode, reason);
        } catch {
          // Ignore close races.
        }
      }
    }
    socketsByLobby.delete(lobbyId);
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LobbyError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: "internal_error" });
  });

  await app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    redis: redis?.isReady ?? false,
    lobbies: lobbyStore.count()
  }));

  app.post(`${API_V1_PREFIX}/lobbies`, async (request, reply) => {
    const body = CreateLobbySchema.parse(request.body);
    const { lobby, host } = lobbyStore.createLobby(body.name, toSettingsPatch(body.settings));
    const publicLobby = toPublicLobby(lobby);
    logMultiplayer("lobby.create", {
      lobbyId: lobby.lobbyId,
      playerId: host.playerId,
      seatIndex: host.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null,
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return reply.code(201).send({
      lobby: publicLobby,
      playerId: host.playerId,
      playerToken: host.playerToken
    });
  });

  app.get(`${API_V1_PREFIX}/lobbies/:lobbyId`, async (request) => {
    const params = LobbyPathSchema.parse(request.params);
    const query = LobbyReadQuerySchema.parse(request.query);
    const lobby = lobbyStore.getLobby(params.lobbyId);
    if (!lobby) {
      throw new LobbyError(404, `Lobby ${params.lobbyId} not found.`);
    }

    const player = lobbyStore.findPlayerByToken(lobby, query.playerToken);
    if (!player) {
      logMultiplayer("lobby.read.rejected", {
        lobbyId: params.lobbyId,
        tokenFingerprint: tokenFingerprint(query.playerToken),
        reason: "invalid_token"
      });
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }

    logMultiplayer("lobby.read", {
      lobbyId: params.lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null
    });
    return {
      lobby: toPublicLobby(lobby),
      playerId: player.playerId
    };
  });

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/join`, async (request) => {
    const params = LobbyPathSchema.parse(request.params);
    const body = JoinLobbySchema.parse(request.body);
    const { lobby, player, isReconnect } = lobbyStore.joinLobby(
      params.lobbyId,
      body.name,
      body.playerToken
    );
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "lobby.state", publicLobby);
    logMultiplayer(isReconnect ? "lobby.reconnect" : "lobby.join", {
      lobbyId: lobby.lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null,
      tokenFingerprint: tokenFingerprint(player.playerToken),
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return {
      lobby: publicLobby,
      playerId: player.playerId,
      playerToken: player.playerToken,
      isReconnect
    };
  });

  app.patch(`${API_V1_PREFIX}/lobbies/:lobbyId/settings`, async (request) => {
    const params = LobbyPathSchema.parse(request.params);
    const body = UpdateLobbySchema.parse(request.body);
    const lobby = lobbyStore.updateSettings(
      params.lobbyId,
      body.playerToken,
      toSettingsPatch(body.settings) ?? {}
    );
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "lobby.state", publicLobby);
    logMultiplayer("lobby.settings.update", {
      lobbyId: lobby.lobbyId,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null,
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return { lobby: publicLobby };
  });

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/start`, async (request) => {
    const params = LobbyPathSchema.parse(request.params);
    const body = StartRaceSchema.parse(request.body);
    const lobby = lobbyStore.startRace(params.lobbyId, body.playerToken);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "race.started", publicLobby);
    broadcast(lobby.lobbyId, "race.state", publicLobby);
    logMultiplayer("race.start", {
      lobbyId: lobby.lobbyId,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null,
      activeSeatIndex: lobby.raceState?.activeSeatIndex ?? null,
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return { lobby: publicLobby };
  });

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/turns`, async (request, reply) => {
    const params = LobbyPathSchema.parse(request.params);
    const body = SubmitTurnSchema.parse(request.body);
    const lobby = lobbyStore.getLobby(params.lobbyId);
    if (!lobby) {
      throw new LobbyError(404, `Lobby ${params.lobbyId} not found.`);
    }
    const player = lobbyStore.findPlayerByToken(lobby, body.playerToken);
    if (!player) {
      logMultiplayer("turn.submit.rejected", {
        lobbyId: params.lobbyId,
        clientCommandId: body.clientCommandId,
        tokenFingerprint: tokenFingerprint(body.playerToken),
        reason: "invalid_token"
      });
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }

    const dedupeKey = `dedupe:${params.lobbyId}:${player.playerId}:${body.clientCommandId}`;
    const deduped = await dedupeStore.get(dedupeKey);
    if (deduped) {
      logMultiplayer("turn.submit.deduped", {
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        seatIndex: player.seatIndex,
        revision: deduped.revision,
        turnIndex: lobby.raceState?.turnIndex ?? null,
        clientCommandId: body.clientCommandId
      });
      return deduped;
    }

    let result: TurnCommandResult;
    if (lobby.status !== "IN_RACE") {
      result = {
        ok: false,
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        clientCommandId: body.clientCommandId,
        revision: lobby.revision,
        error: "lobby_not_in_race"
      };
      await dedupeStore.set(dedupeKey, result, config.DEDUPE_TTL_SECONDS);
      logMultiplayer("turn.submit.rejected", {
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        seatIndex: player.seatIndex,
        revision: lobby.revision,
        turnIndex: lobby.raceState?.turnIndex ?? null,
        clientCommandId: body.clientCommandId,
        reason: "lobby_not_in_race"
      });
      return reply.code(409).send(result);
    }

    if (body.revision !== lobby.revision) {
      result = {
        ok: false,
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        clientCommandId: body.clientCommandId,
        revision: lobby.revision,
        error: "stale_revision"
      };
      await dedupeStore.set(dedupeKey, result, config.DEDUPE_TTL_SECONDS);
      logMultiplayer("turn.submit.rejected", {
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        seatIndex: player.seatIndex,
        revision: lobby.revision,
        turnIndex: lobby.raceState?.turnIndex ?? null,
        clientCommandId: body.clientCommandId,
        reason: "stale_revision",
        expectedRevision: lobby.revision,
        receivedRevision: body.revision,
        raceSummary: summarizeRaceState(lobby.lobbyId)
      });
      return reply.code(409).send(result);
    }

    const activeCar = lobbyStore.getActiveRaceCar(lobby.lobbyId);
    if (!activeCar || activeCar.playerId !== player.playerId) {
      result = {
        ok: false,
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        clientCommandId: body.clientCommandId,
        revision: lobby.revision,
        error: "not_active_player"
      };
      await dedupeStore.set(dedupeKey, result, config.DEDUPE_TTL_SECONDS);
      logMultiplayer("turn.submit.rejected", {
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        seatIndex: player.seatIndex,
        revision: lobby.revision,
        turnIndex: lobby.raceState?.turnIndex ?? null,
        clientCommandId: body.clientCommandId,
        reason: "not_active_player",
        activeSeatIndex: lobby.raceState?.activeSeatIndex ?? null,
        raceSummary: summarizeRaceState(lobby.lobbyId)
      });
      return reply.code(409).send(result);
    }

    lobbyStore.applyTurnAction(lobby.lobbyId, body.action);
    const updatedLobby = lobbyStore.incrementRevision(lobby.lobbyId);
    result = {
      ok: true,
      lobbyId: lobby.lobbyId,
      playerId: player.playerId,
      clientCommandId: body.clientCommandId,
      revision: updatedLobby.revision,
      applied: body.action
    };
    await dedupeStore.set(dedupeKey, result, config.DEDUPE_TTL_SECONDS);
    broadcast(lobby.lobbyId, "turn.applied", result);
    broadcast(lobby.lobbyId, "race.state", toPublicLobby(updatedLobby));
    logMultiplayer("turn.submit.applied", {
      lobbyId: lobby.lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: updatedLobby.revision,
      turnIndex: updatedLobby.raceState?.turnIndex ?? null,
      clientCommandId: body.clientCommandId,
      activeSeatIndex: updatedLobby.raceState?.activeSeatIndex ?? null,
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return result;
  });

  app.get("/admin/lobbies/:lobbyId/timeline", async (request, reply) => {
    if (!config.ADMIN_DEBUG_ENABLED) {
      return reply.code(404).send({ error: "not_found" });
    }

    const params = LobbyPathSchema.parse(request.params);
    const query = AdminTimelineQuerySchema.parse(request.query);
    const auth = request.headers.authorization;
    if (config.ADMIN_DEBUG_TOKEN.length > 0) {
      const expected = `Bearer ${config.ADMIN_DEBUG_TOKEN}`;
      if (auth !== expected) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    const items = timelineByLobby.get(params.lobbyId) ?? [];
    const limit = query.limit ?? 200;
    const entries = items.slice(Math.max(0, items.length - limit));
    const lobby = lobbyStore.getLobby(params.lobbyId);
    return {
      lobbyId: params.lobbyId,
      count: items.length,
      returned: entries.length,
      entries,
      snapshot: lobby ? toPublicLobby(lobby) : null
    };
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const ws = socket as LobbySocket;
    const wsConnId = `ws-${wsConnectionSeq++}`;
    const query = WsQuerySchema.safeParse(request.query);
    if (!query.success) {
      logMultiplayer("ws.connect.rejected", {
        wsConnId,
        reason: "invalid_query"
      });
      ws.close(1008, "invalid_query");
      return;
    }

    const { lobbyId, playerToken } = query.data;
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby) {
      logMultiplayer("ws.connect.rejected", {
        wsConnId,
        lobbyId,
        tokenFingerprint: tokenFingerprint(playerToken),
        reason: "unknown_lobby"
      });
      ws.close(1008, "unknown_lobby");
      return;
    }
    const player = lobbyStore.findPlayerByToken(lobby, playerToken);
    if (!player) {
      logMultiplayer("ws.connect.rejected", {
        wsConnId,
        lobbyId,
        tokenFingerprint: tokenFingerprint(playerToken),
        reason: "invalid_token"
      });
      ws.close(1008, "invalid_token");
      return;
    }

    addSocket(lobbyId, ws);
    lobbyStore.setPlayerConnected(lobbyId, playerToken, true);
    logMultiplayer("ws.open", {
      wsConnId,
      lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.raceState?.turnIndex ?? null
    });
    const publicLobby = toPublicLobby(lobby);
    ws.send(JSON.stringify({ event: "lobby.state", payload: publicLobby }));
    if (publicLobby.raceState !== undefined) {
      ws.send(JSON.stringify({ event: "race.state", payload: publicLobby }));
    }

    ws.on("close", () => {
      removeSocket(lobbyId, ws);
      try {
        const result = lobbyStore.setPlayerConnected(lobbyId, playerToken, false);
        logMultiplayer("ws.close", {
          wsConnId,
          lobbyId,
          playerId: result.player.playerId,
          seatIndex: result.player.seatIndex,
          revision: result.lobby.revision,
          turnIndex: result.lobby.raceState?.turnIndex ?? null
        });
        broadcast(lobbyId, "lobby.state", toPublicLobby(result.lobby));
        if (result.player.isHost && result.lobby.status !== "FINISHED") {
          const ended = lobbyStore.terminateLobby(lobbyId, "host_disconnected");
          logMultiplayer("race.end", {
            wsConnId,
            lobbyId,
            reason: "host_disconnected",
            revision: ended.revision,
            turnIndex: ended.raceState?.turnIndex ?? null
          });
          broadcast(lobbyId, "race.ended", {
            reason: "host_disconnected",
            lobby: toPublicLobby(ended)
          });
          closeLobbySockets(lobbyId, 4001, "host_disconnected");
        }
      } catch {
        // Lobby may already be gone; ignore close handling errors.
      }
    });
  });

  app.addHook("onClose", async () => {
    if (redis) {
      await redis.disconnect();
    }
  });

  return app;
}

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ host: config.HOST, port: config.PORT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap();
}
