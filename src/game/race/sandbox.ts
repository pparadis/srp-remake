import { MOVE_CYCLE } from "../constants";
import { createMoveCycle, getRemainingBudget, type MoveCycle } from "../systems/moveBudgetSystem";
import type { BotLevel, Car } from "../types/car";
import { computeTargets, getActiveCar, type RaceContext, type RaceState } from "./raceEngine";

// Sandbox (`?sandbox`): edit a race state by hand, no rules. Everything here writes state the engine already reads.

export interface CarEdit {
  cellId?: string;
  lapCount?: number;
  tire?: number;
  fuel?: number;
  compound?: "soft" | "hard";
  /** Move points left in the cycle (0..MOVE_CYCLE.budget); a turn can spend at most min(9, this). */
  budgetLeft?: number;
  isBot?: boolean;
  botLevel?: BotLevel;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

// A cycle with `left` points unspent: the points already gone sit in the first move slot.
export function cycleWithBudgetLeft(left: number): MoveCycle {
  const spent = MOVE_CYCLE.budget - clamp(left, 0, MOVE_CYCLE.budget);
  if (spent === 0) return createMoveCycle();
  const cycle = createMoveCycle();
  cycle.spent[0] = spent;
  cycle.index = 1;
  return cycle;
}

/** Applies an edit to a car. Returns why it was refused, or null when applied (nothing changes on a refusal). */
export function editCar(ctx: RaceContext, state: RaceState, carId: number, edit: CarEdit): string | null {
  const car = state.cars.find((c) => c.carId === carId);
  if (!car) return `No car ${carId}.`;
  if (edit.cellId !== undefined) {
    if (!ctx.cellMap.has(edit.cellId)) return `No cell ${edit.cellId}.`;
    const other = state.cars.find((c) => c.carId !== carId && c.cellId === edit.cellId);
    if (other) return `${edit.cellId} is taken by car ${other.carId}.`;
    car.cellId = edit.cellId;
  }
  if (edit.lapCount !== undefined) car.lapCount = clamp(edit.lapCount, -1, state.raceLaps - 1);
  if (edit.tire !== undefined) car.tire = clamp(edit.tire, 0, 100);
  if (edit.fuel !== undefined) car.fuel = clamp(edit.fuel, 0, 100);
  if (edit.compound !== undefined) car.setup = { ...car.setup, compound: edit.compound };
  if (edit.budgetLeft !== undefined) car.moveCycle = cycleWithBudgetLeft(edit.budgetLeft);
  if (edit.isBot !== undefined && edit.isBot !== car.isBot) {
    car.isBot = edit.isBot;
    car.ownerId = `${edit.isBot ? "BOT" : "P"}${car.carId}`;
    if (edit.isBot) car.botLevel = edit.botLevel ?? "normal";
    else delete car.botLevel;
  } else if (edit.botLevel !== undefined && car.isBot) {
    car.botLevel = edit.botLevel;
  }
  return null;
}

/** Drops a car on a cell: a free cell moves it there, a cell held by another car swaps their places. */
export function placeCar(ctx: RaceContext, state: RaceState, carId: number, cellId: string): string | null {
  const car = state.cars.find((c) => c.carId === carId);
  const other = state.cars.find((c) => c.carId !== carId && c.cellId === cellId);
  if (!car) return `No car ${carId}.`;
  if (!other) return editCar(ctx, state, carId, { cellId });
  [car.cellId, other.cellId] = [other.cellId, car.cellId];
  return null;
}

/** Makes a car the one to play (its slot in the play order). */
export function setActiveCar(state: RaceState, carId: number): boolean {
  const index = state.turn.order.indexOf(carId);
  if (index < 0) return false;
  state.turn.index = index;
  return true;
}

// Fields of a "Copy debug" snapshot car that a restore writes back.
interface SnapshotCar {
  carId: number;
  cellId: string;
  isBot: boolean;
  botLevel?: BotLevel;
  lapCount: number;
  state: Car["state"];
  tire: number;
  fuel: number;
  pitTurnsRemaining: number;
  pitExitBoost: boolean;
  pitServiced: boolean;
  setup: Car["setup"];
  budgetLeft?: number;
}

/**
 * Puts the cars and the active car of a "Copy debug" snapshot back. All or nothing: returns why it was refused
 * (different car count, unknown or shared cell), or null when applied.
 */
export function restorePosition(ctx: RaceContext, state: RaceState, snapshot: unknown): string | null {
  const snap = snapshot as { cars?: SnapshotCar[]; activeCarId?: number } | null;
  if (!snap || !Array.isArray(snap.cars)) return "Not a debug snapshot (no cars).";
  if (snap.cars.length !== state.cars.length) {
    return `The snapshot has ${snap.cars.length} cars, this race has ${state.cars.length}.`;
  }
  const seen = new Set<string>();
  for (const sc of snap.cars) {
    if (!state.cars.some((c) => c.carId === sc.carId)) return `No car ${sc.carId} in this race.`;
    if (!ctx.cellMap.has(sc.cellId)) return `No cell ${sc.cellId}.`;
    if (seen.has(sc.cellId)) return `Two cars on ${sc.cellId}.`;
    seen.add(sc.cellId);
  }
  for (const sc of snap.cars) {
    const car = state.cars.find((c) => c.carId === sc.carId)!;
    Object.assign(car, {
      cellId: sc.cellId,
      lapCount: sc.lapCount,
      state: sc.state,
      tire: sc.tire,
      fuel: sc.fuel,
      pitTurnsRemaining: sc.pitTurnsRemaining,
      pitExitBoost: sc.pitExitBoost,
      pitServiced: sc.pitServiced,
      setup: sc.setup,
      moveCycle: cycleWithBudgetLeft(sc.budgetLeft ?? MOVE_CYCLE.budget)
    });
    editCar(ctx, state, car.carId, { isBot: sc.isBot, ...(sc.botLevel ? { botLevel: sc.botLevel } : {}) });
  }
  if (snap.activeCarId !== undefined) setActiveCar(state, snap.activeCarId);
  return null;
}

/** The move points a car has left in its cycle (the sandbox panel shows it). */
export const budgetLeftOf = (car: Car) => getRemainingBudget(car.moveCycle);

/**
 * A ready-to-paste vitest case for the current position: the whole state as data, and the targets the engine offers
 * for the active car today (cell -> move points). Edit the entry you believe is wrong: that is the failing test.
 */
export function positionAsTest(ctx: RaceContext, state: RaceState): string {
  const car = getActiveCar(state);
  const offered = [...computeTargets(ctx, state, car)].map(([id, t]) => `    ${JSON.stringify(id)}: ${t.moveSpend ?? t.distance},`);
  const literal = JSON.stringify(state, null, 2);
  return `import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/${ctx.track.trackId}.json";
import type { TrackData } from "../types/track";
import { computeTargets, createRaceContext, getActiveCar, type RaceState } from "./raceEngine";

// Position copied from the sandbox: car ${car.carId} on ${car.cellId} to play (seed ${state.seed}).
const ctx = createRaceContext(track as unknown as TrackData);
const state: RaceState = ${literal};

describe("sandbox position", () => {
  it("offers these targets to car ${car.carId}", () => {
    const targets = computeTargets(ctx, state, getActiveCar(state));
    const offered = Object.fromEntries([...targets].map(([id, t]) => [id, t.moveSpend ?? t.distance]));
    // Edit the entry you believe is wrong: that is the failing test.
    expect(offered).toEqual({
${offered.join("\n")}
    });
  });
});
`;
}
