import "./style.css";
import {
  BackendApiClient,
  BackendApiError,
  resolveBackendBaseUrl,
  resolveBackendWsBaseUrl,
  type PublicLobby,
  type AppliedTurnSummary,
  type BackendTurnAction
} from "./net/backendApi";
import {
  currentRoute,
  navigate,
  parseRoute,
  routePath,
  screenOf,
  startRouter,
  type Route,
  type Screen
} from "./ui/router";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const app = el("app");
const statusLine = el("statusLine");
const homeNotice = el("homeNotice");
const homeName = el<HTMLInputElement>("homeName");
const homeJoinCode = el<HTMLInputElement>("homeJoinCode");
const homeButtons = ["homeQuickBtn", "homeCreateBtn", "homeJoinBtn"].map((id) =>
  el<HTMLButtonElement>(id)
);
const lobbyTitle = el("lobbyTitle");
const lobbyNote = el("lobbyNote");
const lobbyPlayersBlock = el("lobbyPlayersBlock");
const lobbyPlayers = el("lobbyPlayers");
const lobbyHumans = el<HTMLSelectElement>("lobbyHumans");
const lobbyHumansField = el("lobbyHumansField");
const lobbyBots = el<HTMLSelectElement>("lobbyBots");
const lobbyLaps = el<HTMLInputElement>("lobbyLaps");
const lobbyInviteBlock = el("lobbyInviteBlock");
const lobbyInviteLink = el<HTMLInputElement>("lobbyInviteLink");
const lobbyCopyBtn = el<HTMLButtonElement>("lobbyCopyBtn");
const lobbyStartBtn = el<HTMLButtonElement>("lobbyStartBtn");
const lobbyLeaveBtn = el<HTMLButtonElement>("lobbyLeaveBtn");
const results = el("results");
const resultsWinner = el("resultsWinner");

let game: ReturnType<typeof import("./game").startGame> | null = null;
let gameStarting = false;
let backendBusy = false;
let mode: "solo" | "online" = "solo";
let soloRaceRequested = false;
let raceOver = false;
const soloSettings = { botCars: 3, raceLaps: 5 };
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

type BackendLobbyStateEventDetail = {
  lobby: PublicLobby;
  source: string;
  localPlayerId: string;
};

type BackendTurnAppliedEventDetail = {
  lobbyId: string;
  playerId: string;
  revision: number;
  applied: AppliedTurnSummary;
};

let backendSession: BackendSession | null = null;
let lastLobby: PublicLobby | null = null;
let backendSocket: WebSocket | null = null;
let backendReconnectTimer: number | null = null;
let backendShouldReconnect = false;
let backendReconnectAttempt = 0;
let joining = false;

function setStatus(text: string) {
  statusLine.textContent = text;
}

function showNotice(text: string | null) {
  homeNotice.textContent = text ?? "";
  homeNotice.hidden = text === null;
}

// sessionStorage is per tab: a reload rejoins with the same player token, a second tab is a new player.
const sessionKey = (lobbyId: string) => `srp:session:${lobbyId}`;

function storeSession(session: BackendSession) {
  try {
    window.sessionStorage.setItem(sessionKey(session.lobbyId), JSON.stringify(session));
  } catch {
    // storage unavailable: reload simply won't rejoin
  }
}

function loadStoredToken(lobbyId: string): string | undefined {
  try {
    const raw = window.sessionStorage.getItem(sessionKey(lobbyId));
    const parsed = raw ? (JSON.parse(raw) as { playerToken?: unknown }) : null;
    return typeof parsed?.playerToken === "string" ? parsed.playerToken : undefined;
  } catch {
    return undefined;
  }
}

function clearStoredSession(lobbyId: string) {
  try {
    window.sessionStorage.removeItem(sessionKey(lobbyId));
  } catch {
    // ignore
  }
}

function buildLobbyInviteUrl(lobbyId: string): string {
  return `${window.location.origin}${routePath({ name: "lobby", id: lobbyId })}`;
}

function logMultiplayerClient(event: string, context: Record<string, unknown> = {}) {
  const payload = {
    event,
    ts: Date.now(),
    lobbyId: backendSession?.lobbyId ?? null,
    playerId: backendSession?.playerId ?? null,
    revision: backendSession?.revision ?? null,
    ...context
  };
  console.info("[multiplayer]", payload);
}

function makeCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  const raw = homeName.value.trim();
  return raw.length > 0 ? raw : "Player";
}

// What the game scene is built from: the lobby's settings online, the lobby card offline.
function getComposition() {
  if (mode === "online" && lastLobby) {
    const { totalCars, humanCars, botCars, raceLaps } = lastLobby.settings;
    return { totalCars, humanCars, botCars, raceLaps };
  }
  return {
    totalCars: 1 + soloSettings.botCars,
    humanCars: 1,
    botCars: soloSettings.botCars,
    raceLaps: soloSettings.raceLaps
  };
}

// ---- screens -------------------------------------------------------------------------------

function destroyGame() {
  if (game) {
    game.destroy(true);
    game = null;
  }
  delete window.__srp;
}

function showScreen(screen: Screen) {
  document.body.dataset.screen = screen;
  if (screen !== "race") {
    destroyGame();
    results.hidden = true;
    raceOver = false;
  }
  if (screen === "home") renderHome();
  else if (screen === "lobby") renderLobby();
}

function renderHome() {
  for (const button of homeButtons) button.disabled = backendBusy;
}

function renderLobby() {
  const online = mode === "online";
  const lobby = online ? lastLobby : null;
  const isHost = !online || (backendSession?.isHost ?? false);
  const waiting = !online || lobby?.status === "WAITING";
  const settings = lobby?.settings;

  lobbyTitle.textContent = online ? "Lobby" : "Quick race";
  lobbyPlayersBlock.hidden = !online;
  lobbyInviteBlock.hidden = !online;
  lobbyHumansField.hidden = !online;
  lobbyHumans.value = String(settings?.humanCars ?? 1);
  lobbyBots.value = String(settings?.botCars ?? soloSettings.botCars);
  lobbyLaps.value = String(settings?.raceLaps ?? soloSettings.raceLaps);
  const editable = isHost && waiting && !backendBusy;
  lobbyHumans.disabled = lobbyBots.disabled = lobbyLaps.disabled = !editable;
  lobbyStartBtn.disabled = backendBusy || !isHost || !waiting;
  lobbyStartBtn.hidden = online && !isHost;
  lobbyNote.hidden = !(online && lobby && lobby.status !== "WAITING");
  lobbyNote.textContent =
    lobby?.status === "IN_RACE" ? "Race in progress." : "Race finished. Create a new lobby to race again.";

  lobbyPlayers.replaceChildren(
    ...(lobby?.players ?? []).map((player) => {
      const item = document.createElement("li");
      item.dataset.testid = "lobby-player";
      const dot = document.createElement("span");
      dot.className = player.connected ? "dot on" : "dot";
      item.append(dot, player.name + (player.playerId === backendSession?.playerId ? " (you)" : ""));
      if (player.isHost) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.dataset.testid = "host-badge";
        badge.textContent = "host";
        item.append(badge);
      }
      return item;
    })
  );
  lobbyInviteLink.value = lobby ? buildLobbyInviteUrl(lobby.lobbyId) : "";
  lobbyCopyBtn.disabled = !lobby;
}

function setBackendBusy(next: boolean) {
  backendBusy = next;
  renderHome();
  if (document.body.dataset.screen === "lobby") renderLobby();
}

async function ensureGameStarted() {
  if (game || gameStarting) return;
  gameStarting = true;
  try {
    const { startGame } = await import("./game");
    // The player may have left while the chunk loaded.
    if (document.body.dataset.screen !== "race" || game) return;
    game = startGame(app, getComposition());
  } finally {
    gameStarting = false;
  }
}

function showResults(winnerCarId: number | null) {
  raceOver = true;
  const car = lastLobby?.raceState?.cars.find((candidate) => candidate.carId === winnerCarId);
  const who = car ? car.name : mode === "solo" ? (winnerCarId === 1 ? "you" : "bot") : "";
  resultsWinner.textContent = `Car ${winnerCarId ?? "?"}${who ? ` (${who})` : ""} wins`;
  results.hidden = false;
}

// ---- routing -------------------------------------------------------------------------------

function leaveOnline() {
  disconnectBackendSocket();
  if (backendSession) clearStoredSession(backendSession.lobbyId);
  backendSession = null;
  lastLobby = null;
}

function kickToHome(message: string) {
  leaveOnline();
  navigate({ name: "home" }, "replace");
  showNotice(message);
}

