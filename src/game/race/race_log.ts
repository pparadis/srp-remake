import type { RulesVersion } from '../rules/ids';
import {
  applyAction,
  createRace,
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

/**
 * Every state of the race: `states[0]` is the grid, `states[i]` the race after `actions[i - 1]`. Throws when the engine
 * refuses an action, which means the log does not match the race it was recorded from.
 */
export function replayRace(ctx: RaceContext, log: RaceLog): RaceState[] {
  const state = createRace(ctx, log.seats, log.raceLaps, log.seed, log.rulesVersion);
  const states = [structuredClone(state)];
  log.actions.forEach((action, i) => {
    const result = applyAction(ctx, state, action);
    if (!result.ok) throw new Error(`Race log action ${i} refused on replay (${result.reason}).`);
    states.push(structuredClone(state));
  });
  return states;
}
