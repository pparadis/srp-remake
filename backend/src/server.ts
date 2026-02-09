import Fastify from "fastify";
import websocket from "@fastify/websocket";
import type { RedisClientType } from "redis";
import { createClient } from "redis";
import { z } from "zod";
import type WebSocket from "ws";
import { loadConfig } from "./config.js";
import { MemoryDedupeStore, RedisDedupeStore, type DedupeStore } from "./dedupeStore.js";
import { LobbyError, LobbyStore, toPublicLobby } from "./lobbyStore.js";
import type { TurnCommandResult, TurnSubmitAction } from "./types.js";

const WS_OPEN = 1;

const CreateLobbySchema = z.object({
  name: z.string().min(1),
  settings: z
    .object({
      trackId: z.string().min(1).optional(),
      totalCars: z.number().int().min(1).max(11).optional(),
      humanCars: z.number().int().min(0).max(11).optional(),
      botCars: z.number().int().min(0).max(11).optional(),
      raceLaps: z.number().int().min(1).max(999).optional()
    })
    .optional()
});

const JoinLobbySchema = z.object({
  lobbyId: z.string().min(1),
  name: z.string().min(1).optional(),
  playerToken: z.string().min(1).optional()
});

const UpdateLobbySchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: z.string().min(1),
  settings: z.object({
    trackId: z.string().min(1).optional(),
    totalCars: z.number().int().min(1).max(11).optional(),
    humanCars: z.number().int().min(0).max(11).optional(),
    botCars: z.number().int().min(0).max(11).optional(),
    raceLaps: z.number().int().min(1).max(999).optional()
  })
});

const StartRaceSchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: z.string().min(1)
});

const TurnActionSchema: z.ZodType<TurnSubmitAction> = z.object({
  type: z.enum(["move", "pit", "skip"]),
  targetCellId: z.string().min(1).optional()
});

const SubmitTurnSchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: z.string().min(1),
  clientCommandId: z.string().min(1),
  revision: z.number().int().min(0),
  action: TurnActionSchema
});

const WsQuerySchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: z.string().min(1)
});

async function createDedupeStore(
  redisUrl: string
): Promise<{ dedupeStore: DedupeStore<TurnCommandResult>; redis: RedisClientType | null }> {
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

async function bootstrap() {
  const config = loadConfig();
  const app = Fastify({ logger: true });
  const lobbyStore = new LobbyStore();
  const { dedupeStore, redis } = await createDedupeStore(config.REDIS_URL);
  const socketsByLobby = new Map<string, Set<WebSocket>>();

  function addSocket(lobbyId: string, socket: WebSocket) {
    const set = socketsByLobby.get(lobbyId) ?? new Set<WebSocket>();
    set.add(socket);
    socketsByLobby.set(lobbyId, set);
  }

  function removeSocket(lobbyId: string, socket: WebSocket) {
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
    for (const socket of set) {
      if (socket.readyState === WS_OPEN) {
        socket.send(data);
      }
    }
  }

  function closeLobbySockets(lobbyId: string, closeCode = 4001, reason = "lobby_closed") {
    const set = socketsByLobby.get(lobbyId);
    if (!set) return;
    for (const socket of set) {
      if (socket.readyState === WS_OPEN) {
        socket.close(closeCode, reason);
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

  app.post("/api/lobby.create", async (request, reply) => {
    const body = CreateLobbySchema.parse(request.body);
    const { lobby, host } = lobbyStore.createLobby(body.name, body.settings);
    const publicLobby = toPublicLobby(lobby);
    return reply.code(201).send({
      lobby: publicLobby,
      playerId: host.playerId,
      playerToken: host.playerToken
    });
  });

  app.post("/api/lobby.join", async (request) => {
    const body = JoinLobbySchema.parse(request.body);
    const { lobby, player, isReconnect } = lobbyStore.joinLobby(body.lobbyId, body.name, body.playerToken);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "lobby.state", publicLobby);
    return {
      lobby: publicLobby,
      playerId: player.playerId,
      playerToken: player.playerToken,
      isReconnect
    };
  });

  app.post("/api/lobby.updateSettings", async (request) => {
    const body = UpdateLobbySchema.parse(request.body);
    const lobby = lobbyStore.updateSettings(body.lobbyId, body.playerToken, body.settings);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "lobby.state", publicLobby);
    return { lobby: publicLobby };
  });

  app.post("/api/lobby.startRace", async (request) => {
    const body = StartRaceSchema.parse(request.body);
    const lobby = lobbyStore.startRace(body.lobbyId, body.playerToken);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, "race.started", publicLobby);
    return { lobby: publicLobby };
  });

  app.post("/api/turn.submit", async (request, reply) => {
    const body = SubmitTurnSchema.parse(request.body);
    const lobby = lobbyStore.getLobby(body.lobbyId);
    if (!lobby) {
      throw new LobbyError(404, `Lobby ${body.lobbyId} not found.`);
    }
    const player = lobbyStore.findPlayerByToken(lobby, body.playerToken);
    if (!player) {
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }

    const dedupeKey = `dedupe:${body.lobbyId}:${player.playerId}:${body.clientCommandId}`;
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
    const query = WsQuerySchema.safeParse(request.query);
    if (!query.success) {
      connection.socket.close(1008, "invalid_query");
      return;
    }

    const { lobbyId, playerToken } = query.data;
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby) {
      connection.socket.close(1008, "unknown_lobby");
      return;
    }
    const player = lobbyStore.findPlayerByToken(lobby, playerToken);
    if (!player) {
      connection.socket.close(1008, "invalid_token");
      return;
    }

    addSocket(lobbyId, connection.socket);
    lobbyStore.setPlayerConnected(lobbyId, playerToken, true);
    connection.socket.send(JSON.stringify({ event: "lobby.state", payload: toPublicLobby(lobby) }));

    connection.socket.on("close", () => {
      removeSocket(lobbyId, connection.socket);
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

  await app.listen({ host: config.HOST, port: config.PORT });
}

void bootstrap();
