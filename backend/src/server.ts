import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DEFAULT_MAX_LOBBIES, loadConfig, type BackendConfig } from './config.js';
import { deviceHash, mintDeviceToken, verifyDeviceToken } from './device_token.js';
import { LobbyError, LobbyStore, toPublicLobby } from './lobby_store.js';
import { createRaceStore, type RaceStore } from './race_store.js';
import { createRealtime, seatOf, type LobbySocket } from './realtime.js';
import { getRaceContext } from './tracks.js';
import { must } from '../../src/game/must';
import { MAX_LOGGED_ACTIONS, MAX_RACE_LAPS } from '../../src/game/race/limits';
import { replayEnd, type RaceLog } from '../../src/game/race/race_log';
import { RULES_VERSIONS } from '../../src/game/rules/ids';
import { MAX_SEED } from '../../src/game/systems/bot_style';
import { BOT_LEVEL_CHOICES, type LobbySettings, type TurnCommandResult } from './types.js';

const API_V1_PREFIX = '/api/v1';

// A resent command id gets its first answer back (a lost response, a double tap); only the newest ones are worth keeping.
export const MAX_DEDUPED_RESULTS = 200;

class RecentResults extends Map<string, TurnCommandResult> {
  override set(key: string, value: TurnCommandResult): this {
    super.set(key, value);
    if (this.size > MAX_DEDUPED_RESULTS) this.delete(must(this.keys().next().value, 'oldest key'));
    return this;
  }
}

