/** @vitest-environment jsdom */
import indexHtml from "../index.html?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startGame = vi.fn();
const createLobbyMock = vi.fn();
const joinLobbyMock = vi.fn();
const startRaceMock = vi.fn();
const readLobbyMock = vi.fn();
const submitTurnMock = vi.fn();
const forceSkipMock = vi.fn();
const updateSettingsMock = vi.fn();

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

    health() {
      return Promise.resolve({ ok: true });
    }

    forceSkip(...args: unknown[]) {
      return forceSkipMock(...args);
    }

    updateSettings(...args: unknown[]) {
      return updateSettingsMock(...args);
    }
  },
  BackendApiError: MockBackendApiError,
  resolveBackendBaseUrl: () => "http://localhost:3001",
  resolveBackendWsBaseUrl: () => "ws://localhost:3001"
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  emit(event: string, data: unknown = {}) {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

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
      raceLaps: 5,
      turnTimerSec: 60 as const,
      botLevel: "normal" as "easy" | "normal" | "hard"
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
    forceSkipMock.mockReset();
    FakeWebSocket.instances = [];
    window.sessionStorage.clear();
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

  describe("survivability", () => {
    const banner = () => byId("connectionBanner");

    async function joinAsGuest(lobbyId: string) {
      joinLobbyMock.mockResolvedValue({
        lobby: makeLobby(lobbyId),
        playerId: "guest-player-id",
        playerToken: "guest-token",
        isReconnect: false
      });
      readLobbyMock.mockResolvedValue({ lobby: makeLobby(lobbyId), playerId: "guest-player-id" });
      window.history.replaceState({}, "", `/lobby/${lobbyId}`);
      await import("./main");
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows a reconnecting banner while the socket is down and hides it when it is back", async () => {
      vi.useFakeTimers();
      await joinAsGuest("flaky");
      expect(banner().hidden).toBe(true);

      FakeWebSocket.instances[0]!.close(1006, "");
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain("Reconnecting");

      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.emit("open");
      expect(banner().hidden).toBe(true);
    });

    it("tells a guest while the host is away", async () => {
      await joinAsGuest("hostaway");
      const lobby = makeLobby("hostaway");
      lobby.players[0]!.connected = false;
      FakeWebSocket.instances[0]!.emit("message", {
        data: JSON.stringify({ event: "lobby.state", payload: lobby })
      });
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain("Host disconnected");

      FakeWebSocket.instances[0]!.emit("message", {
        data: JSON.stringify({ event: "lobby.state", payload: makeLobby("hostaway") })
      });
      expect(banner().hidden).toBe(true);
    });

    it("explains a slow cold start after 3 s and clears the message when the server answers", async () => {
      vi.useFakeTimers();
      let answer!: (value: unknown) => void;
      joinLobbyMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      readLobbyMock.mockResolvedValue({ lobby: makeLobby("slow"), playerId: "guest-player-id" });
      window.history.replaceState({}, "", "/lobby/slow");
      await import("./main");

      await vi.advanceTimersByTimeAsync(2900);
      expect(banner().hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain("Waking the server");

      answer({ lobby: makeLobby("slow"), playerId: "guest-player-id", playerToken: "t", isReconnect: false });
      await vi.advanceTimersByTimeAsync(10);
      expect(banner().hidden).toBe(true);
    });

    it("keeps the stored seat when the server cannot be reached, so a retry rejoins", async () => {
      window.sessionStorage.setItem(
        "srp:session:offline",
        JSON.stringify({ lobbyId: "offline", playerToken: "kept-token" })
      );
      joinLobbyMock.mockRejectedValue(new TypeError("Failed to fetch"));
      window.history.replaceState({}, "", "/lobby/offline");
      await import("./main");

      await vi.waitFor(() => expect(document.body.dataset.screen).toBe("home"));
      expect(joinLobbyMock.mock.calls.at(-1)?.[2]).toBe("kept-token");
      expect(window.sessionStorage.getItem("srp:session:offline")).toContain("kept-token");
    });

    it("drops the stored seat when the server says it is gone (401)", async () => {
      window.sessionStorage.setItem(
        "srp:session:gone",
        JSON.stringify({ lobbyId: "gone", playerToken: "old-token" })
      );
      joinLobbyMock.mockRejectedValue(new MockBackendApiError(401, { error: "invalid" }));
      window.history.replaceState({}, "", "/lobby/gone");
      await import("./main");

      await vi.waitFor(() => expect(document.body.dataset.screen).toBe("home"));
      expect(window.sessionStorage.getItem("srp:session:gone")).toBeNull();
    });

    it("creates lobbies with the Normal bot level and hides the select while there are no bots", async () => {
      const lobby = makeLobby("level-lobby");
      createLobbyMock.mockResolvedValue({ lobby, playerId: "host-player-id", playerToken: "host-token" });
      await import("./main");
      byId("homeCreateBtn").click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe("lobby"));
      expect(createLobbyMock.mock.calls.at(-1)?.[1]).toMatchObject({ botLevel: "normal" });
      expect(byId<HTMLSelectElement>("lobbyBotLevel").value).toBe("normal");
      expect(byId("lobbyBotLevelField").hidden).toBe(true); // botCars is 0
      expect(document.querySelector('[data-testid="lobby-bot-level"]')).not.toBeNull();
    });

    it("lets the host pick the bot level and sends it with the other settings", async () => {
      const lobby = makeLobby("level-lobby");
      lobby.settings = { ...lobby.settings, totalCars: 3, humanCars: 2, botCars: 1, botLevel: "easy" as const };
      createLobbyMock.mockResolvedValue({ lobby, playerId: "host-player-id", playerToken: "host-token" });
      updateSettingsMock.mockImplementation(async (_id: string, _token: string, patch: { botLevel: string }) => ({
        lobby: { ...lobby, settings: { ...lobby.settings, botLevel: patch.botLevel } }
      }));
      await import("./main");
      byId("homeCreateBtn").click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe("lobby"));

      const select = byId<HTMLSelectElement>("lobbyBotLevel");
      expect(byId("lobbyBotLevelField").hidden).toBe(false);
      expect(select.value).toBe("easy");
      expect(select.disabled).toBe(false);

      select.value = "hard";
      select.dispatchEvent(new Event("change"));
      await vi.waitFor(() => expect(updateSettingsMock).toHaveBeenCalled());
      expect(updateSettingsMock.mock.calls.at(-1)?.[2]).toMatchObject({ botCars: 1, botLevel: "hard" });
      await vi.waitFor(() => expect(select.value).toBe("hard"));
    });

    it("offers the host a turn timer select defaulting to 60 s", async () => {
      const lobby = makeLobby("timer-lobby");
      createLobbyMock.mockResolvedValue({ lobby, playerId: "host-player-id", playerToken: "host-token" });
      await import("./main");
      byId("homeCreateBtn").click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe("lobby"));
      expect(byId<HTMLSelectElement>("lobbyTurnTimer").value).toBe("60");
      expect(byId<HTMLSelectElement>("lobbyTurnTimer").disabled).toBe(false);
      expect(byId("lobbyTurnTimerField").hidden).toBe(false);
    });
  });
});
