import { randomUUID } from "node:crypto";
import type {
  Lobby,
  LobbyPlayer,
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

function normalizeSettings(input: Partial<LobbySettings> | undefined, base = DEFAULT_SETTINGS): LobbySettings {
  const trackId = input?.trackId?.trim() || base.trackId;
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

export function toPublicLobby(lobby: Lobby): PublicLobby {
  return {
    lobbyId: lobby.lobbyId,
    status: lobby.status,
    hostPlayerId: lobby.hostPlayerId,
    createdAt: lobby.createdAt,
    updatedAt: lobby.updatedAt,
    revision: lobby.revision,
    terminationReason: lobby.terminationReason,
    settings: lobby.settings,
    players: lobby.players.map(toPublicPlayer)
  };
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

  findPlayerByToken(lobby: Lobby, playerToken: string): LobbyPlayer | undefined {
    return lobby.players.find((p) => p.playerToken === playerToken);
  }

  createLobby(hostName: string, rawSettings?: Partial<LobbySettings>): { lobby: Lobby; host: LobbyPlayer } {
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
      playerToken: randomUUID()
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
      playerToken: randomUUID()
    };

    lobby.players.push(player);
    lobby.updatedAt = Date.now();
    return { lobby, player, isReconnect: false };
  }

  setPlayerConnected(lobbyId: string, playerToken: string, connected: boolean): { lobby: Lobby; player: LobbyPlayer } {
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
    if (!host || !host.isHost) {
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
    if (!host || !host.isHost) {
      throw new LobbyError(403, "Only host can start race.");
    }

    lobby.status = "IN_RACE";
    lobby.revision = 0;
    lobby.updatedAt = Date.now();
    return lobby;
  }

  incrementRevision(lobbyId: string): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    lobby.revision += 1;
    lobby.updatedAt = Date.now();
    return lobby;
  }

  terminateLobby(lobbyId: string, reason: LobbyTerminationReason): Lobby {
    const lobby = this.getLobbyOrThrow(lobbyId);
    lobby.status = "FINISHED";
    lobby.terminationReason = reason;
    lobby.updatedAt = Date.now();
    return lobby;
  }
}
