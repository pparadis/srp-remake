import { must } from '../game/must';
import type { PublicLobby } from '../net/backend_api';
import { isTypingTarget } from './typing';
import type { Replay } from './replay_load';

// The board replay's bar (#169, #202): the buttons, the counter and the play timer of a saved race watched on the real
// board. The race scene only sees the lobby states that `sendState` hands out; opening the game for the replay stays with
// the page controller. DOM only, no Phaser; `Replay` is a type, so the lazy replay chunk stays out of the first bundle.

const STEP_MS = 1100;

/** One replay on the board. `composition` is what the page builds the game from; the bar only keeps it. */
export interface ReplayRun<C> {
  raceId: string;
  remote: boolean;
  replay: Replay;
  /** The state shown: 0 is the grid. */
  at: number;
  composition: C;
  timer: number | null;
}

export interface ReplayBar<C> {
  /** Shows the bar on `run`, paused, replacing any run. Does not send a state: the game is opened by the caller. */
  start(run: Omit<ReplayRun<C>, 'timer'>): void;
  /** Sends the state now shown to the board (the scene asks for it once it is built). */
  send(): void;
  /** Hides the bar and drops the run. */
  stop(): void;
  current(): ReplayRun<C> | null;
}

export interface ReplayBarCallbacks {
  /** The lobby state to show on the board (the scene glides the cars that moved). */
  sendState: (lobby: PublicLobby) => void;
  /** The "Recap" button. */
  openRecap: (raceId: string, remote: boolean) => void;
}

export function mountReplayBar<C>(root: HTMLElement, callbacks: ReplayBarCallbacks): ReplayBar<C> {
  const part = <T extends HTMLElement>(id: string) =>
    must(root.querySelector<T>(`#${id}`), `replay bar #${id}`);
  const prevBtn = part<HTMLButtonElement>('replayPrevBtn');
  const nextBtn = part<HTMLButtonElement>('replayNextBtn');
  const playBtn = part<HTMLButtonElement>('replayPlayBtn');
  const count = part('replayCount');
  const text = part('replayText');
  let run: ReplayRun<C> | null = null;

  function render() {
    root.hidden = run === null;
    if (!run) return;
    const last = run.replay.count - 1;
    count.textContent = `${run.at} / ${last}`;
    text.textContent = run.replay.textAt(run.at) || 'On the grid';
    prevBtn.disabled = run.at <= 0;
    nextBtn.disabled = run.at >= last;
    playBtn.textContent = run.timer === null ? 'Play' : 'Pause';
  }

  function sendState() {
    if (!run) return;
    callbacks.sendState(run.replay.lobbyAt(run.at));
    render();
  }

  function pause() {
    if (run?.timer != null) window.clearInterval(run.timer);
    if (run) run.timer = null;
  }

  /** Moves the replay to state `to` (clamped); the scene glides the cars that moved. */
  function step(to: number) {
    if (!run) return;
    const at = Math.max(0, Math.min(run.replay.count - 1, to));
    if (at === run.at) return;
    run.at = at;
    if (at >= run.replay.count - 1) pause();
    sendState();
  }

  function togglePlay() {
    if (!run) return;
    if (run.timer !== null) {
      pause();
      render();
      return;
    }
    if (run.at >= run.replay.count - 1) run.at = 0;
    run.timer = window.setInterval(() => {
      if (run) step(run.at + 1);
    }, STEP_MS);
    sendState();
  }

  prevBtn.addEventListener('click', () => {
    pause();
    if (run) step(run.at - 1);
  });
  nextBtn.addEventListener('click', () => {
    pause();
    if (run) step(run.at + 1);
  });
  playBtn.addEventListener('click', togglePlay);
  part('replayRecapBtn').addEventListener('click', () => {
    if (run) callbacks.openRecap(run.raceId, run.remote);
  });
  window.addEventListener('keydown', (event) => {
    if (!run || isTypingTarget() || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      pause();
      step(run.at + (event.key === 'ArrowRight' ? 1 : -1));
      event.preventDefault();
    }
  });

  return {
    start(next) {
      pause();
      run = { ...next, timer: null };
      render();
    },
    send: sendState,
    stop() {
      pause();
      run = null;
      render();
    },
    current: () => run
  };
}
