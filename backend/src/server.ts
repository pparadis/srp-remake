import Fastify from "fastify";
import websocket from "@fastify/websocket";
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
  const lobbyStore = new LobbyStore();
  const { dedupeStore, redis } = options.dedupeStore
    ? { dedupeStore: options.dedupeStore, redis: options.redis ?? null }
    : await createDedupeStore(config.REDIS_URL);
  const socketsByLobby = new Map<string, Set<LobbySocket>>();

  app.addHook("onRequest", async (request, reply) => {
    // Keep local frontend integration simple: allow browser clients to call v1 API directly.
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Accept,Content-Type,Authorization");
    reply.header("Access-Control-Max-Age", "86400");

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
    return reply.code(201).send({
      lobby: publicLobby,
      playerId: host.playerId,
      playerToken: host.playerToken
    });
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
    return { lobby: publicLobby };
  });

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/start`, async (request) => {
    const params = LobbyPathSchema.parse(request.params);
    const body = StartRaceSchema.parse(request.body);
    const lobby = lobbyStore.startRace(params.lobbyId, body.playerToken);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "race.started", publicLobby);
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
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }

    const dedupeKey = `dedupe:${params.lobbyId}:${player.playerId}:${body.clientCommandId}`;
    const deduped = await dedupeStore.get(dedupeKey);
    if (deduped) {
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
      return reply.code(409).send(result);
    }

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
    return result;
  });

  app.get("/ws", { websocket: true }, (connection, request) => {
    const socket = connection.socket as LobbySocket;
    const query = WsQuerySchema.safeParse(request.query);
    if (!query.success) {
      socket.close(1008, "invalid_query");
      return;
    }

    const { lobbyId, playerToken } = query.data;
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby) {
      socket.close(1008, "unknown_lobby");
      return;
    }
    const player = lobbyStore.findPlayerByToken(lobby, playerToken);
    if (!player) {
      socket.close(1008, "invalid_token");
      return;
    }

    addSocket(lobbyId, socket);
    lobbyStore.setPlayerConnected(lobbyId, playerToken, true);
    socket.send(JSON.stringify({ event: "lobby.state", payload: toPublicLobby(lobby) }));

    socket.on("close", () => {
      removeSocket(lobbyId, socket);
      try {
        const result = lobbyStore.setPlayerConnected(lobbyId, playerToken, false);
        broadcast(lobbyId, "lobby.state", toPublicLobby(result.lobby));
        if (result.player.isHost && result.lobby.status !== "FINISHED") {
          const ended = lobbyStore.terminateLobby(lobbyId, "host_disconnected");
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
