// The realtime parts of the server (#212): the socket registry, the turn timer, the host's grace period, the bot-turn
// loop, the reaper and the heartbeat. They share state, so they live in one factory; `createApp` owns the routes and
// calls it. Nothing here knows about HTTP, so a test builds one around a `LobbyStore` and mock timers.
import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_HOST_GRACE_SECONDS,
  DEFAULT_LOBBY_IDLE_SECONDS,
  type BackendConfig
} from './config.js';
import { toPublicLobby, type LobbyStore } from './lobby_store.js';
import type { RaceStore } from './race_store.js';
import { MAX_LOGGED_ACTIONS } from '../../src/game/race/limits';
import { activeSeatIndex } from '../../src/game/race/race_engine';
import type { BotPolicy } from '../../src/game/systems/bot_system';
import type { Lobby, TurnSubmitAction } from './types.js';

const WS_OPEN = 1;
const REAP_INTERVAL_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
// A finished lobby only stays this long (after its last socket closes) for a late reload to see the results.
const FINISHED_LINGER_MS = 10 * 60_000;

export interface LobbySocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: 'close' | 'pong', listener: () => void): void;
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

export interface RealtimeOptions {
  lobbyStore: LobbyStore;
  raceStore: RaceStore;
  config: Pick<
    BackendConfig,
    'TURN_TIMER_TIME_SCALE' | 'HOST_GRACE_SECONDS' | 'LOBBY_IDLE_SECONDS'
  >;
  log: FastifyBaseLogger;
  // How often every socket is pinged (default 30 s); one that has not answered the last ping is dropped. For tests.
  pingIntervalMs?: number;
  // A lobby was reaped: drop what else is kept per lobby.
  onReap?: (lobbyId: string) => void;
}

export function seatOf(lobby: Lobby) {
  return lobby.race ? activeSeatIndex(lobby.race.engine) : null;
}

export function createRealtime(options: RealtimeOptions) {
  const { lobbyStore, raceStore, config, log } = options;
  const timeScale = config.TURN_TIMER_TIME_SCALE ?? 1;
  const hostGraceMs = (config.HOST_GRACE_SECONDS ?? DEFAULT_HOST_GRACE_SECONDS) * 1000;
  const lobbyIdleMs = (config.LOBBY_IDLE_SECONDS ?? DEFAULT_LOBBY_IDLE_SECONDS) * 1000;
  // lobby -> player -> open sockets. A player is connected while at least one socket is open,
  // so an old socket closing after a reconnect does not mark a live player as gone.
  const socketsByLobby = new Map<string, Map<string, Set<LobbySocket>>>();
  const turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hostGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Sockets that have not answered the last ping.
  const unanswered = new WeakSet<LobbySocket>();
  let closing = false;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function logMultiplayer(event: string, context: Record<string, unknown>) {
    log.info({ event, ...context }, 'multiplayer_event');
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

  function addSocket(lobbyId: string, playerId: string, socket: LobbySocket) {
    const players = socketsByLobby.get(lobbyId) ?? new Map<string, Set<LobbySocket>>();
    const sockets = players.get(playerId) ?? new Set<LobbySocket>();
    sockets.add(socket);
    players.set(playerId, sockets);
    socketsByLobby.set(lobbyId, players);
    socket.on('pong', () => unanswered.delete(socket));
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
    const turnIndex = lobby.race?.turnIndex;
    lobbyStore.setTurnDeadline(lobbyId, Date.now() + delayMs);
    const timer = setTimeout(() => {
      turnTimers.delete(lobbyId);
      const current = lobbyStore.getLobby(lobbyId);
      // A turn played since arming already re-armed (or cleared) the timer. A grid setup is not a turn.
      if (!current || current.status !== 'IN_RACE' || current.race?.turnIndex !== turnIndex) return;
      logMultiplayer('turn.timeout', {
        lobbyId,
        revision: current.revision,
        seatIndex: seat.seatIndex
      });
      // A throw in a timer is not caught by Fastify and would end the process, and every lobby with it.
      try {
        playBotTurnFor(lobbyId, 'autopilot', 'timeout');
      } catch (error) {
        log.error({ err: error, lobbyId }, 'turn timer: autopilot turn failed');
        return;
      }
      runPendingBotTurns(lobbyId).catch((error: unknown) => {
        log.error({ err: error, lobbyId }, 'turn timer: bot turns failed');
      });
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
    // A grid setup does not end the turn: the same player plays on, and their timer keeps running (#141).
    if (event.applied.type !== 'setup') armTurnTimer(lobby.lobbyId);
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
      storeOnlineRace(lobby, winnerCarId);
    }
  }

  // The history keeps every finished online race (#170). After the broadcast and never awaited: a database that is waking
  // up must not delay anyone, and a failure only loses a history entry.
  function storeOnlineRace(lobby: Lobby, winnerCarId: number) {
    const race = lobby.race;
    if (!race || race.stored) return;
    race.stored = true;
    // The row's size is bounded by its actions, not by the table's row cap (#211).
    if (race.log.actions.length > MAX_LOGGED_ACTIONS) {
      log.warn(
        { lobbyId: lobby.lobbyId, actions: race.log.actions.length },
        'race history: online race too long to store'
      );
      return;
    }
    raceStore
      .insert({
        source: 'online',
        trackId: lobby.settings.trackId,
        log: race.log,
        winnerCarId
      })
      .catch((error: unknown) => {
        log.warn({ err: error, lobbyId: lobby.lobbyId }, 'race history: online race not stored');
      });
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
      options.onReap?.(lobbyId);
      lobbyStore.deleteLobby(lobbyId);
      logMultiplayer('lobby.reaped', {
        lobbyId,
        status: lobby.status,
        idleMs: now - lobby.updatedAt
      });
    }
  }

  // A phone that drops off (a tunnel, a closed lid) sends no close frame: without a ping its socket would stay "open",
  // the player "connected", the host's grace period would never start and the reaper would never take the lobby.
  function pingSockets() {
    for (const players of socketsByLobby.values()) {
      for (const sockets of players.values()) {
        for (const socket of sockets) {
          if (unanswered.has(socket)) {
            socket.terminate(); // its close handler does the rest
            continue;
          }
          unanswered.add(socket);
          try {
            socket.ping();
          } catch {
            // The close handler drops it.
          }
        }
      }
    }
  }

  function start() {
    reaper = setInterval(reapDeadLobbies, REAP_INTERVAL_MS);
    reaper.unref();
    heartbeat = setInterval(pingSockets, options.pingIntervalMs ?? PING_INTERVAL_MS);
    heartbeat.unref();
  }

  // Called before the sockets are torn down, so closing them cannot start new timers.
  function stop() {
    closing = true;
    clearInterval(reaper);
    clearInterval(heartbeat);
    for (const lobbyId of [...turnTimers.keys()]) clearTurnTimer(lobbyId);
    for (const lobbyId of [...hostGraceTimers.keys()]) cancelHostGrace(lobbyId);
  }

  return {
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
    reapDeadLobbies,
    start,
    stop
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
