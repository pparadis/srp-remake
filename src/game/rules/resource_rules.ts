// What a rules version decides about tire, fuel and the size of a move (#148). The engine, the bots, the strategy
// readouts and the HUD ask `rulesOf(state).resources`; none of them reads a wear constant directly.
import type { Car, CarSetup } from '../types/car';

type Wearing = Pick<Car, 'tire' | 'fuel' | 'setup'>;

/** What the target search needs to price a move's wear. */
export interface WearRates {
  tireRate: number;
  fuelRate: number;
  setup: CarSetup;
}

export interface ResourceRules {
  /** The setup a grid `setup` action or a pit stop may ask for. */
  isValidSetup(setup: CarSetup): boolean;
  /** The most move points one move may spend: the car's cap, lower when a tire or the tank is empty. */
  moveCap(car: Wearing): number;
  /** The move points a move cycle holds for this setup. */
  cycleBudget(setup: CarSetup): number;
  /** Per-cell wear before the setup, lane and tow factors. */
  wearRates(setup: CarSetup): WearRates;
  /** The grid `setup` action: what the car is set up with before its first turn. */
  gridSetup(car: Car, setup: CarSetup): void;
  /** What a pit stop does to the car: fits `setup` (when given) and refills. */
  pitService(car: Car, setup: CarSetup | null): void;
  /** What the setup UI offers. */
  features: { medium: boolean; fuelLoad: boolean };
}
