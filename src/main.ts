import "./style.css";
import {
  BackendApiClient,
  BackendApiError,
  resolveBackendBaseUrl,
  resolveBackendWsBaseUrl,
  type PublicLobby,
  type BackendTurnAction
} from "./net/backendApi";

const app = document.getElementById("app")!;
const humanCountSelect = document.getElementById("humanCountSelect") as HTMLSelectElement;
const botCountSelect = document.getElementById("botCountSelect") as HTMLSelectElement;
const lapCountInput = document.getElementById("lapCountInput") as HTMLInputElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;
const toggleCarsMovesBtn = document.getElementById(
  "toggleCarsMovesBtn"
) as HTMLButtonElement | null;
const backendLobbyIdInput = document.getElementById(
  "backendLobbyIdInput"
) as HTMLInputElement | null;
const backendPlayerNameInput = document.getElementById(
  "backendPlayerNameInput"
) as HTMLInputElement | null;
const backendHostBtn = document.getElementById("backendHostBtn") as HTMLButtonElement | null;
const backendJoinBtn = document.getElementById("backendJoinBtn") as HTMLButtonElement | null;
const backendStartBtn = document.getElementById("backendStartBtn") as HTMLButtonElement | null;
const backendStatus = document.getElementById("backendStatus") as HTMLSpanElement | null;

let game: ReturnType<typeof import("./game").startGame> | null = null;
let backendBusy = false;
let backendRaceStarted = false;
const backendApiBaseUrl = resolveBackendBaseUrl();
const backendWsBaseUrl = resolveBackendWsBaseUrl(backendApiBaseUrl);
const backendClient = new BackendApiClient(backendApiBaseUrl);

interface BackendSession {
  lobbyId: string;
  playerId: string;
  playerToken: string;
  revision: number;
  isHost: boolean;
}

let backendSession: BackendSession | null = null;
let backendSocket: WebSocket | null = null;
let backendReconnectTimer: number | null = null;
let backendShouldReconnect = false;
let backendReconnectAttempt = 0;

