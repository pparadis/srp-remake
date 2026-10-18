import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  DEFAULT_HOST_GRACE_SECONDS,
  DEFAULT_LOBBY_IDLE_SECONDS,
  DEFAULT_MAX_LOBBIES,
  loadConfig,
  type BackendConfig
} from './config.js';
import { LobbyError, LobbyStore, toPublicLobby } from './lobbyStore.js';
import { activeSeatIndex } from '../../src/game/race/raceEngine';
import type { BotPolicy } from '../../src/game/systems/botSystem';
import {
  BOT_LEVEL_CHOICES,
  type Lobby,
  type LobbySettings,
  type TurnCommandResult,
  type TurnSubmitAction
} from './types.js';

const WS_OPEN = 1;
const API_V1_PREFIX = '/api/v1';
const REAP_INTERVAL_MS = 60_000;
// A finished lobby only stays this long (after its last socket closes) for a late reload to see the results.
const FINISHED_LINGER_MS = 10 * 60_000;

// The player token travels in the URL of the lobby read and the WebSocket; keep it out of the request log.
export function redactTokens(url: string): string {
  return url.replace(/([?&]playerToken=)[^&#]*/g, '$1[redacted]');
}

interface LobbySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close', listener: () => void): void;
}

interface AppliedTurnEvent {
  ok: true;
  lobbyId: string;
  playerId: string;
  clientCommandId: string;
  revision: number;
  applied: TurnSubmitAction;
  // "bot" = a bot seat, "timeout" = the turn timer expired, "force_skip" = the host skipped a stuck player.
  source?: 'human' | 'bot' | 'timeout' | 'force_skip';
  seatIndex?: number;
}

interface CreateAppOptions {
  logger?: boolean;
  // Where the request log goes (default stdout); lets a test read what is logged.
  logStream?: { write(line: string): void };
  // Lets tests set up lobby state directly (e.g. park a car in the pit lane).
  lobbyStore?: LobbyStore;
}

const lobbySettingsPatchSchema = z.object({
  trackId: z.string().min(1).optional(),
  totalCars: z.number().int().min(1).max(11).optional(),
  humanCars: z.number().int().min(0).max(11).optional(),
  botCars: z.number().int().min(0).max(11).optional(),
  raceLaps: z.number().int().min(1).max(999).optional(),
  turnTimerSec: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120)]).optional(),
  botLevel: z.enum(BOT_LEVEL_CHOICES).optional()
});

function toSettingsPatch(
  settings: z.infer<typeof lobbySettingsPatchSchema> | undefined
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
  if (settings.turnTimerSec !== undefined) patch.turnTimerSec = settings.turnTimerSec;
  if (settings.botLevel !== undefined) patch.botLevel = settings.botLevel;
  return patch;
}

const playerNameSchema = z.string().trim().min(1).max(32);
const playerTokenSchema = z.string().min(1).max(64);

const createLobbySchema = z.object({
  name: playerNameSchema,
  settings: lobbySettingsPatchSchema.optional()
});

const joinLobbySchema = z.object({
  name: playerNameSchema.optional(),
  playerToken: playerTokenSchema.optional()
});

const updateLobbySchema = z.object({
  playerToken: playerTokenSchema,
  settings: lobbySettingsPatchSchema
});

const startRaceSchema = z.object({
  playerToken: playerTokenSchema
});

const resetLobbySchema = startRaceSchema;

const forceSkipSchema = z.object({
  playerToken: playerTokenSchema,
  // The revision the host saw; refuses the skip if the stuck player moved in the meantime.
  revision: z.number().int().min(0).optional()
});

// Shape only; the race engine enforces the PSI limits and every game rule.
const carSetupSchema = z.object({
  compound: z.enum(['soft', 'hard']),
  psi: z.object({ fl: z.number(), fr: z.number(), rl: z.number(), rr: z.number() }),
  wing: z.enum(['low', 'medium', 'high'])
});

const turnActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('skip') }),
  z.object({ type: z.literal('move'), targetCellId: z.string().min(1).max(32) }),
  z.object({
    type: z.literal('pit'),
    targetCellId: z.string().min(1).max(32),
    setup: carSetupSchema
  }),
  // Grid setup: free, before the car's first move, and it does not end the turn.
  z.object({ type: z.literal('setup'), setup: carSetupSchema })
]);