async function handleRoute(route: Route, source: "push" | "replace" | "pop") {
  const onRaceScreen = document.body.dataset.screen === "race" && !raceOver;
  if (source === "pop" && onRaceScreen && screenOf(route) !== "race") {
    if (!window.confirm("Leave race?")) {
      // undo the back navigation
      window.history.pushState({}, "", routePath(mode === "solo" ? { name: "soloRace" } : lobbyRaceRoute()));
      return;
    }
    if (mode === "online") {
      // leaving an online race means leaving the lobby (its status would pull us straight back)
      leaveOnline();
      navigate({ name: "home" }, "replace");
      return;
    }
  }
  switch (route.name) {
    case "home":
      leaveOnline();
      soloRaceRequested = false;
      showScreen("home");
      return;
    case "solo":
      leaveOnline();
      mode = "solo";
      soloRaceRequested = false;
      showScreen("lobby");
      return;
    case "soloRace":
      mode = "solo";
      if (!soloRaceRequested) {
        navigate({ name: "solo" }, "replace");
        return;
      }
      showScreen("race");
      await ensureGameStarted();
      return;
    case "lobby":
    case "lobbyRace":
      mode = "online";
      if (!backendSession || backendSession.lobbyId !== route.id) {
        leaveOnline();
        showScreen("lobby");
        await joinLobbyById(route.id);
        return;
      }
      syncOnlineScreen();
  }
}

function lobbyRaceRoute(): Route {
  return { name: "lobbyRace", id: backendSession?.lobbyId ?? "" };
}

// The lobby's status decides which online screen is right; the URL follows it.
function syncOnlineScreen() {
  const route = currentRoute();
  if (mode !== "online" || !backendSession || !lastLobby) return;
  if (route.name !== "lobby" && route.name !== "lobbyRace") return;
  if (lastLobby.terminationReason === "host_disconnected" && !backendSession.isHost) {
    kickToHome("The host disconnected. The lobby is closed.");
    return;
  }
  const hasRace = lastLobby.raceState !== undefined && lastLobby.status !== "WAITING";
  if (route.name === "lobby") {
    if (lastLobby.status === "IN_RACE") {
      navigate({ name: "lobbyRace", id: lastLobby.lobbyId });
    } else {
      showScreen("lobby");
    }
    return;
  }
  if (!hasRace) {
    navigate({ name: "lobby", id: lastLobby.lobbyId }, "replace");
    return;
  }
  if (document.body.dataset.screen !== "race") showScreen("race");
  void ensureGameStarted();
}

// ---- backend session -----------------------------------------------------------------------

function applyLobbyState(lobby: PublicLobby, source: string) {
  if (!backendSession) return;
  if (lobby.lobbyId !== backendSession.lobbyId) return;
  backendSession.revision = Math.max(backendSession.revision, lobby.revision);
  backendSession.isHost = lobby.hostPlayerId === backendSession.playerId;
  lastLobby = lobby;
  storeSession(backendSession);
  setStatus(`${source}: ${lobby.status.toLowerCase()} (rev ${lobby.revision})`);
  logMultiplayerClient("lobby.state.applied", {
    source,
    status: lobby.status,
    players: lobby.players.length
  });
  window.dispatchEvent(
    new CustomEvent<BackendLobbyStateEventDetail>("srp:backend-lobby-state", {
      detail: { lobby, source, localPlayerId: backendSession.playerId }
    })
  );
  if (document.body.dataset.screen === "lobby") renderLobby();
  syncOnlineScreen();
}

function clearBackendReconnectTimer() {
  if (backendReconnectTimer === null) return;
  window.clearTimeout(backendReconnectTimer);
  backendReconnectTimer = null;
}

async function rehydrateLobbyState(reason: string) {
  if (!backendSession) return;
  logMultiplayerClient("lobby.rehydrate.start", { reason });
  try {
    const read = await backendClient.readLobby(backendSession.lobbyId, backendSession.playerToken);
    if (!backendSession || backendSession.lobbyId !== read.lobby.lobbyId) return;
    backendSession.playerId = read.playerId;
    applyLobbyState(read.lobby, `rehydrate(${reason})`);
    logMultiplayerClient("lobby.rehydrate.success", { reason });
  } catch (error) {
    setStatus(`rehydrate failed (${toErrorText(error)})`);
    logMultiplayerClient("lobby.rehydrate.failed", { reason, error: toErrorText(error) });
  }
}

