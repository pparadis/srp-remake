import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import type { TargetInfo } from "./movementSystem";
import { pickBotMove } from "./botSystem";

function makeCar(overrides: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: "BOT1",
    isBot: true,
    cellId: "A0",
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
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] },
    ...overrides
  };
}

function makeTargets(entries: Array<[string, TargetInfo]>): Map<string, TargetInfo> {
  return new Map(entries);
}

describe("pickBotMove", () => {
  it("prefers max distance when resources are healthy", () => {
    const car = makeCar({ tire: 80, fuel: 80 });
    const targets = makeTargets([
      ["A", { distance: 1, tireCost: 5, fuelCost: 5, isPitTrigger: false }],
      ["B", { distance: 2, tireCost: 2, fuelCost: 2, isPitTrigger: false }]
    ]);
    const pick = pickBotMove(targets, car);
    expect(pick?.cellId).toBe("B");
  });

  it("prefers pit box when resources are low", () => {
    const car = makeCar({ tire: 20, fuel: 20 });
    const targets = makeTargets([
      ["A", { distance: 2, tireCost: 5, fuelCost: 5, isPitTrigger: false }],
      ["P", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }]
    ]);
    const pick = pickBotMove(targets, car);
    expect(pick?.cellId).toBe("P");
  });

  it("returns null when no targets", () => {
    const car = makeCar();
    const pick = pickBotMove(new Map(), car);
    expect(pick).toBeNull();
  });
});
