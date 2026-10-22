import { FUEL_LOAD_MIN, FUEL_LOAD_STEP, SETUP_LIMITS, WING_LEVELS } from '../constants';
import { must } from '../must';
import type { CarSetup } from '../types/car';

// The edits of the setup panels (grid setup, pit stop), shared so the two say the same. All of them change `setup`.

/** What the rules offer: the medium compound and the fuel load row (rules v3). */
export interface SetupFeatures {
  medium: boolean;
  fuelLoad: boolean;
}

/**
 * A setup the rules do not offer (the medium compound, a fuel load) is traded for the closest one they do; the fuel
 * load starts from a full tank when the rules have one and the setup names none. Returns a copy.
 */
export function fitToFeatures(setup: CarSetup, features: SetupFeatures): CarSetup {
  const fitted = structuredClone(setup);
  if (!features.medium && fitted.compound === 'medium') fitted.compound = 'hard';
  if (features.fuelLoad) fitted.fuelLoad ??= 100;
  else delete fitted.fuelLoad;
  return fitted;
}

export function nudgePsi(setup: CarSetup, delta: number): void {
  const clamp = (v: number) =>
    Math.max(SETUP_LIMITS.psi.min, Math.min(SETUP_LIMITS.psi.max, v + delta));
  setup.psi.fl = clamp(setup.psi.fl);
  setup.psi.fr = clamp(setup.psi.fr);
  setup.psi.rl = clamp(setup.psi.rl);
  setup.psi.rr = clamp(setup.psi.rr);
}

/** "-1" is a lower wing (faster, wears more), "+1" a higher one (slower, saves tires and fuel). */
export function nudgeWing(setup: CarSetup, delta: number): void {
  const index = WING_LEVELS.indexOf(setup.wing) + delta;
  setup.wing = must(
    WING_LEVELS[Math.max(0, Math.min(WING_LEVELS.length - 1, index))],
    'wing level'
  );
}

/** "-" is a lighter tank (faster while it is heavy, less range), "+" a heavier one; `direction` is -1 or 1. */
export function nudgeFuel(setup: CarSetup, direction: -1 | 1): void {
  setup.fuelLoad = Math.max(
    FUEL_LOAD_MIN,
    Math.min(100, (setup.fuelLoad ?? 100) + direction * FUEL_LOAD_STEP)
  );
}
