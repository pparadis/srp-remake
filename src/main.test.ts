/** @vitest-environment jsdom */
import indexHtml from '../index.html?raw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import track from '../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar
} from './game/race/race_engine';
import { logAction, startRaceLog } from './game/race/race_log';
import { saveRace } from './ui/recap_store';
import type { TrackData } from './game/types/track';

const startGame = vi.fn();

vi.mock('./game', () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));

// The real page markup, so the test cannot drift from index.html.
function loadBody() {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/
    .exec(indexHtml)![1]!
    .replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.dataset.screen = 'home';
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

// Each test imports a fresh main.ts, which adds its own window listeners: drop them after the test, or a
// back navigation or a key press would also reach the pages of earlier tests.
const added: Array<[string, Parameters<typeof window.removeEventListener>[1]]> = [];
const realAdd = window.addEventListener.bind(window);

// The browser's back button: the URL is already the previous entry when popstate fires.
function goBack(path: string) {
  window.history.replaceState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function startSoloRace() {
  byId('homeQuickBtn').click();
  byId('lobbyStartBtn').click();
  await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
  expect(document.body.dataset.screen).toBe('race');
}

describe('main (solo flow)', () => {
  beforeEach(() => {
    vi.resetModules();
    startGame.mockReset();
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
    loadBody();
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) added.push([type, listener]);
      realAdd(type, listener, options);
    });
  });

  afterEach(() => {
    for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not start a game on load', async () => {
    await import('./main');
    expect(document.body.dataset.screen).toBe('home');
    expect(startGame).not.toHaveBeenCalled();
  });

  it('draws the home track at startup and pauses its laps while another screen is shown', async () => {
    const pause = vi.fn();
    const unpause = vi.fn();
    Object.assign(SVGSVGElement.prototype, { pauseAnimations: pause, unpauseAnimations: unpause });
    await import('./main');
    expect(document.querySelectorAll('#homeTrack g.home-car')).toHaveLength(3);
    expect(document.querySelector('#homeTrack #home-lane-1')).not.toBeNull();
    expect([pause.mock.calls.length, unpause.mock.calls.length]).toEqual([0, 1]);

    byId('homeQuickBtn').click(); // the solo lobby
    expect(pause).toHaveBeenCalledTimes(1);
    goBack('/');
    expect(unpause).toHaveBeenCalledTimes(2);
    delete (SVGSVGElement.prototype as Partial<SVGSVGElement>).pauseAnimations;
    delete (SVGSVGElement.prototype as Partial<SVGSVGElement>).unpauseAnimations;
  });

  it('"Race now" is the main button and leads to the solo lobby', async () => {
    await import('./main');
    expect(byId('homeQuickBtn').textContent?.trim()).toBe('Race now');
    expect(byId('homeQuickBtn').classList.contains('primary')).toBe(true);
    byId('homeQuickBtn').click();
    expect(document.body.dataset.screen).toBe('lobby');
    expect(window.location.pathname).toBe('/solo');
  });

  it('the quick race menu picks the movement rules, v2 first, and the game gets them (#118)', async () => {
    startGame.mockImplementation(() => ({
      destroy: vi.fn(),
      canvas: document.createElement('canvas')
    }));
    await import('./main');
    byId('homeQuickBtn').click();
    const rules = byId<HTMLSelectElement>('lobbyRules');
    expect(byId('lobbyRulesField').hidden).toBe(false);
    expect(rules.value).toBe('v3');
    expect([...rules.options].map((o) => o.value)).toEqual(['v3', 'v2', 'v1']);
    rules.value = 'v1';
    rules.dispatchEvent(new Event('change'));
    expect(byId<HTMLSelectElement>('lobbyRules').value).toBe('v1'); // kept across the re-render
    byId('lobbyStartBtn').click();
    await vi.waitFor(() =>
      expect(startGame).toHaveBeenCalledWith(
        byId('app'),
        expect.objectContaining({ rulesVersion: 'v1' })
      )
    );
  });

  it('?rules=v1 (the sandbox link) starts the menu on v1; an unknown value on the default', async () => {
    window.history.replaceState({}, '', '/?rules=v1');
    await import('./main');
    byId('homeQuickBtn').click();
    expect(byId<HTMLSelectElement>('lobbyRules').value).toBe('v1');
    vi.resetModules();
    window.history.replaceState({}, '', '/?rules=v9');
    await import('./main');
    byId('homeQuickBtn').click();
    expect(byId<HTMLSelectElement>('lobbyRules').value).toBe('v3');
  });

  it('quick race -> lobby -> start creates the game with the lobby settings', async () => {
    const destroy = vi.fn();
    const canvas = document.createElement('canvas');
    startGame.mockImplementation((parent: HTMLElement) => {
      parent.append(canvas);
      return { destroy, canvas };
    });
    await import('./main');

    byId('homeQuickBtn').click();
    expect(document.body.dataset.screen).toBe('lobby');
    expect(window.location.pathname).toBe('/solo');
    expect(byId('lobbyPlayersBlock').hidden).toBe(true);

    const bots = byId<HTMLSelectElement>('lobbyBots');
    bots.value = '2';
    bots.dispatchEvent(new Event('change'));
    const laps = byId<HTMLInputElement>('lobbyLaps');
    laps.value = '2';
    laps.dispatchEvent(new Event('change'));
    const level = byId<HTMLSelectElement>('lobbyBotLevel');
    expect(level.value).toBe('normal');
    expect(byId('lobbyBotLevelField').hidden).toBe(false);
    level.value = 'hard';
    level.dispatchEvent(new Event('change'));

    byId('lobbyStartBtn').click();
    expect(window.location.pathname).toBe('/solo/race');
    await vi.waitFor(() => {
      expect(startGame).toHaveBeenCalledWith(byId('app'), {
        totalCars: 3,
        humanCars: 1,
        botCars: 2,
        raceLaps: 2,
        botLevel: 'hard',
        seed: expect.any(Number),
        rulesVersion: 'v3',
        hidpi: true,
        animate: false
      });
    });

    byId('lobbyLeaveBtn').click();
    byId('homeQuickBtn').click();
    expect(destroy).toHaveBeenCalled();
    // Phaser removes its canvas only on its next frame: it leaves the page at once, so a new race never shows two
    expect(canvas.isConnected).toBe(false);
  });

  it('reloading /solo/race falls back to /solo', async () => {
    window.history.replaceState({}, '', '/solo/race');
    await import('./main');
    expect(window.location.pathname).toBe('/solo');
    expect(document.body.dataset.screen).toBe('lobby');
    expect(startGame).not.toHaveBeenCalled();
  });

  it('redirects old ?lobby= links to /lobby/:id', async () => {
    window.history.replaceState({}, '', '/?lobby=abc');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
    await import('./main');
    expect(window.location.pathname).toBe('/lobby/abc');
    expect(window.location.search).toBe('');
    vi.unstubAllGlobals();
  });

  it('back from /solo returns home', async () => {
    await import('./main');
    byId('homeQuickBtn').click();
    expect(window.location.pathname).toBe('/solo');
    goBack('/');
    expect(document.body.dataset.screen).toBe('home');
  });

  it('back from a solo race asks before leaving, and stays on the race when declined', async () => {
    const destroy = vi.fn();
    startGame.mockReturnValue({ destroy });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await import('./main');
    await startSoloRace();

    goBack('/solo');
    expect(confirm).toHaveBeenCalledWith('Leave race?');
    expect(window.location.pathname).toBe('/solo/race');
    expect(document.body.dataset.screen).toBe('race');
    expect(destroy).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    goBack('/solo');
    expect(window.location.pathname).toBe('/solo');
    expect(document.body.dataset.screen).toBe('lobby');
    expect(destroy).toHaveBeenCalled();
  });

  it('leaves a finished race without asking', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    startGame.mockReturnValue({ destroy: vi.fn() });
    await import('./main');
    await startSoloRace();
    window.dispatchEvent(new CustomEvent('srp:race-finished', { detail: { winnerCarId: 1 } }));
    expect(byId('results').hidden).toBe(false);
    expect(byId('resultsWinner').textContent).toBe('Car 1 (you) wins');
    goBack('/solo');
    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.dataset.screen).toBe('lobby');
    expect(byId('results').hidden).toBe(true);
  });

  describe('the race recap (#169)', () => {
    // a few real bot turns: enough for a log that replays
    function shortLog() {
      const ctx = createRaceContext(track as unknown as TrackData);
      const seats = [
        { isBot: false, ownerId: 'P1' },
        { isBot: true, ownerId: 'BOT1', botLevel: 'normal' as const }
      ];
      const state = createRace(ctx, seats, 5, 0, 'v3');
      const log = startRaceLog(seats, 5, 0, 'v3');
      for (let i = 0; i < 8; i += 1) {
        const action = decideBotAction(
          ctx,
          state,
          getActiveCar(state).isBot ? undefined : 'autopilot'
        ).action;
        applyAction(ctx, state, action);
        logAction(log, action);
      }
      return log;
    }
    const finish = (recap: unknown) =>
      window.dispatchEvent(
        new CustomEvent('srp:race-finished', { detail: { winnerCarId: 1, recap } })
      );

    it('offers the recap of a finished solo race, saves it, and lists it on the home screen', async () => {
      startGame.mockReturnValue({ destroy: vi.fn() });
      await import('./main');
      await startSoloRace();
      expect(byId('resultsRecapBtn').hidden).toBe(true);
      finish({ log: shortLog(), names: { 1: 'You', 2: 'Car 2' } });
      expect(byId('resultsRecapBtn').hidden).toBe(false);
      const saved = JSON.parse(window.localStorage.getItem('srp:races')!) as Array<{
        label: string;
      }>;
      expect(saved).toHaveLength(1);
      expect(saved[0]!.label).toBe('Solo, 5 laps, you won');

      byId('resultsHomeBtn').click();
      expect(byId('homeRaces').hidden).toBe(false);
      expect(tid('home-race').textContent).toBe('Solo, 5 laps, you won');
    });

    it('has no recap button for a race with no log (online, or edited in the sandbox)', async () => {
      startGame.mockReturnValue({ destroy: vi.fn() });
      await import('./main');
      await startSoloRace();
      finish(null);
      expect(byId('resultsRecapBtn').hidden).toBe(true);
      expect(window.localStorage.getItem('srp:races')).toBeNull();
    });

    it('opens the recap page from the results screen and from the home list', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(track), { status: 200 }))
      );
      startGame.mockReturnValue({ destroy: vi.fn() });
      await import('./main');
      await startSoloRace();
      finish({ log: shortLog(), names: { 1: 'You', 2: 'Car 2' } });

      byId('resultsRecapBtn').click();
      await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
      expect(document.body.dataset.screen).toBe('recap');
      expect(window.location.pathname).toMatch(/^\/recap\//);
      expect(tid('recap-title').textContent).toBe('Solo, 5 laps, you won');

      tid('recap-back').click();
      expect(document.body.dataset.screen).toBe('home');
      tid('home-race').click();
      await vi.waitFor(() => expect(document.body.dataset.screen).toBe('recap'));
      await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
    });

    describe('sharing solo races (#170)', () => {
      const shared = { log: undefined as unknown, calls: 0 };
      function stubUpload(answer: () => Response | Promise<Response>) {
        shared.calls = 0;
        shared.log = undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string, init?: { body?: string }) => {
            if (String(url).endsWith('/api/v1/races')) {
              shared.calls += 1;
              shared.log = JSON.parse(init?.body ?? '{}');
              return answer();
            }
            return new Response('{}', { status: 404 });
          })
        );
      }
      const quickRace = async () => {
        startGame.mockReturnValue({ destroy: vi.fn() });
        await import('./main');
        byId('homeQuickBtn').click();
      };
      const share = () => tid('lobby-share') as HTMLInputElement;

      it('is off by default, remembers the choice, and is solo only', async () => {
        await quickRace();
        expect(share().checked).toBe(false);
        expect(byId('lobbyShareField').hidden).toBe(false);
        share().checked = true;
        share().dispatchEvent(new Event('change'));
        expect(window.localStorage.getItem('srp:share-solo')).toBe('1');
        share().checked = false;
        share().dispatchEvent(new Event('change'));
        expect(window.localStorage.getItem('srp:share-solo')).toBeNull();

        window.localStorage.setItem('srp:share-solo', '1');
        vi.resetModules();
        loadBody();
        await quickRace();
        expect(share().checked).toBe(true);
      });

      it('uploads the finished race when it is on, and says so', async () => {
        stubUpload(
          () => new Response(JSON.stringify({ id: 'x', duplicate: false }), { status: 201 })
        );
        window.localStorage.setItem('srp:share-solo', '1');
        await quickRace();
        byId('lobbyStartBtn').click();
        await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
        const log = shortLog();
        window.dispatchEvent(
          new CustomEvent('srp:race-finished', {
            detail: { winnerCarId: 1, recap: { log, names: { 1: 'You', 2: 'Car 2' } } }
          })
        );
        await vi.waitFor(() => expect(byId('resultsShared').hidden).toBe(false));
        expect(shared.calls).toBe(1);
        expect(shared.log).toEqual({ trackId: 'oval16_3lanes', log });
        expect(byId('resultsShared').textContent).toContain('Shared in the public history');
      });

      it('says when the race is already there, and when it could not be shared', async () => {
        stubUpload(
          () => new Response(JSON.stringify({ id: 'x', duplicate: true }), { status: 200 })
        );
        window.localStorage.setItem('srp:share-solo', '1');
        await quickRace();
        byId('lobbyStartBtn').click();
        await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
        const finish = () =>
          window.dispatchEvent(
            new CustomEvent('srp:race-finished', {
              detail: {
                winnerCarId: 1,
                recap: { log: shortLog(), names: { 1: 'You', 2: 'Car 2' } }
              }
            })
          );
        finish();
        await vi.waitFor(() => expect(byId('resultsShared').textContent).toContain('Already in'));

        stubUpload(() => new Response('{"error":"down"}', { status: 503 }));
        finish();
        await vi.waitFor(() =>
          expect(byId('resultsShared').textContent).toContain('Could not share')
        );
        expect(byId('resultsRecapBtn').hidden).toBe(false); // the local recap is not affected
      });

      it('does not upload when it is off, nor a race with no log', async () => {
        stubUpload(() => new Response('{}', { status: 201 }));
        await quickRace();
        byId('lobbyStartBtn').click();
        await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
        window.dispatchEvent(
          new CustomEvent('srp:race-finished', {
            detail: { winnerCarId: 1, recap: { log: shortLog(), names: { 1: 'You' } } }
          })
        );
        window.localStorage.setItem('srp:share-solo', '1');
        window.dispatchEvent(
          new CustomEvent('srp:race-finished', { detail: { winnerCarId: 1, recap: null } })
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(shared.calls).toBe(0);
        expect(byId('resultsShared').hidden).toBe(true);
      });
    });

    describe('the public history (#170)', () => {
      const summary = {
        id: 'srv-1',
        finishedAt: 1_700_000_000_000,
        source: 'solo',
        trackId: 'oval16_3lanes',
        rulesVersion: 'v3',
        laps: 5,
        cars: 2,
        winnerCarId: 1
      };
      function stubServer(routes: Record<string, () => Response>) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: string) => {
            // the path without the origin (the test backend may be relative) and without the query
            const path =
              String(url)
                .replace(/^https?:\/\/[^/]+/, '')
                .split('?')[0] ?? '';
            if (path.endsWith('.json')) return new Response(JSON.stringify(track), { status: 200 });
            const answer = routes[path];
            return answer ? answer() : new Response('{"error":"not_found"}', { status: 404 });
          })
        );
      }
      const json =
        (body: unknown, status = 200) =>
        () =>
          new Response(JSON.stringify(body), { status });

      it('lists the server races from the home button, and opens one as a recap fetched from the server', async () => {
        stubServer({
          '/api/v1/races': json({ races: [summary] }),
          '/api/v1/races/srv-1': json({ ...summary, log: shortLog() })
        });
        await import('./main');
        tid('home-history').click();
        await vi.waitFor(() => expect(tid('history-race')).not.toBeNull());
        expect(document.body.dataset.screen).toBe('history');
        expect(window.location.pathname).toBe('/history');

        tid('history-race').click();
        await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
        expect(document.body.dataset.screen).toBe('recap');
        expect(window.location.pathname).toBe('/history/srv-1');
        expect(tid('recap-title').textContent).toBe('Solo, 5 laps, Player 1 won');

        // Back from a public race goes to the list; the race was not kept in this browser
        tid('recap-back').click();
        expect(document.body.dataset.screen).toBe('history');
        expect(window.localStorage.getItem('srp:races')).toBeNull();
      });

      it('replays a public race on the board and returns to its recap', async () => {
        stubServer({
          '/api/v1/races/srv-1': json({ ...summary, log: shortLog() })
        });
        startGame.mockReturnValue({ destroy: vi.fn() });
        window.history.replaceState({}, '', '/history/srv-1');
        await import('./main');
        await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
        tid('recap-watch').click();
        await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
        expect(window.location.pathname).toBe('/history/srv-1/board');
        expect(byId('replayBar').hidden).toBe(false);
        tid('replay-recap').click();
        await vi.waitFor(() => expect(document.body.dataset.screen).toBe('recap'));
        expect(window.location.pathname).toBe('/history/srv-1');
        await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
      });

      it('says when the history is down and tries again on request', async () => {
        stubServer({ '/api/v1/races': json({ error: 'down' }, 503) });
        await import('./main');
        tid('home-history').click();
        await vi.waitFor(() => expect(tid('history-error').textContent).toContain('not available'));
        stubServer({ '/api/v1/races': json({ races: [summary] }) });
        tid('history-retry').click();
        await vi.waitFor(() => expect(tid('history-race')).not.toBeNull());
      });

      it('goes home with a notice for a race the server does not know', async () => {
        stubServer({});
        window.history.replaceState({}, '', '/history/nope');
        await import('./main');
        await vi.waitFor(() =>
          expect(byId('homeNotice').textContent).toContain('not in the history')
        );
        expect(document.body.dataset.screen).toBe('home');
      });
    });

    describe('the board replay', () => {
      const states: Array<{ revision: number; source: string; localPlayerId: string }> = [];
      const onState = (event: Event) => {
        const detail = (
          event as CustomEvent<(typeof states)[number] & { lobby: { revision: number } }>
        ).detail;
        states.push({
          revision: detail.lobby.revision,
          source: detail.source,
          localPlayerId: detail.localPlayerId
        });
      };

      async function openBoard(at?: number) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response(JSON.stringify(track), { status: 200 }))
        );
        startGame.mockReturnValue({ destroy: vi.fn() });
        states.length = 0;
        window.addEventListener('srp:backend-lobby-state', onState);
        saveRace({
          id: 'saved-1',
          finishedAt: 1,
          trackId: 'oval16_3lanes',
          label: 'Solo, 5 laps, you won',
          names: { '1': 'You', '2': 'Car 2' },
          log: shortLog()
        });
        await import('./main');
        if (at === undefined) {
          window.history.pushState({}, '', '/recap/saved-1/board');
          window.dispatchEvent(new PopStateEvent('popstate'));
        } else {
          window.history.pushState({}, '', '/recap/saved-1');
          window.dispatchEvent(new PopStateEvent('popstate'));
          await vi.waitFor(() => expect(tid('recap-open-turns')).not.toBeNull());
          tid('recap-open-turns').click();
          for (let i = 0; i < at; i += 1) tid('recap-next').click();
          tid('recap-watch-turn').click();
        }
        await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
        window.dispatchEvent(new Event('srp:scene-ready'));
      }

      afterEach(() => {
        window.removeEventListener('srp:backend-lobby-state', onState);
        vi.useRealTimers();
      });

      it('starts a scene for the race with nobody in control, and shows the grid first', async () => {
        await openBoard();
        expect(document.body.dataset.screen).toBe('race');
        expect(startGame).toHaveBeenCalledWith(
          byId('app'),
          expect.objectContaining({ totalCars: 2, humanCars: 2, botCars: 0, raceLaps: 5, seed: 0 })
        );
        expect(byId('replayBar').hidden).toBe(false);
        expect(states.at(-1)).toEqual({ revision: 0, source: 'replay', localPlayerId: '' });
        expect(tid('replay-count').textContent).toBe('0 / 8');
        expect(tid('replay-text').textContent).toBe('On the grid');
        expect(tid('replay-prev')).toHaveProperty('disabled', true);
      });

      it('steps with the buttons and the arrow keys, and stops at both ends', async () => {
        await openBoard();
        tid('replay-next').click();
        expect(states.at(-1)!.revision).toBe(1);
        expect(tid('replay-count').textContent).toBe('1 / 8');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        expect(states.at(-1)!.revision).toBe(2);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        tid('replay-prev').click();
        expect(states.at(-1)!.revision).toBe(0);
        const before = states.length;
        tid('replay-prev').click(); // already on the grid
        expect(states).toHaveLength(before);
        for (let i = 0; i < 12; i += 1) tid('replay-next').click();
        expect(states.at(-1)!.revision).toBe(8);
        expect(tid('replay-next')).toHaveProperty('disabled', true);
      });

      it('plays on by itself and pauses at the end', async () => {
        await openBoard();
        vi.useFakeTimers();
        tid('replay-play').click();
        expect(tid('replay-play').textContent).toBe('Pause');
        vi.advanceTimersByTime(1200 * 3);
        expect(states.at(-1)!.revision).toBeGreaterThanOrEqual(2);
        vi.advanceTimersByTime(1200 * 20);
        expect(states.at(-1)!.revision).toBe(8);
        expect(tid('replay-play').textContent).toBe('Play');
      });

      it('opens at the turn picked in the recap', async () => {
        await openBoard(4);
        expect(states.at(-1)!.revision).toBe(5); // the race after the 5th action
        expect(tid('replay-count').textContent).toBe('5 / 8');
      });

      it('does not take the replay reaching the flag for a race ending, and goes back to the recap', async () => {
        await openBoard();
        window.dispatchEvent(
          new CustomEvent('srp:race-finished', { detail: { winnerCarId: 1, recap: null } })
        );
        expect(byId('results').hidden).toBe(true);
        tid('replay-recap').click();
        await vi.waitFor(() => expect(document.body.dataset.screen).toBe('recap'));
        expect(window.location.pathname).toBe('/recap/saved-1');
        expect(byId('replayBar').hidden).toBe(true);
        // let the recap finish loading: a request still on its way would reach into the next test
        await vi.waitFor(() => expect(tid('recap-car')).not.toBeNull());
      });
    });

    it('goes home with a notice for a recap that is no longer saved', async () => {
      window.history.replaceState({}, '', '/recap/gone');
      await import('./main');
      // the page starts on home: wait for the notice itself, not for the screen
      await vi.waitFor(() => expect(byId('homeNotice').textContent).toContain('no longer saved'));
      expect(document.body.dataset.screen).toBe('home');
    });
  });

  it('has no chat in a solo race', async () => {
    startGame.mockReturnValue({ destroy: vi.fn() });
    await import('./main');
    await startSoloRace();
    expect(document.body.dataset.screen).toBe('race');
    expect(tid('hud-chat').hidden).toBe(true);
    expect(byId('lobbyChatBlock').hidden).toBe(true);
  });

  describe('frame-rate readout (issue #79)', () => {
    // a game with an event emitter, so the meter can hook postrender
    const listeners = new Set<() => void>();
    const fakeGame = () => ({
      destroy: vi.fn(),
      events: {
        on: (_event: string, fn: () => void) => listeners.add(fn),
        off: (_event: string, fn: () => void) => listeners.delete(fn)
      }
    });
    const line = () => tid('hud-fps');

    beforeEach(() => {
      listeners.clear();
      startGame.mockReturnValue(fakeGame());
    });

    it('P toggles it during a race, and it counts the frames the game draws', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
      await import('./main');
      await startSoloRace();
      expect(line().hidden).toBe(true);
      expect(listeners.size).toBe(0);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
      expect(line().hidden).toBe(false);
      expect(line().textContent).toBe('fps \u2026');
      expect(tid('hud-fps-toggle').getAttribute('aria-pressed')).toBe('true');
      expect(listeners.size).toBe(1);

      for (let i = 0; i < 30; i += 1) {
        vi.advanceTimersByTime(30);
        for (const fn of listeners) fn();
      }
      vi.advanceTimersByTime(100);
      expect(line().textContent).toMatch(/^fps 3\d \u00b7 worst frame \d+ ms$/);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P' }));
      expect(line().hidden).toBe(true);
      expect(listeners.size).toBe(0);
      vi.useRealTimers();
    });

    it('ignores P while typing in a field and off the race screen', async () => {
      await import('./main');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
      expect(line().hidden).toBe(true);

      await startSoloRace();
      const input = document.createElement('input');
      document.body.append(input);
      input.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
      expect(line().hidden).toBe(true);
      input.blur();
      input.remove();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
      expect(line().hidden).toBe(true);
    });

    it('the touch button toggles it; ?fps starts it on; a new race starts a fresh meter', async () => {
      window.history.replaceState({}, '', '/?fps');
      await import('./main');
      await startSoloRace();
      expect(line().hidden).toBe(false);
      expect(listeners.size).toBe(1);

      tid('hud-fps-toggle').click();
      expect(line().hidden).toBe(true);
      expect(listeners.size).toBe(0);
      tid('hud-fps-toggle').click();
      expect(listeners.size).toBe(1);

      // leaving the race drops the listener with the game; the next race hooks the new game again
      vi.stubGlobal('confirm', () => true);
      goBack('/');
      expect(listeners.size).toBe(0);
      startGame.mockClear();
      startGame.mockReturnValue(fakeGame());
      await startSoloRace();
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      expect(line().hidden).toBe(false);
    });
  });

  it('the mute toggle follows the button and the M key, and persists across reloads', async () => {
    startGame.mockReturnValue({ destroy: vi.fn() });
    await import('./main');
    expect(tid('hud-mute').textContent).toBe('Sound: on');
    tid('hud-mute').click();
    expect(tid('hud-mute').textContent).toBe('Sound: off');
    expect(window.localStorage.getItem('srp:muted')).toBe('1');

    // reload: a fresh page reads the stored choice
    for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
    vi.resetModules();
    loadBody();
    await import('./main');
    expect(tid('hud-mute').textContent).toBe('Sound: off');

    // M only works on the race screen
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(tid('hud-mute').textContent).toBe('Sound: off');
    await startSoloRace();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M' }));
    expect(tid('hud-mute').textContent).toBe('Sound: on');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }));
    expect(tid('hud-mute').textContent).toBe('Sound: on');
  });

  it('C on the race screen asks the scene to toggle cars and moves', async () => {
    startGame.mockReturnValue({ destroy: vi.fn() });
    const toggles = vi.fn();
    await import('./main');
    window.addEventListener('srp:toggle-cars-moves', toggles);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    expect(toggles).not.toHaveBeenCalled();
    await startSoloRace();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    expect(toggles).toHaveBeenCalledTimes(1);
  });
});
