import './style.css';
import {
  formatCountdown,
  mountHud,
  renderFps,
  renderHud,
  renderMute,
  renderResults,
  showToast,
  type HudSnapshot,
  type ToastKind
} from './ui/hud';
import { must } from './game/must';
import { fpsText, startFpsMeter } from './ui/fps_meter';
import { currentlyMuted, initSound, setMuted } from './ui/sound';
import { mountSandboxPanel } from './ui/sandbox_panel';
import { randomPlayerName } from './ui/player_name';
import { createChat, isChatMessage } from './ui/chat';
import { isCompactHud } from './ui/layout';
import { isTypingTarget } from './ui/typing';
import type { RaceLog } from './game/race/race_log';
import type { Replay } from './ui/replay_load';
import { mountRecapPage } from './ui/recap_page';
import { mountHistoryPage } from './ui/history_page';
import { listSavedRaces, loadSavedRace, saveRace, type SavedRace } from './ui/recap_store';
import { renderHomeTrack, setHomeTrackRunning } from './ui/home_track';
import { mountVersion, renderVersion, type ServerVersion } from './ui/version';
import { showUncaughtErrors, startRenderProbe } from './ui/diagnostics';
import { MAX_SEED, normalizeSeed } from './game/systems/bot_style';
import { DEFAULT_RULES_VERSION, isRulesVersion, type RulesVersion } from './game/rules/ids';
import {
  BackendApiClient,
  BackendApiError,
  resolveBackendBaseUrl,
  resolveBackendWsBaseUrl,
  type PublicLobby,
  type AppliedTurnSummary,
  type BackendTurnAction,
  type BotLevel,
  type TurnSource,
  type TurnTimerSec
} from './net/backend_api';
import {
  currentRoute,
  navigate,
  parseRoute,
  routePath,
  screenOf,
  startRouter,
  type Route,
  type Screen
} from './ui/router';

function el<T extends HTMLElement>(id: string): T {
  return must(document.getElementById(id), `element #${id}`) as T;
}

const app = el('app');
showUncaughtErrors(el('crashReport'));
const homeTrack = must(document.querySelector<SVGSVGElement>('#homeTrack'), 'element #homeTrack');
const statusLine = el('statusLine');
const homeNotice = el('homeNotice');
const homeName = el<HTMLInputElement>('homeName');
const homeJoinCode = el<HTMLInputElement>('homeJoinCode');
const homeButtons = ['homeQuickBtn', 'homeCreateBtn', 'homeJoinBtn'].map((id) =>
  el<HTMLButtonElement>(id)
);
const lobbyTitle = el('lobbyTitle');
const lobbyNote = el('lobbyNote');
const lobbyPlayersBlock = el('lobbyPlayersBlock');
const lobbyPlayers = el('lobbyPlayers');
const lobbyName = el<HTMLInputElement>('lobbyName');
const lobbyNameField = el('lobbyNameField');
const lobbyNameHint = el('lobbyNameHint');
const lobbyChatBlock = el('lobbyChatBlock');
const lobbyChatSlot = el('lobbyChatSlot');
const lobbyHumans = el<HTMLSelectElement>('lobbyHumans');
const lobbyHumansField = el('lobbyHumansField');
const lobbyBots = el<HTMLSelectElement>('lobbyBots');
const lobbyLaps = el<HTMLInputElement>('lobbyLaps');
const lobbyBotLevel = el<HTMLSelectElement>('lobbyBotLevel');
const lobbyBotLevelField = el('lobbyBotLevelField');
const lobbyRules = el<HTMLSelectElement>('lobbyRules');
const lobbyRulesField = el('lobbyRulesField');
const lobbyShareField = el('lobbyShareField');
const lobbyShare = el<HTMLInputElement>('lobbyShare');
const lobbyTurnTimer = el<HTMLSelectElement>('lobbyTurnTimer');
const lobbyTurnTimerField = el('lobbyTurnTimerField');
const connectionBanner = el('connectionBanner');
const lobbyInviteBlock = el('lobbyInviteBlock');
const lobbyInviteLink = el<HTMLInputElement>('lobbyInviteLink');
const lobbyCopyBtn = el<HTMLButtonElement>('lobbyCopyBtn');
const lobbyStartBtn = el<HTMLButtonElement>('lobbyStartBtn');
const lobbyPlayAgainBtn = el<HTMLButtonElement>('lobbyPlayAgainBtn');
const resultsPlayAgainBtn = el<HTMLButtonElement>('resultsPlayAgainBtn');
const resultsWait = el('resultsWait');
const lobbyLeaveBtn = el<HTMLButtonElement>('lobbyLeaveBtn');
const results = el('results');
const resultsWinner = el('resultsWinner');
const resultsRecapBtn = el<HTMLButtonElement>('resultsRecapBtn');
const resultsShared = el('resultsShared');
const homeRaces = el('homeRaces');
const homeRaceList = el('homeRaceList');
const hud = el('hud');
mountHud(hud);
function hudPart<T extends HTMLElement>(selector: string): T {
  return must(hud.querySelector<T>(selector), `HUD part ${selector}`);
}
const hudChat = hudPart<HTMLDetailsElement>('[data-testid="hud-chat"]');
const hudChatBody = hudPart('[data-testid="hud-chat-body"]');
const hudChatUnread = hudPart('[data-testid="hud-chat-unread"]');
const hudDrawerDot = hudPart('[data-testid="hud-drawer-dot"]');
const hudDrawerToggle = hudPart('[data-testid="hud-drawer-toggle"]');
// `?sandbox` (solo only): a dev tool to place cars by hand; `?pos=<base64 of a Copy debug snapshot>` starts from one.
const sandbox = new URLSearchParams(window.location.search).has('sandbox');
// Sharp canvas on a high-density screen (src/game/hidpi.ts), on by default; `?hidpi=0` turns it off and a bare `?hidpi`
// adds a probe line. Read once, the router drops the query.
const hidpiParam = new URLSearchParams(window.location.search).get('hidpi');
const hidpi = hidpiParam !== '0';
const hidpiProbe = hidpiParam !== null && hidpiParam !== '0';
// `?anim`: glide the cars in a test build too (the e2e build moves them at once; one spec turns this on)
const animate = new URLSearchParams(window.location.search).has('anim');
// `?fps` starts the frame-rate readout on; the P key (or the touch button) toggles it during a race (issue #79)
let fpsOn = new URLSearchParams(window.location.search).has('fps');
let stopFps: (() => void) | null = null;
if (sandbox) mountSandboxPanel(hudPart('.hud-right'));
renderMute(hud, currentlyMuted());
initSound();

// Starts or stops the readout for the current game; with no game yet it only remembers the choice
// (ensureGameStarted applies it).
function applyFps() {
  stopFps?.();
  stopFps = null;
  renderFps(hud, fpsOn, 'fps \u2026');
  if (fpsOn && game) {
    stopFps = startFpsMeter((stats) => renderFps(hud, true, fpsText(stats)), game);
  }
}

function toggleFps() {
  fpsOn = !fpsOn;
  applyFps();
}

function toggleMute() {
  setMuted(!currentlyMuted());
  renderMute(hud, currentlyMuted());
}
hudPart('[data-testid="hud-mute"]').addEventListener('click', toggleMute);
hudPart('[data-testid="hud-fps-toggle"]').addEventListener('click', toggleFps);
renderFps(hud, fpsOn, 'fps \u2026'); // `?fps`: the meter itself starts with the game (ensureGameStarted)
const hudTimer = hudPart('[data-testid="hud-timer"]');
const hudForceSkip = hudPart<HTMLButtonElement>('[data-testid="hud-force-skip"]');