function scheduleBackendReconnect() {
  if (!backendShouldReconnect || !backendSession) return;
  clearBackendReconnectTimer();
  const delayMs = Math.min(5000, 500 * 2 ** Math.min(backendReconnectAttempt, 5));
  backendReconnectAttempt += 1;
  setStatus(`ws reconnect in ${delayMs}ms`);
  logMultiplayerClient("ws.reconnect.scheduled", { delayMs, attempt: backendReconnectAttempt });
  backendReconnectTimer = window.setTimeout(() => {
    void connectBackendSocket("retry");
  }, delayMs);
}

function handleBackendWsEvent(eventName: string, payload: unknown) {
  logMultiplayerClient("ws.message", { wsEvent: eventName });
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
      }
    }
    if (
      payload &&
      typeof payload === "object" &&
      "lobbyId" in payload &&
      "playerId" in payload &&
      "revision" in payload &&
      "applied" in payload
    ) {
      const turnPayload = payload as {
        lobbyId: unknown;
        playerId: unknown;
        revision: unknown;
        applied: unknown;
      };
      if (
        typeof turnPayload.lobbyId === "string" &&
        typeof turnPayload.playerId === "string" &&
        typeof turnPayload.revision === "number" &&
        turnPayload.applied &&
        typeof turnPayload.applied === "object"
      ) {
        const applied = turnPayload.applied as { type?: unknown; targetCellId?: unknown };
        if (
          (applied.type === "move" || applied.type === "pit" || applied.type === "skip") &&
          (applied.targetCellId === undefined || typeof applied.targetCellId === "string")
        ) {
          window.dispatchEvent(
            new CustomEvent<BackendTurnAppliedEventDetail>("srp:backend-turn-applied", {
              detail: {
                lobbyId: turnPayload.lobbyId,
                playerId: turnPayload.playerId,
                revision: turnPayload.revision,
                applied: {
                  type: applied.type,
                  ...(applied.targetCellId ? { targetCellId: applied.targetCellId } : {})
                }
              }
            })
          );
        }
      }
    }
    return;
  }
  if (eventName === "race.ended" && payload && typeof payload === "object") {
    const lobby = (payload as { lobby?: unknown }).lobby;
    if (lobby && typeof lobby === "object" && "lobbyId" in lobby) {
      applyLobbyState(lobby as PublicLobby, "race.ended");
    }
  }
}

function disconnectBackendSocket() {
  backendShouldReconnect = false;
  clearBackendReconnectTimer();
  if (!backendSocket) return;
  const socket = backendSocket;
  backendSocket = null;
  logMultiplayerClient("ws.disconnect.requested");
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
  setStatus(`ws connecting (${reason})...`);
  logMultiplayerClient("ws.connecting", { reason });

  socket.addEventListener("open", () => {
    if (backendSocket !== socket) return;
    backendReconnectAttempt = 0;
    setStatus("ws connected");
    logMultiplayerClient("ws.open", { reason });
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
      setStatus("ws parse error");
      logMultiplayerClient("ws.parse_error");
    }
  });

  socket.addEventListener("close", (event) => {
    if (backendSocket !== socket) return;
    backendSocket = null;
    if (!backendShouldReconnect) return;
    logMultiplayerClient("ws.close", { code: event.code, reason: event.reason || "" });

    if (event.code === 1008) {
      kickToHome("Your session expired.");
      return;
    }
    if (event.code === 4001) {
      backendShouldReconnect = false;
      if (lastLobby?.terminationReason === "race_finished") return;
      kickToHome("The host disconnected. The lobby is closed.");
      return;
    }
    scheduleBackendReconnect();
  });

  socket.addEventListener("error", () => {
    if (backendSocket !== socket) return;
    setStatus("ws error");
    logMultiplayerClient("ws.error");
  });
}

function openSession(
  response: { lobby: PublicLobby; playerId: string; playerToken: string },
  reason: string
) {
  backendSession = {
    lobbyId: response.lobby.lobbyId,
    playerId: response.playerId,
    playerToken: response.playerToken,
    revision: response.lobby.revision,
    isHost: response.lobby.hostPlayerId === response.playerId
  };
  applyLobbyState(response.lobby, reason);
  void connectBackendSocket(reason);
}

