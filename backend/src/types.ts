export type LobbyStatus = "WAITING" | "IN_RACE" | "FINISHED";
export type LobbyTerminationReason = "host_disconnected";

export interface RaceCarState {
  carId: number;
  seatIndex: number;
  playerId: string | null;
  name: string;
  isBot: boolean;
  lapCount: number;
}

export interface RaceState {
  trackId: string;
  raceLaps: number;
  turnIndex: number;
  activeSeatIndex: number;
  cars: RaceCarState[];
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
  raceState?: RaceState;
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

export interface TurnSubmitAction {
  type: "move" | "pit" | "skip";
  targetCellId?: string;
}

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
      error: "stale_revision" | "lobby_not_in_race";
    };