const submitTurnSchema = z.object({
  playerToken: playerTokenSchema,
  clientCommandId: z.string().min(1).max(64),
  revision: z.number().int().min(0),
  action: turnActionSchema
});

const chatSchema = z.object({
  playerToken: playerTokenSchema,
  // Generous: normalizeChatText applies the real limit (100 graphemes, 400 code units); this only bounds the work.
  text: z.string().max(2000)
});

const lobbyPathSchema = z.object({
  lobbyId: z.string().min(1)
});

const wsQuerySchema = z.object({
  lobbyId: z.string().min(1),
  playerToken: playerTokenSchema
});

const lobbyReadQuerySchema = z.object({
  playerToken: playerTokenSchema
});

function seatOf(lobby: Lobby) {
  return lobby.race ? activeSeatIndex(lobby.race.engine) : null;
}

export async function createApp(config: BackendConfig, options: CreateAppOptions = {}) {
  // A hop count trusts that many proxies in front of us (Fastify's own number support is not in its types).
  const trustProxyConfig = config.TRUST_PROXY ?? false;
  const trustProxy =
    typeof trustProxyConfig === 'number'
      ? (_address: string, hop: number) => hop < trustProxyConfig
      : trustProxyConfig;
  const app = Fastify({
    logger:
      (options.logger ?? true)
        ? {
            ...(options.logStream ? { stream: options.logStream } : {}),
            serializers: {
              // The default one logs the raw url, player token included.
              req: (request) => ({
                method: request.method,
                url: redactTokens(request.url),
                host: request.host,
                remoteAddress: request.ip
              })
            }
          }
        : false,
    // 16 KiB is far above any honest request.
    bodyLimit: 16 * 1024,
    trustProxy
  });
  const lobbyStore =
    options.lobbyStore ??
    new LobbyStore(
      config.PLAYER_TOKEN_TTL_SECONDS * 1000,
      config.MAX_LOBBIES ?? DEFAULT_MAX_LOBBIES
    );
  // lobby -> "player:clientCommandId" -> result. Dropped with the lobby when it is reaped.
  const dedupedResults = new Map<string, Map<string, TurnCommandResult>>();
  const lobbyIdleMs = (config.LOBBY_IDLE_SECONDS ?? DEFAULT_LOBBY_IDLE_SECONDS) * 1000;
  // lobby -> player -> open sockets. A player is connected while at least one socket is open,
  // so an old socket closing after a reconnect does not mark a live player as gone.
  const socketsByLobby = new Map<string, Map<string, Set<LobbySocket>>>();
  const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hostGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const timeScale = config.TURN_TIMER_TIME_SCALE ?? 1;
  const hostGraceMs = (config.HOST_GRACE_SECONDS ?? DEFAULT_HOST_GRACE_SECONDS) * 1000;
  let closing = false;
  let wsConnectionSeq = 1;
  const allowedOrigins = config.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowAnyOrigin = allowedOrigins.includes('*');

  function resolveAllowOrigin(requestOrigin: string | undefined): string {
    if (allowAnyOrigin) {
      return '*';
    }
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      return requestOrigin;
    }
    return allowedOrigins[0] ?? '*';
  }

  function tokenFingerprint(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return createHash('sha256').update(token).digest('hex').slice(0, 10);
  }

  function summarizeRaceState(lobbyId: string) {
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby?.race) return null;
    const { engine, seats } = lobby.race;
    return {
      turnIndex: lobby.race.turnIndex,
      activeSeatIndex: activeSeatIndex(engine),
      winnerCarId: engine.winnerCarId,
      cars: engine.cars.map((car, i) => ({
        seatIndex: seats[i]?.seatIndex,
        playerId: seats[i]?.playerId ?? null,
        isBot: car.isBot,
        cellId: car.cellId,
        lapCount: car.lapCount ?? 0
      }))
    };
  }

  function logMultiplayer(event: string, context: Record<string, unknown>) {
    app.log.info({ event, ...context }, 'multiplayer_event');
  }

  app.addHook('onRequest', async (request, reply) => {
    const allowOrigin = resolveAllowOrigin(request.headers.origin);

    // Enable browser frontend access for local and hosted clients.
    reply.header('Access-Control-Allow-Origin', allowOrigin);
    reply.header('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Accept,Content-Type,Authorization');
    reply.header('Access-Control-Max-Age', '86400');
    if (!allowAnyOrigin) {
      reply.header('Vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  function addSocket(lobbyId: string, playerId: string, socket: LobbySocket) {
    const players = socketsByLobby.get(lobbyId) ?? new Map<string, Set<LobbySocket>>();
    const sockets = players.get(playerId) ?? new Set<LobbySocket>();
    sockets.add(socket);
    players.set(playerId, sockets);
    socketsByLobby.set(lobbyId, players);
  }

  // Returns how many sockets the player still has open.
  function removeSocket(lobbyId: string, playerId: string, socket: LobbySocket): number {
    const players = socketsByLobby.get(lobbyId);
    const sockets = players?.get(playerId);
    if (!players || !sockets) return 0;
    sockets.delete(socket);
    if (sockets.size === 0) {
      players.delete(playerId);
      if (players.size === 0) socketsByLobby.delete(lobbyId);
    }
    return sockets.size;
  }

  function broadcast(lobbyId: string, event: string, payload: unknown) {
    const players = socketsByLobby.get(lobbyId);
    if (!players) return;
    const data = JSON.stringify({ event, payload });
    for (const sockets of players.values()) {
      for (const socket of sockets) {
        if (socket.readyState !== WS_OPEN) continue;
        try {
          socket.send(data);
        } catch {
          // The close handler drops it.
        }
      }
    }
  }

  function closeLobbySockets(lobbyId: string, closeCode = 4001, reason = 'lobby_closed') {
    const players = socketsByLobby.get(lobbyId);
    if (!players) return;
    for (const sockets of players.values()) {
      for (const socket of sockets) {
        if (socket.readyState === WS_OPEN) {
          try {
            socket.close(closeCode, reason);
          } catch {
            // Ignore close races.
          }
        }
      }
    }
    socketsByLobby.delete(lobbyId);
  }

  function clearTurnTimer(lobbyId: string) {
    const timer = turnTimers.get(lobbyId);
    if (timer) clearTimeout(timer);
    turnTimers.delete(lobbyId);
    lobbyStore.setTurnDeadline(lobbyId, undefined);
  }

  // (Re)arms the AFK timer when the active seat is a human and the lobby has a timer; clears it
  // otherwise. Called before a state is broadcast so the state carries turnRemainingMs.
  function armTurnTimer(lobbyId: string) {
    clearTurnTimer(lobbyId);
    const lobby = lobbyStore.getLobby(lobbyId);
    if (closing || !lobby || lobby.status !== 'IN_RACE' || lobby.settings.turnTimerSec === 0) {
      return;
    }
    const seat = lobbyStore.getActiveRaceSeat(lobbyId);
    if (!seat || seat.isBot) return;
    const delayMs = Math.max(1, Math.round(lobby.settings.turnTimerSec * 1000 * timeScale));
    const revision = lobby.revision;
    lobbyStore.setTurnDeadline(lobbyId, Date.now() + delayMs);
    const timer = setTimeout(() => {
      turnTimers.delete(lobbyId);
      const current = lobbyStore.getLobby(lobbyId);
      // Anything that moved the race on since arming already re-armed (or cleared) the timer.
      if (!current || current.status !== 'IN_RACE' || current.revision !== revision) return;
      logMultiplayer('turn.timeout', { lobbyId, revision, seatIndex: seat.seatIndex });
      playBotTurnFor(lobbyId, 'autopilot', 'timeout');
      void runPendingBotTurns(lobbyId);
    }, delayMs);
    timer.unref();
    turnTimers.set(lobbyId, timer);
  }

  function cancelHostGrace(lobbyId: string) {
    const timer = hostGraceTimers.get(lobbyId);
    if (timer) clearTimeout(timer);
    hostGraceTimers.delete(lobbyId);
  }

  function terminateForHost(lobbyId: string) {
    clearTurnTimer(lobbyId);
    const ended = lobbyStore.terminateLobby(lobbyId, 'host_disconnected');
    logMultiplayer('race.end', {
      lobbyId,
      reason: 'host_disconnected',
      revision: ended.revision,
      turnIndex: ended.race?.turnIndex ?? null
    });
    broadcast(lobbyId, 'race.ended', { reason: 'host_disconnected', lobby: toPublicLobby(ended) });
    closeLobbySockets(lobbyId, 4001, 'host_disconnected');
  }

  // The host's last socket closed (often just a page reload): give them time to come back.
  function startHostGrace(lobbyId: string) {
    cancelHostGrace(lobbyId);
    if (closing) return;
    const timer = setTimeout(() => {
      hostGraceTimers.delete(lobbyId);
      const lobby = lobbyStore.getLobby(lobbyId);
      if (!lobby || lobby.status === 'FINISHED') return;
      terminateForHost(lobbyId);
    }, hostGraceMs);
    timer.unref();
    hostGraceTimers.set(lobbyId, timer);
  }

  // After an applied turn: tell everyone, and close the race when someone won.
  function announceTurn(lobby: Lobby, event: AppliedTurnEvent) {
    armTurnTimer(lobby.lobbyId);
    broadcast(lobby.lobbyId, 'turn.applied', event);
    broadcast(lobby.lobbyId, 'race.state', toPublicLobby(lobby));
    const winnerCarId = lobby.race?.engine.winnerCarId ?? null;
    if (winnerCarId !== null) {
      logMultiplayer('race.end', {
        lobbyId: lobby.lobbyId,
        reason: 'race_finished',
        winnerCarId,
        revision: lobby.revision,
        turnIndex: lobby.race?.turnIndex ?? null
      });
      broadcast(lobby.lobbyId, 'race.ended', {
        reason: 'race_finished',
        winnerCarId,
        lobby: toPublicLobby(lobby)
      });
    }
  }

  // Plays one turn for the active seat with a bot policy and announces it. Bots play at their own
  // level (the lobby's botLevel); the turn timer and the host's force-skip hand a human seat to
  // the "autopilot".
  function playBotTurnFor(
    lobbyId: string,
    policy: BotPolicy | undefined,
    source: 'bot' | 'timeout' | 'force_skip'
  ): boolean {
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby || lobby.status !== 'IN_RACE' || !lobby.race) return false;
    const activeSeat = lobbyStore.getActiveRaceSeat(lobbyId);
    if (!activeSeat) return false;

    const decision = lobbyStore.decideBotTurn(lobbyId, policy);
    const applied = lobbyStore.applyTurnAction(lobbyId, decision.action);
    if (!applied.ok) {
      // The shared heuristic only proposes legal actions; stop rather than spin.
      logMultiplayer('turn.bot.rejected', {
        lobbyId,
        seatIndex: activeSeat.seatIndex,
        source,
        reason: applied.reason
      });
      return false;
    }
    const updatedLobby = lobbyStore.incrementRevision(lobbyId);
    const playerId = activeSeat.playerId ?? `BOT${activeSeat.seatIndex + 1}`;
    const clientCommandId = `${source}-${updatedLobby.revision}-${activeSeat.seatIndex}`;
    announceTurn(updatedLobby, {
      ok: true,
      lobbyId,
      playerId,
      clientCommandId,
      revision: updatedLobby.revision,
      applied: decision.action,
      source,
      seatIndex: activeSeat.seatIndex
    });
    logMultiplayer('turn.bot.applied', {
      lobbyId,
      playerId,
      seatIndex: activeSeat.seatIndex,
      source,
      revision: updatedLobby.revision,
      turnIndex: updatedLobby.race?.turnIndex ?? null,
      clientCommandId,
      activeSeatIndex: seatOf(updatedLobby),
      applied: decision.action,
      botTrace: {
        selectedCellId: decision.trace?.selectedCellId ?? null,
        lowResources: decision.trace?.lowResources ?? null,
        candidates: decision.trace?.candidates.length ?? 0
      },
      raceSummary: summarizeRaceState(lobbyId)
    });
    return true;
  }

  // Hard bots simulate a round per candidate (a few ms each, more with many cars), so give the
  // event loop a turn between bots instead of playing them all in one go.
  async function runPendingBotTurns(lobbyId: string) {
    while (lobbyStore.getActiveRaceSeat(lobbyId)?.isBot) {
      if (!playBotTurnFor(lobbyId, undefined, 'bot')) return;
      if (lobbyStore.getLobby(lobbyId)?.settings.botLevel === 'hard') {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof LobbyError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: 'invalid_request', issues: error.issues });
      return;
    }
    // Fastify's own 4xx (body too large, bad JSON) and the rate limiter's 429.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      reply.code(status).send({ error: status === 429 ? 'rate_limited' : 'bad_request' });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: 'internal_error' });
  });

  // Frames are only ever ignored (there is no inbound message handler), so a small cap is plenty.
  await app.register(websocket, { options: { maxPayload: 1024 } });

  // shortcut: in-memory counters, right for the one instance we run; several instances need a shared store (Redis).
  const rateLimitEnabled = config.RATE_LIMIT_ENABLED ?? false;
  if (rateLimitEnabled) {
    await app.register(rateLimit, { global: false });
  }
  // Per IP and minute; sized above what several players behind one router do (see issue #69).
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  app.get('/health', async () => ({
    ok: true,
    lobbies: lobbyStore.count(),
    sha: config.GIT_SHA ?? 'unknown'
  }));

  app.post(`${API_V1_PREFIX}/lobbies`, { config: limit(10) }, async (request, reply) => {
    const body = createLobbySchema.parse(request.body);
    const { lobby, host } = lobbyStore.createLobby(body.name, toSettingsPatch(body.settings));
    const publicLobby = toPublicLobby(lobby);
    logMultiplayer('lobby.create', {
      lobbyId: lobby.lobbyId,
      playerId: host.playerId,
      seatIndex: host.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.race?.turnIndex ?? null,
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    return reply.code(201).send({
      lobby: publicLobby,
      playerId: host.playerId,
      playerToken: host.playerToken
    });
  });

  app.get(`${API_V1_PREFIX}/lobbies/:lobbyId`, { config: limit(240) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const query = lobbyReadQuerySchema.parse(request.query);
    const lobby = lobbyStore.getLobby(params.lobbyId);
    if (!lobby) {
      throw new LobbyError(404, `Lobby ${params.lobbyId} not found.`);
    }

    const player = lobbyStore.findPlayerByToken(lobby, query.playerToken);
    if (!player) {
      logMultiplayer('lobby.read.rejected', {
        lobbyId: params.lobbyId,
        tokenFingerprint: tokenFingerprint(query.playerToken),
        reason: 'invalid_token'
      });
      throw new LobbyError(401, 'Invalid player token for this lobby.');
    }

    logMultiplayer('lobby.read', {
      lobbyId: params.lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.race?.turnIndex ?? null
    });
    return {
      lobby: toPublicLobby(lobby),
      playerId: player.playerId
    };
  });

  // Also how a player reconnects.
  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/join`, { config: limit(30) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const body = joinLobbySchema.parse(request.body);
    const { lobby, player, isReconnect } = lobbyStore.joinLobby(
      params.lobbyId,
      body.name,
      body.playerToken
    );
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, 'lobby.state', publicLobby);
    logMultiplayer(isReconnect ? 'lobby.reconnect' : 'lobby.join', {
      lobbyId: lobby.lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.race?.turnIndex ?? null,
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

  app.patch(
    `${API_V1_PREFIX}/lobbies/:lobbyId/settings`,
    { config: limit(240) },
    async (request) => {
      const params = lobbyPathSchema.parse(request.params);
      const body = updateLobbySchema.parse(request.body);
      const lobby = lobbyStore.updateSettings(
        params.lobbyId,
        body.playerToken,
        toSettingsPatch(body.settings) ?? {}
      );
      const publicLobby = toPublicLobby(lobby);
      broadcast(lobby.lobbyId, 'lobby.state', publicLobby);
      logMultiplayer('lobby.settings.update', {
        lobbyId: lobby.lobbyId,
        revision: lobby.revision,
        turnIndex: lobby.race?.turnIndex ?? null,
        raceSummary: summarizeRaceState(lobby.lobbyId)
      });
      return { lobby: publicLobby };
    }
  );

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/start`, { config: limit(240) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const body = startRaceSchema.parse(request.body);
    const lobby = lobbyStore.startRace(params.lobbyId, body.playerToken);
    armTurnTimer(lobby.lobbyId);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, 'race.started', publicLobby);
    broadcast(lobby.lobbyId, 'race.state', publicLobby);
    logMultiplayer('race.start', {
      lobbyId: lobby.lobbyId,
      revision: lobby.revision,
      turnIndex: lobby.race?.turnIndex ?? null,
      activeSeatIndex: seatOf(lobby),
      raceSummary: summarizeRaceState(lobby.lobbyId)
    });
    await runPendingBotTurns(lobby.lobbyId);
    return { lobby: toPublicLobby(lobby) };
  });

  app.post(`${API_V1_PREFIX}/lobbies/:lobbyId/reset`, { config: limit(240) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const body = resetLobbySchema.parse(request.body);
    const lobby = lobbyStore.resetLobby(params.lobbyId, body.playerToken);
    clearTurnTimer(lobby.lobbyId);
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, 'lobby.state', publicLobby);
    logMultiplayer('lobby.reset', {
      lobbyId: lobby.lobbyId,
      revision: lobby.revision
    });
    return { lobby: publicLobby };
  });

  // Host only: the host plays one autopilot turn for a stuck human seat.
  app.post(
    `${API_V1_PREFIX}/lobbies/:lobbyId/force-skip`,
    { config: limit(240) },
    async (request) => {
      const params = lobbyPathSchema.parse(request.params);
      const body = forceSkipSchema.parse(request.body);
      const lobby = lobbyStore.getLobby(params.lobbyId);
      if (!lobby) {
        throw new LobbyError(404, `Lobby ${params.lobbyId} not found.`);
      }
      const host = lobbyStore.findPlayerByToken(lobby, body.playerToken);
      if (!host) {
        throw new LobbyError(401, 'Invalid player token for this lobby.');
      }
      if (!host.isHost) {
        throw new LobbyError(403, 'Only host can force-skip a turn.');
      }
      const activeSeat = lobbyStore.getActiveRaceSeat(lobby.lobbyId);
      if (lobby.status !== 'IN_RACE' || !activeSeat || activeSeat.isBot) {
        throw new LobbyError(409, 'Force-skip needs a running race with a human seat to play.');
      }
      if (body.revision !== undefined && body.revision !== lobby.revision) {
        throw new LobbyError(409, 'The race moved on; nothing was skipped.');
      }
      playBotTurnFor(lobby.lobbyId, 'autopilot', 'force_skip');
      await runPendingBotTurns(lobby.lobbyId);
      return { lobby: toPublicLobby(lobby) };
    }
  );

  app.post(
    `${API_V1_PREFIX}/lobbies/:lobbyId/chat`,
    { config: limit(60) },
    async (request, reply) => {
      const params = lobbyPathSchema.parse(request.params);
      const body = chatSchema.parse(request.body);
      const message = lobbyStore.addChatMessage(params.lobbyId, body.playerToken, body.text);
      broadcast(params.lobbyId, 'chat.message', message);
      return reply.code(201).send({ message });
    }
  );

  app.post(
    `${API_V1_PREFIX}/lobbies/:lobbyId/turns`,
    { config: limit(240) },
    async (request, reply) => {
      const params = lobbyPathSchema.parse(request.params);
      const body = submitTurnSchema.parse(request.body);
      const lobby = lobbyStore.getLobby(params.lobbyId);
      if (!lobby) {
        throw new LobbyError(404, `Lobby ${params.lobbyId} not found.`);
      }
      const player = lobbyStore.findPlayerByToken(lobby, body.playerToken);
      if (!player) {
        logMultiplayer('turn.submit.rejected', {
          lobbyId: params.lobbyId,
          clientCommandId: body.clientCommandId,
          tokenFingerprint: tokenFingerprint(body.playerToken),
          reason: 'invalid_token'
        });
        throw new LobbyError(401, 'Invalid player token for this lobby.');
      }

      const dedupeKey = `${player.playerId}:${body.clientCommandId}`;
      const lobbyDeduped =
        dedupedResults.get(lobby.lobbyId) ?? new Map<string, TurnCommandResult>();
      dedupedResults.set(lobby.lobbyId, lobbyDeduped);
      const deduped = lobbyDeduped.get(dedupeKey);
      if (deduped) {
        logMultiplayer('turn.submit.deduped', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: deduped.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId
        });
        return deduped;
      }

      let result: TurnCommandResult;
      if (lobby.status !== 'IN_RACE') {
        result = {
          ok: false,
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          clientCommandId: body.clientCommandId,
          revision: lobby.revision,
          error: 'lobby_not_in_race'
        };
        lobbyDeduped.set(dedupeKey, result);
        logMultiplayer('turn.submit.rejected', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: lobby.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId,
          reason: 'lobby_not_in_race'
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
          error: 'stale_revision'
        };
        lobbyDeduped.set(dedupeKey, result);
        logMultiplayer('turn.submit.rejected', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: lobby.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId,
          reason: 'stale_revision',
          expectedRevision: lobby.revision,
          receivedRevision: body.revision,
          raceSummary: summarizeRaceState(lobby.lobbyId)
        });
        return reply.code(409).send(result);
      }

      const activeSeat = lobbyStore.getActiveRaceSeat(lobby.lobbyId);
      if (!activeSeat || activeSeat.playerId !== player.playerId) {
        result = {
          ok: false,
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          clientCommandId: body.clientCommandId,
          revision: lobby.revision,
          error: 'not_active_player'
        };
        lobbyDeduped.set(dedupeKey, result);
        logMultiplayer('turn.submit.rejected', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: lobby.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId,
          reason: 'not_active_player',
          activeSeatIndex: seatOf(lobby),
          raceSummary: summarizeRaceState(lobby.lobbyId)
        });
        return reply.code(409).send(result);
      }

      // The shared race engine validates the move against the real rules.
      const applied = lobbyStore.applyTurnAction(lobby.lobbyId, body.action);
      if (!applied.ok) {
        result = {
          ok: false,
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          clientCommandId: body.clientCommandId,
          revision: lobby.revision,
          error: 'invalid_action',
          reason: applied.reason
        };
        lobbyDeduped.set(dedupeKey, result);
        logMultiplayer('turn.submit.rejected', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: lobby.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId,
          reason: 'invalid_action',
          engineReason: applied.reason,
          action: body.action.type
        });
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
      lobbyDeduped.set(dedupeKey, result);
      announceTurn(updatedLobby, result);
      logMultiplayer('turn.submit.applied', {
        lobbyId: lobby.lobbyId,
        playerId: player.playerId,
        seatIndex: player.seatIndex,
        revision: updatedLobby.revision,
        turnIndex: updatedLobby.race?.turnIndex ?? null,
        clientCommandId: body.clientCommandId,
        activeSeatIndex: seatOf(updatedLobby),
        raceSummary: summarizeRaceState(lobby.lobbyId)
      });
      await runPendingBotTurns(lobby.lobbyId);
      return result;
    }
  );

  app.get('/ws', { websocket: true, config: limit(240) }, (socket, request) => {
    const ws = socket as LobbySocket;
    const wsConnId = `ws-${wsConnectionSeq++}`;
    const query = wsQuerySchema.safeParse(request.query);
    if (!query.success) {
      logMultiplayer('ws.connect.rejected', {
        wsConnId,
        reason: 'invalid_query'
      });
      ws.close(1008, 'invalid_query');
      return;
    }

    const { lobbyId, playerToken } = query.data;
    const lobby = lobbyStore.getLobby(lobbyId);
    if (!lobby) {
      logMultiplayer('ws.connect.rejected', {
        wsConnId,
        lobbyId,
        tokenFingerprint: tokenFingerprint(playerToken),
        reason: 'unknown_lobby'
      });
      ws.close(1008, 'unknown_lobby');
      return;
    }
    const player = lobbyStore.findPlayerByToken(lobby, playerToken);
    if (!player) {
      logMultiplayer('ws.connect.rejected', {
        wsConnId,
        lobbyId,
        tokenFingerprint: tokenFingerprint(playerToken),
        reason: 'invalid_token'
      });
      ws.close(1008, 'invalid_token');
      return;
    }

    addSocket(lobbyId, player.playerId, ws);
    const wasConnected = player.connected;
    lobbyStore.setPlayerConnected(lobbyId, playerToken, true);
    if (player.isHost) cancelHostGrace(lobbyId);
    logMultiplayer('ws.open', {
      wsConnId,
      lobbyId,
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      revision: lobby.revision,
      turnIndex: lobby.race?.turnIndex ?? null
    });
    const publicLobby = toPublicLobby(lobby);
    if (wasConnected) {
      ws.send(JSON.stringify({ event: 'lobby.state', payload: publicLobby }));
    } else {
      // Everyone (this socket included) learns the player is back.
      broadcast(lobbyId, 'lobby.state', publicLobby);
    }
    if (publicLobby.raceState !== undefined) {
      ws.send(JSON.stringify({ event: 'race.state', payload: publicLobby }));
    }
    // This socket only: the others have seen these as they came.
    ws.send(JSON.stringify({ event: 'chat.history', payload: { messages: lobby.chat } }));

    ws.on('close', () => {
      // A newer socket of the same player (reload/reconnect) keeps them connected.
      if (removeSocket(lobbyId, player.playerId, ws) > 0) {
        logMultiplayer('ws.close', {
          wsConnId,
          lobbyId,
          playerId: player.playerId,
          stillConnected: true
        });
        return;
      }
      try {
        const result = lobbyStore.setPlayerConnected(lobbyId, playerToken, false);
        logMultiplayer('ws.close', {
          wsConnId,
          lobbyId,
          playerId: result.player.playerId,
          seatIndex: result.player.seatIndex,
          revision: result.lobby.revision,
          turnIndex: result.lobby.race?.turnIndex ?? null
        });
        broadcast(lobbyId, 'lobby.state', toPublicLobby(result.lobby));
        if (result.player.isHost && result.lobby.status !== 'FINISHED') {
          startHostGrace(lobbyId);
        }
      } catch {
        // Lobby may already be gone; ignore close handling errors.
      }
    });
  });

  // A lobby nobody is connected to is dead weight once it is idle (or finished a while ago). One with an
  // open socket is never reaped.
  function reapDeadLobbies() {
    const now = Date.now();
    for (const lobby of lobbyStore.allLobbies()) {
      const { lobbyId } = lobby;
      if (socketsByLobby.has(lobbyId)) continue;
      const maxIdleMs =
        lobby.status === 'FINISHED' ? Math.min(FINISHED_LINGER_MS, lobbyIdleMs) : lobbyIdleMs;
      if (now - lobby.updatedAt <= maxIdleMs) continue;
      clearTurnTimer(lobbyId);
      cancelHostGrace(lobbyId);
      dedupedResults.delete(lobbyId);
      lobbyStore.deleteLobby(lobbyId);
      logMultiplayer('lobby.reaped', {
        lobbyId,
        status: lobby.status,
        idleMs: now - lobby.updatedAt
      });
    }
  }

  const reaper = setInterval(reapDeadLobbies, REAP_INTERVAL_MS);
  reaper.unref();

  // preClose runs before the sockets are torn down, so closing them cannot start new timers.
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(reaper);
    for (const lobbyId of [...turnTimers.keys()]) clearTurnTimer(lobbyId);
    for (const lobbyId of [...hostGraceTimers.keys()]) cancelHostGrace(lobbyId);
  });

  return app;
}

async function bootstrap() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ host: config.HOST, port: config.PORT });

  // As PID 1 in a container, Node ignores SIGTERM unless it handles it; without
  // this `podman stop` waits for the force-kill timeout.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().finally(() => process.exit(0));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap();
}
