export const REG_TOTAL_CARS = "totalCars";
export const REG_HUMAN_CARS = "humanCars";
export const REG_BOT_CARS = "botCars";
export const REG_RACE_LAPS = "raceLaps";
export const REG_BOT_LEVEL = "botLevel";
export const PIT_LANE = 0;
export const MAIN_LANES = [1, 2, 3] as const;
export const INNER_MAIN_LANE = MAIN_LANES[0];
export const MIDDLE_MAIN_LANE = MAIN_LANES[1];
export const OUTER_MAIN_LANE = MAIN_LANES[2];

// Tire/fuel wear per move, and how far a car may travel in one turn.
export const MOVE_RATES = {
  softTire: 0.5,
  hardTire: 0.35,
  fuel: 0.45
} as const;
export const MOVE_BUDGET = {
  baseMax: 9,
  zeroResourceMax: 4
} as const;
// Pit-stop setup limits (what the pit modal allows).
export const SETUP_LIMITS = {
  psi: { min: 15, max: 35 },
  wingDeg: { min: 0, max: 20 }
} as const;
// One move cycle: this many moves share this much distance budget.
export const MOVE_CYCLE = { moves: 5, budget: 40 } as const;
