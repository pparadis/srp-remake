import { describe, expect, it } from "vitest";
import { applyMove } from "./moveCommitSystem";
import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";

function makeCar(): Car {
  return {
    carId: 1,
    ownerId: "P1",
    isBot: false,
    cellId: "A",
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
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] }
  };
}

function makeCell(id: string, forwardIndex: number, tags: TrackCell["tags"] = []): TrackCell {
  return {
    id,
    zoneIndex: 1,
    laneIndex: 1,
    forwardIndex,
    pos: { x: 0, y: 0 },
    next: [],
    tags
  };
}

describe("applyMove lap counting", () => {
  it("increments lap when forwardIndex wraps", () => {
    const car = makeCar();
    const fromCell = makeCell("Z12", 12);
    const toCell = makeCell("Z02", 1);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(1);
  });

  it("does not increment lap without crossing", () => {
    const car = makeCar();
    const fromCell = makeCell("Z10", 10);
    const toCell = makeCell("Z11", 11);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(0);
  });

  it("increments lap when crossing start/finish", () => {
    const car = makeCar();
    const fromCell = makeCell("Z12", 12);
    const toCell = makeCell("Z01", 0, ["START_FINISH"]);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(1);
  });
});