async function hostLobby() {
  if (backendBusy) return;
  showNotice(null);
  setBackendBusy(true);
  setStatus("creating lobby...");
  logMultiplayerClient("lobby.host.start");
  try {
    const created = await backendClient.createLobby(getPlayerName(), {
      trackId: "oval16_3lanes",
      totalCars: 2,
      humanCars: 2,
      botCars: 0,
      raceLaps: 5
    });
    mode = "online";
    openSession(created, "host");
    navigate({ name: "lobby", id: created.lobby.lobbyId });
    logMultiplayerClient("lobby.host.success");
  } catch (error) {
    showNotice(`Could not create the lobby (${toErrorText(error)}).`);
    logMultiplayerClient("lobby.host.failed", { error: toErrorText(error) });
  } finally {
    setBackendBusy(false);
  }
}

// Joins (or, with a stored token for this tab, rejoins) a lobby named by the URL.
async function joinLobbyById(lobbyId: string) {
  if (joining) return;
  joining = true;
  setBackendBusy(true);
  setStatus(`joining ${lobbyId}...`);
  logMultiplayerClient("lobby.join.start", { requestedLobbyId: lobbyId });
  try {
    const joined = await backendClient.joinLobby(lobbyId, getPlayerName(), loadStoredToken(lobbyId));
    openSession(joined, "join");
    logMultiplayerClient("lobby.join.success");
  } catch (error) {
    clearStoredSession(lobbyId);
    logMultiplayerClient("lobby.join.failed", { error: toErrorText(error) });
    kickToHome(`Could not join the lobby (${toErrorText(error)}).`);
  } finally {
    joining = false;
    setBackendBusy(false);
  }
}

function extractLobbyId(input: string): string {
  const text = input.trim();
  try {
    const route = parseRoute(new URL(text).pathname);
    if (route.name === "lobby" || route.name === "lobbyRace") return route.id;
  } catch {
    // not a URL: treat as a bare lobby code
  }
  return text;
}

async function startRace() {
  if (backendBusy) return;
  if (mode === "solo") {
    soloRaceRequested = true;
    navigate({ name: "soloRace" });
    return;
  }
  if (!backendSession?.isHost) return;
  setBackendBusy(true);
  setStatus("starting race...");
  logMultiplayerClient("race.start.requested");
  try {
    const started = await backendClient.startRace(backendSession.lobbyId, backendSession.playerToken);
    applyLobbyState(started.lobby, "start");
    logMultiplayerClient("race.start.accepted");
  } catch (error) {
    setStatus(`start failed (${toErrorText(error)})`);
    logMultiplayerClient("race.start.failed", { error: toErrorText(error) });
  } finally {
    setBackendBusy(false);
  }
}

async function changeSettings() {
  const humanCars = Number.parseInt(lobbyHumans.value, 10);
  const botCars = Number.parseInt(lobbyBots.value, 10);
  const raceLaps = Math.max(1, Math.min(999, Number.parseInt(lobbyLaps.value, 10) || 1));
  if (mode === "solo") {
    soloSettings.botCars = botCars;
    soloSettings.raceLaps = raceLaps;
    renderLobby();
    return;
  }
  if (!backendSession?.isHost) return;
  try {
    const updated = await backendClient.updateSettings(
      backendSession.lobbyId,
      backendSession.playerToken,
      { humanCars, botCars, raceLaps }
    );
    applyLobbyState(updated.lobby, "settings");
  } catch (error) {
    setStatus(`settings rejected (${toErrorText(error)})`);
    renderLobby();
  }
}

async function copyInviteLink() {
  if (!lobbyInviteLink.value) return;
  try {
    await navigator.clipboard.writeText(lobbyInviteLink.value);
    setStatus("invite link copied");
  } catch (error) {
    setStatus(`invite copy failed (${toErrorText(error)})`);
  }
}

