/** @vitest-environment jsdom */
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
  document.body.innerHTML = `
    <div id="controls">
      <div class="controls-shell">
        <section>
          <select id="humanCountSelect">
            <option value="1">1</option>
            <option value="2" selected>2</option>
          </select>
          <select id="botCountSelect"><option value="0" selected>0</option></select>
          <input id="lapCountInput" value="5" />
          <button id="restartBtn"></button>
        </section>
        <section>
          <input id="backendPlayerNameInput" value="Player" />
          <input id="backendLobbyIdInput" value="" />
          <button id="backendHostBtn" type="button">Host lobby</button>
          <button id="backendJoinBtn" type="button">Join lobby</button>
          <button id="backendStartBtn" type="button">Start race</button>
          <input id="backendLobbyLinkInput" value="" />
          <button id="backendCopyInviteBtn" type="button">Copy invite</button>
          <button id="backendOpenInviteBtn" type="button">Open invite</button>
          <button id="backendCopyMpDebugBtn" type="button">Copy multiplayer debug</button>
          <span id="backendStatus"></span>
        </section>
      </div>
    </div>
    <div id="app"></div>
  `;
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

describe("main multiplayer controls", () => {
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

  it("disables start race locally for multi-human composition", async () => {
    await import("./main");

    const humanSelect = document.getElementById("humanCountSelect") as HTMLSelectElement;
    const startBtn = document.getElementById("backendStartBtn") as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);

    humanSelect.value = "1";
    humanSelect.dispatchEvent(new Event("change"));
    expect(startBtn.disabled).toBe(false);
  });

  it("keeps start race enabled for host lobby owner", async () => {
    createLobbyMock.mockResolvedValue({
      lobby: makeLobby("host-lobby"),
      playerId: "host-player-id",
      playerToken: "host-token"
    });

    await import("./main");

    const hostBtn = document.getElementById("backendHostBtn") as HTMLButtonElement;
    const startBtn = document.getElementById("backendStartBtn") as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);

    hostBtn.click();

    await vi.waitFor(() => {
      expect(createLobbyMock).toHaveBeenCalledTimes(1);
      expect(startBtn.disabled).toBe(false);
    });
  });

  it("keeps start race disabled for joined non-host player", async () => {
    joinLobbyMock.mockResolvedValue({
      lobby: makeLobby("joined-lobby"),
      playerId: "guest-player-id",
      playerToken: "guest-token",
      isReconnect: false
    });

    await import("./main");

    const lobbyIdInput = document.getElementById("backendLobbyIdInput") as HTMLInputElement;
    const joinBtn = document.getElementById("backendJoinBtn") as HTMLButtonElement;
    const startBtn = document.getElementById("backendStartBtn") as HTMLButtonElement;

    lobbyIdInput.value = "joined-lobby";
    joinBtn.click();

    await vi.waitFor(() => {
      expect(joinLobbyMock).toHaveBeenCalled();
      expect(joinLobbyMock.mock.calls.at(-1)?.[0]).toBe("joined-lobby");
      expect(startBtn.disabled).toBe(true);
    });
  });
});
