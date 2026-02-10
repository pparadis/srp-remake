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
const backendLobbyLinkInput = document.getElementById(
  "backendLobbyLinkInput"
) as HTMLInputElement | null;
const backendCopyInviteBtn = document.getElementById(
  "backendCopyInviteBtn"
) as HTMLButtonElement | null;
const backendOpenInviteBtn = document.getElementById(
  "backendOpenInviteBtn"
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
const backendCopyMpDebugBtn = document.getElementById(
  "backendCopyMpDebugBtn"
) as HTMLButtonElement | null;
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

type BackendLobbyStateEventDetail = {
  lobby: PublicLobby;
  source: string;
  localPlayerId: string;
};

type BackendTurnAppliedEventDetail = {
  lobbyId: string;
  playerId: string;
  revision: number;
  applied: BackendTurnAction;
};

let backendSession: BackendSession | null = null;
let backendSocket: WebSocket | null = null;
let backendReconnectTimer: number | null = null;
let backendShouldReconnect = false;
let backendReconnectAttempt = 0;
let inviteAutoJoinRequested = false;
let clientTimelineSeq = 1;
const clientTimelineLimit = 500;
const clientTimeline: Array<{
  seq: number;
  at: number;
  event: string;
  context: Record<string, unknown>;
}> = [];

function getLobbyIdFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const lobbyId = url.searchParams.get("lobby")?.trim() ?? "";
    return lobbyId.length > 0 ? lobbyId : null;
  } catch {
    return null;
  }
}

function buildLobbyInviteUrl(lobbyId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("lobby", lobbyId);
  return url.toString();
}

function syncLobbyUrl(lobbyId: string | null) {
  const url = new URL(window.location.href);
  if (lobbyId) {
    url.searchParams.set("lobby", lobbyId);
  } else {
    url.searchParams.delete("lobby");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function updateInviteUi(lobbyId: string | null) {
  if (!backendLobbyLinkInput) return;
  if (!lobbyId) {
    backendLobbyLinkInput.value = "";
    if (backendCopyInviteBtn) backendCopyInviteBtn.disabled = true;
    if (backendOpenInviteBtn) backendOpenInviteBtn.disabled = true;
    return;
  }
  backendLobbyLinkInput.value = buildLobbyInviteUrl(lobbyId);
  if (backendCopyInviteBtn) backendCopyInviteBtn.disabled = backendBusy;
  if (backendOpenInviteBtn) backendOpenInviteBtn.disabled = backendBusy;
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
  clientTimeline.push({
    seq: clientTimelineSeq++,
    at: payload.ts,
    event,
    context: payload
  });
  if (clientTimeline.length > clientTimelineLimit) {
    clientTimeline.splice(0, clientTimeline.length - clientTimelineLimit);
  }
  console.info("[multiplayer]", payload);
}

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
  syncLobbyUrl(lobby.lobbyId);
  updateInviteUi(lobby.lobbyId);
  if (backendLobbyIdInput) {
    backendLobbyIdInput.value = lobby.lobbyId;
  }
  setBackendStatusText(
    `Backend: ${source} -> ${lobby.status.toLowerCase()} (rev ${lobby.revision}, players ${lobby.players.length})`
  );
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
    setBackendStatusText(`Backend: rehydrate failed (${toErrorText(error)})`);
    logMultiplayerClient("lobby.rehydrate.failed", { reason, error: toErrorText(error) });
  }
}

function scheduleBackendReconnect() {
  if (!backendShouldReconnect || !backendSession) return;
  clearBackendReconnectTimer();
  const delayMs = Math.min(5000, 500 * 2 ** Math.min(backendReconnectAttempt, 5));
  backendReconnectAttempt += 1;
  setBackendStatusText(`Backend: ws reconnect in ${delayMs}ms`);
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
        setBackendStatusText(`Backend: turn applied (rev ${backendSession.revision})`);
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
  setBackendStatusText(`Backend: ws connecting (${reason})...`);
  logMultiplayerClient("ws.connecting", { reason });

  socket.addEventListener("open", () => {
    if (backendSocket !== socket) return;
    backendReconnectAttempt = 0;
    setBackendStatusText("Backend: ws connected");
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
      setBackendStatusText("Backend: ws parse error");
      logMultiplayerClient("ws.parse_error");
    }
  });

  socket.addEventListener("close", (event) => {
    if (backendSocket !== socket) return;
    backendSocket = null;
    if (!backendShouldReconnect) return;
    logMultiplayerClient("ws.close", { code: event.code, reason: event.reason || "" });

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
    logMultiplayerClient("ws.error");
  });
}

