import { describe, expect, it } from "vitest";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets, shouldOpenPitModal } from "./pitSystem";
import type { Car } from "../types/car";
import type { TrackCell, TrackTag } from "../types/track";

function makeCar(): Car {
  return {
    carId: 1,
    ownerId: "P1",
    isBot: false,
    cellId: "Z01_L0_00",
    tire: 50,
    fuel: 40,
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

function pitCell(tags?: TrackTag[]): TrackCell {
  return {
    id: "Z02_L3_00",
    zoneIndex: 2,
    laneIndex: 3,
    forwardIndex: 1,
    pos: { x: 0, y: 0 },
    next: [],
    ...(tags ? { tags } : {})
  };
}

describe("pitSystem", () => {
  it("opens pit modal on PIT_BOX when not serviced", () => {
    const car = makeCar();
    const cell = pitCell(["PIT_BOX"]);
    expect(shouldOpenPitModal(car, cell)).toBe(true);
  });

  it("does not open pit modal when already serviced or not in PIT_BOX", () => {
    const car = makeCar();
    car.pitServiced = true;
    expect(shouldOpenPitModal(car, pitCell(["PIT_BOX"]))).toBe(false);
    car.pitServiced = false;
    expect(shouldOpenPitModal(car, pitCell([]))).toBe(false);
    expect(shouldOpenPitModal(car, pitCell())).toBe(false);
  });

  it("applies pit stop and sets service state", () => {
    const car = makeCar();
    const cell = pitCell(["PIT_BOX"]);
    applyPitStop(car, cell.id, { ...car.setup, compound: "hard" });
    expect(car.cellId).toBe(cell.id);
    expect(car.tire).toBe(100);
    expect(car.fuel).toBe(100);
    expect(car.state).toBe("PITTING");
    expect(car.pitTurnsRemaining).toBe(1);
    expect(car.pitServiced).toBe(true);
    expect(car.setup.compound).toBe("hard");
  });

  it("keeps current setup when pit stop setup is null", () => {
    const car = makeCar();
    const originalSetup = structuredClone(car.setup);
    applyPitStop(car, "Z03_L3_00", null);
    expect(car.setup).toEqual(originalSetup);
  });

  it("returns false when no pit penalty remains", () => {
    const car = makeCar();
    car.pitTurnsRemaining = 0;
    const advanced = advancePitPenalty(car);
    expect(advanced).toBe(false);
    expect(car.state).toBe("ACTIVE");
  });

  it("advances pit penalty and sets exit boost", () => {
    const car = makeCar();
    car.pitTurnsRemaining = 1;
    car.state = "PITTING";
    const advanced = advancePitPenalty(car);
    expect(advanced).toBe(true);
    expect(car.pitTurnsRemaining).toBe(0);
    expect(car.state).toBe("ACTIVE");
    expect(car.pitExitBoost).toBe(true);
  });

  it("keeps pitting state when penalty remains", () => {
    const car = makeCar();
    car.pitTurnsRemaining = 2;
    car.state = "PITTING";
    car.pitExitBoost = false;
    const advanced = advancePitPenalty(car);
    expect(advanced).toBe(true);
    expect(car.pitTurnsRemaining).toBe(1);
    expect(car.state).toBe("PITTING");
    expect(car.pitExitBoost).toBe(false);
  });

  it("disallows pit box targets after service", () => {
    const car = makeCar();
    car.pitServiced = true;
    expect(shouldDisallowPitBoxTargets(car, false)).toBe(true);
    expect(shouldDisallowPitBoxTargets(car, true)).toBe(true);
  });

  it("allows pit box targets when not serviced", () => {
    const car = makeCar();
    car.pitServiced = false;
    expect(shouldDisallowPitBoxTargets(car, false)).toBe(false);
  });
});
