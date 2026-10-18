export const REG_TOTAL_CARS = "totalCars";
export const REG_HUMAN_CARS = "humanCars";
export const REG_BOT_CARS = "botCars";
export const REG_RACE_LAPS = "raceLaps";
export const REG_BOT_LEVEL = "botLevel";
export const REG_SEED = "seed";
export const REG_RULES_VERSION = "rulesVersion";
export const REG_SANDBOX = "sandbox";
export const REG_POSITION = "position";
export const REG_ANIMATE = "animate";
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
  psi: { min: 15, max: 35 }
} as const;
// One move cycle: this many moves share this much distance budget (Medium wing, hard compound).
export const MOVE_CYCLE = { moves: 5, budget: 40 } as const;
// Downforce is a trade: Low is faster and wears the tires and the tank, High is slower and saves them.
// `pace` is added to the cycle budget; `tire` / `fuel` multiply the per-cell wear (Medium = 1).
export const WING_LEVELS = ["low", "medium", "high"] as const;
export type WingLevel = (typeof WING_LEVELS)[number];
export const WING_EFFECTS: Record<WingLevel, { pace: number; tire: number; fuel: number }> = {
  low: { pace: 1, tire: 1.6, fuel: 1.05 },
  medium: { pace: 0, tire: 1, fuel: 1 },
  high: { pace: -1, tire: 0.8, fuel: 0.9 }
};
// The soft compound grips better: it adds this to the cycle budget (and wears faster, see MOVE_RATES).
export const SOFT_PACE_BONUS = 1;

// Drafting (issue #55): a car in a main lane with another car 1 to DRAFT_RANGE cells directly ahead in its own lane
// runs in its slipstream. A move that starts there wears less; after DRAFT_SLINGSHOT_TURNS consecutive turns begun in
// the draft, a pull-out pass of the drafted car skips the +1 lane-change surcharge (the slingshot).
export const DRAFT_RANGE = 2;
export const DRAFT_FUEL_FACTOR = 0.8;
export const DRAFT_TIRE_FACTOR = 0.9;
export const DRAFT_SLINGSHOT_TURNS = 2;

// Extra move points per car passed when a boxed-in car squeezes past (see docs/movement-spec.md).
export const SQUEEZE_SURCHARGE_PER_CAR = 2;
