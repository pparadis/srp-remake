// What a rules version decides about tire, fuel and the size of a move (#148). The engine, the bots, the strategy
// readouts and the HUD ask `resourcesOf(state, trackIndex)`; none of them reads a wear constant directly.
import type { Car, CarSetup } from '../types/car';

type Wearing = Pick<Car, 'tire' | 'fuel' | 'setup'>;

/** The length of the race: from v3 on, a tank and a tire set are sized to it. */
export interface RaceScale {
  raceLaps: number;
  spineLen: number;
}

/** What the target search needs to price a move's wear. */
export interface WearRates {
  tireRate: number;
  fuelRate: number;
  setup: CarSetup;
}

export interface ResourceRules {
  /** The setup a grid `setup` action or a pit stop may ask for. */
  isValidSetup(setup: CarSetup): boolean;
  /** The setup a car is dealt, from the plain one it spawns with (its tire pressures are kept). */
  defaultSetup(dealt: CarSetup): CarSetup;
  /** The most move points one move may spend: the car's cap, lower when a tire or the tank is empty. */
  moveCap(car: Wearing): number;
  /** The move points a move cycle holds for this car now. */
  cycleBudget(car: Wearing): number;
  /** Per-cell wear before the setup, lane and tow factors. */
  wearRates(setup: CarSetup): WearRates;
  /** What a move that spends `points` multiplies the per-cell wear by (1 in v1 and v2: the size changes nothing). */
  sizeFactor(points: number): { fuel: number; tire: number };
  /** The grid `setup` action: what the car is set up with before its first turn. */
  gridSetup(car: Wearing, setup: CarSetup): void;
  /** What a pit stop does to the car: fits `setup` (when given) and refills. */
  pitService(car: Wearing, setup: CarSetup | null): void;
  /** What the setup UI offers; `psi` (tire pressure rows) is off on every live version, #163. */
  features: { medium: boolean; fuelLoad: boolean; psi: boolean };
}

/** A version's resource rules, made for one race. */
export type ResourceRulesFor = (race: RaceScale) => ResourceRules;
