// What a golden file records of a rules version (#118), shared by the generator (tools/rules_golden.ts) and the test
// that replays it (rules_golden.test.ts).
import {
  applyAction,
  computeTargets,
  getActiveCar,
  type RaceAction,
  type RaceContext,
  type RaceState
} from '../race/race_engine';
import { must } from '../must';
import type { RulesVersion } from './versions';

export interface GoldenSample {
  name: string;
  state: RaceState;
  /** the active car's offered targets, sorted by cell id */
  targets: [string, unknown][];
  action: RaceAction;
  /** the active car after the action; null when the action was refused */
  after: unknown;
}

export interface Golden {
  version: string;
  generatedFrom: string;
  trackId: string;
  samples: GoldenSample[];
}

/** Plain JSON, as the file stores it (no undefined fields). */
export function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function carAfter(state: RaceState, carId: number) {
  const c = must(
    state.cars.find((x) => x.carId === carId),
    'car'
  );
  return {
    cellId: c.cellId,
    lapCount: c.lapCount ?? 0,
    tire: c.tire,
    fuel: c.fuel,
    moveCycle: c.moveCycle,
    draftTurns: c.draftTurns ?? 0,
    slingshots: c.slingshots ?? 0,
    state: c.state
  };
}

export function targetsOf(ctx: RaceContext, state: RaceState): [string, unknown][] {
  return [...computeTargets(ctx, state, getActiveCar(state)).entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );
}

/** What the rules answer for a sample's position now: its targets, and the car after the recorded action. */
export function replay(
  ctx: RaceContext,
  sample: GoldenSample,
  rulesVersion: RulesVersion
): Pick<GoldenSample, 'targets' | 'after'> {
  // v1's file was made before states carried a version: the version under test is set on every sample
  const state = { ...plain(sample.state), rulesVersion };
  const targets = targetsOf(ctx, state);
  const carId = getActiveCar(state).carId;
  const result = applyAction(ctx, state, sample.action);
  return plain({ targets, after: result.ok ? carAfter(state, carId) : null });
}