// The player token travels in the URL of the WebSocket (a browser cannot set headers on one) and, for a page from before
// #194 step 3, of the lobby read; keep it out of the request log.
export function redactTokens(url: string): string {
  return url.replace(/([?&]playerToken=)[^&#]*/g, '$1[redacted]');
}

interface CreateAppOptions {
  logger?: boolean;
  // Where the request log goes (default stdout); lets a test read what is logged.
  logStream?: { write(line: string): void };
  // Lets tests set up lobby state directly (e.g. park a car in the pit lane).
  lobbyStore?: LobbyStore;
  // The race history (#170); default: Postgres when DATABASE_URL is set, memory otherwise.
  raceStore?: RaceStore;
  // How often every socket is pinged (default 30 s); one that has not answered the last ping is dropped. For tests.
  pingIntervalMs?: number;
}

const lobbySettingsPatchSchema = z.object({
  trackId: z.string().min(1).optional(),
  totalCars: z.number().int().min(1).max(11).optional(),
  humanCars: z.number().int().min(0).max(11).optional(),
  botCars: z.number().int().min(0).max(11).optional(),
  raceLaps: z.number().int().min(1).max(MAX_RACE_LAPS).optional(),
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

// The player's token (#194 step 3) comes in `Authorization: Bearer`. The body or query field of the schemas below still
// works for one release, for a page loaded before the deploy; then those fields and `playerTokenOf`'s second argument go.
const optionalPlayerTokenSchema = playerTokenSchema.optional();

interface BearerRequest {
  headers: { authorization?: string | undefined };
}

// `Authorization: Bearer <token>`: the device token (#194) and the player token.
function bearerOf(request: BearerRequest): string | undefined {
  return /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
}

// The header wins; `fromBodyOrQuery` is the one-release fallback. No token, or one that is too long, is a 401 like a token
// the lobby does not know.
function playerTokenOf(request: BearerRequest, fromBodyOrQuery: string | undefined): string {
  const token = bearerOf(request) ?? fromBodyOrQuery;
  if (!token || !playerTokenSchema.safeParse(token).success) {
    throw new LobbyError(401, 'A player token is required.');
  }
  return token;
}

const createLobbySchema = z.object({
  name: playerNameSchema,
  settings: lobbySettingsPatchSchema.optional()
});

const joinLobbySchema = z.object({
  name: playerNameSchema.optional(),
  playerToken: optionalPlayerTokenSchema
});

const renamePlayerSchema = z.object({
  playerToken: optionalPlayerTokenSchema,
  name: playerNameSchema
});

const updateLobbySchema = z.object({
  playerToken: optionalPlayerTokenSchema,
  settings: lobbySettingsPatchSchema
});

// No body at all is fine now: the token is in the header.
const startRaceSchema = z.object({
  playerToken: optionalPlayerTokenSchema
});

const resetLobbySchema = startRaceSchema;

const forceSkipSchema = z.object({
  playerToken: optionalPlayerTokenSchema,
  // The revision the host saw; refuses the skip if the stuck player moved in the meantime.
  revision: z.number().int().min(0).optional()
});

// Shape only; the race engine enforces the PSI limits and every game rule.
// `medium` and `fuelLoad` exist from rules v3 on; the engine refuses them on older rules.
const carSetupSchema = z.object({
  compound: z.enum(['soft', 'medium', 'hard']),
  psi: z.object({ fl: z.number(), fr: z.number(), rl: z.number(), rr: z.number() }),
  wing: z.enum(['low', 'medium', 'high']),
  fuelLoad: z.number().int().optional()
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
  playerToken: optionalPlayerTokenSchema,
  clientCommandId: z.string().min(1).max(64),
  revision: z.number().int().min(0),
  action: turnActionSchema
});

// A race log sent by a client (#170). Shape only; `replayRace` is the real check: the engine must accept every action.
// Bounds keep the replay's work small (a real 6-car, 12-lap race is about 300 actions).
const raceLogSchema = z.object({
  seats: z
    .array(
      z.object({
        isBot: z.boolean(),
        ownerId: z.string().max(64),
        botLevel: z.enum(BOT_LEVEL_CHOICES).optional()
      })
    )
    .min(1)
    .max(11),
  raceLaps: z.number().int().min(1).max(MAX_RACE_LAPS),
  seed: z.number().int().min(0).max(MAX_SEED),
  rulesVersion: z.enum(RULES_VERSIONS),
  actions: z.array(turnActionSchema).max(MAX_LOGGED_ACTIONS)
});

const uploadRaceSchema = z.object({
  trackId: z.string().min(1).max(64).default('oval16_3lanes'),
  log: raceLogSchema
});

const raceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const racePathSchema = z.object({ raceId: z.string().min(1).max(64) });

const chatSchema = z.object({
  playerToken: optionalPlayerTokenSchema,
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
  playerToken: optionalPlayerTokenSchema
});

export async function createApp(config: BackendConfig, options: CreateAppOptions = {}) {
  // A hop count trusts that many proxies in front of us (Fastify's own number support is not in its types).
  const trustProxyConfig = config.TRUST_PROXY ?? false;
  const trustProxy =
    typeof trustProxyConfig === 'number'
      ? (_address: string, hop: number) => hop < trustProxyConfig
      : trustProxyConfig;
  const clientIpHeader = config.CLIENT_IP_HEADER?.toLowerCase();
  // The client's address: the edge's header when one is configured and holds an IP, else what trustProxy made of the socket.
  function clientIpOf(request: { ip: string; headers: IncomingHttpHeaders }): string {
    if (!clientIpHeader) return request.ip;
    const value = request.headers[clientIpHeader];
    const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
    return first && isIP(first) ? first : request.ip;
  }
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
                remoteAddress: clientIpOf(request)
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
  const raceStore =
    options.raceStore ?? createRaceStore(config.DATABASE_URL, config.DATABASE_URL_UNPOOLED);
  app.addHook('onClose', async () => {
    await raceStore.close();
  });
  const deviceSecret = config.DEVICE_TOKEN_SECRET ?? randomBytes(32).toString('hex');
  if (!config.DEVICE_TOKEN_SECRET) {
    app.log.warn('DEVICE_TOKEN_SECRET is not set: device tokens will not survive a restart.');
  }
  // lobby -> "player:clientCommandId" -> result. Dropped with the lobby when it is reaped.
  const dedupedResults = new Map<string, Map<string, TurnCommandResult>>();
  // Sockets, timers, the bot loop, the reaper and the heartbeat (#212).
  const {
    logMultiplayer,
    summarizeRaceState,
    addSocket,
    removeSocket,
    broadcast,
    armTurnTimer,
    clearTurnTimer,
    startHostGrace,
    cancelHostGrace,
    playBotTurnFor,
    runPendingBotTurns,
    announceTurn,
    start: startRealtime,
    stop: stopRealtime
  } = createRealtime({
    lobbyStore,
    raceStore,
    config,
    log: app.log,
    ...(options.pingIntervalMs !== undefined ? { pingIntervalMs: options.pingIntervalMs } : {}),
    onReap: (lobbyId) => dedupedResults.delete(lobbyId)
  });
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

  // Mints and uploads per IP (#194), so a script filling the history shows in the logs; #205 waits on these.
  function logHistory(
    event: string,
    request: { ip: string; headers: IncomingHttpHeaders },
    context: Record<string, unknown> = {}
  ) {
    app.log.info({ event, ip: clientIpOf(request), ...context }, 'history_event');
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

  app.setErrorHandler((error, request, reply) => {
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
      // A 429 on the mint is the first signal #205 waits on (an IP at its 20 a day).
      if (status === 429 && request.url.startsWith(`${API_V1_PREFIX}/devices`)) {
        logHistory('device.mint_limited', request);
      }
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
    await app.register(rateLimit, { global: false, keyGenerator: clientIpOf });
  }
  // Per IP and minute; sized above what several players behind one router do (see issue #69).
  const limit = (max: number, timeWindow = '1 minute') => ({ rateLimit: { max, timeWindow } });

  // The uploader's device (#194): a token this server signed, in `Authorization: Bearer`. What the history keeps is the hash.
  function deviceOf(request: BearerRequest): string {
    const token = bearerOf(request);
    const id = token ? verifyDeviceToken(deviceSecret, token) : null;
    if (!id) throw new LobbyError(401, 'A device token is required.');
    return deviceHash(id);
  }

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

  // The log of the finished race (#169); 409 until somebody has won. Fetched once, at the end of the race.
  app.get(`${API_V1_PREFIX}/lobbies/:lobbyId/recap`, { config: limit(60) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const query = lobbyReadQuerySchema.parse(request.query);
    return lobbyStore.getRaceRecap(params.lobbyId, playerTokenOf(request, query.playerToken));
  });

  app.get(`${API_V1_PREFIX}/lobbies/:lobbyId`, { config: limit(240) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const query = lobbyReadQuerySchema.parse(request.query);
    const playerToken = playerTokenOf(request, query.playerToken);
    const { lobby, player } = lobbyStore.requirePlayer(params.lobbyId, playerToken, () =>
      logMultiplayer('lobby.read.rejected', {
        lobbyId: params.lobbyId,
        tokenFingerprint: tokenFingerprint(playerToken),
        reason: 'invalid_token'
      })
    );

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
    // A reconnect carries its token, a new player none; too long a token is refused like any other field.
    const { lobby, player, isReconnect } = lobbyStore.joinLobby(
      params.lobbyId,
      body.name,
      optionalPlayerTokenSchema.parse(bearerOf(request) ?? body.playerToken)
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

  // An anonymous device identity (#194): no account, so this only raises the cost of filling the history. A person needs one
  // token, ever; the per-IP day limit is what bounds how many a script can make.
  app.post(`${API_V1_PREFIX}/devices`, { config: limit(20, '1 day') }, async (request, reply) => {
    logHistory('device.mint', request);
    return reply.code(201).send({ deviceToken: mintDeviceToken(deviceSecret) });
  });

  // The race history (#170). Anonymous: nothing identifies who raced. A solo race is uploaded by its player (opt-in) with a
  // device token (#194); the server replays the log first, so only races the engine accepts are kept.
  app.post(
    `${API_V1_PREFIX}/races`,
    { config: limit(10), bodyLimit: 128 * 1024 },
    async (request, reply) => {
      const device = deviceOf(request);
      const body = uploadRaceSchema.parse(request.body);
      const ctx = getRaceContext(body.trackId);
      if (!ctx) throw new LobbyError(400, `Unknown track ${body.trackId}.`);
      // zod's optional is `T | undefined`, the engine's seat is `T` or absent
      const log: RaceLog = {
        ...body.log,
        seats: body.log.seats.map((seat) => ({
          isBot: seat.isBot,
          ownerId: seat.ownerId,
          ...(seat.botLevel ? { botLevel: seat.botLevel } : {})
        }))
      };
      let winnerCarId: number | null;
      try {
        winnerCarId = replayEnd(ctx, log).winnerCarId;
      } catch {
        throw new LobbyError(400, 'The race log does not replay on this track.');
      }
      if (winnerCarId === null) throw new LobbyError(400, 'The race is not finished.');
      try {
        const stored = await raceStore.insert({
          source: 'solo',
          trackId: body.trackId,
          log,
          winnerCarId,
          device
        });
        logHistory('race.upload', request, {
          device,
          duplicate: stored.duplicate,
          evicted: stored.evicted
        });
        return reply
          .code(stored.duplicate ? 200 : 201)
          .send({ id: stored.id, duplicate: stored.duplicate });
      } catch (error) {
        app.log.warn({ err: error }, 'race history: solo race not stored');
        throw new LobbyError(503, 'The race history is not available right now.');
      }
    }
  );

  app.get(`${API_V1_PREFIX}/races`, { config: limit(120) }, async (request) => {
    const query = raceListQuerySchema.parse(request.query);
    try {
      return { races: await raceStore.list(query.limit) };
    } catch {
      throw new LobbyError(503, 'The race history is not available right now.');
    }
  });

  app.get(`${API_V1_PREFIX}/races/:raceId`, { config: limit(120) }, async (request) => {
    const params = racePathSchema.parse(request.params);
    let race;
    try {
      race = await raceStore.get(params.raceId);
    } catch {
      throw new LobbyError(503, 'The race history is not available right now.');
    }
    if (!race) throw new LobbyError(404, 'Race not found.');
    return race;
  });

  // A rename, not a join: `/join` also marks the player connected and is the reconnect path.
  app.patch(`${API_V1_PREFIX}/lobbies/:lobbyId/player`, { config: limit(60) }, async (request) => {
    const params = lobbyPathSchema.parse(request.params);
    const body = renamePlayerSchema.parse(request.body);
    const lobby = lobbyStore.renamePlayer(
      params.lobbyId,
      playerTokenOf(request, body.playerToken),
      body.name
    );
    const publicLobby = toPublicLobby(lobby);
    broadcast(lobby.lobbyId, 'lobby.state', publicLobby);
    return { lobby: publicLobby };
  });

  app.patch(
    `${API_V1_PREFIX}/lobbies/:lobbyId/settings`,
    { config: limit(240) },
    async (request) => {
      const params = lobbyPathSchema.parse(request.params);
      const body = updateLobbySchema.parse(request.body);
      const lobby = lobbyStore.updateSettings(
        params.lobbyId,
        playerTokenOf(request, body.playerToken),
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
    const body = startRaceSchema.parse(request.body ?? {});
    const lobby = lobbyStore.startRace(params.lobbyId, playerTokenOf(request, body.playerToken));
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
    const body = resetLobbySchema.parse(request.body ?? {});
    const lobby = lobbyStore.resetLobby(params.lobbyId, playerTokenOf(request, body.playerToken));
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
      const body = forceSkipSchema.parse(request.body ?? {});
      const playerToken = playerTokenOf(request, body.playerToken);
      const lobby = lobbyStore.requireHost(
        params.lobbyId,
        playerToken,
        'Only host can force-skip a turn.'
      );
      const activeSeat = lobbyStore.getActiveRaceSeat(lobby.lobbyId);
      if (lobby.status !== 'IN_RACE' || !activeSeat || activeSeat.isBot) {
        throw new LobbyError(409, 'Force-skip needs a running race with a human seat to play.');
      }
      if (body.revision !== undefined && body.revision !== lobby.revision) {
        throw new LobbyError(409, 'The race moved on; nothing was skipped.');
      }
      if (!playBotTurnFor(lobby.lobbyId, 'autopilot', 'force_skip')) {
        throw new LobbyError(409, 'The autopilot could not play this turn; nothing was skipped.');
      }
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
      const message = lobbyStore.addChatMessage(
        params.lobbyId,
        playerTokenOf(request, body.playerToken),
        body.text
      );
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
      const playerToken = playerTokenOf(request, body.playerToken);
      const { lobby, player } = lobbyStore.requirePlayer(params.lobbyId, playerToken, () =>
        logMultiplayer('turn.submit.rejected', {
          lobbyId: params.lobbyId,
          clientCommandId: body.clientCommandId,
          tokenFingerprint: tokenFingerprint(playerToken),
          reason: 'invalid_token'
        })
      );

      const dedupeKey = `${player.playerId}:${body.clientCommandId}`;
      const lobbyDeduped = dedupedResults.get(lobby.lobbyId) ?? new RecentResults();
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

      // A refused command is remembered like an applied one, so a resend gets the same answer.
      const reject = (
        error: Extract<TurnCommandResult, { ok: false }>['error'],
        logExtra: Record<string, unknown> = {},
        reason?: Extract<TurnCommandResult, { ok: false }>['reason']
      ) => {
        const refused: TurnCommandResult = {
          ok: false,
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          clientCommandId: body.clientCommandId,
          revision: lobby.revision,
          error,
          ...(reason ? { reason } : {})
        };
        lobbyDeduped.set(dedupeKey, refused);
        logMultiplayer('turn.submit.rejected', {
          lobbyId: lobby.lobbyId,
          playerId: player.playerId,
          seatIndex: player.seatIndex,
          revision: lobby.revision,
          turnIndex: lobby.race?.turnIndex ?? null,
          clientCommandId: body.clientCommandId,
          reason: error,
          ...logExtra
        });
        return reply.code(409).send(refused);
      };

      if (lobby.status !== 'IN_RACE') return reject('lobby_not_in_race');

      if (body.revision !== lobby.revision) {
        return reject('stale_revision', {
          expectedRevision: lobby.revision,
          receivedRevision: body.revision,
          raceSummary: summarizeRaceState(lobby.lobbyId)
        });
      }

      const activeSeat = lobbyStore.getActiveRaceSeat(lobby.lobbyId);
      if (!activeSeat || activeSeat.playerId !== player.playerId) {
        return reject('not_active_player', {
          activeSeatIndex: seatOf(lobby),
          raceSummary: summarizeRaceState(lobby.lobbyId)
        });
      }

      // The shared race engine validates the move against the real rules.
      const applied = lobbyStore.applyTurnAction(lobby.lobbyId, body.action);
      if (!applied.ok) {
        return reject(
          'invalid_action',
          { engineReason: applied.reason, action: body.action.type },
          applied.reason
        );
      }

      const updatedLobby = lobbyStore.incrementRevision(lobby.lobbyId);
      const result: TurnCommandResult = {
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

  startRealtime();
  // preClose runs before the sockets are torn down, so closing them cannot start new timers.
  app.addHook('preClose', async () => {
    stopRealtime();
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
