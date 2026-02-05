import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import { createMoveCycle } from "./moveBudgetSystem";
import { advanceTurn, createTurnState, getCurrentCarId } from "./turnSystem";

function makeCar(id: number): Car {
  return {
    carId: id,
    ownerId: `P${id}`,
    isBot: false,
    cellId: `C${id}`,
    lapCount: 0,
    tire: 100,
    fuel: 100,
    setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    },
    state: "ACTIVE",
    pitTurnsRemaining: 0,
    pitExitBoost: false,
    pitServiced: false,
    moveCycle: createMoveCycle()
  };
}

describe("turnSystem", () => {
  it("creates a turn order from car ids and clamps start index", () => {
    const cars = [makeCar(10), makeCar(11), makeCar(12)];
    const state = createTurnState(cars, 99);
    expect(state.order).toEqual([10, 11, 12]);
    expect(state.index).toBe(2);
  });

  it("returns null when there are no cars", () => {
    const state = createTurnState([], 0);
    expect(getCurrentCarId(state)).toBeNull();
  });

  it("advances and wraps turn index", () => {
    const cars = [makeCar(1), makeCar(2)];
    const state = createTurnState(cars, 0);
    expect(getCurrentCarId(state)).toBe(1);
    advanceTurn(state);
    expect(getCurrentCarId(state)).toBe(2);
    advanceTurn(state);
    expect(getCurrentCarId(state)).toBe(1);
  });
});
