import "./style.css";
import {
  BackendApiClient,
  BackendApiError,
  resolveBackendBaseUrl,
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
const backendClient = new BackendApiClient(resolveBackendBaseUrl());

interface BackendSession {
  lobbyId: string;
  playerId: string;
  playerToken: string;
  revision: number;
  isHost: boolean;
}

let backendSession: BackendSession | null = null;

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
    if (backendLobbyIdInput) backendLobbyIdInput.value = created.lobby.lobbyId;
    setBackendStatusText(
      `Backend: hosted ${created.lobby.lobbyId} (rev ${created.lobby.revision})`
    );
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
    setBackendStatusText(`Backend: joined ${joined.lobby.lobbyId} (rev ${joined.lobby.revision})`);
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

setBackendStatusText(`Backend: ready (${resolveBackendBaseUrl()})`);