async function submitTurnAction(action: BackendTurnAction) {
  if (!backendSession || lastLobby?.status !== "IN_RACE" || backendBusy) return;
  let revision = backendSession.revision;
  const clientCommandId = makeCommandId();
  logMultiplayerClient("turn.submit.start", { clientCommandId, action: action.type });

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
        // The race.state / race.ended events can arrive before this response: never
        // move the revision backwards or overwrite an end-of-race status.
        backendSession.revision = Math.max(backendSession.revision, result.revision);
        logMultiplayerClient("turn.submit.applied", { clientCommandId, revision: result.revision });
        return;
      }
      if (result.error === "stale_revision") {
        revision = result.revision;
        backendSession.revision = result.revision;
        logMultiplayerClient("turn.submit.stale_revision", {
          clientCommandId,
          revision: result.revision
        });
        continue;
      }
      backendSession.revision = result.revision;
      if (result.error === "lobby_not_in_race") {
        setStatus("lobby not in race");
        logMultiplayerClient("turn.submit.rejected", {
          clientCommandId,
          reason: "lobby_not_in_race"
        });
        return;
      }
      if (result.error === "not_active_player") {
        setStatus("not your turn");
        logMultiplayerClient("turn.submit.rejected", {
          clientCommandId,
          reason: "not_active_player"
        });
        void rehydrateLobbyState("not-active-player");
        return;
      }
      setStatus(
        result.error === "invalid_action"
          ? `move rejected (${result.reason ?? "invalid"})`
          : `turn rejected (${result.error})`
      );
      logMultiplayerClient("turn.submit.rejected", {
        clientCommandId,
        reason: result.error,
        engineReason: result.reason
      });
      void rehydrateLobbyState("turn-rejected");
      return;
    } catch (error) {
      setStatus(`turn submit failed (${toErrorText(error)})`);
      logMultiplayerClient("turn.submit.failed", {
        clientCommandId,
        error: toErrorText(error)
      });
      void rehydrateLobbyState("turn-failed");
      return;
    }
  }

  setStatus(`turn stale (rev ${backendSession.revision})`);
  logMultiplayerClient("turn.submit.give_up", { clientCommandId });
}

// ---- wiring --------------------------------------------------------------------------------

el("homeQuickBtn").addEventListener("click", () => {
  showNotice(null);
  navigate({ name: "solo" });
});
el("homeCreateBtn").addEventListener("click", () => void hostLobby());
el("homeJoinBtn").addEventListener("click", () => {
  const id = extractLobbyId(homeJoinCode.value);
  if (id.length === 0) {
    showNotice("Enter a lobby code first.");
    return;
  }
  showNotice(null);
  navigate({ name: "lobby", id });
});
homeName.addEventListener("change", () => {
  try {
    window.localStorage.setItem("srp:name", getPlayerName());
  } catch {
    // ignore
  }
});

for (const input of [lobbyHumans, lobbyBots, lobbyLaps]) {
  input.addEventListener("change", () => void changeSettings());
}
lobbyStartBtn.addEventListener("click", () => void startRace());
lobbyCopyBtn.addEventListener("click", () => void copyInviteLink());
lobbyLeaveBtn.addEventListener("click", () => navigate({ name: "home" }));

el("resultsLobbyBtn").addEventListener("click", () => {
  if (mode === "online" && backendSession) {
    navigate({ name: "lobby", id: backendSession.lobbyId });
  } else {
    navigate({ name: "solo" });
  }
});
el("resultsHomeBtn").addEventListener("click", () => navigate({ name: "home" }));

window.addEventListener("srp:local-turn-action", (event) => {
  const custom = event as CustomEvent<BackendTurnAction>;
  if (!custom.detail) return;
  void submitTurnAction(custom.detail);
});

window.addEventListener("srp:race-finished", (event) => {
  const winner = (event as CustomEvent<{ winnerCarId: number | null }>).detail?.winnerCarId ?? null;
  showResults(winner);
});

// The scene starts listening only after it is built: hand it the latest lobby state.
window.addEventListener("srp:scene-ready", () => {
  if (mode !== "online" || !backendSession || !lastLobby) return;
  window.dispatchEvent(
    new CustomEvent<BackendLobbyStateEventDetail>("srp:backend-lobby-state", {
      detail: { lobby: lastLobby, source: "scene-ready", localPlayerId: backendSession.playerId }
    })
  );
});

// Keyboard shortcut next to the scene's F (forwardIndex overlay).
window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "c" || event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.body.dataset.screen !== "race") return;
  window.dispatchEvent(new Event("srp:toggle-cars-moves"));
});

window.addEventListener("beforeunload", () => {
  disconnectBackendSocket();
});

try {
  homeName.value = window.localStorage.getItem("srp:name") || homeName.value;
} catch {
  // ignore
}
setStatus(`ready (${backendApiBaseUrl})`);
startRouter((route, source) => void handleRoute(route, source));
