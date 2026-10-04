import { randomUUID } from "node:crypto";
import {
  applyAction,
  createRace,
  decideBotAction,
  getActiveCar,
  type ApplyResult,
  type BotTurnDecision
} from "../../src/game/race/raceEngine";
import { getRaceContext, knownTrackIds } from "./tracks.js";
import type {
  Lobby,
  LobbyPlayer,
  RaceCarState,
  RaceSeatInfo,
  RaceState,
  ServerRace,
  TurnSubmitAction,
  LobbySettings,
  LobbyTerminationReason,
  PublicLobby,
  PublicLobbyPlayer
} from "./types.js";

const DEFAULT_SETTINGS: LobbySettings = {
  trackId: "oval16_3lanes",
  totalCars: 4,
  humanCars: 1,
  botCars: 3,
  raceLaps: 5
};

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeSettings(
  input: Partial<LobbySettings> | undefined,
  base = DEFAULT_SETTINGS
): LobbySettings {
  const trackId = input?.trackId?.trim() || base.trackId;
  if (!getRaceContext(trackId)) {
    throw new LobbyError(400, `Unknown trackId "${trackId}" (available: ${knownTrackIds().join(", ")}).`);
  }
  let humanCars = clampInt(input?.humanCars ?? base.humanCars, 0, 11);
  let botCars = clampInt(input?.botCars ?? base.botCars, 0, 11);

  if (humanCars + botCars === 0) {
    humanCars = 1;
    botCars = 0;
  }

  let totalCars = clampInt(input?.totalCars ?? humanCars + botCars, 1, 11);
  humanCars = Math.min(humanCars, totalCars);
  botCars = Math.min(botCars, totalCars - humanCars);
  totalCars = humanCars + botCars;

  const raceLaps = clampInt(input?.raceLaps ?? base.raceLaps, 1, 999);
  return { trackId, totalCars, humanCars, botCars, raceLaps };
}

function toPublicPlayer(player: LobbyPlayer): PublicLobbyPlayer {
  return {
    playerId: player.playerId,
    name: player.name,
    connected: player.connected,
    seatIndex: player.seatIndex,
    isHost: player.isHost
  };
}

function toPublicRaceState(lobby: Lobby): RaceState | undefined {
  const race = lobby.race;
  if (!race) return undefined;
  const { engine, seats } = race;
  return {
    trackId: lobby.settings.trackId,
    raceLaps: engine.raceLaps,
    turnIndex: race.turnIndex,
    activeSeatIndex: engine.turn.index,
    winnerCarId: engine.winnerCarId,
    cars: engine.cars.map((car, i): RaceCarState => ({ ...car, ...seats[i]! }))
  };
}

export function toPublicLobby(lobby: Lobby): PublicLobby {
  const publicLobby: PublicLobby = {
    lobbyId: lobby.lobbyId,
    status: lobby.status,
    hostPlayerId: lobby.hostPlayerId,
    createdAt: lobby.createdAt,
    updatedAt: lobby.updatedAt,
    revision: lobby.revision,
    settings: lobby.settings,
    players: lobby.players.map(toPublicPlayer)
  };

  if (lobby.terminationReason !== undefined) {
    publicLobby.terminationReason = lobby.terminationReason;
  }
  const raceState = toPublicRaceState(lobby);
  if (raceState !== undefined) {
    publicLobby.raceState = raceState;
  }

  return publicLobby;
}

export class LobbyError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export class LobbyStore {
  constructor(private readonly playerTokenTtlMs = Number.POSITIVE_INFINITY) {}

  private lobbies = new Map<string, Lobby>();

  count(): number {
    return this.lobbies.size;
  }

  getLobby(lobbyId: string): Lobby | undefined {
    return this.lobbies.get(lobbyId);
  }

