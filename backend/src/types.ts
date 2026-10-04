import type { RaceAction, RaceState as EngineRaceState, RejectReason } from "../../src/game/race/raceEngine";
import type { Car } from "../../src/game/types/car";

export type LobbyStatus = "WAITING" | "IN_RACE" | "FINISHED";
export type LobbyTerminationReason = "host_disconnected" | "race_finished";

// A car as the server reports it: the engine's Car plus who drives it.
export interface RaceSeatInfo {
  seatIndex: number;
  playerId: string | null;
  name: string;
}

export interface RaceCarState extends Car, RaceSeatInfo {}

export interface RaceState {
  trackId: string;
  raceLaps: number;
  // Turns applied so far (human and bot).
  turnIndex: number;
  activeSeatIndex: number;
  winnerCarId: number | null;
  cars: RaceCarState[];
}

// Server-side race: the engine's state plus seat ownership (carId = seatIndex + 1).
export interface ServerRace {
  engine: EngineRaceState;
  seats: RaceSeatInfo[];
  turnIndex: number;
}

export interface LobbySettings {
  trackId: string;
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
}

export interface LobbyPlayer {
  playerId: string;
  name: string;
  connected: boolean;
  seatIndex: number;
  isHost: boolean;
  playerToken: string;
  tokenIssuedAt: number;
  tokenRevoked: boolean;
}

export interface Lobby {
  lobbyId: string;
  status: LobbyStatus;
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  terminationReason?: LobbyTerminationReason;
  settings: LobbySettings;
  players: LobbyPlayer[];
  race?: ServerRace;
}

export interface PublicLobbyPlayer {
  playerId: string;
  name: string;
  connected: boolean;
  seatIndex: number;
  isHost: boolean;
}

export interface PublicLobby {
  lobbyId: string;
  status: LobbyStatus;
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  terminationReason?: LobbyTerminationReason;
  settings: LobbySettings;
  players: PublicLobbyPlayer[];
  raceState?: RaceState;
}

export type TurnSubmitAction = RaceAction;

export type TurnCommandResult =
  | {
      ok: true;
      lobbyId: string;
      playerId: string;
      clientCommandId: string;
      revision: number;
      applied: TurnSubmitAction;
    }
  | {
      ok: false;
      lobbyId: string;
      playerId: string;
      clientCommandId: string;
      revision: number;
      error: "stale_revision" | "lobby_not_in_race" | "not_active_player" | "invalid_action";
      // Why the race engine refused an `invalid_action`.
      reason?: RejectReason;
    };
