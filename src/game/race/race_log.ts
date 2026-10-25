import type { RulesVersion } from '../rules/ids';
import {
  applyAction,
  createRace,
  type ApplyResult,
  type RaceAction,
  type RaceContext,
  type RaceSeat,
  type RaceState
} from './race_engine';

/**
 * A whole race as data (#169): what `createRace` was given and every action `applyAction` accepted, in order. The engine
 * is deterministic, so `replayRace` rebuilds every state from it. Kept next to the race (the solo session, the server's
 * race), never inside `RaceState`, which goes out on every turn.
 */
export interface RaceLog {
  seats: RaceSeat[];
  raceLaps: number;
  seed: number;
  rulesVersion: RulesVersion;
  actions: RaceAction[];
}

/** Starts the log of a race made with `createRace(ctx, seats, raceLaps, seed, rulesVersion)`. */
export function startRaceLog(
  seats: RaceSeat[],
  raceLaps: number,
  seed: number,
  rulesVersion: RulesVersion
): RaceLog {
  return { seats: structuredClone(seats), raceLaps, seed, rulesVersion, actions: [] };
}

/** Records an action the engine accepted (a copy: the caller's setup object may change later). */
export function logAction(log: RaceLog, action: RaceAction): void {
  log.actions.push(structuredClone(action));
}

/** One logged action replayed: the race before and after it (`before` is the previous step's `after`) and the engine's answer. */
export interface ReplayStep {
  action: RaceAction;
  before: RaceState;
  after: RaceState;
  result: Extract<ApplyResult, { ok: true }>;
}

/**
 * The race one action at a time. Throws when the engine refuses an action, which means the log does not match the race
 * it was recorded from.
 */
export function replaySteps(ctx: RaceContext, log: RaceLog): ReplayStep[] {
  const state = createRace(ctx, log.seats, log.raceLaps, log.seed, log.rulesVersion);
  let before = structuredClone(state);
  return log.actions.map((action, i) => {
    const result = applyAction(ctx, state, action);
    if (!result.ok) throw new Error(`Race log action ${i} refused on replay (${result.reason}).`);
    const after = structuredClone(state);
    const step = { action, before, after, result };
    before = after;
    return step;
  });
}

/**
 * Only the last state, on one state with no copies: the server's check of an uploaded log, which runs on its event loop.
 * Throws as `replaySteps` does.
 */
export function replayEnd(ctx: RaceContext, log: RaceLog): RaceState {
  const state = createRace(ctx, log.seats, log.raceLaps, log.seed, log.rulesVersion);
  log.actions.forEach((action, i) => {
    const result = applyAction(ctx, state, action);
    if (!result.ok) throw new Error(`Race log action ${i} refused on replay (${result.reason}).`);
  });
  return state;
}

/** Every state of the race: `states[0]` is the grid, `states[i]` the race after `actions[i - 1]`. */
export function replayRace(ctx: RaceContext, log: RaceLog): RaceState[] {
  const grid = createRace(ctx, log.seats, log.raceLaps, log.seed, log.rulesVersion);
  return [grid, ...replaySteps(ctx, log).map((step) => step.after)];
}
