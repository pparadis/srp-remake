import { describe, expect, it } from "vitest";
import { applyMove } from "./moveCommitSystem";
import type { Car } from "../types/car";
import type { TrackCell } from "../types/track";
import { PIT_LANE } from "../constants";

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

function makeCell(
  id: string,
  forwardIndex: number,
  tags: TrackCell["tags"] = [],
  laneIndex = 1
): TrackCell {
  return {
    id,
    zoneIndex: 1,
    laneIndex,
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

  it("initializes lap count when crossing with undefined lapCount", () => {
    const car = makeCar();
    delete car.lapCount;
    const fromCell = makeCell("Z12", 12);
    const toCell = makeCell("Z01", 0, ["START_FINISH"]);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(1);
  });

  it("does not increment lap when moving from pit lane", () => {
    const car = makeCar();
    const fromCell = makeCell("PIT_A", 12, [], PIT_LANE);
    const toCell = makeCell("MAIN_A", 1, [], 1);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(0);
  });

  it("does not increment lap when moving into pit lane", () => {
    const car = makeCar();
    const fromCell = makeCell("MAIN_A", 12, [], 1);
    const toCell = makeCell("PIT_A", 1, [], PIT_LANE);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.lapCount).toBe(0);
  });

  it("resets pitServiced only after returning to non-pit lane", () => {
    const car = makeCar();
    car.pitServiced = true;
    const pitFrom = makeCell("PIT_A", 1, [], PIT_LANE);
    const pitTo = makeCell("PIT_B", 2, [], PIT_LANE);
    applyMove(car, pitFrom, pitTo, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.pitServiced).toBe(true);

    const mainTo = makeCell("MAIN_A", 3, [], 1);
    applyMove(car, pitTo, mainTo, { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 1);
    expect(car.pitServiced).toBe(false);
  });

  it("clamps tire and fuel to zero for high costs", () => {
    const car = makeCar();
    car.tire = 2;
    car.fuel = 1;
    const fromCell = makeCell("A", 5);
    const toCell = makeCell("B", 6);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: 10, fuelCost: 10, isPitTrigger: false }, 1);
    expect(car.tire).toBe(0);
    expect(car.fuel).toBe(0);
  });

  it("clamps tire and fuel to 100 for negative costs", () => {
    const car = makeCar();
    car.tire = 99;
    car.fuel = 98;
    const fromCell = makeCell("A", 5);
    const toCell = makeCell("B", 6);
    applyMove(car, fromCell, toCell, { distance: 1, tireCost: -10, fuelCost: -10, isPitTrigger: false }, 1);
    expect(car.tire).toBe(100);
    expect(car.fuel).toBe(100);
  });

  it("records move spend in cycle and clears pit exit boost", () => {
    const car = makeCar();
    car.pitExitBoost = true;
    const fromCell = makeCell("A", 5);
    const toCell = makeCell("B", 6);
    applyMove(car, fromCell, toCell, { distance: 2, tireCost: 0, fuelCost: 0, isPitTrigger: false }, 3);
    expect(car.moveCycle.spent[0]).toBe(3);
    expect(car.moveCycle.index).toBe(1);
    expect(car.pitExitBoost).toBe(false);
  });
});
