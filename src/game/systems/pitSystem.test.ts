import { describe, expect, it } from "vitest";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets, shouldOpenPitModal } from "./pitSystem";
import type { Car } from "../types/car";
import type { TrackCell, TrackTag } from "../types/track";

function makeCar(): Car {
  return {
    carId: 1,
    ownerId: "P1",
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

function pitCell(tags: TrackTag[]): TrackCell {
  return {
    id: "Z02_L3_00",
    zoneIndex: 2,
    laneIndex: 3,
    forwardIndex: 1,
    pos: { x: 0, y: 0 },
    next: [],
    tags
  };
}

describe("pitSystem", () => {
  it("opens pit modal on PIT_BOX when not serviced", () => {
    const car = makeCar();
    const cell = pitCell(["PIT_BOX"]);
    expect(shouldOpenPitModal(car, cell)).toBe(true);
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

  it("disallows pit box targets only outside pit lane after service", () => {
    const car = makeCar();
    car.pitServiced = true;
    expect(shouldDisallowPitBoxTargets(car, false)).toBe(true);
    expect(shouldDisallowPitBoxTargets(car, true)).toBe(false);
  });
});
