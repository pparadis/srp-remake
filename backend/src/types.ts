import type {
  RaceAction,
  RaceState as EngineRaceState,
  RejectReason
} from '../../src/game/race/race_engine';
import type { RaceLog } from '../../src/game/race/race_log';
import type { RulesVersion } from '../../src/game/rules/ids';
import { BOT_LEVELS, type BotLevel, type Car } from '../../src/game/types/car';
import type { Season } from '../../src/game/season';

export const TURN_TIMER_CHOICES = [0, 30, 60, 120] as const;
export type TurnTimerSec = (typeof TURN_TIMER_CHOICES)[number];

type LobbyStatus = 'WAITING' | 'IN_RACE' | 'FINISHED';
export type LobbyTerminationReason = 'host_disconnected' | 'race_finished';

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
  // Car ids in the order they play this round (the server is the authority: from v4 it changes every round, #138).
  turnOrder: number[];
  winnerCarId: number | null;
  // Per-race seed: bot personalities and the grid (src/game/systems/bot_style.ts).
  seed: number;
  // The movement and resource rules the race plays (src/game/rules/versions.ts).
  rulesVersion: RulesVersion;
  cars: RaceCarState[];
  // Time left for the active human seat (server clock, so no client clock skew); absent without a timer.
  turnRemainingMs?: number;
}

// Server-side race: the engine's state plus seat ownership (carId = seatIndex + 1).
export interface ServerRace {
  engine: EngineRaceState;
  // Every accepted action since the grid (#169): rebuilds the race with replayRace. Never sent with the lobby.
  log: RaceLog;
  // Set once the finished race has been handed to the race history (#170), so it is stored once.
  stored?: boolean;
  // The race of the lobby's championship this is (index into its calendar), #273.
  seasonIndex?: number;
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
  // A championship of the fixed calendar (#273): the track and laps are the calendar's, and once it runs the cars and the
  // bot level are fixed.
  season: boolean;
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
  // Epoch ms of the player's last chat message (one a second).
  lastChatAt?: number;
}

export interface ChatMessage {
  // Per-lobby counter.
  id: number;
  playerId: string;
  // The name at send time.
  name: string;
  text: string;
  sentAt: number;
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
  // The championship the lobby is playing, once its first race has started (or it was resumed), #273.
  season?: Season;
  // The last CHAT_HISTORY messages. Not part of PublicLobby: that payload goes out on every turn.
  chat: ChatMessage[];
  chatSeq: number;
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
  season?: Season;
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
      error: 'stale_revision' | 'lobby_not_in_race' | 'not_active_player' | 'invalid_action';
      // Why the race engine refused an `invalid_action`.
      reason?: RejectReason;
    };
