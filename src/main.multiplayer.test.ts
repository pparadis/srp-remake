/** @vitest-environment jsdom */
import indexHtml from "../index.html?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startGame = vi.fn();
const createLobbyMock = vi.fn();
const joinLobbyMock = vi.fn();
const startRaceMock = vi.fn();
const readLobbyMock = vi.fn();
const submitTurnMock = vi.fn();

vi.mock("./game", () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));

class MockBackendApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Backend API error ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

vi.mock("./net/backendApi", () => ({
  BackendApiClient: class BackendApiClient {
    createLobby(...args: unknown[]) {
      return createLobbyMock(...args);
    }

    joinLobby(...args: unknown[]) {
      return joinLobbyMock(...args);
    }

    startRace(...args: unknown[]) {
      return startRaceMock(...args);
    }

    readLobby(...args: unknown[]) {
      return readLobbyMock(...args);
    }

    submitTurn(...args: unknown[]) {
      return submitTurnMock(...args);
    }
  },
  BackendApiError: MockBackendApiError,
  resolveBackendBaseUrl: () => "http://localhost:3001",
  resolveBackendWsBaseUrl: () => "ws://localhost:3001"
}));

class FakeWebSocket {
  readyState = 1;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {}

  addEventListener(event: string, listener: (event: unknown) => void) {
    const items = this.listeners.get(event) ?? [];
    items.push(listener);
    this.listeners.set(event, items);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    const items = this.listeners.get("close") ?? [];
    for (const listener of items) {
      listener({ code, reason });
    }
  }
}

function setupDom() {
  window.history.replaceState({}, "", "/");
  
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml)![1]!.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );
  document.body.dataset.screen = "home";
}

function makeLobby(lobbyId: string) {
  return {
    lobbyId,
    status: "WAITING" as const,
    hostPlayerId: "host-player-id",
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    settings: {
      trackId: "oval16_3lanes",
      totalCars: 2,
      humanCars: 2,
      botCars: 0,
      raceLaps: 5
    },
    players: [
      {
        playerId: "host-player-id",
        name: "Host",
        connected: true,
        seatIndex: 0,
        isHost: true
      },
      {
        playerId: "guest-player-id",
        name: "Guest",
        connected: true,
        seatIndex: 1,
        isHost: false
      }
    ]
  };
}

describe("main multiplayer screens", () => {
  beforeEach(() => {
    vi.resetModules();
    startGame.mockReset();
    createLobbyMock.mockReset();
    joinLobbyMock.mockReset();
    startRaceMock.mockReset();
    readLobbyMock.mockReset();
    submitTurnMock.mockReset();
    startGame.mockReturnValue({ destroy: vi.fn() });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    setupDom();
  });

  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  it("host creates a lobby and may start the race", async () => {
    createLobbyMock.mockResolvedValue({
      lobby: makeLobby("host-lobby"),
      playerId: "host-player-id",
      playerToken: "host-token"
    });
    await import("./main");

    byId("homeCreateBtn").click();

    await vi.waitFor(() => {
      expect(createLobbyMock).toHaveBeenCalledTimes(1);
      expect(document.body.dataset.screen).toBe("lobby");
    });
    expect(window.location.pathname).toBe("/lobby/host-lobby");
    expect(byId<HTMLInputElement>("lobbyInviteLink").value).toBe(
      `${window.location.origin}/lobby/host-lobby`
    );
    expect(byId("lobbyPlayers").querySelectorAll("li")).toHaveLength(2);
    expect(byId("lobbyPlayers").querySelectorAll('[data-testid="host-badge"]')).toHaveLength(1);
    expect(byId<HTMLButtonElement>("lobbyStartBtn").disabled).toBe(false);
    expect(byId<HTMLSelectElement>("lobbyBots").disabled).toBe(false);
  });

  it("a joined non-host cannot start or edit settings", async () => {
    joinLobbyMock.mockResolvedValue({
      lobby: makeLobby("joined-lobby"),
      playerId: "guest-player-id",
      playerToken: "guest-token",
      isReconnect: false
    });
    window.history.replaceState({}, "", "/lobby/joined-lobby");
    await import("./main");

    await vi.waitFor(() => {
      expect(joinLobbyMock).toHaveBeenCalled();
      expect(joinLobbyMock.mock.calls.at(-1)?.[0]).toBe("joined-lobby");
      expect(byId("lobbyPlayers").querySelectorAll("li")).toHaveLength(2);
    });
    expect(byId<HTMLButtonElement>("lobbyStartBtn").hidden).toBe(true);
    expect(byId<HTMLButtonElement>("lobbyStartBtn").disabled).toBe(true);
    expect(byId<HTMLInputElement>("lobbyLaps").disabled).toBe(true);
  });

  it("goes back home with a notice when joining fails", async () => {
    joinLobbyMock.mockRejectedValue(new MockBackendApiError(404, { error: "not_found" }));
    window.history.replaceState({}, "", "/lobby/missing");
    await import("./main");

    await vi.waitFor(() => {
      expect(document.body.dataset.screen).toBe("home");
    });
    expect(window.location.pathname).toBe("/");
    expect(byId("homeNotice").hidden).toBe(false);
    expect(byId("homeNotice").textContent).toContain("404");
  });
});
