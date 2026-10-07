import type { RaceAction, RaceState as EngineRaceState, RejectReason } from "../../src/game/race/raceEngine";
import { BOT_LEVELS, type BotLevel, type Car } from "../../src/game/types/car";

export const TURN_TIMER_CHOICES = [0, 30, 60, 120] as const;
export type TurnTimerSec = (typeof TURN_TIMER_CHOICES)[number];

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
  // Per-race seed: bot personalities and the grid (src/game/systems/botStyle.ts).
  seed: number;
  cars: RaceCarState[];
  // Time left for the active human seat (server clock, so no client clock skew); absent without a timer.
  turnRemainingMs?: number;
}

// Server-side race: the engine's state plus seat ownership (carId = seatIndex + 1).
export interface ServerRace {
  engine: EngineRaceState;
  seats: RaceSeatInfo[];
  turnIndex: number;
  // Epoch ms at which the active human seat is auto-played; set by the server while a timer runs.
  turnDeadlineAt?: number;
}

export const BOT_LEVEL_CHOICES = BOT_LEVELS;
export type { BotLevel };

export interface LobbySettings {
  trackId: string;
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  // Seconds a human seat has per turn before it is auto-played; 0 = no limit.
  turnTimerSec: TurnTimerSec;
  // Difficulty of every bot in the race.
  botLevel: BotLevel;
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
