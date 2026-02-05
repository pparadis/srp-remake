import { describe, expect, it } from "vitest";
import { validateMoveAttempt } from "./moveValidationSystem";
import type { Car } from "../types/car";
import type { TrackCell, TrackTag } from "../types/track";

function makeCar(): Car {
  return {
    carId: 1,
    ownerId: "P1",
    isBot: false,
    cellId: "Z01_L0_00",
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
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] }
  };
}

function makeCell(id: string, laneIndex: number, tags: TrackTag[] = []): TrackCell {
  return {
    id,
    zoneIndex: 1,
    laneIndex,
    forwardIndex: 0,
    pos: { x: 0, y: 0 },
    next: [],
    tags
  };
}

describe("validateMoveAttempt", () => {
  it("returns not-your-turn when canMove is false", () => {
    const car = makeCar();
    const cell = makeCell("Z02_L0_00", 0);
    const targets = new Map([[cell.id, { distance: 3, tireCost: 1, fuelCost: 1, isPitTrigger: false }]]);
    const res = validateMoveAttempt(car, cell, targets, false);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not-your-turn");
  });

  it("returns inactive-car when car is not ACTIVE", () => {
    const car = makeCar();
    car.state = "PITTING";
    const cell = makeCell("Z02_L0_00", 0);
    const targets = new Map([[cell.id, { distance: 3, tireCost: 1, fuelCost: 1, isPitTrigger: false }]]);
    const res = validateMoveAttempt(car, cell, targets, true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("inactive-car");
  });

  it("returns no-cell when target is null", () => {
    const car = makeCar();
    const res = validateMoveAttempt(car, null, new Map(), true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-cell");
  });

  it("returns invalid-target when cell is not in valid targets", () => {
    const car = makeCar();
    const cell = makeCell("Z02_L0_00", 0);
    const res = validateMoveAttempt(car, cell, new Map(), true);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid-target");
  });

  it("returns ok with moveSpend and pit flag", () => {
    const car = makeCar();
    const cell = makeCell("Z02_L3_00", 3, ["PIT_BOX"]);
    const targets = new Map([[cell.id, { distance: 2, tireCost: 1, fuelCost: 1, isPitTrigger: true }]]);
    const res = validateMoveAttempt(car, cell, targets, true);
    expect(res.ok).toBe(true);
    expect(res.moveSpend).toBe(1);
    expect(res.isPitStop).toBe(true);
  });
});
