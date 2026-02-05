import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import { sortCarsByProgress } from "./orderingSystem";

function makeCell(id: string, forwardIndex: number): TrackCell {
  return {
    id,
    zoneIndex: 1,
    laneIndex: 0,
    forwardIndex,
    pos: { x: 0, y: 0 },
    next: []
  };
}

function makeCar(carId: number, cellId: string, lapCount = 0): Car {
  return {
    carId,
    ownerId: `P${carId}`,
    cellId,
    lapCount,
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

describe("sortCarsByProgress", () => {
  it("orders by forwardIndex when lapCount is equal", () => {
    const cellMap = new Map<string, TrackCell>([
      ["A", makeCell("A", 10)],
      ["B", makeCell("B", 12)]
    ]);
    const cars = [makeCar(1, "A"), makeCar(2, "B")];
    const ordered = sortCarsByProgress(cars, cellMap);
    expect(ordered[0]?.carId).toBe(2);
    expect(ordered[1]?.carId).toBe(1);
  });

  it("orders by lapCount before forwardIndex", () => {
    const cellMap = new Map<string, TrackCell>([
      ["A", makeCell("A", 2)],
      ["B", makeCell("B", 20)]
    ]);
    const cars = [makeCar(1, "A", 1), makeCar(2, "B", 0)];
    const ordered = sortCarsByProgress(cars, cellMap);
    expect(ordered[0]?.carId).toBe(1);
    expect(ordered[1]?.carId).toBe(2);
  });
});
