// v3's tire, fuel and move-size rules (#148), the only copy of the math: the engine, the bots, the strategy readouts and
// the HUD reach it through `resourcesOf(state, trackIndex)`. v1 and v2 keep their own in rules/v2/resources.ts.
import {
  COMPOUND_TABLE,
  COMPOUNDS,
  FUEL_LOAD_MIN,
  FUEL_LOAD_STEP,
  FUEL_MARGIN,
  HEAVY_FUEL,
  MOVE_BUDGET,
  MOVE_CYCLE,
  MOVE_FACTOR,
  NORMAL_MOVE_POINTS,
  SETUP_LIMITS,
  STINT_LAPS,
  WING_EFFECTS,
  WING_LEVELS,
  type Compound
} from '../constants';
import type { RaceScale, ResourceRules, ResourceRulesFor } from '../rules/resource_rules';
import type { CarSetup } from '../types/car';

/** Cells one tank and one tire set are sized for: a stint of at most STINT_LAPS laps. */
export function capacityCells(race: RaceScale): number {
  return Math.min(race.raceLaps, STINT_LAPS) * race.spineLen;
}

/** Fuel per cell at the normal pace: a full tank covers FUEL_MARGIN times the stint. */
export function fuelPerCell(race: RaceScale): number {
  return 100 / (capacityCells(race) * FUEL_MARGIN);
}

/** Tire wear per cell at the normal pace: a set lasts `tireLife` stints. */
export function tirePerCell(race: RaceScale, compound: Compound): number {
  return 100 / (capacityCells(race) * COMPOUND_TABLE[compound].tireLife);
}

/** The wear multipliers of a move that spends `points` move points. */
export function moveFactor(points: number): { fuel: number; tire: number } {
  if (points < NORMAL_MOVE_POINTS) return MOVE_FACTOR.conservative;
  return points === NORMAL_MOVE_POINTS ? MOVE_FACTOR.normal : MOVE_FACTOR.high;
}

/** v3 prices wear to 0.1: whole numbers would swallow a 15% factor. */
export function roundWear(amount: number): number {
  return Math.round(amount * 10) / 10;
}

export function fuelLoadOf(setup: Pick<CarSetup, 'fuelLoad'>): number {
  return setup.fuelLoad ?? 100;
}

/** The fuel a race of 8s needs, rounded up to a grid step and kept inside what the grid allows. */
export function recommendedFuel(race: RaceScale): number {
  const need = race.raceLaps * race.spineLen * fuelPerCell(race);
  const stepped = Math.ceil(need / FUEL_LOAD_STEP) * FUEL_LOAD_STEP;
  return Math.max(FUEL_LOAD_MIN, Math.min(100, stepped));
}

/** Heavy: the car holds enough fuel to cost a point of pace. */
export function isHeavy(car: { fuel: number }): boolean {
  return car.fuel > HEAVY_FUEL;
}

function isValidFuelLoad(fuelLoad: number | undefined): boolean {
  return (
    fuelLoad === undefined ||
    (Number.isInteger(fuelLoad) &&
      fuelLoad >= FUEL_LOAD_MIN &&
      fuelLoad <= 100 &&
      fuelLoad % FUEL_LOAD_STEP === 0)
  );
}

export const resourceRulesFor: ResourceRulesFor = (race) => {
  const rules: ResourceRules = {
    isValidSetup(setup) {
      const { psi } = SETUP_LIMITS;
      const psiOk = [setup.psi.fl, setup.psi.fr, setup.psi.rl, setup.psi.rr].every(
        (v) => Number.isInteger(v) && v >= psi.min && v <= psi.max
      );
      return (
        COMPOUNDS.includes(setup.compound) &&
        WING_LEVELS.includes(setup.wing) &&
        isValidFuelLoad(setup.fuelLoad) &&
        psiOk
      );
    },
    defaultSetup(dealt) {
      return { ...dealt, compound: 'medium', wing: 'medium', fuelLoad: recommendedFuel(race) };
    },
    moveCap(car) {
      return car.tire === 0 || car.fuel === 0
        ? MOVE_BUDGET.zeroResourceMax
        : COMPOUND_TABLE[car.setup.compound].cap;
    },
    cycleBudget(car) {
      const { cap, budget } = COMPOUND_TABLE[car.setup.compound];
      const pace = budget + WING_EFFECTS[car.setup.wing].pace - (isHeavy(car) ? 1 : 0);
      return Math.min(pace, cap * MOVE_CYCLE.moves);
    },
    wearRates(setup) {
      return {
        tireRate: tirePerCell(race, setup.compound),
        fuelRate: fuelPerCell(race),
        setup
      };
    },
    gridSetup(car, setup) {
      car.setup = structuredClone(setup);
      car.fuel = fuelLoadOf(setup);
    },
    pitService(car, setup) {
      if (setup) car.setup = setup;
      car.tire = 100;
      car.fuel = Math.max(car.fuel, fuelLoadOf(car.setup));
    },
    features: { medium: true, fuelLoad: true }
  };
  return rules;
};