  private getLobbyOrThrow(lobbyId: string): Lobby {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) {
      throw new LobbyError(404, `Lobby ${lobbyId} not found.`);
    }
    return lobby;
  }

  private findNextHumanSeat(lobby: Lobby): number {
    const used = new Set(lobby.players.map((p) => p.seatIndex));
    for (let seat = 0; seat < lobby.settings.humanCars; seat += 1) {
      if (!used.has(seat)) return seat;
    }
    throw new LobbyError(409, "No human seats remaining in lobby settings.");
  }

  private buildInitialRace(lobby: Lobby): ServerRace {
    const ctx = getRaceContext(lobby.settings.trackId);
    if (!ctx) {
      throw new LobbyError(400, `Unknown trackId "${lobby.settings.trackId}".`);
    }
    const playersBySeat = new Map<number, LobbyPlayer>();
    for (const player of lobby.players) {
      playersBySeat.set(player.seatIndex, player);
    }

    let botCounter = 0;
    const seats = Array.from({ length: lobby.settings.totalCars }, (_, seatIndex): RaceSeatInfo => {
      const player = playersBySeat.get(seatIndex);
      if (!player) botCounter += 1;
      return {
        seatIndex,
        playerId: player?.playerId ?? null,
        name: player?.name ?? `Bot ${botCounter}`
      };
    });

    const engine = createRace(
      ctx,
      seats.map((seat) => ({
        isBot: seat.playerId === null,
        ownerId: seat.playerId ?? `BOT${seat.seatIndex + 1}`
      })),
      lobby.settings.raceLaps
    );
    return { engine, seats, turnIndex: 0 };
  }

  findPlayerByToken(lobby: Lobby, playerToken: string): LobbyPlayer | undefined {
    const now = Date.now();
    return lobby.players.find((p) => {
      if (p.playerToken !== playerToken) return false;
      if (p.tokenRevoked) return false;
      return now - p.tokenIssuedAt <= this.playerTokenTtlMs;
    });
  }

  createLobby(
    hostName: string,
    rawSettings?: Partial<LobbySettings>
  ): { lobby: Lobby; host: LobbyPlayer } {
    const trimmedName = hostName.trim();
    if (trimmedName.length === 0) {
      throw new LobbyError(400, "Host name is required.");
    }

    const now = Date.now();
    const settings = normalizeSettings(rawSettings);
    if (settings.humanCars < 1) {
      throw new LobbyError(400, "humanCars must be >= 1 for a host seat.");
    }

    const lobbyId = randomUUID();
    const host: LobbyPlayer = {
      playerId: randomUUID(),
      name: trimmedName,
      connected: true,
      seatIndex: 0,
      isHost: true,
      playerToken: randomUUID(),
      tokenIssuedAt: now,
      tokenRevoked: false
    };

    const lobby: Lobby = {
      lobbyId,
      status: "WAITING",
      hostPlayerId: host.playerId,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      settings,
      players: [host]
    };

    this.lobbies.set(lobbyId, lobby);
    return { lobby, host };
  }

  joinLobby(
    lobbyId: string,
    name: string | undefined,
    playerToken: string | undefined
  ): { lobby: Lobby; player: LobbyPlayer; isReconnect: boolean } {
    const lobby = this.getLobbyOrThrow(lobbyId);
    if (playerToken) {
      const existing = this.findPlayerByToken(lobby, playerToken);
      if (!existing) {
        throw new LobbyError(401, "Invalid player token for this lobby.");
      }
      existing.connected = true;
      if (name?.trim()) {
        existing.name = name.trim();
      }
      lobby.updatedAt = Date.now();
      return { lobby, player: existing, isReconnect: true };
    }

    if (lobby.status !== "WAITING") {
      throw new LobbyError(409, "New players can only join while lobby is waiting.");
    }

    const trimmedName = name?.trim() ?? "";
    if (trimmedName.length === 0) {
      throw new LobbyError(400, "Player name is required for a new join.");
    }

    const playerCount = lobby.players.length;
    if (playerCount >= lobby.settings.humanCars) {
      throw new LobbyError(409, "Lobby human seats are full.");
    }

    const player: LobbyPlayer = {
      playerId: randomUUID(),
      name: trimmedName,
      connected: true,
      seatIndex: this.findNextHumanSeat(lobby),
      isHost: false,
      playerToken: randomUUID(),
      tokenIssuedAt: Date.now(),
      tokenRevoked: false
    };

    lobby.players.push(player);
    lobby.updatedAt = Date.now();
    return { lobby, player, isReconnect: false };
  }

  setPlayerConnected(
    lobbyId: string,
    playerToken: string,
    connected: boolean
  ): { lobby: Lobby; player: LobbyPlayer } {
    const lobby = this.getLobbyOrThrow(lobbyId);
    const player = this.findPlayerByToken(lobby, playerToken);
    if (!player) {
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }
    player.connected = connected;
    lobby.updatedAt = Date.now();
    return { lobby, player };
  }

  updateSettings(lobbyId: string, hostToken: string, patch: Partial<LobbySettings>): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    if (lobby.status !== "WAITING") {
      throw new LobbyError(409, "Cannot update settings after race start.");
    }

    const host = this.findPlayerByToken(lobby, hostToken);
    if (!host) {
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }
    if (!host.isHost) {
      throw new LobbyError(403, "Only host can update lobby settings.");
    }

    const nextSettings = normalizeSettings(patch, lobby.settings);
    if (lobby.players.length > nextSettings.humanCars) {
      throw new LobbyError(409, "Cannot set humanCars below current connected/joined players.");
    }
    if (nextSettings.totalCars < lobby.players.length) {
      throw new LobbyError(409, "Cannot set totalCars below current player count.");
    }

    lobby.settings = nextSettings;
    lobby.updatedAt = Date.now();
    return lobby;
  }

  startRace(lobbyId: string, hostToken: string): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    if (lobby.status !== "WAITING") {
      throw new LobbyError(409, "Race already started or finished.");
    }

    const host = this.findPlayerByToken(lobby, hostToken);
    if (!host) {
      throw new LobbyError(401, "Invalid player token for this lobby.");
    }
    if (!host.isHost) {
      throw new LobbyError(403, "Only host can start race.");
    }

    lobby.status = "IN_RACE";
    lobby.revision = 0;
    lobby.race = this.buildInitialRace(lobby);
    lobby.updatedAt = Date.now();
    return lobby;
  }

  incrementRevision(lobbyId: string): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    lobby.revision += 1;
    lobby.updatedAt = Date.now();
    return lobby;
  }

  // The seat whose turn it is (carId = seatIndex + 1), or undefined outside a race.
  getActiveRaceSeat(lobbyId: string): (RaceSeatInfo & { isBot: boolean }) | undefined {
    const race = this.getLobbyOrThrow(lobbyId).race;
    if (!race) return undefined;
    const car = getActiveCar(race.engine);
    const seat = race.seats[car.carId - 1];
    return seat ? { ...seat, isBot: car.isBot } : undefined;
  }

  // Validates `action` with the shared race engine and applies it for the active
  // car. A rejected action changes nothing. The caller bumps the revision.
  applyTurnAction(lobbyId: string, action: TurnSubmitAction): ApplyResult {
    const lobby = this.getLobbyOrThrow(lobbyId);
    const race = lobby.race;
    const ctx = getRaceContext(lobby.settings.trackId);
    if (!race || !ctx) {
      throw new LobbyError(409, "Race state not initialized.");
    }

    const result = applyAction(ctx, race.engine, action);
    if (!result.ok) return result;

    race.turnIndex += 1;
    if (race.engine.winnerCarId !== null) {
      lobby.status = "FINISHED";
      lobby.terminationReason = "race_finished";
    }
    lobby.updatedAt = Date.now();
    return result;
  }

  // What the shared bot heuristic would play for the active car. Changes nothing.
  decideBotTurn(lobbyId: string): BotTurnDecision {
    const lobby = this.getLobbyOrThrow(lobbyId);
    const ctx = getRaceContext(lobby.settings.trackId);
    if (!lobby.race || !ctx) {
      throw new LobbyError(409, "Race state not initialized.");
    }
    return decideBotAction(ctx, lobby.race.engine);
  }

  terminateLobby(lobbyId: string, reason: LobbyTerminationReason): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    lobby.status = "FINISHED";
    lobby.terminationReason = reason;
    for (const player of lobby.players) {
      player.tokenRevoked = true;
      player.connected = false;
    }
    lobby.updatedAt = Date.now();
    return lobby;
  }
}