function parseSelectInt(select: HTMLSelectElement, fallback: number): number {
  const parsed = Number.parseInt(select.value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseInputInt(input: HTMLInputElement, fallback: number): number {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getComposition() {
  let humanCars = Math.max(0, Math.min(11, parseSelectInt(humanCountSelect, 1)));
  let botCars = Math.max(0, Math.min(11, parseSelectInt(botCountSelect, 0)));
  const raceLaps = Math.max(1, Math.min(999, parseInputInt(lapCountInput, 5)));
  if (humanCars + botCars === 0) {
    humanCars = 1;
    botCars = 0;
  }
  if (humanCars + botCars > 11) {
    const maxBots = Math.max(0, 11 - humanCars);
    botCars = Math.min(botCars, maxBots);
    if (humanCars + botCars > 11) {
      humanCars = 11;
      botCars = 0;
    }
  }
  const totalCars = humanCars + botCars;
  return { totalCars, humanCars, botCars, raceLaps };
}

function makeCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setBackendStatusText(text: string) {
  if (!backendStatus) return;
  backendStatus.textContent = text;
}

function syncCompositionFromLobby(lobby: PublicLobby) {
  humanCountSelect.value = String(lobby.settings.humanCars);
  botCountSelect.value = String(lobby.settings.botCars);
  lapCountInput.value = String(lobby.settings.raceLaps);
}

function applyLobbyState(lobby: PublicLobby, source: string) {
  if (!backendSession) return;
  if (lobby.lobbyId !== backendSession.lobbyId) return;
  backendSession.revision = lobby.revision;
  backendRaceStarted = lobby.status === "IN_RACE";
  syncCompositionFromLobby(lobby);
  if (backendLobbyIdInput) {
    backendLobbyIdInput.value = lobby.lobbyId;
  }
  setBackendStatusText(
    `Backend: ${source} -> ${lobby.status.toLowerCase()} (rev ${lobby.revision}, players ${lobby.players.length})`
  );
}

function clearBackendReconnectTimer() {
  if (backendReconnectTimer === null) return;
  window.clearTimeout(backendReconnectTimer);
  backendReconnectTimer = null;
}

async function rehydrateLobbyState(reason: string) {
  if (!backendSession) return;
  try {
    const read = await backendClient.readLobby(backendSession.lobbyId, backendSession.playerToken);
    if (!backendSession || backendSession.lobbyId !== read.lobby.lobbyId) return;
    backendSession.playerId = read.playerId;
    applyLobbyState(read.lobby, `rehydrate(${reason})`);
  } catch (error) {
    setBackendStatusText(`Backend: rehydrate failed (${toErrorText(error)})`);
  }
}

function scheduleBackendReconnect() {
  if (!backendShouldReconnect || !backendSession) return;
  clearBackendReconnectTimer();
  const delayMs = Math.min(5000, 500 * 2 ** Math.min(backendReconnectAttempt, 5));
  backendReconnectAttempt += 1;
  setBackendStatusText(`Backend: ws reconnect in ${delayMs}ms`);
  backendReconnectTimer = window.setTimeout(() => {
    void connectBackendSocket("retry");
  }, delayMs);
}

function handleBackendWsEvent(eventName: string, payload: unknown) {
  if (!backendSession) return;
  if (eventName === "lobby.state" || eventName === "race.started" || eventName === "race.state") {
    if (payload && typeof payload === "object" && "lobbyId" in payload) {
      applyLobbyState(payload as PublicLobby, eventName);
    }
    return;
  }
  if (eventName === "turn.applied") {
    if (payload && typeof payload === "object" && "revision" in payload) {
      const revision = (payload as { revision: unknown }).revision;
      if (typeof revision === "number") {
        backendSession.revision = Math.max(backendSession.revision, revision);
        setBackendStatusText(`Backend: turn applied (rev ${backendSession.revision})`);
      }
    }
    return;
  }
  if (eventName === "race.ended") {
    backendRaceStarted = false;
    if (payload && typeof payload === "object") {
      const reason = (payload as { reason?: unknown }).reason;
      const lobby = (payload as { lobby?: unknown }).lobby;
      if (lobby && typeof lobby === "object" && "lobbyId" in lobby) {
        applyLobbyState(lobby as PublicLobby, "race.ended");
      }
      if (typeof reason === "string") {
        setBackendStatusText(`Backend: race ended (${reason})`);
      }
    }
  }
}

function disconnectBackendSocket() {
  backendShouldReconnect = false;
  clearBackendReconnectTimer();
  if (!backendSocket) return;
  const socket = backendSocket;
  backendSocket = null;
  socket.close(1000, "client_close");
}

async function connectBackendSocket(reason: string) {
  if (!backendSession) return;
  clearBackendReconnectTimer();
  if (backendSocket) {
    backendSocket.close(1000, "reconnect");
    backendSocket = null;
  }
  backendShouldReconnect = true;

  const socketUrl = `${backendWsBaseUrl}/ws?lobbyId=${encodeURIComponent(backendSession.lobbyId)}&playerToken=${encodeURIComponent(backendSession.playerToken)}`;
  const socket = new WebSocket(socketUrl);
  backendSocket = socket;
  setBackendStatusText(`Backend: ws connecting (${reason})...`);

  socket.addEventListener("open", () => {
    if (backendSocket !== socket) return;
    backendReconnectAttempt = 0;
    setBackendStatusText("Backend: ws connected");
    void rehydrateLobbyState("ws-open");
  });

  socket.addEventListener("message", (event) => {
    if (backendSocket !== socket) return;
    try {
      const parsed = JSON.parse(String(event.data)) as {
        event?: unknown;
        payload?: unknown;
      };
      if (typeof parsed.event !== "string") return;
      handleBackendWsEvent(parsed.event, parsed.payload);
    } catch {
      setBackendStatusText("Backend: ws parse error");
    }
  });

  socket.addEventListener("close", (event) => {
    if (backendSocket === socket) {
      backendSocket = null;
    }
    if (!backendShouldReconnect) return;

    if (event.code === 1008) {
      backendShouldReconnect = false;
      setBackendStatusText("Backend: ws auth failed");
      return;
    }
    if (event.code === 4001) {
      backendShouldReconnect = false;
      backendRaceStarted = false;
      setBackendStatusText(`Backend: ws closed (${event.reason || "host_disconnected"})`);
      return;
    }
    scheduleBackendReconnect();
  });

  socket.addEventListener("error", () => {
    if (backendSocket !== socket) return;
    setBackendStatusText("Backend: ws error");
  });
}

function setBackendBusy(nextBusy: boolean) {
  backendBusy = nextBusy;
  if (backendHostBtn) backendHostBtn.disabled = nextBusy;
  if (backendJoinBtn) backendJoinBtn.disabled = nextBusy;
  if (backendStartBtn) backendStartBtn.disabled = nextBusy;
}

function toErrorText(error: unknown): string {
  if (error instanceof BackendApiError) {
    const payload = error.payload as { error?: string };
    const reason = typeof payload?.error === "string" ? payload.error : "request_failed";
    return `HTTP ${error.status}: ${reason}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown_error";
}

function getPlayerName(): string {
  const raw = backendPlayerNameInput?.value?.trim() ?? "";
  return raw.length > 0 ? raw : "Player";
}

async function hostLobby() {
  if (backendBusy) return;
  setBackendBusy(true);
  setBackendStatusText("Backend: creating lobby...");
  try {
    const name = getPlayerName();
    const composition = getComposition();
    const created = await backendClient.createLobby(name, {
      trackId: "oval16_3lanes",
      totalCars: composition.totalCars,
      humanCars: composition.humanCars,
      botCars: composition.botCars,
      raceLaps: composition.raceLaps
    });
    backendSession = {
      lobbyId: created.lobby.lobbyId,
      playerId: created.playerId,
      playerToken: created.playerToken,
      revision: created.lobby.revision,
      isHost: true
    };
    backendRaceStarted = created.lobby.status === "IN_RACE";
    syncCompositionFromLobby(created.lobby);
    if (backendLobbyIdInput) backendLobbyIdInput.value = created.lobby.lobbyId;
    setBackendStatusText(`Backend: hosted ${created.lobby.lobbyId} (rev ${created.lobby.revision})`);
    void connectBackendSocket("host");
  } catch (error) {
    setBackendStatusText(`Backend: host failed (${toErrorText(error)})`);
  } finally {
    setBackendBusy(false);
  }
}

async function joinLobby() {
  if (backendBusy) return;
  const lobbyId = backendLobbyIdInput?.value?.trim() ?? "";
  if (lobbyId.length === 0) {
    setBackendStatusText("Backend: enter Lobby ID first");
    return;
  }
  setBackendBusy(true);
  setBackendStatusText(`Backend: joining ${lobbyId}...`);
  try {
    const joined = await backendClient.joinLobby(lobbyId, getPlayerName());
    backendSession = {
      lobbyId: joined.lobby.lobbyId,
      playerId: joined.playerId,
      playerToken: joined.playerToken,
      revision: joined.lobby.revision,
      isHost: false
    };
    backendRaceStarted = joined.lobby.status === "IN_RACE";
    syncCompositionFromLobby(joined.lobby);
    setBackendStatusText(`Backend: joined ${joined.lobby.lobbyId} (rev ${joined.lobby.revision})`);
    void connectBackendSocket("join");
  } catch (error) {
    setBackendStatusText(`Backend: join failed (${toErrorText(error)})`);
  } finally {
    setBackendBusy(false);
  }
}

async function startRace() {
  if (backendBusy) return;
  if (!backendSession) {
    setBackendStatusText("Backend: host or join a lobby first");
    return;
  }
  if (!backendSession.isHost) {
    setBackendStatusText("Backend: only host can start race");
    return;
  }
  setBackendBusy(true);
  setBackendStatusText("Backend: starting race...");
  try {
    const started = await backendClient.startRace(
      backendSession.lobbyId,
      backendSession.playerToken
    );
    backendSession.revision = started.lobby.revision;
    backendRaceStarted = started.lobby.status === "IN_RACE";
    setBackendStatusText(`Backend: race started (rev ${backendSession.revision})`);
  } catch (error) {
    setBackendStatusText(`Backend: start failed (${toErrorText(error)})`);
  } finally {
    setBackendBusy(false);
  }
}

async function submitTurnAction(action: BackendTurnAction) {
  if (!backendSession || !backendRaceStarted || backendBusy) return;
  let revision = backendSession.revision;
  const clientCommandId = makeCommandId();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await backendClient.submitTurn(
        backendSession.lobbyId,
        backendSession.playerToken,
        revision,
        attempt === 0 ? clientCommandId : `${clientCommandId}-retry`,
        action
      );
      if (result.ok) {
        backendSession.revision = result.revision;
        setBackendStatusText(`Backend: turn synced (rev ${result.revision})`);
        return;
      }
      if (result.error === "stale_revision") {
        revision = result.revision;
        backendSession.revision = result.revision;
        continue;
      }
      if (result.error === "lobby_not_in_race") {
        backendRaceStarted = false;
        backendSession.revision = result.revision;
        setBackendStatusText("Backend: lobby not in race");
        return;
      }
      if (result.error === "not_active_player") {
        backendSession.revision = result.revision;
        setBackendStatusText("Backend: not your turn");
        void rehydrateLobbyState("not-active-player");
        return;
      }
      setBackendStatusText(`Backend: turn rejected (${result.error})`);
      return;
    } catch (error) {
      setBackendStatusText(`Backend: turn submit failed (${toErrorText(error)})`);
      return;
    }
  }

  setBackendStatusText(`Backend: turn stale (rev ${backendSession.revision})`);
}

async function ensureGameStarted() {
  if (game) return;
  const { startGame } = await import("./game");
  game = startGame(app, getComposition());
}

async function restartGame() {
  disconnectBackendSocket();
  backendSession = null;
  backendRaceStarted = false;
  if (game) {
    game.destroy(true);
    game = null;
  }
  await ensureGameStarted();
}

void ensureGameStarted();

restartBtn.addEventListener("click", () => {
  restartGame();
});

toggleCarsMovesBtn?.addEventListener("click", () => {
  window.dispatchEvent(new Event("srp:toggle-cars-moves"));
});

backendHostBtn?.addEventListener("click", () => {
  void hostLobby();
});

backendJoinBtn?.addEventListener("click", () => {
  void joinLobby();
});

backendStartBtn?.addEventListener("click", () => {
  void startRace();
});

window.addEventListener("srp:local-turn-action", (event) => {
  const custom = event as CustomEvent<BackendTurnAction>;
  if (!custom.detail) return;
  void submitTurnAction(custom.detail);
});

window.addEventListener("beforeunload", () => {
  disconnectBackendSocket();
});

setBackendStatusText(`Backend: ready (${backendApiBaseUrl})`);
