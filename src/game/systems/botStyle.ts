// Driver personalities: parameter sets for the Normal scorer and the stop plan (botSystem, botPlan).
// A race carries an integer seed; `personalityOf(seed, carId)` is a pure function of the two, so the
// same seed always gives the same grid of drivers. Seed 0 is the neutral baseline (everyone
// "balanced", exactly the pre-personality Normal bot). Humans and the autopilot never get one.
// Documented in docs/bot-system.md; this table is the single source of the numbers.

export type PersonalityKey = "balanced" | "adaptive" | "pusher" | "steady" | "racer" | "defender" | "strategist";

export interface Personality {
  key: PersonalityKey;
  // Shown next to the bot's name in the standings.
  label: string;
  // Multiplies the tire+fuel cost of a move (below 1: takes risks on tire).
  wearWeight: number;
  // Points per point the remaining moves' even share of the cycle budget shrinks (0 = front-loads).
  shareWeight: number;
  // How much of the inner lane's value (LANE_SPAN) the driver sees: the lane is shorter, so every
  // move is worth about 0.6 cells more per lane inward. 0 ignores the geometry (the old Normal).
  innerLane: number;
  // Points added to a lane change between main lanes (negative: avoids them).
  laneChange: number;
  // Points per car passed by the move.
  overtake: number;
  // Penalty for ending right behind a car in the same lane.
  queue: number;
  // Bonus for ending in the lane of a rival close behind (blocks it).
  block: number;
  // Cells added to the gain of a stop, and to the window of passes it may be taken in (+ = earlier).
  pitGain: number;
  pitWindow: number;
}

const BASE: Personality = {
  key: "balanced", label: "Balanced",
  wearWeight: 1, shareWeight: 2, innerLane: 0, laneChange: 0, overtake: 0, queue: 0, block: 0, pitGain: 0, pitWindow: 0
};

// The table. The pit strategist's sign comes from the seed (pitSide): early + / late -.
export const PERSONALITIES: Record<PersonalityKey, Personality> = {
  balanced: BASE,
  // Hard's own taste, not drawn from the seed: no quirks, front-loads the cycle, values the inner lane
  // (measured: Hard with a seeded quirky style lost its edge over Normal, this one is +0.1 / +0.4).
  adaptive: { ...BASE, key: "adaptive", label: "Adaptive", shareWeight: 0, innerLane: 0.6 },
  // front-loads the cycle (9-9-9-9-4), takes tire risks, will pass when it is cheap
  pusher: { ...BASE, key: "pusher", label: "Pusher", wearWeight: 0.5, shareWeight: 0, innerLane: 0.6, overtake: 8, queue: 4 },
  // even spend (8-8-8-8-8: the share weight outweighs a cell of progress), inner lane, few lane changes
  steady: { ...BASE, key: "steady", label: "Steady", shareWeight: 48, innerLane: 1, laneChange: -3 },
  // hunts positions: passes with lane changes, hates queuing, accepts the +1 lane change cost
  racer: { ...BASE, key: "racer", label: "Racer", innerLane: 0.7, overtake: 30, queue: 10, block: 10, laneChange: 2 },
  // holds the inner lane and sits in the lane of a rival close behind
  defender: { ...BASE, key: "defender", label: "Defender", innerLane: 1.2, laneChange: -8, block: 14 },
  // plain Normal, but stops earlier or later than the rest
  strategist: { ...BASE, key: "strategist", label: "Strategist", innerLane: 0.8 }
};

// What Hard adds to its personality: it reads the field instead of only its own plan.
export const HARD_ADAPT = { overtake: 14, queue: 8, block: 0, innerLane: 0.3 } as const;
// Points between the inner and the outer lane at innerLane = 1 (about 1.1 cells a move over a few moves).
export const LANE_SPAN = 60;
// A rival counts for blocking when it is this many cells behind, for queuing when this close ahead.
export const BLOCK_RANGE = 6;
export const QUEUE_RANGE = 2;

// Easy: seeded noise on every score (points, 10 = one cell), and the chance it ignores its style.
export const EASY_NOISE = 25;
export const EASY_IGNORE_STYLE = 0.3;

export const SEEDED_STYLES: PersonalityKey[] = ["pusher", "steady", "racer", "defender", "strategist"];

// FNV-style integer mix (no Math.random anywhere in the engine).
export function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// A shuffled deck of the five styles per block of five cars: within a block everyone differs,
// beyond it styles repeat, and each car's style is uniform over seeds.
export function personalityOf(seed: number, carId: number): Personality {
  if (!seed) return PERSONALITIES.balanced;
  const block = Math.floor((carId - 1) / SEEDED_STYLES.length);
  const deck = [...SEEDED_STYLES];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = mix(seed, block, i) % (i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return personalityFor(deck[(carId - 1) % SEEDED_STYLES.length]!, seed, carId);
}

// A given style for a car; the pit strategist's early/late side still comes from the seed.
export function personalityFor(key: PersonalityKey, seed: number, carId: number): Personality {
  if (key !== "strategist") return PERSONALITIES[key];
  const early = mix(seed, carId, 99) % 2 === 0;
  return {
    ...PERSONALITIES.strategist,
    // cells of gain and of pass window: early +12 / +14, late -12 / -5
    pitGain: early ? 12 : -12,
    pitWindow: early ? 14 : -5
  };
}

// Uniform [0, 1) from integers: the seeded dice of Easy.
export function unit(...parts: number[]): number {
  return mix(...parts) / 4294967296;
}

export const MAX_SEED = 0x7fffffff;

// Fresh seed for a new race, only at the boundary (server start of a race, solo scene).
export function normalizeSeed(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : 0;
}

// Play order of the cars (carIds): the pole sitter first. Without it car 1 would move first every
// round wherever the seed put it on the grid and win every tie (equal pace finishes on the same turn).
export function turnOrderOf(seed: number, n: number): number[] {
  const slots = gridSlots(seed, n);
  const order: number[] = [];
  slots.forEach((slot, i) => (order[slot] = i + 1));
  return order;
}

// The race seed also shuffles the grid: `gridSlots(seed, n)[i]` is the starting slot (0 = pole) of
// car i + 1. Seed 0 keeps car order = grid order. A seeded Fisher-Yates, pure.
export function gridSlots(seed: number, n: number): number[] {
  const slots = Array.from({ length: n }, (_, i) => i);
  if (!seed) return slots;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = mix(seed, 0x6721d, i) % (i + 1);
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  return slots;
}