async function copyMultiplayerDebugSnapshot() {
  const snapshot: Record<string, unknown> = {
    version: "multiplayer-debug-v1",
    // eslint-disable-next-line no-undef
    gitSha: __GIT_SHA__,
    generatedAt: new Date().toISOString(),
    backendApiBaseUrl,
    backendWsBaseUrl,
    session: backendSession,
    clientTimeline
  };

  if (backendSession) {
    const headers: Record<string, string> = {};
    const adminToken = import.meta.env.VITE_BACKEND_ADMIN_TOKEN?.trim();
    if (adminToken && adminToken.length > 0) {
      headers.authorization = `Bearer ${adminToken}`;
    }
    try {
      const res = await fetch(
        `${backendApiBaseUrl}/admin/lobbies/${encodeURIComponent(backendSession.lobbyId)}/timeline?limit=500`,
        { headers }
      );
      const text = await res.text();
      let payload: unknown = { raw: text };
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          // Keep raw payload fallback.
        }
      }
      if (res.ok) {
        snapshot.backendTimeline = payload;
      } else {
        snapshot.backendTimelineError = {
          status: res.status,
          payload
        };
      }
    } catch (error) {
      snapshot.backendTimelineError = {
        error: error instanceof Error ? error.message : "unknown_error"
      };
    }
  }

  try {
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    setBackendStatusText("Backend: multiplayer debug copied");
    logMultiplayerClient("debug.copy.success");
  } catch (error) {
    setBackendStatusText("Backend: multiplayer debug copy failed");
    logMultiplayerClient("debug.copy.failed", {
      error: error instanceof Error ? error.message : "unknown_error"
    });
  }
}

