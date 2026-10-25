/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicLobby } from '../net/backend_api';
import { mountReplayBar, type ReplayBar } from './replay_bar';
import type { Replay } from './replay_load';

const MARKUP = `
  <div id="replayBar" hidden>
    <button id="replayRecapBtn"></button>
    <button id="replayPrevBtn"></button>
    <button id="replayPlayBtn"></button>
    <button id="replayNextBtn"></button>
    <span id="replayCount"></span>
    <span id="replayText"></span>
  </div>
  <input id="field" />`;

// Four states: the grid and three moves.
const replay = {
  count: 4,
  lobbyAt: (index: number) => ({ revision: index }) as unknown as PublicLobby,
  textAt: (index: number) => (index === 0 ? '' : `move ${index}`)
} as unknown as Replay;

const byId = (id: string) => document.getElementById(id) as HTMLButtonElement;
const key = (name: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true, ...init }));

describe('replay bar (#202)', () => {
  let bar: ReplayBar<string>;
  const sendState = vi.fn();
  const openRecap = vi.fn();
  const sent = () =>
    sendState.mock.calls.map(([lobby]) => (lobby as { revision: number }).revision);

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = MARKUP;
    sendState.mockReset();
    openRecap.mockReset();
    bar = mountReplayBar<string>(byId('replayBar'), { sendState, openRecap });
  });
  afterEach(() => {
    bar.stop(); // a run left open would keep its timer and its key handler alive
    vi.useRealTimers();
  });

  const start = (at = 0) =>
    bar.start({ raceId: 'r1', remote: false, replay, at, composition: 'c' });

  it('is hidden until a run starts, and shows the grid with Previous off', () => {
    expect(byId('replayBar').hidden).toBe(true);
    start();
    expect(byId('replayBar').hidden).toBe(false);
    expect(byId('replayCount').textContent).toBe('0 / 3');
    expect(byId('replayText').textContent).toBe('On the grid');
    expect(byId('replayPrevBtn').disabled).toBe(true);
    expect(byId('replayPlayBtn').textContent).toBe('Play');
    expect(sendState).not.toHaveBeenCalled(); // the page opens the game, which asks for the state itself
    expect(bar.current()?.composition).toBe('c');
  });

  it('send() gives the board the state now shown, and nothing with no run', () => {
    bar.send();
    expect(sendState).not.toHaveBeenCalled();
    start(2);
    bar.send();
    expect(sent()).toEqual([2]);
  });

  it('steps with Next and Previous, sends each state, and stops at both ends', () => {
    start();
    byId('replayNextBtn').click();
    byId('replayNextBtn').click();
    byId('replayNextBtn').click();
    byId('replayNextBtn').click(); // already at the end: nothing more
    expect(sent()).toEqual([1, 2, 3]);
    expect(byId('replayCount').textContent).toBe('3 / 3');
    expect(byId('replayText').textContent).toBe('move 3');
    expect(byId('replayNextBtn').disabled).toBe(true);
    byId('replayPrevBtn').click();
    expect(sent().at(-1)).toBe(2);
  });

  it('plays a state every 1.1 s, pauses at the end, and plays again from the grid', () => {
    start();
    byId('replayPlayBtn').click();
    expect(byId('replayPlayBtn').textContent).toBe('Pause');
    vi.advanceTimersByTime(1100);
    vi.advanceTimersByTime(1100);
    expect(sent()).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(1100);
    expect(byId('replayCount').textContent).toBe('3 / 3');
    expect(byId('replayPlayBtn').textContent).toBe('Play'); // reached the end: paused by itself
    vi.advanceTimersByTime(5000);
    expect(sent()).toEqual([0, 1, 2, 3]);

    byId('replayPlayBtn').click(); // from the end: back to the grid
    expect(byId('replayCount').textContent).toBe('0 / 3');
  });

  it('pauses on a second click on Play and when a step is taken by hand', () => {
    start();
    byId('replayPlayBtn').click();
    byId('replayPlayBtn').click();
    vi.advanceTimersByTime(5000);
    expect(bar.current()?.at).toBe(0);
    byId('replayPlayBtn').click();
    byId('replayNextBtn').click();
    vi.advanceTimersByTime(5000);
    expect(bar.current()?.at).toBe(1);
  });

  it('steps with the arrow keys, but not while typing or with Ctrl', () => {
    start(1);
    key('ArrowRight');
    key('ArrowLeft');
    key('ArrowLeft');
    expect(bar.current()?.at).toBe(0);
    key('ArrowRight', { ctrlKey: true });
    expect(bar.current()?.at).toBe(0);
    byId('field').focus();
    key('ArrowRight');
    expect(bar.current()?.at).toBe(0);
  });

  it('ignores the keys with no run, and stop hides the bar and cancels the timer', () => {
    key('ArrowRight');
    expect(sendState).not.toHaveBeenCalled();
    start();
    byId('replayPlayBtn').click();
    bar.stop();
    expect(byId('replayBar').hidden).toBe(true);
    expect(bar.current()).toBeNull();
    sendState.mockReset();
    vi.advanceTimersByTime(5000);
    expect(sendState).not.toHaveBeenCalled();
  });

  it('starting a new run replaces the old one and its timer', () => {
    start();
    byId('replayPlayBtn').click();
    bar.start({ raceId: 'r2', remote: true, replay, at: 2, composition: 'd' });
    expect(byId('replayCount').textContent).toBe('2 / 3');
    expect(byId('replayPlayBtn').textContent).toBe('Play');
    sendState.mockReset();
    vi.advanceTimersByTime(5000);
    expect(sendState).not.toHaveBeenCalled();
  });

  it('the Recap button names the race and where it came from', () => {
    bar.start({ raceId: 'r2', remote: true, replay, at: 0, composition: 'd' });
    byId('replayRecapBtn').click();
    expect(openRecap).toHaveBeenCalledWith('r2', true);
  });
});
