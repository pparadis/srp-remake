export type BackendTurnAction =
  | { type: "move"; targetCellId?: string }
  | { type: "pit"; targetCellId?: string }
  | { type: "skip"; targetCellId?: string };

export interface PublicLobby {
  lobbyId: string;
  status: "WAITING" | "IN_RACE" | "FINISHED";
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  terminationReason?: "host_disconnected";
  settings: {
    trackId: string;
    totalCars: number;
    humanCars: number;
    botCars: number;
    raceLaps: number;
  };
  players: Array<{
    playerId: string;
    name: string;
    connected: boolean;
    seatIndex: number;
    isHost: boolean;
  }>;
  raceState?: {
    trackId: string;
    raceLaps: number;
    turnIndex: number;
    activeSeatIndex: number;
    cars: Array<{
      carId: number;
      seatIndex: number;
      playerId: string | null;
      name: string;
      isBot: boolean;
      lapCount: number;
    }>;
  };
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
      applied: BackendTurnAction;
    }
  | {
      ok: false;
      lobbyId: string;
      playerId: string;
      clientCommandId: string;
      revision: number;
      error: "stale_revision" | "lobby_not_in_race" | "not_active_player";
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class BackendApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);

    const text = await res.text();
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

  readLobby(lobbyId: string, playerToken: string): Promise<ReadLobbyResponse> {
    const path = `/api/v1/lobbies/${encodeURIComponent(lobbyId)}?playerToken=${encodeURIComponent(playerToken)}`;
    return this.request("GET", path);
  }

  submitTurn(
    lobbyId: string,
    playerToken: string,
    revision: number,
    clientCommandId: string,
    action: BackendTurnAction
  ): Promise<SubmitTurnResponse> {
    return this.request("POST", `/api/v1/lobbies/${encodeURIComponent(lobbyId)}/turns`, {
      playerToken,
      revision,
      clientCommandId,
      action
    });
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
