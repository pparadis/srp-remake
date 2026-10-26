/** @vitest-environment jsdom */
import indexHtml from '../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import track from '../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction
} from './game/race/race_engine';
import { logAction, startRaceLog } from './game/race/race_log';
import type { TrackData } from './game/types/track';

const startGame = vi.fn();
const createLobbyMock = vi.fn();
const joinLobbyMock = vi.fn();
const startRaceMock = vi.fn();
const readLobbyMock = vi.fn();
const submitTurnMock = vi.fn();
const forceSkipMock = vi.fn();
const updateSettingsMock = vi.fn();
const sendChatMock = vi.fn();
const renamePlayerMock = vi.fn();
const readRecapMock = vi.fn();

vi.mock('./game', () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));
// jsdom has no WebGL: the page asks before it starts the game
vi.mock('./ui/webgl_support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui/webgl_support')>()),
  webglSupported: () => true
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

vi.mock('./net/backend_api', () => ({
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

    sendChat(...args: unknown[]) {
      return sendChatMock(...args);
    }

    renamePlayer(...args: unknown[]) {
      return renamePlayerMock(...args);
    }

    readRecap(...args: unknown[]) {
      return readRecapMock(...args);
    }
  },
  BackendApiError: MockBackendApiError,
  resolveBackendBaseUrl: () => 'http://localhost:3001',
  resolveBackendWsBaseUrl: () => 'ws://localhost:3001'
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

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

  close(code = 1000, reason = '') {
    this.readyState = 3;
    const items = this.listeners.get('close') ?? [];
    for (const listener of items) {
      listener({ code, reason });
    }
  }
}

function setupDom() {
  window.history.replaceState({}, '', '/');

  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/
    .exec(indexHtml)![1]!
    .replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.dataset.screen = 'home';
}

function makeLobby(lobbyId: string) {
  return {
    lobbyId,
    status: 'WAITING' as const,
    hostPlayerId: 'host-player-id',
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    settings: {
      trackId: 'oval16_3lanes',
      totalCars: 2,
      humanCars: 2,
      botCars: 0,
      raceLaps: 5,
      turnTimerSec: 60 as const,
      botLevel: 'normal' as 'easy' | 'normal' | 'hard'
    },
    players: [
      {
        playerId: 'host-player-id',
        name: 'Host',
        connected: true,
        seatIndex: 0,
        isHost: true
      },
      {
        playerId: 'guest-player-id',
        name: 'Guest',
        connected: true,
        seatIndex: 1,
        isHost: false
      }
    ]
  };
}

// A race in progress between the two players of makeLobby: seat 0 is the host's car 1, seat 1 the guest's car 2.
function makeRaceLobby(
  lobbyId: string,
  activeSeatIndex: number,
  over: { turnRemainingMs?: number } = {}
) {
  const lobby = makeLobby(lobbyId);
  return {
    ...lobby,
    status: 'IN_RACE' as 'IN_RACE' | 'FINISHED',
    revision: 3,
    raceState: {
      trackId: 'oval16_3lanes',
      raceLaps: 5,
      turnIndex: 0,
      activeSeatIndex,
      winnerCarId: null,
      seed: 0,
      cars: lobby.players.map((player) => ({
        carId: player.seatIndex + 1,
        seatIndex: player.seatIndex,
        playerId: player.playerId,
        name: player.name
      })),
      ...over
    }
  };
}

// Each test imports a fresh main.ts, which adds its own window listeners: drop them after the test, or a
// back navigation would also reach the pages of earlier tests.
const added: Array<[string, Parameters<typeof window.removeEventListener>[1]]> = [];
const realAdd = window.addEventListener.bind(window);

describe('main multiplayer screens', () => {
  afterEach(() => {
    for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) added.push([type, listener]);
      realAdd(type, listener, options);
    });
    vi.resetModules();
    startGame.mockReset();
    createLobbyMock.mockReset();
    joinLobbyMock.mockReset();
    startRaceMock.mockReset();
    readLobbyMock.mockReset();
    submitTurnMock.mockReset();
    forceSkipMock.mockReset();
    sendChatMock.mockReset();
    renamePlayerMock.mockReset();
    readRecapMock.mockReset();
    window.localStorage.clear();
    FakeWebSocket.instances = [];
    window.sessionStorage.clear();
    startGame.mockReturnValue({ destroy: vi.fn() });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    setupDom();
  });

  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  it('host creates a lobby and may start the race', async () => {
    createLobbyMock.mockResolvedValue({
      lobby: makeLobby('host-lobby'),
      playerId: 'host-player-id',
      playerToken: 'host-token'
    });
    await import('./main');

    byId('homeCreateBtn').click();

    await vi.waitFor(() => {
      expect(createLobbyMock).toHaveBeenCalledTimes(1);
      expect(document.body.dataset.screen).toBe('lobby');
    });
    expect(window.location.pathname).toBe('/lobby/host-lobby');
    expect(byId<HTMLInputElement>('lobbyInviteLink').value).toBe(
      `${window.location.origin}/lobby/host-lobby`
    );
    expect(byId('lobbyPlayers').querySelectorAll('li')).toHaveLength(2);
    expect(byId('lobbyPlayers').querySelectorAll('[data-testid="host-badge"]')).toHaveLength(1);
    expect(byId<HTMLButtonElement>('lobbyStartBtn').disabled).toBe(false);
    expect(byId<HTMLSelectElement>('lobbyBots').disabled).toBe(false);
  });

  it('a joined non-host cannot start or edit settings', async () => {
    joinLobbyMock.mockResolvedValue({
      lobby: makeLobby('joined-lobby'),
      playerId: 'guest-player-id',
      playerToken: 'guest-token',
      isReconnect: false
    });
    window.history.replaceState({}, '', '/lobby/joined-lobby');
    await import('./main');

    await vi.waitFor(() => {
      expect(joinLobbyMock).toHaveBeenCalled();
      expect(joinLobbyMock.mock.calls.at(-1)?.[0]).toBe('joined-lobby');
      expect(byId('lobbyPlayers').querySelectorAll('li')).toHaveLength(2);
    });
    expect(byId<HTMLButtonElement>('lobbyStartBtn').hidden).toBe(true);
    expect(byId<HTMLButtonElement>('lobbyStartBtn').disabled).toBe(true);
    expect(byId<HTMLInputElement>('lobbyLaps').disabled).toBe(true);
  });

  it('goes back home with a notice when joining fails', async () => {
    joinLobbyMock.mockRejectedValue(new MockBackendApiError(404, { error: 'not_found' }));
    window.history.replaceState({}, '', '/lobby/missing');
    await import('./main');

    await vi.waitFor(() => {
      expect(document.body.dataset.screen).toBe('home');
    });
    expect(window.location.pathname).toBe('/');
    expect(byId('homeNotice').hidden).toBe(false);
    expect(byId('homeNotice').textContent).toContain('404');
  });

  it('says to wait a few seconds when the server rate limits the join, and keeps the seat', async () => {
    window.sessionStorage.setItem(
      'srp:session:busy',
      JSON.stringify({ lobbyId: 'busy', playerToken: 'kept-token' })
    );
    joinLobbyMock.mockRejectedValue(new MockBackendApiError(429, { error: 'rate_limited' }));
    window.history.replaceState({}, '', '/lobby/busy');
    await import('./main');

    await vi.waitFor(() => expect(document.body.dataset.screen).toBe('home'));
    expect(byId('homeNotice').textContent).toContain(
      'Too many requests, try again in a few seconds'
    );
    expect(window.sessionStorage.getItem('srp:session:busy')).toContain('kept-token');
  });

  describe('survivability', () => {
    const banner = () => byId('connectionBanner');

    async function joinAsGuest(lobbyId: string) {
      joinLobbyMock.mockResolvedValue({
        lobby: makeLobby(lobbyId),
        playerId: 'guest-player-id',
        playerToken: 'guest-token',
        isReconnect: false
      });
      readLobbyMock.mockResolvedValue({ lobby: makeLobby(lobbyId), playerId: 'guest-player-id' });
      window.history.replaceState({}, '', `/lobby/${lobbyId}`);
      await import('./main');
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a reconnecting banner while the socket is down and hides it when it is back', async () => {
      vi.useFakeTimers();
      await joinAsGuest('flaky');
      expect(banner().hidden).toBe(true);

      FakeWebSocket.instances[0]!.close(1006, '');
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain('Reconnecting');

      await vi.advanceTimersByTimeAsync(600);
      expect(FakeWebSocket.instances).toHaveLength(2);
      FakeWebSocket.instances[1]!.emit('open');
      expect(banner().hidden).toBe(true);
    });

    it('tells a guest while the host is away', async () => {
      await joinAsGuest('hostaway');
      const lobby = makeLobby('hostaway');
      lobby.players[0]!.connected = false;
      FakeWebSocket.instances[0]!.emit('message', {
        data: JSON.stringify({ event: 'lobby.state', payload: lobby })
      });
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain('Host disconnected');

      FakeWebSocket.instances[0]!.emit('message', {
        data: JSON.stringify({ event: 'lobby.state', payload: makeLobby('hostaway') })
      });
      expect(banner().hidden).toBe(true);
    });

    it('explains a slow cold start after 3 s and clears the message when the server answers', async () => {
      vi.useFakeTimers();
      let answer!: (value: unknown) => void;
      joinLobbyMock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      readLobbyMock.mockResolvedValue({ lobby: makeLobby('slow'), playerId: 'guest-player-id' });
      window.history.replaceState({}, '', '/lobby/slow');
      await import('./main');

      await vi.advanceTimersByTimeAsync(2900);
      expect(banner().hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      expect(banner().hidden).toBe(false);
      expect(banner().textContent).toContain('Waking the server');

      answer({
        lobby: makeLobby('slow'),
        playerId: 'guest-player-id',
        playerToken: 't',
        isReconnect: false
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(banner().hidden).toBe(true);
    });

    it('keeps the stored seat when the server cannot be reached, so a retry rejoins', async () => {
      window.sessionStorage.setItem(
        'srp:session:offline',
        JSON.stringify({ lobbyId: 'offline', playerToken: 'kept-token' })
      );
      joinLobbyMock.mockRejectedValue(new TypeError('Failed to fetch'));
      window.history.replaceState({}, '', '/lobby/offline');
      await import('./main');

      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('home'));
      expect(joinLobbyMock.mock.calls.at(-1)?.[2]).toBe('kept-token');
      expect(window.sessionStorage.getItem('srp:session:offline')).toContain('kept-token');
    });

    it('drops the stored seat when the server says it is gone (401)', async () => {
      window.sessionStorage.setItem(
        'srp:session:gone',
        JSON.stringify({ lobbyId: 'gone', playerToken: 'old-token' })
      );
      joinLobbyMock.mockRejectedValue(new MockBackendApiError(401, { error: 'invalid' }));
      window.history.replaceState({}, '', '/lobby/gone');
      await import('./main');

      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('home'));
      expect(window.sessionStorage.getItem('srp:session:gone')).toBeNull();
    });

    it('creates lobbies with the Normal bot level and hides the select while there are no bots', async () => {
      const lobby = makeLobby('level-lobby');
      createLobbyMock.mockResolvedValue({
        lobby,
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));
      expect(createLobbyMock.mock.calls.at(-1)?.[1]).toMatchObject({ botLevel: 'normal' });
      expect(byId<HTMLSelectElement>('lobbyBotLevel').value).toBe('normal');
      expect(byId('lobbyBotLevelField').hidden).toBe(true); // botCars is 0
      expect(document.querySelector('[data-testid="lobby-bot-level"]')).not.toBeNull();
      expect(byId('lobbyRulesField').hidden).toBe(true); // an online race plays the server's rules, v1 is not offered (#118)
    });

    it('lets the host pick the bot level and sends it with the other settings', async () => {
      const lobby = makeLobby('level-lobby');
      lobby.settings = {
        ...lobby.settings,
        totalCars: 3,
        humanCars: 2,
        botCars: 1,
        botLevel: 'easy' as const
      };
      createLobbyMock.mockResolvedValue({
        lobby,
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      updateSettingsMock.mockImplementation(
        async (_id: string, _token: string, patch: { botLevel: string }) => ({
          lobby: { ...lobby, settings: { ...lobby.settings, botLevel: patch.botLevel } }
        })
      );
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));

      const select = byId<HTMLSelectElement>('lobbyBotLevel');
      expect(byId('lobbyBotLevelField').hidden).toBe(false);
      expect(select.value).toBe('easy');
      expect(select.disabled).toBe(false);

      select.value = 'hard';
      select.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(updateSettingsMock).toHaveBeenCalled());
      expect(updateSettingsMock.mock.calls.at(-1)?.[2]).toMatchObject({
        botCars: 1,
        botLevel: 'hard'
      });
      await vi.waitFor(() => expect(select.value).toBe('hard'));
    });

    it('lets the host pick the track, and the guest see it (#175)', async () => {
      const lobby = makeLobby('track-lobby');
      createLobbyMock.mockResolvedValue({
        lobby,
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      updateSettingsMock.mockImplementation(
        async (_id: string, _token: string, patch: { trackId: string }) => ({
          lobby: { ...lobby, settings: { ...lobby.settings, trackId: patch.trackId } }
        })
      );
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));

      const select = byId<HTMLSelectElement>('lobbyTrack');
      expect(select.value).toBe('oval16_3lanes');
      expect(select.disabled).toBe(false);
      select.value = 'oval32_3lanes';
      select.dispatchEvent(new Event('change'));
      await vi.waitFor(() => expect(updateSettingsMock).toHaveBeenCalled());
      expect(updateSettingsMock.mock.calls.at(-1)?.[2]).toMatchObject({ trackId: 'oval32_3lanes' });
      await vi.waitFor(() => expect(select.value).toBe('oval32_3lanes'));
    });

    it('offers the host a turn timer select defaulting to 60 s', async () => {
      const lobby = makeLobby('timer-lobby');
      createLobbyMock.mockResolvedValue({
        lobby,
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));
      expect(byId<HTMLSelectElement>('lobbyTurnTimer').value).toBe('60');
      expect(byId<HTMLSelectElement>('lobbyTurnTimer').disabled).toBe(false);
      expect(byId('lobbyTurnTimerField').hidden).toBe(false);
    });
  });

  describe('in the lobby and the race', () => {
    const socket = () => FakeWebSocket.instances.at(-1)!;
    const send = (event: string, payload: unknown) =>
      socket().emit('message', { data: JSON.stringify({ event, payload }) });
    const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

    async function enter(as: 'host' | 'guest', lobby: { lobbyId: string }) {
      const playerId = `${as}-player-id`;
      joinLobbyMock.mockResolvedValue({
        lobby,
        playerId,
        playerToken: `${as}-token`,
        isReconnect: false
      });
      readLobbyMock.mockResolvedValue({ lobby, playerId });
      window.history.replaceState({}, '', `/lobby/${lobby.lobbyId}`);
      await import('./main');
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a guest sees the host's settings as they change, and cannot edit them", async () => {
      await enter('guest', makeLobby('settings'));
      const lobby = makeLobby('settings');
      lobby.settings = { ...lobby.settings, raceLaps: 3 };
      send('lobby.state', lobby);
      expect(byId<HTMLInputElement>('lobbyLaps').value).toBe('3');
      expect(byId('lobbyBotLevelField').hidden).toBe(true);

      lobby.settings = { ...lobby.settings, totalCars: 3, botCars: 1, botLevel: 'hard' };
      send('lobby.state', lobby);
      expect(byId('lobbyBotLevelField').hidden).toBe(false);
      expect(byId<HTMLSelectElement>('lobbyBotLevel').value).toBe('hard');
      expect(byId<HTMLSelectElement>('lobbyBotLevel').disabled).toBe(true);
      expect(byId<HTMLButtonElement>('lobbyPlayAgainBtn').hidden).toBe(true);
    });

    describe('the recap of an online race (#169)', () => {
      // a few real turns, as the server would send them
      function shortLog() {
        const ctx = createRaceContext(track as unknown as TrackData);
        const seats = [
          { isBot: false, ownerId: 'host-player-id' },
          { isBot: false, ownerId: 'guest-player-id' }
        ];
        const state = createRace(ctx, seats, 5, 0, 'v3');
        const log = startRaceLog(seats, 5, 0, 'v3');
        for (let i = 0; i < 8; i += 1) {
          const action = decideBotAction(ctx, state, 'autopilot').action;
          applyAction(ctx, state, action);
          logAction(log, action);
        }
        return log;
      }
      const recapBody = () => ({
        log: shortLog(),
        names: { '1': 'Host', '2': 'Guest' },
        trackId: 'oval16_3lanes'
      });
      const finishRace = async () => {
        await enter('guest', makeLobby('end'));
        send('race.started', makeRaceLobby('end', 0));
        window.dispatchEvent(
          new CustomEvent('srp:race-finished', { detail: { winnerCarId: 2, recap: null } })
        );
      };

      it('fetches the race as it ends, saves it, and offers the recap', async () => {
        readRecapMock.mockResolvedValue(recapBody());
        await finishRace();
        await vi.waitFor(() => expect(byId('resultsRecapBtn').hidden).toBe(false));
        expect(readRecapMock).toHaveBeenCalledWith('end', 'guest-token');
        const saved = JSON.parse(window.localStorage.getItem('srp:races')!) as Array<{
          label: string;
          names: Record<string, string>;
        }>;
        // the guest's car (2) won: the label says "you"
        expect(saved[0]!.label).toBe('Online, 5 laps, you won');
        expect(saved[0]!.names).toEqual({ '1': 'Host', '2': 'Guest' });
      });

      it('has no recap button when the server has no log to give', async () => {
        readRecapMock.mockRejectedValue(new MockBackendApiError(409, { error: 'conflict' }));
        await finishRace();
        await vi.waitFor(() => expect(readRecapMock).toHaveBeenCalled());
        expect(byId('results').hidden).toBe(false);
        expect(byId('resultsRecapBtn').hidden).toBe(true);
        expect(window.localStorage.getItem('srp:races')).toBeNull();
      });

      it('keeps the lobby while the recap is read, and Back returns to it', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response(JSON.stringify(track), { status: 200 }))
        );
        readRecapMock.mockResolvedValue(recapBody());
        await finishRace();
        // the server says so too: a finished race
        send('lobby.state', { ...makeRaceLobby('end', 0), status: 'FINISHED' });
        await vi.waitFor(() => expect(byId('resultsRecapBtn').hidden).toBe(false));

        byId('resultsRecapBtn').click();
        await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
        expect(document.body.dataset.screen).toBe('recap');
        expect(FakeWebSocket.instances.at(-1)!.readyState).not.toBe(3);

        tid('recap-back').click();
        expect(window.location.pathname).toBe('/lobby/end');
        expect(document.body.dataset.screen).toBe('lobby');
      });
    });

    describe('the player name in the lobby (#78)', () => {
      const nameInput = () => byId<HTMLInputElement>('lobbyName');
      const type = (value: string) => {
        nameInput().value = value;
        nameInput().dispatchEvent(new Event('change'));
      };

      it('is prefilled with the name the player joined with, and listed as "(you)"', async () => {
        window.localStorage.setItem('srp:name', 'Guest');
        await enter('guest', makeLobby('name'));
        expect(byId('lobbyNameField').hidden).toBe(false);
        expect(nameInput().value).toBe('Guest');
        expect(nameInput().disabled).toBe(false);
        expect(byId('lobbyNameHint').hidden).toBe(true);
      });

      it('renames through the API, remembers the name and shows it in the list', async () => {
        window.localStorage.setItem('srp:name', 'Guest');
        await enter('guest', makeLobby('name'));
        const renamed = makeLobby('name');
        renamed.players[1]!.name = 'Speedy';
        renamePlayerMock.mockResolvedValue({ lobby: renamed });

        type('  Speedy ');

        await vi.waitFor(() =>
          expect(renamePlayerMock).toHaveBeenCalledWith('name', 'guest-token', 'Speedy')
        );
        expect(window.localStorage.getItem('srp:name')).toBe('Speedy');
        expect(byId<HTMLInputElement>('homeName').value).toBe('Speedy');
        await vi.waitFor(() => expect(byId('lobbyPlayers').textContent).toContain('Speedy (you)'));
      });

      it('puts the old name back when the field is emptied, without asking the server', async () => {
        await enter('guest', makeLobby('name'));
        type('   ');
        expect(renamePlayerMock).not.toHaveBeenCalled();
        expect(nameInput().value).toBe('Guest');
      });

      it('says so and keeps the list when the server refuses', async () => {
        await enter('guest', makeLobby('name'));
        renamePlayerMock.mockRejectedValue(new MockBackendApiError(409, { error: 'conflict' }));
        type('Late');
        await vi.waitFor(() => expect(byId('statusLine').textContent).toContain('name rejected'));
        expect(nameInput().value).toBe('Guest');
      });

      it('cannot be edited once the race has started', async () => {
        await enter('guest', makeLobby('name'));
        send('race.started', makeRaceLobby('name', 0));
        send('lobby.state', { ...makeRaceLobby('name', 0), status: 'FINISHED' });
        expect(nameInput().disabled).toBe(true);
      });

      it('asks a first-time guest to pick a name: the hint shows and the field has the focus', async () => {
        await enter('guest', makeLobby('name'));
        expect(byId('lobbyNameHint').hidden).toBe(false);
        expect(document.activeElement).toBe(nameInput());
      });

      it('gives a player with no saved name a generated one, kept for the next visit', async () => {
        await enter('guest', makeLobby('name'));
        const name = window.localStorage.getItem('srp:name');
        expect(name).toMatch(/^[a-z]+_[a-z]+$/);
        expect(window.localStorage.getItem('srp:name-auto')).toBe('1');
        expect(byId<HTMLInputElement>('homeName').value).toBe(name);
        expect(joinLobbyMock.mock.calls.at(-1)?.[1]).toBe(name);
      });

      it('keeps a name the player picked, with no hint, and drops the generated flag on a pick', async () => {
        window.localStorage.setItem('srp:name', 'Guest');
        await enter('guest', makeLobby('name'));
        expect(byId<HTMLInputElement>('homeName').value).toBe('Guest');
        expect(window.localStorage.getItem('srp:name-auto')).toBeNull();

        window.localStorage.clear();
        window.localStorage.setItem('srp:name', 'swift_apex');
        window.localStorage.setItem('srp:name-auto', '1');
        FakeWebSocket.instances = [];
        vi.resetModules();
        setupDom();
        window.history.replaceState({}, '', '/lobby/name');
        await import('./main');
        await vi.waitFor(() => expect(byId('lobbyNameHint').hidden).toBe(false));
        renamePlayerMock.mockResolvedValue({ lobby: makeLobby('name') });
        type('Speedy');
        await vi.waitFor(() => expect(renamePlayerMock).toHaveBeenCalled());
        expect(window.localStorage.getItem('srp:name-auto')).toBeNull();
      });

      it('rejoins with the new name after a reload', async () => {
        window.localStorage.setItem('srp:name', 'Guest');
        await enter('guest', makeLobby('name'));
        renamePlayerMock.mockResolvedValue({ lobby: makeLobby('name') });
        type('Speedy');
        await vi.waitFor(() => expect(renamePlayerMock).toHaveBeenCalled());

        FakeWebSocket.instances = [];
        vi.resetModules();
        setupDom();
        window.history.replaceState({}, '', '/lobby/name');
        await import('./main');
        await vi.waitFor(() => expect(joinLobbyMock.mock.calls.at(-1)?.[1]).toBe('Speedy'));
      });
    });

    it('the race start takes both pages to the race screen', async () => {
      await enter('guest', makeLobby('start'));
      expect(document.body.dataset.screen).toBe('lobby');
      send('race.started', makeRaceLobby('start', 0));
      expect(window.location.pathname).toBe('/lobby/start/race');
      expect(document.body.dataset.screen).toBe('race');
      await vi.waitFor(() =>
        expect(startGame).toHaveBeenCalledWith(
          byId('app'),
          expect.objectContaining({ totalCars: 2, humanCars: 2 })
        )
      );
    });

    describe('chat', () => {
      const chatMessage = (id: number, playerId: string, name: string, text: string) => ({
        id,
        playerId,
        name,
        text,
        sentAt: id
      });
      const rows = () => [
        ...document.querySelectorAll<HTMLElement>('[data-testid="chat-list"] li')
      ];
      const input = () => tid('chat-input') as HTMLInputElement;
      const type = (text: string) => {
        input().value = text;
        input().dispatchEvent(new Event('input', { bubbles: true }));
      };
      const submit = () =>
        tid('chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

      it('shows the history and live messages in the lobby, as text', async () => {
        await enter('guest', makeLobby('chat'));
        expect(byId('lobbyChatBlock').hidden).toBe(false);
        expect(byId('lobbyChatSlot').contains(tid('chat'))).toBe(true);

        send('chat.history', {
          messages: [chatMessage(1, 'host-player-id', 'Host', 'welcome 👋')]
        });
        send(
          'chat.message',
          chatMessage(2, 'host-player-id', 'Host', '<img src=x onerror="window.pwned=1">')
        );
        expect(rows().map((row) => row.querySelector('.chat-text')!.textContent)).toEqual([
          'welcome 👋',
          '<img src=x onerror="window.pwned=1">'
        ]);
        expect(tid('chat-list').querySelector('img')).toBeNull();
        expect(rows()[0]!.querySelector('.chat-name')!.textContent).toBe('Host');

        // a history sent again (a reconnect) replaces, it does not repeat
        send('chat.history', {
          messages: [chatMessage(1, 'host-player-id', 'Host', 'welcome 👋')]
        });
        expect(rows()).toHaveLength(1);
      });

      it('sends what is typed, clears the input, and shows a refusal under it', async () => {
        await enter('host', makeLobby('send'));
        sendChatMock.mockResolvedValueOnce({
          message: chatMessage(1, 'host-player-id', 'Host', 'gg')
        });
        type('  gg  ');
        expect(tid('chat-count').textContent).toBe('6/100');
        submit();
        await vi.waitFor(() =>
          expect(sendChatMock).toHaveBeenCalledWith('send', 'host-token', 'gg')
        );
        await vi.waitFor(() => expect(input().value).toBe(''));
        expect(rows().map((row) => row.querySelector('.chat-text')!.textContent)).toEqual(['gg']);
        // the broadcast of the same message does not repeat it
        send('chat.message', chatMessage(1, 'host-player-id', 'Host', 'gg'));
        expect(rows()).toHaveLength(1);

        sendChatMock.mockRejectedValueOnce(
          new MockBackendApiError(429, { error: 'One chat message a second.' })
        );
        type('again');
        submit();
        await vi.waitFor(() => expect(tid('chat-error').hidden).toBe(false));
        expect(tid('chat-error').textContent).toContain('Too many requests');
        expect(input().value).toBe('again');
      });

      it('will not send an empty or over-long message', async () => {
        await enter('host', makeLobby('limits'));
        type('   ');
        expect((tid('chat-send') as HTMLButtonElement).disabled).toBe(true);
        type('a'.repeat(101));
        expect((tid('chat-send') as HTMLButtonElement).disabled).toBe(true);
        expect(tid('chat-count').classList.contains('is-over')).toBe(true);
        type('a'.repeat(100));
        expect((tid('chat-send') as HTMLButtonElement).disabled).toBe(false);
        sendChatMock.mockResolvedValue({ message: chatMessage(1, 'host-player-id', 'Host', 'a') });
        submit();
        await vi.waitFor(() => expect(sendChatMock).toHaveBeenCalledTimes(1));
      });

      it('mutes an author on this screen, and keeps that across a reload of the lobby', async () => {
        await enter('guest', makeLobby('mute'));
        send('chat.history', {
          messages: [
            chatMessage(1, 'host-player-id', 'Host', 'annoying'),
            chatMessage(2, 'guest-player-id', 'Guest', 'mine')
          ]
        });
        // your own message has no mute button
        expect(rows()[1]!.querySelector('[data-testid="chat-mute"]')).toBeNull();
        rows()[0]!.querySelector<HTMLButtonElement>('[data-testid="chat-mute"]')!.click();
        expect(rows().map((row) => row.querySelector('.chat-text')!.textContent)).toEqual(['mine']);
        send('chat.message', chatMessage(3, 'host-player-id', 'Host', 'still annoying'));
        expect(rows()).toHaveLength(1);
        expect(tid('chat-muted').textContent).toContain('Host');
        expect(window.sessionStorage.getItem('srp:chat-muted:mute')).toBe('["host-player-id"]');

        // reload: a fresh page, the same tab (sessionStorage stays)
        for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
        vi.resetModules();
        FakeWebSocket.instances = [];
        setupDom();
        window.history.replaceState({}, '', '/lobby/mute');
        await import('./main');
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        send('chat.history', {
          messages: [
            chatMessage(1, 'host-player-id', 'Host', 'annoying'),
            chatMessage(2, 'guest-player-id', 'Guest', 'mine')
          ]
        });
        expect(rows().map((row) => row.querySelector('.chat-text')!.textContent)).toEqual(['mine']);

        // unmute brings them back
        tid('chat-unmute').click();
        expect(rows()).toHaveLength(2);
      });

      it("keeps the typed letters from the game's shortcuts", async () => {
        await enter('guest', makeRaceLobby('keys', 0));
        expect(document.body.dataset.screen).toBe('race');
        const mute = tid('hud-mute');
        expect(mute.textContent).toBe('Sound: on');

        input().focus();
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        expect(mute.textContent).toBe('Sound: on');

        input().blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
        expect(mute.textContent).toBe('Sound: off');
      });

      it('lives in the HUD during the race, and counts what came in while it was collapsed', async () => {
        await enter('guest', makeLobby('unread'));
        send('race.started', makeRaceLobby('unread', 0));
        expect(document.body.dataset.screen).toBe('race');
        expect(byId('lobbyChatBlock').hidden).toBe(true);
        expect(tid('hud-chat').hidden).toBe(false);
        expect((tid('hud-chat') as HTMLDetailsElement).open).toBe(false);
        expect(tid('hud-chat-body').contains(tid('chat'))).toBe(true);

        send('chat.history', { messages: [chatMessage(1, 'host-player-id', 'Host', 'old')] });
        expect(tid('hud-chat-unread').hidden).toBe(true); // history is not news

        send('chat.message', chatMessage(2, 'host-player-id', 'Host', 'new 1'));
        send('chat.message', chatMessage(3, 'guest-player-id', 'Guest', 'from me'));
        send('chat.message', chatMessage(4, 'host-player-id', 'Host', 'new 2'));
        expect(tid('hud-chat-unread').hidden).toBe(false);
        expect(tid('hud-chat-unread').textContent).toBe(' (2)');

        const details = tid('hud-chat') as HTMLDetailsElement;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        expect(tid('hud-chat-unread').hidden).toBe(true);
        // open: new messages are read as they arrive
        send('chat.message', chatMessage(5, 'host-player-id', 'Host', 'new 3'));
        expect(tid('hud-chat-unread').hidden).toBe(true);
      });

      it('is not there when the lobby ends', async () => {
        await enter('guest', makeRaceLobby('bye', 0));
        send('chat.history', { messages: [chatMessage(1, 'host-player-id', 'Host', 'hi')] });
        send('lobby.state', {
          ...makeRaceLobby('bye', 0),
          status: 'FINISHED',
          terminationReason: 'host_disconnected'
        });
        expect(document.body.dataset.screen).toBe('home');
        expect(tid('hud-chat').hidden).toBe(true);
        expect(byId('lobbyChatBlock').hidden).toBe(true);
        expect(rows()).toHaveLength(0);
      });
    });

    it('shows everyone the turn countdown, and warns in the last 10 s', async () => {
      vi.useFakeTimers();
      await enter('guest', makeRaceLobby('timer', 0, { turnRemainingMs: 42_000 }));
      expect(document.body.dataset.screen).toBe('race');
      await vi.advanceTimersByTimeAsync(250); // the countdown ticks every 250 ms
      expect(tid('hud-timer').hidden).toBe(false);
      expect(tid('hud-timer').textContent).toBe('Auto-play in 0:42');
      expect(tid('hud-timer').classList.contains('is-warn')).toBe(false);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(tid('hud-timer').textContent).toBe('Auto-play in 0:07');
      expect(tid('hud-timer').classList.contains('is-warn')).toBe(true);
      // the guest is not the host: no skip button, not even on the host's turn
      expect(tid('hud-force-skip').hidden).toBe(true);
      // a lobby without a timer has no countdown
      send('race.state', makeRaceLobby('timer', 1));
      expect(tid('hud-timer').hidden).toBe(true);
    });

    it("lets the host skip a stuck guest, and only while it is the guest's turn", async () => {
      await enter('host', makeRaceLobby('skip', 1, { turnRemainingMs: 60_000 }));
      forceSkipMock.mockResolvedValue({ ok: true });
      const skip = tid('hud-force-skip');
      await vi.waitFor(() => expect(skip.hidden).toBe(false));
      skip.click();
      await vi.waitFor(() => expect(forceSkipMock).toHaveBeenCalledWith('skip', 'host-token', 3));

      send('race.state', makeRaceLobby('skip', 0, { turnRemainingMs: 60_000 }));
      expect(skip.hidden).toBe(true); // the host's own turn
    });

    it('sends the grid setup to the server as a turn action, and tells the scene when it was applied', async () => {
      await enter('host', makeRaceLobby('grid', 0));
      expect(document.body.dataset.screen).toBe('race');
      const setup = { compound: 'soft', psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: 'low' };
      submitTurnMock.mockResolvedValue({ ok: true, revision: 4 });

      window.dispatchEvent(
        new CustomEvent('srp:local-turn-action', { detail: { type: 'setup', setup } })
      );
      await vi.waitFor(() => expect(submitTurnMock).toHaveBeenCalled());
      expect(submitTurnMock.mock.calls.at(-1)?.[4]).toEqual({ type: 'setup', setup });

      const applied = vi.fn();
      window.addEventListener('srp:backend-turn-applied', applied);
      send('turn.applied', {
        lobbyId: 'grid',
        playerId: 'host-player-id',
        revision: 4,
        applied: { type: 'setup' }
      });
      expect(applied).toHaveBeenCalledTimes(1);
      expect((applied.mock.calls[0]![0] as CustomEvent).detail.applied).toEqual({ type: 'setup' });
      window.removeEventListener('srp:backend-turn-applied', applied);
    });

    it('sends the medium compound and the fuel load of a v3 grid setup to the server untouched (#148)', async () => {
      await enter('host', makeRaceLobby('grid-v3', 0));
      const setup = {
        compound: 'medium',
        psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
        wing: 'medium',
        fuelLoad: 80
      };
      submitTurnMock.mockResolvedValue({ ok: true, revision: 4 });
      window.dispatchEvent(
        new CustomEvent('srp:local-turn-action', { detail: { type: 'setup', setup } })
      );
      await vi.waitFor(() => expect(submitTurnMock).toHaveBeenCalled());
      expect(submitTurnMock.mock.calls.at(-1)?.[4]).toEqual({ type: 'setup', setup });
    });

    it('warns a guest when the host closes their page, then sends them home once the lobby closes', async () => {
      await enter('guest', makeRaceLobby('gone', 0));
      expect(document.body.dataset.screen).toBe('race');
      const away = makeRaceLobby('gone', 0);
      away.players[0]!.connected = false;
      send('lobby.state', away);
      expect(byId('connectionBanner').textContent).toMatch(/host disconnected/i);
      expect(document.body.dataset.screen).toBe('race');

      send('lobby.state', { ...away, status: 'FINISHED', terminationReason: 'host_disconnected' });
      expect(document.body.dataset.screen).toBe('home');
      expect(window.location.pathname).toBe('/');
      expect(byId('homeNotice').textContent).toMatch(/host disconnected/i);
      expect(window.sessionStorage.getItem('srp:session:gone')).toBeNull();
    });

    it('sends a guest home when the server closes the socket because the host is gone', async () => {
      await enter('guest', makeRaceLobby('closed', 0));
      socket().close(4001, 'host_disconnected');
      expect(document.body.dataset.screen).toBe('home');
      expect(byId('homeNotice').textContent).toMatch(/host disconnected/i);
    });

    it('the host copies the invite link', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      createLobbyMock.mockResolvedValue({
        lobby: makeLobby('copy'),
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));
      byId('lobbyCopyBtn').click();
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/lobby/copy`);
    });

    it("back from the host's lobby goes home and leaves the lobby", async () => {
      createLobbyMock.mockResolvedValue({
        lobby: makeLobby('back'),
        playerId: 'host-player-id',
        playerToken: 'host-token'
      });
      await import('./main');
      byId('homeCreateBtn').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('lobby'));
      window.history.replaceState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
      expect(document.body.dataset.screen).toBe('home');
      expect(FakeWebSocket.instances[0]!.readyState).toBe(3);
      expect(window.sessionStorage.getItem('srp:session:back')).toBeNull();
    });
  });
});
