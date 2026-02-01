import type { Car } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";
import { createMoveCycle } from "./moveBudgetSystem";

interface SpawnOptions {
  playerCount: number;
}

const DEFAULT_COLORS = [0xe94cff, 0x35d0c7, 0xffc857, 0xff6b6b];
const DEFAULT_SETUPS: Car["setup"][] = [
  { compound: "soft", psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 },
  { compound: "hard", psi: { fl: 24, fr: 24, rl: 22, rr: 22 }, wingFrontDeg: 5, wingRearDeg: 11 },
  { compound: "soft", psi: { fl: 25, fr: 25, rl: 23, rr: 23 }, wingFrontDeg: 7, wingRearDeg: 13 },
  { compound: "hard", psi: { fl: 22, fr: 22, rl: 20, rr: 20 }, wingFrontDeg: 4, wingRearDeg: 10 }
];

export function buildSpawnSlots(track: TrackData): TrackCell[] {
  const mainLanes = [0, 1, 2];
  const slots: TrackCell[] = [];
  for (let z = 1; z <= track.zones; z += 1) {
    for (const lane of mainLanes) {
      const cell = track.cells.find((c) => c.zoneIndex === z && c.laneIndex === lane);
      if (cell) slots.push(cell);
    }
  }
  return slots;
}

export function spawnCars(track: TrackData, options: SpawnOptions) {
  const slots = buildSpawnSlots(track);
  const count = Math.max(1, Math.min(options.playerCount, slots.length));

  const cars: Car[] = [];
  const tokens: Array<{ car: Car; color: number }> = [];

  for (let i = 0; i < count; i += 1) {
    const cell = slots[i];
    const setup = DEFAULT_SETUPS[i % DEFAULT_SETUPS.length];
    const car: Car = {
      carId: i + 1,
      ownerId: `P${i + 1}`,
      cellId: cell.id,
      tire: 100,
      fuel: 100,
      setup: structuredClone(setup),
      state: "ACTIVE",
      pitTurnsRemaining: 0,
      pitExitBoost: false,
      pitServiced: false,
      moveCycle: createMoveCycle()
    };
    cars.push(car);
    tokens.push({ car, color: DEFAULT_COLORS[i % DEFAULT_COLORS.length] });
  }

  return { cars, tokens };
}