// `?seed=N` reproduces a solo race (bot personalities and grid); otherwise each race gets a fresh
// one. The seed is made here, at the boundary: the engine never rolls dice.
const seedParam = new URLSearchParams(window.location.search).get('seed');
const urlSeed = seedParam === null ? null : normalizeSeed(seedParam); // 0 is a valid, pinned seed
// `?rules=v1` starts the menu's Rules on that version (the sandbox link carries it); the menu is how it is chosen.
const rulesParam = new URLSearchParams(window.location.search).get('rules');
function freshSeed(): number {
  return (must(crypto.getRandomValues(new Uint32Array(1))[0], 'random number') % MAX_SEED) + 1;
}

function startPosition(): string | undefined {
  const raw = new URLSearchParams(window.location.search).get('pos');
  try {
    return sandbox && raw ? atob(raw) : undefined;
  } catch {
    return undefined; // not base64: start without a position
  }
}
const sandboxPosition = startPosition();

let game: ReturnType<typeof import('./game').startGame> | null = null;
let gameStarting = false;
let stopRenderProbe: (() => void) | null = null;
let backendBusy = false;
let mode: 'solo' | 'online' = 'solo';
let soloRaceRequested = false;
let raceOver = false;
const soloSettings: {
  botCars: number;
  raceLaps: number;
  botLevel: BotLevel;
  seed: number;
  rulesVersion: RulesVersion;
} = {
  seed: 0,
  rulesVersion: isRulesVersion(rulesParam) ? rulesParam : DEFAULT_RULES_VERSION,
  botCars: 3,
  raceLaps: 5,
  botLevel: 'normal'
};
try {
  // a position decides how many cars the race needs
  const cars =
    (JSON.parse(sandboxPosition ?? 'null') as { cars?: unknown[] } | null)?.cars?.length ?? 0;
  if (cars >= 1 && cars <= 11) soloSettings.botCars = cars - 1;
} catch {
  // unreadable position: the scene will say so
}
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

interface BackendLobbyStateEventDetail {
  lobby: PublicLobby;
  source: string;
  localPlayerId: string;
}

interface BackendTurnAppliedEventDetail {
  lobbyId: string;
  playerId: string;
  revision: number;
  applied: AppliedTurnSummary;
  source?: TurnSource;
}

let backendSession: BackendSession | null = null;
let lastLobby: PublicLobby | null = null;
let backendSocket: WebSocket | null = null;
let backendReconnectTimer: number | null = null;
let backendShouldReconnect = false;
let backendReconnectAttempt = 0;
let joining = false;
let reconnecting = false;
let wakingServer = false;
// When the active human seat gets auto-played (local clock = receipt time + the server's remaining time).
let turnDeadlineAt: number | null = null;
const WAKE_NOTICE_DELAY_MS = 3000;

function setStatus(text: string) {
  statusLine.textContent = text;
}

function showNotice(text: string | null) {
  homeNotice.textContent = text ?? '';
  homeNotice.hidden = text === null;
}

function renderConnectionBanner() {
  const hostAway =
    mode === 'online' &&
    backendSession !== null &&
    !backendSession.isHost &&
    lastLobby !== null &&
    lastLobby.status !== 'FINISHED' &&
    lastLobby.players.some((player) => player.isHost && !player.connected);
  const text = wakingServer
    ? 'Waking the server, this can take up to a minute...'
    : reconnecting
      ? 'Reconnecting...'
      : hostAway
        ? 'Host disconnected: waiting for them to come back...'
        : null;
  connectionBanner.hidden = text === null;
  connectionBanner.textContent = text ?? '';
}

// Shows the cold-start notice if `request` is still pending after a few seconds.
async function withWakeNotice<T>(request: Promise<T>): Promise<T> {
  const timer = window.setTimeout(() => {
    wakingServer = true;
    renderConnectionBanner();
  }, WAKE_NOTICE_DELAY_MS);
  try {
    return await request;
  } finally {
    window.clearTimeout(timer);
    wakingServer = false;
    renderConnectionBanner();
  }
}

function renderTurnTimer() {
  const race = lastLobby?.raceState;
  const live =
    mode === 'online' &&
    backendSession !== null &&
    lastLobby?.status === 'IN_RACE' &&
    race !== undefined &&
    !raceOver &&
    document.body.dataset.screen === 'race';
  const remainingMs = turnDeadlineAt === null ? null : turnDeadlineAt - Date.now();
  hudTimer.hidden = !(live && remainingMs !== null);
  if (live && remainingMs !== null) {
    hudTimer.textContent = `Auto-play in ${formatCountdown(remainingMs)}`;
    hudTimer.classList.toggle('is-warn', remainingMs < 10_000);
  }
  const activeCar = race?.cars.find((car) => car.seatIndex === race.activeSeatIndex);
  const stuckHuman = activeCar?.playerId != null && activeCar.playerId !== backendSession?.playerId;
  hudForceSkip.hidden = !(live && backendSession?.isHost && stuckHuman);
}

// sessionStorage is per tab: a reload rejoins with the same player token, a second tab is a new player.
function sessionKey(lobbyId: string): string {
  return `srp:session:${lobbyId}`;
}

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
    return typeof parsed?.playerToken === 'string' ? parsed.playerToken : undefined;
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
  return `${window.location.origin}${routePath({ name: 'lobby', id: lobbyId })}`;
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
  console.info('[multiplayer]', payload);
}

