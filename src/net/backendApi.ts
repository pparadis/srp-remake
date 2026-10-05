import type { RaceAction, RejectReason } from "../game/race/raceEngine";
import type { Car } from "../game/types/car";

// What a client submits for its turn; identical to the race engine's action.
export type BackendTurnAction = RaceAction;

// A turn as announced to everyone (the pit setup is not needed to render a log line).
export interface AppliedTurnSummary {
  type: "move" | "pit" | "skip";
  targetCellId?: string;
}

// Who decided a turn: absent for a human, "bot", or the server stepping in for a stuck player.
export type TurnSource = "bot" | "timeout" | "force_skip";

// Seconds a human seat has per turn before the server plays it (0 = no limit).
export type TurnTimerSec = 0 | 30 | 60 | 120;

// The engine's Car plus who drives it, as the server reports it.
export interface PublicRaceCar extends Car {
  seatIndex: number;
  playerId: string | null;
  name: string;
}

export interface PublicRaceState {
  trackId: string;
  raceLaps: number;
  turnIndex: number;
  activeSeatIndex: number;
  winnerCarId: number | null;
  cars: PublicRaceCar[];
  /** Time left for the active human seat, measured by the server; absent when the lobby has no timer. */
  turnRemainingMs?: number;
}

export interface PublicLobby {
  lobbyId: string;
  status: "WAITING" | "IN_RACE" | "FINISHED";
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  terminationReason?: "host_disconnected" | "race_finished";
  settings: {
    trackId: string;
    totalCars: number;
    humanCars: number;
    botCars: number;
    raceLaps: number;
    turnTimerSec: TurnTimerSec;
  };
  players: Array<{
    playerId: string;
    name: string;
    connected: boolean;
    seatIndex: number;
    isHost: boolean;
  }>;
  raceState?: PublicRaceState;
}

export interface CreateLobbyResponse {
  lobby: PublicLobby;
  playerId: string;
  playerToken: string;
}

export interface JoinLobbyResponse {
  lobby: PublicLobby;
  playerId: string;
  playerToken: string;
  isReconnect: boolean;
}

export interface StartRaceResponse {
  lobby: PublicLobby;
}

export interface ReadLobbyResponse {
  lobby: PublicLobby;
  playerId: string;
}

export type SubmitTurnResponse =
  | {
      ok: true;
      lobbyId: string;
      playerId: string;
      clientCommandId: string;
      revision: number;
      applied: AppliedTurnSummary;
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

export class BackendApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Backend API error ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

function isTurnRejection(payload: unknown): payload is SubmitTurnResponse {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { ok?: unknown }).ok === false &&
    typeof (payload as { error?: unknown }).error === "string"
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// A sleeping free-plan server needs about a minute for its first response.
export const REQUEST_TIMEOUT_MS = 90_000;

export class BackendApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!res.ok) {
      throw new BackendApiError(res.status, payload);
    }
    return payload as T;
  }

  createLobby(name: string, settings: PublicLobby["settings"]): Promise<CreateLobbyResponse> {
    return this.request("POST", "/api/v1/lobbies", { name, settings });
  }

  joinLobby(lobbyId: string, name: string, playerToken?: string): Promise<JoinLobbyResponse> {
    return this.request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/join`, {
      name,
      ...(playerToken ? { playerToken } : {})
    });
  }

  startRace(lobbyId: string, playerToken: string): Promise<StartRaceResponse> {
    return this.request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/start`, {
      playerToken
    });
  }

  // Host only: a finished (not closed) lobby goes back to WAITING.
  resetLobby(lobbyId: string, playerToken: string): Promise<StartRaceResponse> {
    return this.request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/reset`, {
      playerToken
    });
  }

  updateSettings(
    lobbyId: string,
    playerToken: string,
    settings: Partial<PublicLobby["settings"]>
  ): Promise<StartRaceResponse> {
    return this.request("PATCH", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/settings`, {
      playerToken,
      settings
    });
  }

  readLobby(lobbyId: string, playerToken: string): Promise<ReadLobbyResponse> {
    const path = `/api/v1/lobbies/${encodeURIComponent(lobbyId)}?playerToken=${encodeURIComponent(playerToken)}`;
    return this.request("GET", path);
  }

  // Host only: the server plays one autopilot turn for the stuck human seat.
  forceSkip(lobbyId: string, playerToken: string, revision?: number): Promise<StartRaceResponse> {
    return this.request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/force-skip`, {
      playerToken,
      ...(revision !== undefined ? { revision } : {})
    });
  }

  // Cheap request that wakes a sleeping server.
  health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  // A refused turn is a 409 whose body says why; hand that back instead of throwing.
  async submitTurn(
    lobbyId: string,
    playerToken: string,
    revision: number,
    clientCommandId: string,
    action: BackendTurnAction
  ): Promise<SubmitTurnResponse> {
    try {
      return await this.request<SubmitTurnResponse>(
        "POST",
        `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/turns`,
        { playerToken, revision, clientCommandId, action }
      );
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 409 && isTurnRejection(error.payload)) {
        return error.payload;
      }
      throw error;
    }
  }
}

export function resolveBackendBaseUrl(): string {
  const configured = import.meta.env.VITE_BACKEND_API_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured : "http://localhost:3001";
}

export function resolveBackendWsBaseUrl(apiBaseUrl: string): string {
  const configured = import.meta.env.VITE_BACKEND_WS_BASE_URL?.trim();
  if (configured && configured.length > 0) {
    return normalizeBaseUrl(configured);
  }
  const parsed = new URL(apiBaseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return normalizeBaseUrl(parsed.toString());
}
