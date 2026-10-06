import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { createRaceContext } from "../race/raceEngine";
import type { Car } from "../types/car";
import type { TrackData } from "../types/track";
import {
  buildPlanContext,
  cellsToFeeder,
  forwardGain,
  IDEAL_PIT_SETUP,
  isFinalLap,
  resourceWeights,
  stopIsDue,
  wearPerCell
} from "./botPlan";

const ctx = createRaceContext(track as unknown as TrackData);
const cell = (id: string) => ctx.cellMap.get(id)!;
const plan = (laps: number) => buildPlanContext(ctx.trackIndex, laps);

function car(overrides: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: "BOT1",
    isBot: true,
    cellId: "Z01_L1_00",
    lapCount: 0,
    tire: 100,
    fuel: 100,
    setup: { compound: "soft", psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 },
    state: "ACTIVE",
    pitTurnsRemaining: 0,
    pitExitBoost: false,
    pitServiced: false,
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] },
    ...overrides
  };
}

describe("plan context", () => {
  it("finds the one lane-1 cell a stop can start from", () => {
    expect(plan(5)).toEqual({ raceLaps: 5, spineLen: 28, feederFwd: 26 });
    expect(cellsToFeeder(cell("Z19_L1_00"), plan(5))).toBe(8);
    expect(cellsToFeeder(cell("Z27_L1_00"), plan(5))).toBe(0);
    expect(cellsToFeeder(cell("Z28_L1_00"), plan(5))).toBe(27);
  });

  it("knows the final lap", () => {
    expect(isFinalLap(car({ lapCount: 3 }), plan(5))).toBe(false);
    expect(isFinalLap(car({ lapCount: 4 }), plan(5))).toBe(true);
  });
});

describe("wear and ideal setup", () => {
  it("the ideal setup wears less than any default setup", () => {
    const ideal = wearPerCell(IDEAL_PIT_SETUP);
    const soft = wearPerCell(car().setup);
    expect(ideal.tire).toBeLessThan(soft.tire);
    expect(ideal.fuel).toBeLessThan(soft.fuel);
    expect(ideal.fuel).toBeCloseTo(0.45, 5);
  });
});

describe("forwardGain", () => {
  it("counts forwardIndex, not cells, on main lanes", () => {
    // Z10_L3 is 9 cells past Z01_L3 but only 8 forwardIndex ahead.
    expect(forwardGain(cell("Z01_L3_00"), cell("Z10_L3_00"), 9, plan(5))).toBe(8);
    expect(forwardGain(cell("Z01_L1_00"), cell("Z10_L1_00"), 9, plan(5))).toBe(9);
  });
  it("wraps around the line and falls back to distance in the pit lane or without a plan", () => {
    expect(forwardGain(cell("Z27_L1_00"), cell("Z03_L1_00"), 4, plan(5))).toBe(4);
    expect(forwardGain(cell("Z27_L1_00"), cell("Z28_L0_00"), 1, plan(5))).toBe(1);
    expect(forwardGain(cell("Z01_L3_00"), cell("Z10_L3_00"), 9, undefined)).toBe(9);
  });
});

describe("stop planning", () => {
  it("is not due in a race the tires and tank can finish", () => {
    expect(stopIsDue(car({ cellId: "Z27_L1_00", lapCount: 1 }), cell("Z27_L1_00"), plan(5))).toBe(false);
  });
  it("is not due when the stop would cost more than the crawl it saves", () => {
    // 6 laps on soft tires: a short crawl at the end beats a lap lost in the pit lane.
    const worn = car({ cellId: "Z27_L1_00", lapCount: 4, tire: 5, fuel: 30 });
    expect(stopIsDue(worn, cell("Z27_L1_00"), plan(6))).toBe(false);
  });
  it("is due on the last pass that still beats crawling, never on the final lap or once serviced", () => {
    const worn = car({ cellId: "Z27_L1_00", lapCount: 4, tire: 5, fuel: 20 });
    expect(stopIsDue(worn, cell("Z27_L1_00"), plan(12))).toBe(true);
    expect(stopIsDue({ ...worn, lapCount: 11 }, cell("Z27_L1_00"), plan(12))).toBe(false);
    expect(stopIsDue({ ...worn, pitServiced: true }, cell("Z27_L1_00"), plan(12))).toBe(false);
    // plenty left for another lap: wait for a later pass
    expect(stopIsDue({ ...worn, tire: 60, fuel: 60 }, cell("Z27_L1_00"), plan(12))).toBe(false);
  });
});

describe("resource weights", () => {
  it("are 1 when the resource lasts to the flag and worth the crawl it saves when it does not", () => {
    const fresh = resourceWeights(car(), cell("Z01_L1_00"), plan(3));
    expect(fresh).toEqual({ tire: 1, fuel: 1 });
    const longRace = resourceWeights(car(), cell("Z01_L1_00"), plan(12));
    expect(longRace.tire).toBeGreaterThan(5);
    expect(longRace.fuel).toBeGreaterThan(5);
  });
});