function makeCommandId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toErrorText(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (error.status === 429) return 'Too many requests, try again in a few seconds';
    const payload = error.payload as { error?: string };
    const reason = typeof payload?.error === 'string' ? payload.error : 'request_failed';
    return `HTTP ${error.status}: ${reason}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unknown_error';
}

// ---- chat (online only) ---------------------------------------------------------------------
// One panel element: the lobby card holds it on the lobby screen, the collapsible HUD panel during the race.

async function sendChatText(text: string) {
  if (!backendSession) throw new Error('Not connected to a lobby');
  try {
    const { message } = await backendClient.sendChat(
      backendSession.lobbyId,
      backendSession.playerToken,
      text
    );
    // the broadcast brings it too; the panel drops the duplicate
    chat.add(message);
  } catch (error) {
    throw new Error(toErrorText(error));
  }
}

const chat = createChat({ send: sendChatText });
let chatUnread = 0;

// The panel is "seen" on the lobby screen; in a race only while its HUD panel is open (and, on a phone, the drawer).
function renderChatBadges() {
  const drawerOpen = hud.classList.contains('is-drawer-open');
  const onRace = document.body.dataset.screen === 'race';
  chat.setSeen(!onRace || (hudChat.open && (!isCompactHud() || drawerOpen)));
  hudChatUnread.hidden = chatUnread === 0;
  hudChatUnread.textContent = ` (${chatUnread})`;
  hudDrawerDot.hidden = chatUnread === 0 || drawerOpen;
}

chat.onUnread((count) => {
  chatUnread = count;
  renderChatBadges();
});
hudChat.addEventListener('toggle', renderChatBadges);
hudDrawerToggle.addEventListener('click', renderChatBadges);

function placeChat() {
  const online = mode === 'online' && backendSession !== null;
  const screen = document.body.dataset.screen;
  lobbyChatBlock.hidden = !(online && screen === 'lobby');
  hudChat.hidden = !(online && screen === 'race');
  if (online) (screen === 'race' ? hudChatBody : lobbyChatSlot).append(chat.element);
  renderChatBadges();
}

// The name a player who has not picked one races as, like Docker's container names ("steady_hairpin"). Stable for the page
// load: it is also what an emptied name field falls back to.
const defaultName = randomPlayerName();

function getPlayerName(): string {
  const raw = homeName.value.trim();
  return raw.length > 0 ? raw : defaultName;
}

interface RaceComposition {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel: BotLevel;
  seed: number;
  rulesVersion?: RulesVersion;
  sandbox?: boolean;
  position?: string;
}

// What the game scene is built from: the lobby's settings online, the lobby card offline.
function getComposition(): RaceComposition {
  if (replayRun) return replayRun.composition;
  if (mode === 'online' && lastLobby) {
    const { totalCars, humanCars, botCars, raceLaps, botLevel } = lastLobby.settings;
    return {
      totalCars,
      humanCars,
      botCars,
      raceLaps,
      botLevel,
      seed: lastLobby.raceState?.seed ?? 0
    };
  }
  return {
    totalCars: 1 + soloSettings.botCars,
    humanCars: 1,
    botCars: soloSettings.botCars,
    raceLaps: soloSettings.raceLaps,
    botLevel: soloSettings.botLevel,
    seed: soloSettings.seed,
    rulesVersion: soloSettings.rulesVersion,
    ...(sandbox ? { sandbox, ...(sandboxPosition ? { position: sandboxPosition } : {}) } : {})
  };
}

// ---- screens -------------------------------------------------------------------------------

function destroyGame() {
  if (game) {
    // Phaser takes its canvas out of the page only on its next frame: do it now, so a race started right away (race
    // again) never has two canvases on the page
    game.canvas?.remove();
    game.destroy(true);
    game = null;
  }
  stopRenderProbe?.();
  stopRenderProbe = null;
  stopFps?.();
  stopFps = null;
  delete window.__srp;
}

function showScreen(screen: Screen) {
  const changed = document.body.dataset.screen !== screen;
  document.body.dataset.screen = screen;
  if (screen !== 'race') {
    destroyGame();
    results.hidden = true;
    raceOver = false;
    stopReplay();
  }
  setHomeTrackRunning(homeTrack, screen === 'home');
  // the race screen can leave the page (or the home screen) scrolled; a screen opens at its top. Only on a change:
  // every lobby update calls showScreen("lobby") again and must not throw the scroll back
  if (changed) {
    document.scrollingElement?.scrollTo?.(0, 0);
    document.getElementById(`screen-${screen}`)?.scrollTo?.(0, 0);
  }
  if (screen === 'home') renderHome();
  else if (screen === 'lobby') renderLobby();
  placeChat();
}

function renderHome() {
  for (const button of homeButtons) button.disabled = backendBusy;
  const races = listSavedRaces();
  homeRaces.hidden = races.length === 0;
  homeRaceList.replaceChildren(
    ...races.map((race) => {
      const item = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.dataset.testid = 'home-race';
      open.textContent = race.label;
      open.addEventListener('click', () => navigate({ name: 'recap', id: race.id }));
      item.append(open);
      return item;
    })
  );
}

// ---- recap (#169) --------------------------------------------------------------------------

const recapPage = mountRecapPage(
  el('recapPage'),
  () => {
    if (openRecapRemote) {
      navigate({ name: 'history' });
      return;
    }
    navigate(backendSession ? { name: 'lobby', id: backendSession.lobbyId } : { name: 'home' });
  },
  (state) => {
    if (!openRecapId) return;
    replayStart = state;
    navigate({ name: 'recapBoard', id: openRecapId, ...(openRecapRemote ? { remote: true } : {}) });
  }
);
// The saved race the recap page shows, and the state a board replay opens at (0 = the grid).
let openRecapId: string | null = null;
let openRecapRemote = false;
let replayStart = 0;
// The saved race the results screen offers a recap of (none: online, sandbox, or nothing could be kept).
let lastSavedRaceId: string | null = null;

interface FinishedRaceRecap {
  log: RaceLog;
  names: Record<number, string>;
}

function saveFinishedRace(
  recap: FinishedRaceRecap & { trackId: string },
  winnerCarId: number | null,
  kind: 'Solo' | 'Online',
  myCarId: number | null
): boolean {
  const winner = winnerCarId === null ? undefined : recap.names[winnerCarId];
  const laps = recap.log.raceLaps;
  const who =
    winnerCarId !== null && winnerCarId === myCarId ? 'you won' : `${winner ?? 'nobody'} won`;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const kept = saveRace({
    id,
    finishedAt: Date.now(),
    trackId: recap.trackId,
    label: `${kind}, ${laps} ${laps === 1 ? 'lap' : 'laps'}, ${who}`,
    names: Object.fromEntries(Object.entries(recap.names).map(([id, name]) => [String(id), name])),
    log: recap.log
  });
  lastSavedRaceId = kept ? id : null;
  return kept;
}

// A finished solo race goes to the server's public history (#170), anonymous (the log holds no name). On by default, the
// player can untick the box in the Quick race card; only an explicit "0" is remembered as off. The server replays the
// log before keeping it. Never in the way: it runs after the results are up, and a failure only says so.
const SHARE_KEY = 'srp:share-solo';
let shareSolo = true;
try {
  shareSolo = window.localStorage.getItem(SHARE_KEY) !== '0';
} catch {
  // storage unavailable: the default stands
}

async function shareSoloRace(log: RaceLog) {
  try {
    const stored = await backendClient.uploadRace('oval16_3lanes', log);
    resultsShared.textContent = stored.duplicate
      ? 'Already in the public history.'
      : 'Shared in the public history, anonymously.';
  } catch {
    resultsShared.textContent = 'Could not share this race now.';
  }
  if (!results.hidden) resultsShared.hidden = false;
}

lobbyShare.addEventListener('change', () => {
  shareSolo = lobbyShare.checked;
  try {
    window.localStorage.setItem(SHARE_KEY, shareSolo ? '1' : '0');
  } catch {
    // ignore
  }
});

// An online race: the server holds the log (only once somebody has won), so the client asks for it as the race ends.
async function saveOnlineRace(winnerCarId: number | null) {
  const session = backendSession;
  if (!session) return;
  const myCarId =
    lastLobby?.raceState?.cars.find((car) => car.playerId === session.playerId)?.carId ?? null;
  try {
    const recap = await backendClient.readRecap(session.lobbyId, session.playerToken);
    const names: Record<number, string> = {};
    for (const [carId, name] of Object.entries(recap.names)) names[Number(carId)] = name;
    // the player may have left the results screen while it was on its way
    if (!saveFinishedRace({ ...recap, names }, winnerCarId, 'Online', myCarId)) return;
    if (!results.hidden) resultsRecapBtn.hidden = false;
  } catch {
    // no recap this time (the lobby went, the server restarted): the results screen simply has no button
  }
}

// ---- public history (#170) -----------------------------------------------------------------

const historyPage = mountHistoryPage(el('historyPage'), {
  onBack: () => navigate({ name: 'home' }),
  onOpen: (raceId) => navigate({ name: 'recap', id: raceId, remote: true }),
  onRetry: () => void openHistory()
});
el('homeHistoryBtn').addEventListener('click', () => navigate({ name: 'history' }));

async function openHistory() {
  historyPage.showLoading();
  try {
    historyPage.showRaces((await backendClient.listRaces(50)).races);
  } catch (error) {
    const down = error instanceof BackendApiError && error.status === 503;
    historyPage.showError(
      down
        ? 'The race history is not available right now.'
        : `Could not load the history (${toErrorText(error)}).`
    );
  }
}

// A race of the public history, as the recap and the replay take it: the log has no names, so cars are told apart by seat.
async function loadRemoteRace(id: string): Promise<SavedRace> {
  const race = await backendClient.readRace(id);
  const names: Record<string, string> = {};
  race.log.seats.forEach((seat, i) => {
    names[String(i + 1)] = seat.isBot ? `Bot ${i + 1}` : `Player ${i + 1}`;
  });
  const laps = race.log.raceLaps;
  return {
    id: race.id,
    finishedAt: race.finishedAt,
    trackId: race.trackId,
    label: `${race.source === 'online' ? 'Online' : 'Solo'}, ${laps} ${laps === 1 ? 'lap' : 'laps'}, ${names[String(race.winnerCarId)] ?? 'someone'} won`,
    names,
    log: race.log
  };
}

// null: not there (a race of this browser that was dropped, or an id the server does not know); it has been said.
async function loadRace(id: string, remote: boolean): Promise<SavedRace | null> {
  if (!remote) {
    const saved = loadSavedRace(id);
    if (!saved) kickToHome('That race is no longer saved.');
    return saved;
  }
  try {
    return await loadRemoteRace(id);
  } catch (error) {
    const missing = error instanceof BackendApiError && error.status === 404;
    kickToHome(
      missing
        ? 'That race is not in the history.'
        : `Could not load the race (${toErrorText(error)}).`
    );
    return null;
  }
}

async function openRecap(id: string, remote: boolean) {
  const saved = await loadRace(id, remote);
  if (!saved) return;
  try {
    const { buildRecap } = await import('./ui/recap_load');
    recapPage.show(await buildRecap(saved, import.meta.env.BASE_URL), saved.label);
    openRecapId = id;
    openRecapRemote = remote;
  } catch (error) {
    kickToHome(`Could not open the recap (${toErrorText(error)}).`);
  }
}

// ---- board replay (#169) -------------------------------------------------------------------
// A saved race on the real board: the race scene watches it like an online race it takes no part in, and each state of the
// race is sent to it as the lobby state the server would have sent.

interface ReplayRun {
  raceId: string;
  remote: boolean;
  replay: Replay;
  at: number;
  composition: RaceComposition;
  timer: number | null;
}
let replayRun: ReplayRun | null = null;
const replayBar = el('replayBar');
const replayPrevBtn = el<HTMLButtonElement>('replayPrevBtn');
const replayNextBtn = el<HTMLButtonElement>('replayNextBtn');
const replayPlayBtn = el<HTMLButtonElement>('replayPlayBtn');
const REPLAY_STEP_MS = 1100;

function renderReplayBar() {
  replayBar.hidden = replayRun === null;
  if (!replayRun) return;
  const last = replayRun.replay.count - 1;
  el('replayCount').textContent = `${replayRun.at} / ${last}`;
  el('replayText').textContent = replayRun.replay.textAt(replayRun.at) || 'On the grid';
  replayPrevBtn.disabled = replayRun.at <= 0;
  replayNextBtn.disabled = replayRun.at >= last;
  replayPlayBtn.textContent = replayRun.timer === null ? 'Play' : 'Pause';
}

function sendReplayState() {
  if (!replayRun) return;
  window.dispatchEvent(
    new CustomEvent<BackendLobbyStateEventDetail>('srp:backend-lobby-state', {
      detail: { lobby: replayRun.replay.lobbyAt(replayRun.at), source: 'replay', localPlayerId: '' }
    })
  );
  renderReplayBar();
}

function pauseReplay() {
  if (replayRun?.timer != null) window.clearInterval(replayRun.timer);
  if (replayRun) replayRun.timer = null;
}

function stopReplay() {
  pauseReplay();
  replayRun = null;
  renderReplayBar();
}

/** Moves the replay to state `to` (clamped); the scene glides the cars that moved. */
function stepReplay(to: number) {
  if (!replayRun) return;
  const at = Math.max(0, Math.min(replayRun.replay.count - 1, to));
  if (at === replayRun.at) return;
  replayRun.at = at;
  if (at >= replayRun.replay.count - 1) pauseReplay();
  sendReplayState();
}

function toggleReplayPlay() {
  if (!replayRun) return;
  if (replayRun.timer !== null) {
    pauseReplay();
    renderReplayBar();
    return;
  }
  if (replayRun.at >= replayRun.replay.count - 1) replayRun.at = 0;
  replayRun.timer = window.setInterval(() => {
    if (replayRun) stepReplay(replayRun.at + 1);
  }, REPLAY_STEP_MS);
  sendReplayState();
}

async function openReplay(id: string, remote: boolean) {
  const saved = await loadRace(id, remote);
  if (!saved) return;
  try {
    const { buildReplay } = await import('./ui/replay_load');
    const replay = await buildReplay(saved, import.meta.env.BASE_URL);
    const cars = saved.log.seats.length;
    destroyGame();
    results.hidden = true;
    raceOver = false;
    stopReplay();
    replayRun = {
      raceId: id,
      remote,
      replay,
      at: Math.max(0, Math.min(replay.count - 1, replayStart)),
      timer: null,
      composition: {
        totalCars: cars,
        humanCars: cars,
        botCars: 0,
        raceLaps: saved.log.raceLaps,
        botLevel: 'normal',
        seed: saved.log.seed,
        rulesVersion: saved.log.rulesVersion
      }
    };
    replayStart = 0;
    renderReplayBar();
    await ensureGameStarted();
  } catch (error) {
    kickToHome(`Could not open the replay (${toErrorText(error)}).`);
  }
}

replayPrevBtn.addEventListener('click', () => {
  pauseReplay();
  if (replayRun) stepReplay(replayRun.at - 1);
});
replayNextBtn.addEventListener('click', () => {
  pauseReplay();
  if (replayRun) stepReplay(replayRun.at + 1);
});
replayPlayBtn.addEventListener('click', toggleReplayPlay);
el('replayRecapBtn').addEventListener('click', () => {
  if (replayRun) {
    navigate({
      name: 'recap',
      id: replayRun.raceId,
      ...(replayRun.remote ? { remote: true } : {})
    });
  }
});
window.addEventListener('keydown', (event) => {
  if (!replayRun || isTypingTarget() || event.ctrlKey || event.metaKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    pauseReplay();
    stepReplay(replayRun.at + (event.key === 'ArrowRight' ? 1 : -1));
    event.preventDefault();
  }
});

function renderLobby() {
  const online = mode === 'online';
  const lobby = online ? lastLobby : null;
  const isHost = !online || (backendSession?.isHost ?? false);
  const waiting = !online || lobby?.status === 'WAITING';
  const settings = lobby?.settings;

  lobbyTitle.textContent = online ? 'Lobby' : 'Quick race';
  lobbyPlayersBlock.hidden = !online;
  lobbyInviteBlock.hidden = !online;
  lobbyHumansField.hidden = !online;
  lobbyTurnTimerField.hidden = !online;
  lobbyTurnTimer.value = String(settings?.turnTimerSec ?? 60);
  lobbyHumans.value = String(settings?.humanCars ?? 1);
  lobbyBots.value = String(settings?.botCars ?? soloSettings.botCars);
  lobbyLaps.value = String(settings?.raceLaps ?? soloSettings.raceLaps);
  lobbyBotLevel.value = settings?.botLevel ?? soloSettings.botLevel;
  // Solo only: an online race plays the server's rules, and v1 is not offered there.
  lobbyRulesField.hidden = online;
  // Solo only: an online race goes to the history by itself (the server keeps it)
  lobbyShareField.hidden = online;
  lobbyShare.checked = shareSolo;
  lobbyRules.value = soloSettings.rulesVersion;
  // The select stays in the DOM; with no bots there is nothing for it to set.
  lobbyBotLevelField.hidden = Number(lobbyBots.value) === 0;
  const editable = isHost && waiting && !backendBusy;
  lobbyHumans.disabled =
    lobbyBots.disabled =
    lobbyLaps.disabled =
    lobbyTurnTimer.disabled =
    lobbyBotLevel.disabled =
    lobbyRules.disabled =
      !editable;
  lobbyStartBtn.disabled = backendBusy || !isHost || !waiting;
  lobbyStartBtn.hidden = online && !isHost;
  const canPlayAgain =
    online && lobby?.status === 'FINISHED' && lobby.terminationReason === 'race_finished';
  lobbyPlayAgainBtn.hidden = !(canPlayAgain && isHost);
  lobbyPlayAgainBtn.disabled = backendBusy;
  lobbyNote.hidden = !(online && lobby && lobby.status !== 'WAITING');
  lobbyNote.textContent =
    lobby?.status === 'IN_RACE'
      ? 'Race in progress.'
      : canPlayAgain
        ? isHost
          ? 'Race finished.'
          : 'Race finished. Waiting for host to start another race.'
        : 'This lobby is closed.';

  lobbyPlayers.replaceChildren(
    ...(lobby?.players ?? []).map((player) => {
      const item = document.createElement('li');
      item.dataset.testid = 'lobby-player';
      const dot = document.createElement('span');
      dot.className = player.connected ? 'dot on' : 'dot';
      item.append(
        dot,
        player.name + (player.playerId === backendSession?.playerId ? ' (you)' : '')
      );
      if (player.isHost) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.dataset.testid = 'host-badge';
        badge.textContent = 'host';
        item.append(badge);
      }
      return item;
    })
  );
  // The player's own name (#78): editable while the lobby waits, and not overwritten while it is being typed
  lobbyNameField.hidden = !online;
  lobbyName.disabled = !waiting || backendBusy;
  const me = lobby?.players.find((player) => player.playerId === backendSession?.playerId);
  if (me && document.activeElement !== lobbyName) lobbyName.value = me.name;
  lobbyInviteLink.value = lobby ? buildLobbyInviteUrl(lobby.lobbyId) : '';
  lobbyCopyBtn.disabled = !lobby;
}

function setBackendBusy(next: boolean) {
  backendBusy = next;
  renderHome();
  if (document.body.dataset.screen === 'lobby') renderLobby();
}

async function ensureGameStarted() {
  if (game || gameStarting) return;
  gameStarting = true;
  try {
    const { startGame } = await import('./game');
    // The player may have left while the chunk loaded.
    if (document.body.dataset.screen !== 'race' || game) return;
    game = startGame(app, { ...getComposition(), hidpi, animate });
    // `?hidpi` (src/game/hidpi.ts): a line with what the browser really draws, to compare on a phone
    if (hidpiProbe) stopRenderProbe = startRenderProbe(el('renderProbe'), game);
    applyFps();
  } finally {
    gameStarting = false;
  }
}

function showResults(winnerCarId: number | null) {
  raceOver = true;
  const car = lastLobby?.raceState?.cars.find((candidate) => candidate.carId === winnerCarId);
  const who = car ? car.name : mode === 'solo' ? (winnerCarId === 1 ? 'you' : 'bot') : '';
  resultsWinner.textContent = `Car ${winnerCarId ?? '?'}${who ? ` (${who})` : ''} wins`;
  // null: not an online race (solo has no host)
  const isHost = mode === 'online' && backendSession !== null ? backendSession.isHost : null;
  resultsPlayAgainBtn.hidden = isHost !== true;
  resultsWait.hidden = isHost !== false;
  resultsRecapBtn.hidden = lastSavedRaceId === null;
  results.hidden = false;
}

// ---- routing -------------------------------------------------------------------------------

function leaveOnline() {
  disconnectBackendSocket();
  turnDeadlineAt = null;
  if (backendSession) clearStoredSession(backendSession.lobbyId);
  backendSession = null;
  lastLobby = null;
  chat.close();
  placeChat();
}

function kickToHome(message: string) {
  leaveOnline();
  navigate({ name: 'home' }, 'replace');
  showNotice(message);
}

async function handleRoute(route: Route, source: 'push' | 'replace' | 'pop') {
  const onRaceScreen = document.body.dataset.screen === 'race' && !raceOver;
  if (source === 'pop' && onRaceScreen && screenOf(route) !== 'race') {
    if (!window.confirm('Leave race?')) {
      // undo the back navigation
      window.history.pushState(
        {},
        '',
        routePath(mode === 'solo' ? { name: 'soloRace' } : lobbyRaceRoute())
      );
      return;
    }
    if (mode === 'online') {
      // leaving an online race means leaving the lobby (its status would pull us straight back)
      leaveOnline();
      navigate({ name: 'home' }, 'replace');
      return;
    }
  }
  switch (route.name) {
    case 'home':
      leaveOnline();
      soloRaceRequested = false;
      showScreen('home');
      return;
    case 'solo':
      leaveOnline();
      mode = 'solo';
      soloRaceRequested = false;
      showScreen('lobby');
      return;
    case 'soloRace':
      mode = 'solo';
      if (!soloRaceRequested) {
        navigate({ name: 'solo' }, 'replace');
        return;
      }
      showScreen('race');
      await ensureGameStarted();
      return;
    case 'recap':
      // an online player keeps the lobby while reading it: Back returns there
      showScreen('recap');
      await openRecap(route.id, route.remote === true);
      return;
    case 'recapBoard':
      showScreen('race');
      await openReplay(route.id, route.remote === true);
      return;
    case 'history':
      showScreen('history');
      await openHistory();
      return;
    case 'lobby':
    case 'lobbyRace':
      mode = 'online';
      if (!backendSession || backendSession.lobbyId !== route.id) {
        leaveOnline();
        showScreen('lobby');
        await joinLobbyById(route.id);
        return;
      }
      syncOnlineScreen();
      break;
    default:
      route satisfies never; // a new route that is not handled above fails to compile
  }
}

function lobbyRaceRoute(): Route {
  return { name: 'lobbyRace', id: backendSession?.lobbyId ?? '' };
}

// The lobby's status decides which online screen is right; the URL follows it.
function syncOnlineScreen() {
  const route = currentRoute();
  if (mode !== 'online' || !backendSession || !lastLobby) return;
  if (route.name !== 'lobby' && route.name !== 'lobbyRace') return;
  if (lastLobby.terminationReason === 'host_disconnected' && !backendSession.isHost) {
    kickToHome('The host disconnected. The lobby is closed.');
    return;
  }
  const hasRace = lastLobby.raceState !== undefined && lastLobby.status !== 'WAITING';
  if (route.name === 'lobby') {
    if (lastLobby.status === 'IN_RACE') {
      navigate({ name: 'lobbyRace', id: lastLobby.lobbyId });
    } else {
      showScreen('lobby');
    }
    return;
  }
  if (!hasRace) {
    navigate({ name: 'lobby', id: lastLobby.lobbyId }, 'replace');
    return;
  }
  if (document.body.dataset.screen !== 'race') showScreen('race');
  void ensureGameStarted();
}

// ---- backend session -----------------------------------------------------------------------

function applyLobbyState(lobby: PublicLobby, source: string) {
  if (!backendSession) return;
  if (lobby.lobbyId !== backendSession.lobbyId) return;
  backendSession.revision = Math.max(backendSession.revision, lobby.revision);
  backendSession.isHost = lobby.hostPlayerId === backendSession.playerId;
  lastLobby = lobby;
  const remainingMs = lobby.status === 'IN_RACE' ? lobby.raceState?.turnRemainingMs : undefined;
  turnDeadlineAt = remainingMs === undefined ? null : Date.now() + remainingMs;
  storeSession(backendSession);
  setStatus(`${source}: ${lobby.status.toLowerCase()} (rev ${lobby.revision})`);
  logMultiplayerClient('lobby.state.applied', {
    source,
    status: lobby.status,
    players: lobby.players.length
  });
  // a board replay owns the scene: the live race must not reach it
  if (!replayRun) {
    window.dispatchEvent(
      new CustomEvent<BackendLobbyStateEventDetail>('srp:backend-lobby-state', {
        detail: { lobby, source, localPlayerId: backendSession.playerId }
      })
    );
  }
  if (document.body.dataset.screen === 'lobby') renderLobby();
  renderConnectionBanner();
  renderTurnTimer();
  syncOnlineScreen();
}

function clearBackendReconnectTimer() {
  if (backendReconnectTimer === null) return;
  window.clearTimeout(backendReconnectTimer);
  backendReconnectTimer = null;
}

async function rehydrateLobbyState(reason: string) {
  if (!backendSession) return;
  logMultiplayerClient('lobby.rehydrate.start', { reason });
  try {
    const read = await backendClient.readLobby(backendSession.lobbyId, backendSession.playerToken);
    if (!backendSession || backendSession.lobbyId !== read.lobby.lobbyId) return;
    backendSession.playerId = read.playerId;
    applyLobbyState(read.lobby, `rehydrate(${reason})`);
    logMultiplayerClient('lobby.rehydrate.success', { reason });
  } catch (error) {
    setStatus(`rehydrate failed (${toErrorText(error)})`);
    logMultiplayerClient('lobby.rehydrate.failed', { reason, error: toErrorText(error) });
  }
}

function scheduleBackendReconnect() {
  if (!backendShouldReconnect || !backendSession) return;
  clearBackendReconnectTimer();
  const delayMs = Math.min(5000, 500 * 2 ** Math.min(backendReconnectAttempt, 5));
  backendReconnectAttempt += 1;
  reconnecting = true;
  renderConnectionBanner();
  setStatus(`ws reconnect in ${delayMs}ms`);
  logMultiplayerClient('ws.reconnect.scheduled', { delayMs, attempt: backendReconnectAttempt });
  backendReconnectTimer = window.setTimeout(() => {
    void connectBackendSocket('retry');
  }, delayMs);
}

function handleBackendWsEvent(eventName: string, payload: unknown) {
  logMultiplayerClient('ws.message', { wsEvent: eventName });
  if (!backendSession) return;
  if (eventName === 'lobby.state' || eventName === 'race.started' || eventName === 'race.state') {
    if (payload && typeof payload === 'object' && 'lobbyId' in payload) {
      applyLobbyState(payload as PublicLobby, eventName);
    }
    return;
  }
  if (eventName === 'chat.history') {
    const messages = (payload as { messages?: unknown } | null)?.messages;
    if (Array.isArray(messages)) chat.setHistory(messages.filter(isChatMessage));
    return;
  }
  if (eventName === 'chat.message') {
    if (isChatMessage(payload)) chat.add(payload);
    return;
  }
  if (eventName === 'turn.applied') {
    if (payload && typeof payload === 'object' && 'revision' in payload) {
      const revision = (payload as { revision: unknown }).revision;
      if (typeof revision === 'number') {
        backendSession.revision = Math.max(backendSession.revision, revision);
      }
    }
    if (
      payload &&
      typeof payload === 'object' &&
      'lobbyId' in payload &&
      'playerId' in payload &&
      'revision' in payload &&
      'applied' in payload
    ) {
      const turnPayload = payload as {
        lobbyId: unknown;
        playerId: unknown;
        revision: unknown;
        applied: unknown;
      };
      if (
        typeof turnPayload.lobbyId === 'string' &&
        typeof turnPayload.playerId === 'string' &&
        typeof turnPayload.revision === 'number' &&
        turnPayload.applied &&
        typeof turnPayload.applied === 'object'
      ) {
        const applied = turnPayload.applied as { type?: unknown; targetCellId?: unknown };
        const source = (payload as { source?: unknown }).source;
        if (
          (applied.type === 'move' ||
            applied.type === 'pit' ||
            applied.type === 'skip' ||
            applied.type === 'setup') &&
          (applied.targetCellId === undefined || typeof applied.targetCellId === 'string')
        ) {
          if (!replayRun) {
            window.dispatchEvent(
              new CustomEvent<BackendTurnAppliedEventDetail>('srp:backend-turn-applied', {
                detail: {
                  lobbyId: turnPayload.lobbyId,
                  playerId: turnPayload.playerId,
                  revision: turnPayload.revision,
                  applied: {
                    type: applied.type,
                    ...(applied.targetCellId ? { targetCellId: applied.targetCellId } : {})
                  },
                  ...(source === 'bot' || source === 'timeout' || source === 'force_skip'
                    ? { source }
                    : {})
                }
              })
            );
          }
        }
      }
    }
    return;
  }
  if (eventName === 'race.ended' && payload && typeof payload === 'object') {
    const lobby = (payload as { lobby?: unknown }).lobby;
    if (lobby && typeof lobby === 'object' && 'lobbyId' in lobby) {
      applyLobbyState(lobby as PublicLobby, 'race.ended');
    }
  }
}

function disconnectBackendSocket() {
  backendShouldReconnect = false;
  reconnecting = false;
  clearBackendReconnectTimer();
  renderConnectionBanner();
  if (!backendSocket) return;
  const socket = backendSocket;
  backendSocket = null;
  logMultiplayerClient('ws.disconnect.requested');
  socket.close(1000, 'client_close');
}

async function connectBackendSocket(reason: string) {
  if (!backendSession) return;
  clearBackendReconnectTimer();
  if (backendSocket) {
    backendSocket.close(1000, 'reconnect');
    backendSocket = null;
  }
  backendShouldReconnect = true;

  const socketUrl = `${backendWsBaseUrl}/ws?lobbyId=${encodeURIComponent(backendSession.lobbyId)}&playerToken=${encodeURIComponent(backendSession.playerToken)}`;
  const socket = new WebSocket(socketUrl);
  backendSocket = socket;
  setStatus(`ws connecting (${reason})...`);
  logMultiplayerClient('ws.connecting', { reason });

  socket.addEventListener('open', () => {
    if (backendSocket !== socket) return;
    backendReconnectAttempt = 0;
    reconnecting = false;
    renderConnectionBanner();
    setStatus('ws connected');
    logMultiplayerClient('ws.open', { reason });
    void rehydrateLobbyState('ws-open');
  });

  socket.addEventListener('message', (event) => {
    if (backendSocket !== socket) return;
    try {
      const parsed = JSON.parse(String(event.data)) as {
        event?: unknown;
        payload?: unknown;
      };
      if (typeof parsed.event !== 'string') return;
      handleBackendWsEvent(parsed.event, parsed.payload);
    } catch {
      setStatus('ws parse error');
      logMultiplayerClient('ws.parse_error');
    }
  });

  socket.addEventListener('close', (event) => {
    if (backendSocket !== socket) return;
    backendSocket = null;
    if (!backendShouldReconnect) return;
    logMultiplayerClient('ws.close', { code: event.code, reason: event.reason || '' });

    if (event.code === 1008) {
      kickToHome('Your session expired.');
      return;
    }
    if (event.code === 4001) {
      backendShouldReconnect = false;
      if (lastLobby?.terminationReason === 'race_finished') return;
      kickToHome('The host disconnected. The lobby is closed.');
      return;
    }
    scheduleBackendReconnect();
  });

  socket.addEventListener('error', () => {
    if (backendSocket !== socket) return;
    setStatus('ws error');
    logMultiplayerClient('ws.error');
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
  chat.open(response.lobby.lobbyId, response.playerId);
  applyLobbyState(response.lobby, reason);
  void connectBackendSocket(reason);
}

async function hostLobby() {
  if (backendBusy) return;
  showNotice(null);
  setBackendBusy(true);
  setStatus('creating lobby...');
  logMultiplayerClient('lobby.host.start');
  try {
    const created = await withWakeNotice(
      backendClient.createLobby(getPlayerName(), {
        trackId: 'oval16_3lanes',
        totalCars: 2,
        humanCars: 2,
        botCars: 0,
        raceLaps: 5,
        turnTimerSec: 60,
        botLevel: 'normal'
      })
    );
    mode = 'online';
    openSession(created, 'host');
    navigate({ name: 'lobby', id: created.lobby.lobbyId });
    logMultiplayerClient('lobby.host.success');
  } catch (error) {
    showNotice(`Could not create the lobby (${toErrorText(error)}).`);
    logMultiplayerClient('lobby.host.failed', { error: toErrorText(error) });
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
  logMultiplayerClient('lobby.join.start', { requestedLobbyId: lobbyId });
  let askName = false;
  try {
    const joined = await withWakeNotice(
      backendClient.joinLobby(lobbyId, getPlayerName(), loadStoredToken(lobbyId))
    );
    openSession(joined, 'join');
    askName = !nameWasSaved && !joined.isReconnect;
    logMultiplayerClient('lobby.join.success');
  } catch (error) {
    // Only a definite "your seat is gone" answer drops the stored seat. A network error or a
    // timeout (e.g. reloading while the server wakes up) keeps it so the next attempt rejoins.
    if (error instanceof BackendApiError && (error.status === 401 || error.status === 404)) {
      clearStoredSession(lobbyId);
    }
    logMultiplayerClient('lobby.join.failed', { error: toErrorText(error) });
    kickToHome(`Could not join the lobby (${toErrorText(error)}).`);
  } finally {
    joining = false;
    setBackendBusy(false);
  }
  // after the busy state clears: a disabled field cannot take the focus
  if (askName) {
    lobbyNameHint.hidden = false;
    lobbyName.focus();
    lobbyName.select();
  }
}

function extractLobbyId(input: string): string {
  const text = input.trim();
  try {
    const route = parseRoute(new URL(text).pathname);
    if (route.name === 'lobby' || route.name === 'lobbyRace') return route.id;
  } catch {
    // not a URL: treat as a bare lobby code
  }
  return text;
}

async function startRace() {
  if (backendBusy) return;
  if (mode === 'solo') {
    soloRaceRequested = true;
    soloSettings.seed = urlSeed ?? freshSeed();
    navigate({ name: 'soloRace' });
    return;
  }
  if (!backendSession?.isHost) return;
  setBackendBusy(true);
  setStatus('starting race...');
  logMultiplayerClient('race.start.requested');
  try {
    const started = await backendClient.startRace(
      backendSession.lobbyId,
      backendSession.playerToken
    );
    applyLobbyState(started.lobby, 'start');
    logMultiplayerClient('race.start.accepted');
  } catch (error) {
    setStatus(`start failed (${toErrorText(error)})`);
    logMultiplayerClient('race.start.failed', { error: toErrorText(error) });
  } finally {
    setBackendBusy(false);
  }
}

async function playAgain() {
  if (backendBusy || !backendSession?.isHost) return;
  setBackendBusy(true);
  setStatus('resetting lobby...');
  logMultiplayerClient('lobby.reset.requested');
  try {
    const reset = await backendClient.resetLobby(
      backendSession.lobbyId,
      backendSession.playerToken
    );
    applyLobbyState(reset.lobby, 'reset');
  } catch (error) {
    setStatus(`play again failed (${toErrorText(error)})`);
    logMultiplayerClient('lobby.reset.failed', { error: toErrorText(error) });
  } finally {
    setBackendBusy(false);
  }
}

async function changeSettings() {
  const humanCars = Number(lobbyHumans.value);
  const botCars = Number(lobbyBots.value);
  const raceLaps = Math.max(1, Math.min(999, Math.trunc(Number(lobbyLaps.value)) || 1));
  const turnTimerSec = Number(lobbyTurnTimer.value) as TurnTimerSec;
  const botLevel = lobbyBotLevel.value as BotLevel;
  if (mode === 'solo') {
    soloSettings.botCars = botCars;
    soloSettings.raceLaps = raceLaps;
    soloSettings.botLevel = botLevel;
    if (isRulesVersion(lobbyRules.value)) soloSettings.rulesVersion = lobbyRules.value;
    renderLobby();
    return;
  }
  if (!backendSession?.isHost) return;
  try {
    const updated = await backendClient.updateSettings(
      backendSession.lobbyId,
      backendSession.playerToken,
      { humanCars, botCars, raceLaps, turnTimerSec, botLevel }
    );
    applyLobbyState(updated.lobby, 'settings');
  } catch (error) {
    setStatus(`settings rejected (${toErrorText(error)})`);
    renderLobby();
  }
}

async function forceSkip() {
  if (!backendSession?.isHost || hudForceSkip.disabled) return;
  hudForceSkip.disabled = true;
  try {
    await backendClient.forceSkip(
      backendSession.lobbyId,
      backendSession.playerToken,
      backendSession.revision
    );
    logMultiplayerClient('turn.force_skip.accepted');
  } catch (error) {
    // 409: the player moved just before the click; nothing to do.
    setStatus(`skip failed (${toErrorText(error)})`);
    logMultiplayerClient('turn.force_skip.failed', { error: toErrorText(error) });
  } finally {
    hudForceSkip.disabled = false;
  }
}

async function copyInviteLink() {
  if (!lobbyInviteLink.value) return;
  try {
    await navigator.clipboard.writeText(lobbyInviteLink.value);
    setStatus('invite link copied');
  } catch (error) {
    setStatus(`invite copy failed (${toErrorText(error)})`);
  }
}

async function submitTurnAction(action: BackendTurnAction) {
  if (!backendSession || lastLobby?.status !== 'IN_RACE' || backendBusy) return;
  let revision = backendSession.revision;
  const clientCommandId = makeCommandId();
  logMultiplayerClient('turn.submit.start', { clientCommandId, action: action.type });

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
        logMultiplayerClient('turn.submit.applied', { clientCommandId, revision: result.revision });
        return;
      }
      if (result.error === 'stale_revision') {
        revision = result.revision;
        backendSession.revision = result.revision;
        logMultiplayerClient('turn.submit.stale_revision', {
          clientCommandId,
          revision: result.revision
        });
        continue;
      }
      backendSession.revision = result.revision;
      if (result.error === 'lobby_not_in_race') {
        setStatus('lobby not in race');
        logMultiplayerClient('turn.submit.rejected', {
          clientCommandId,
          reason: 'lobby_not_in_race'
        });
        return;
      }
      if (result.error === 'not_active_player') {
        setStatus('not your turn');
        logMultiplayerClient('turn.submit.rejected', {
          clientCommandId,
          reason: 'not_active_player'
        });
        void rehydrateLobbyState('not-active-player');
        return;
      }
      setStatus(
        result.error === 'invalid_action'
          ? `move rejected (${result.reason ?? 'invalid'})`
          : `turn rejected (${result.error})`
      );
      logMultiplayerClient('turn.submit.rejected', {
        clientCommandId,
        reason: result.error,
        engineReason: result.reason
      });
      void rehydrateLobbyState('turn-rejected');
      return;
    } catch (error) {
      setStatus(`turn submit failed (${toErrorText(error)})`);
      logMultiplayerClient('turn.submit.failed', {
        clientCommandId,
        error: toErrorText(error)
      });
      void rehydrateLobbyState('turn-failed');
      return;
    }
  }

  setStatus(`turn stale (rev ${backendSession.revision})`);
  logMultiplayerClient('turn.submit.give_up', { clientCommandId });
}

// ---- wiring --------------------------------------------------------------------------------

el('homeQuickBtn').addEventListener('click', () => {
  showNotice(null);
  navigate({ name: 'solo' });
});
el('homeCreateBtn').addEventListener('click', () => void hostLobby());
el('homeJoinBtn').addEventListener('click', () => {
  const id = extractLobbyId(homeJoinCode.value);
  if (id.length === 0) {
    showNotice('Enter a lobby code first.');
    return;
  }
  showNotice(null);
  navigate({ name: 'lobby', id });
});
// A name picked in the lobby (#78) goes back to the home field too, so a reload rejoins with it.
function rememberName() {
  nameWasSaved = true;
  try {
    window.localStorage.setItem('srp:name', getPlayerName());
    window.localStorage.removeItem('srp:name-auto');
  } catch {
    // ignore
  }
}
homeName.addEventListener('change', rememberName);

// The name the lobby holds for this player, put back in the field (renderLobby leaves a field that has the focus alone).
function restoreName() {
  const me = lastLobby?.players.find((player) => player.playerId === backendSession?.playerId);
  if (me) lobbyName.value = me.name;
  renderLobby();
}

// Enter or leaving the field. An empty name puts the old one back.
async function renameSelf() {
  const name = lobbyName.value.trim();
  lobbyNameHint.hidden = true;
  if (!backendSession || name.length === 0) {
    restoreName();
    return;
  }
  homeName.value = name;
  rememberName();
  try {
    const renamed = await backendClient.renamePlayer(
      backendSession.lobbyId,
      backendSession.playerToken,
      name
    );
    applyLobbyState(renamed.lobby, 'rename');
  } catch (error) {
    setStatus(`name rejected (${toErrorText(error)})`);
    restoreName();
  }
}
lobbyName.addEventListener('change', () => void renameSelf());

for (const input of [
  lobbyHumans,
  lobbyBots,
  lobbyLaps,
  lobbyTurnTimer,
  lobbyBotLevel,
  lobbyRules
]) {
  input.addEventListener('change', () => void changeSettings());
}
hudForceSkip.addEventListener('click', () => void forceSkip());
lobbyStartBtn.addEventListener('click', () => void startRace());
lobbyPlayAgainBtn.addEventListener('click', () => void playAgain());
resultsPlayAgainBtn.addEventListener('click', () => void playAgain());
lobbyCopyBtn.addEventListener('click', () => void copyInviteLink());
lobbyLeaveBtn.addEventListener('click', () => navigate({ name: 'home' }));

el('resultsLobbyBtn').addEventListener('click', () => {
  if (mode === 'online' && backendSession) {
    navigate({ name: 'lobby', id: backendSession.lobbyId });
  } else {
    navigate({ name: 'solo' });
  }
});
el('resultsHomeBtn').addEventListener('click', () => navigate({ name: 'home' }));

window.addEventListener('srp:local-turn-action', (event) => {
  const custom = event as CustomEvent<BackendTurnAction>;
  if (!custom.detail) return;
  void submitTurnAction(custom.detail);
});

window.addEventListener('srp:hud', (event) => {
  const snapshot = (event as CustomEvent<HudSnapshot>).detail;
  renderHud(hud, snapshot);
  renderResults(document.body, snapshot);
});

window.addEventListener('srp:toast', (event) => {
  const { text, kind } = (event as CustomEvent<{ text: string; kind: ToastKind }>).detail;
  showToast(hud, text, kind);
});

window.addEventListener('srp:race-finished', (event) => {
  if (replayRun) return; // the replay reaching the flag is not a race ending
  const detail = (
    event as CustomEvent<{ winnerCarId: number | null; recap?: FinishedRaceRecap | null }>
  ).detail;
  const winner = detail?.winnerCarId ?? null;
  lastSavedRaceId = null;
  resultsShared.hidden = true;
  if (detail?.recap) {
    saveFinishedRace({ ...detail.recap, trackId: 'oval16_3lanes' }, winner, 'Solo', 1);
    if (shareSolo) void shareSoloRace(detail.recap.log);
  }
  showResults(winner);
  if (!detail?.recap && mode === 'online') void saveOnlineRace(winner);
});
resultsRecapBtn.addEventListener('click', () => {
  if (lastSavedRaceId) navigate({ name: 'recap', id: lastSavedRaceId });
});

// The scene starts listening only after it is built: hand it the latest lobby state.
window.addEventListener('srp:scene-ready', () => {
  if (replayRun) {
    sendReplayState();
    return;
  }
  if (mode !== 'online' || !backendSession || !lastLobby) return;
  window.dispatchEvent(
    new CustomEvent<BackendLobbyStateEventDetail>('srp:backend-lobby-state', {
      detail: { lobby: lastLobby, source: 'scene-ready', localPlayerId: backendSession.playerId }
    })
  );
});

// Keyboard shortcut next to the scene's F (forwardIndex overlay).
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (
    (key !== 'c' && key !== 'm' && key !== 'p') ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }
  if (document.body.dataset.screen !== 'race' || isTypingTarget()) return;
  if (key === 'm') toggleMute();
  else if (key === 'p') toggleFps();
  else window.dispatchEvent(new Event('srp:toggle-cars-moves'));
});

window.addEventListener('beforeunload', () => {
  disconnectBackendSocket();
});

// A player who never picked a name gets a generated one, kept in `srp:name` (flagged `srp:name-auto`) so a reload keeps
// it. A guest who opens an invite with such a name is asked to pick one (#78).
let nameWasSaved = false;
try {
  const saved = window.localStorage.getItem('srp:name');
  if (saved) {
    homeName.value = saved;
    nameWasSaved = window.localStorage.getItem('srp:name-auto') !== '1';
  } else {
    homeName.value = defaultName;
    window.localStorage.setItem('srp:name', defaultName);
    window.localStorage.setItem('srp:name-auto', '1');
  }
} catch {
  homeName.value = defaultName;
}
setStatus(`ready (${backendApiBaseUrl})`);
// Wake a sleeping server in the background; its answer says which commit it runs.
const webVersion = { sha: __GIT_SHA__, date: __BUILD_DATE__, pr: __PREVIEW_PR__ };
let serverVersion: ServerVersion = null;
const versionEl = document.getElementById('version') as HTMLButtonElement;
mountVersion(versionEl, webVersion, () => serverVersion);
void backendClient
  .health()
  .then((health) => (serverVersion = { sha: health.sha ?? 'unknown' }))
  .catch((): ServerVersion => 'offline')
  .then((version) => {
    serverVersion = version;
    renderVersion(versionEl, webVersion, serverVersion);
  });
window.setInterval(renderTurnTimer, 250);
renderHomeTrack(homeTrack, undefined, {
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
});
startRouter((route, source) => void handleRoute(route, source));