function setBackendBusy(nextBusy: boolean) {
  backendBusy = nextBusy;
  if (backendHostBtn) backendHostBtn.disabled = nextBusy;
  if (backendJoinBtn) backendJoinBtn.disabled = nextBusy;
  if (backendStartBtn) backendStartBtn.disabled = nextBusy;
  if (backendCopyMpDebugBtn) backendCopyMpDebugBtn.disabled = nextBusy;
  const hasInvite = (backendLobbyLinkInput?.value?.trim().length ?? 0) > 0;
  if (backendCopyInviteBtn) backendCopyInviteBtn.disabled = nextBusy || !hasInvite;
  if (backendOpenInviteBtn) backendOpenInviteBtn.disabled = nextBusy || !hasInvite;
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

async function copyInviteLink() {
  const inviteUrl =
    (backendLobbyLinkInput?.value?.trim() ?? "") ||
    (backendSession ? buildLobbyInviteUrl(backendSession.lobbyId) : "");
  if (inviteUrl.length === 0) {
    setBackendStatusText("Backend: no invite link yet");
    return;
  }
  try {
    await navigator.clipboard.writeText(inviteUrl);
    setBackendStatusText("Backend: invite link copied");
  } catch (error) {
    setBackendStatusText(`Backend: invite copy failed (${toErrorText(error)})`);
  }
}

function openInviteLink() {
  const inviteUrl =
    (backendLobbyLinkInput?.value?.trim() ?? "") ||
    (backendSession ? buildLobbyInviteUrl(backendSession.lobbyId) : "");
  if (inviteUrl.length === 0) {
    setBackendStatusText("Backend: no invite link yet");
    return;
  }
  window.open(inviteUrl, "_blank", "noopener,noreferrer");
}

function requestAutoJoinFromInvite() {
  if (inviteAutoJoinRequested) return;
  if (backendSession) return;
  inviteAutoJoinRequested = true;
  setBackendStatusText("Backend: joining from invite...");
  void joinLobby();
}

async function hostLobby() {
  if (backendBusy) return;
  setBackendBusy(true);
  setBackendStatusText("Backend: creating lobby...");
  logMultiplayerClient("lobby.host.start");
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
    syncLobbyUrl(created.lobby.lobbyId);
    updateInviteUi(created.lobby.lobbyId);
    setBackendStatusText(`Backend: hosted ${created.lobby.lobbyId} (rev ${created.lobby.revision})`);
    logMultiplayerClient("lobby.host.success");
    void connectBackendSocket("host");
  } catch (error) {
    setBackendStatusText(`Backend: host failed (${toErrorText(error)})`);
    logMultiplayerClient("lobby.host.failed", { error: toErrorText(error) });
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
  logMultiplayerClient("lobby.join.start", { requestedLobbyId: lobbyId });
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
    syncLobbyUrl(joined.lobby.lobbyId);
    updateInviteUi(joined.lobby.lobbyId);
    setBackendStatusText(`Backend: joined ${joined.lobby.lobbyId} (rev ${joined.lobby.revision})`);
    logMultiplayerClient("lobby.join.success");
    void connectBackendSocket("join");
  } catch (error) {
    setBackendStatusText(`Backend: join failed (${toErrorText(error)})`);
    logMultiplayerClient("lobby.join.failed", { error: toErrorText(error) });
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
  logMultiplayerClient("race.start.requested");
  try {
    const started = await backendClient.startRace(
      backendSession.lobbyId,
      backendSession.playerToken
    );
    backendSession.revision = started.lobby.revision;
    backendRaceStarted = started.lobby.status === "IN_RACE";
    setBackendStatusText(`Backend: race started (rev ${backendSession.revision})`);
    logMultiplayerClient("race.start.accepted");
  } catch (error) {
    setBackendStatusText(`Backend: start failed (${toErrorText(error)})`);
    logMultiplayerClient("race.start.failed", { error: toErrorText(error) });
  } finally {
    setBackendBusy(false);
  }
}

async function submitTurnAction(action: BackendTurnAction) {
  if (!backendSession || !backendRaceStarted || backendBusy) return;
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
        backendSession.revision = result.revision;
        setBackendStatusText(`Backend: turn synced (rev ${result.revision})`);
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
      if (result.error === "lobby_not_in_race") {
        backendRaceStarted = false;
        backendSession.revision = result.revision;
        setBackendStatusText("Backend: lobby not in race");
        logMultiplayerClient("turn.submit.rejected", {
          clientCommandId,
          reason: "lobby_not_in_race"
        });
        return;
      }
      if (result.error === "not_active_player") {
        backendSession.revision = result.revision;
        setBackendStatusText("Backend: not your turn");
        logMultiplayerClient("turn.submit.rejected", {
          clientCommandId,
          reason: "not_active_player"
        });
        void rehydrateLobbyState("not-active-player");
        return;
      }
      setBackendStatusText(`Backend: turn rejected (${result.error})`);
      logMultiplayerClient("turn.submit.rejected", {
        clientCommandId,
        reason: result.error
      });
      return;
    } catch (error) {
      setBackendStatusText(`Backend: turn submit failed (${toErrorText(error)})`);
      logMultiplayerClient("turn.submit.failed", {
        clientCommandId,
        error: toErrorText(error)
      });
      return;
    }
  }

  setBackendStatusText(`Backend: turn stale (rev ${backendSession.revision})`);
  logMultiplayerClient("turn.submit.give_up", { clientCommandId });
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
  syncLobbyUrl(null);
  updateInviteUi(null);
  if (backendLobbyIdInput) backendLobbyIdInput.value = "";
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

backendCopyInviteBtn?.addEventListener("click", () => {
  void copyInviteLink();
});

backendOpenInviteBtn?.addEventListener("click", () => {
  openInviteLink();
});

backendCopyMpDebugBtn?.addEventListener("click", () => {
  void copyMultiplayerDebugSnapshot();
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

const lobbyIdFromUrl = getLobbyIdFromUrl();
if (lobbyIdFromUrl) {
  if (backendLobbyIdInput) backendLobbyIdInput.value = lobbyIdFromUrl;
  updateInviteUi(lobbyIdFromUrl);
  setBackendStatusText(`Backend: invite loaded (${lobbyIdFromUrl})`);
  requestAutoJoinFromInvite();
} else {
  updateInviteUi(null);
}
