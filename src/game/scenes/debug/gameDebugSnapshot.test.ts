import { describe, expect, it } from "vitest";
import type { Car } from "../../types/car";
import type { TrackCell, TrackData } from "../../types/track";
import type { TargetInfo } from "../../systems/movementSystem";
import { buildGameDebugSnapshot } from "./gameDebugSnapshot";

function makeCell(id: string, laneIndex: number, forwardIndex: number, tags: TrackCell["tags"] = []): TrackCell {
  return {
    id,
    zoneIndex: forwardIndex + 1,
    laneIndex,
    forwardIndex,
    pos: { x: forwardIndex, y: laneIndex },
    next: [],
    tags
  };
}

function makeCar(carId: number, cellId: string, overrides: Partial<Car> = {}): Car {
  return {
    carId,
    ownerId: `P${carId}`,
    isBot: false,
    cellId,
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

describe("buildGameDebugSnapshot", () => {
  it("builds core snapshot fields and sorts cars by carId", () => {
    const track: TrackData = {
      trackId: "debug-track",
      zones: 2,
      lanes: 4,
      cells: [
        makeCell("S0", 1, 0, ["START_FINISH"]),
        makeCell("S1", 1, 1),
        makeCell("P0", 0, 0, ["PIT_ENTRY"])
      ]
    };
    const cellMap = new Map(track.cells.map((cell) => [cell.id, cell]));
    const cars = [makeCar(2, "S1"), makeCar(1, "S0")];
    const activeCar = cars[1]!;
    const validTargets = new Map<string, TargetInfo>([
      ["S1", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: false }]
    ]);

    const snapshot = buildGameDebugSnapshot({
      buildInfo: { version: "v1", gitSha: "abc" },
      track,
      cellMap,
      cars,
      activeCar,
      validTargets,
      botDecisionCount: 3,
      moveBudget: { baseMax: 9, zeroResourceMax: 4 },
      moveRates: { softTire: 0.5, hardTire: 0.35, fuel: 0.45 },
      disallowPitBoxTargets: false
    });

    expect(snapshot.version).toBe("v1");
    expect(snapshot.gitSha).toBe("abc");
    expect(snapshot.trackId).toBe("debug-track");
    expect(snapshot.startFinishIds).toEqual(["S0"]);
    expect(snapshot.cars[0]?.carId).toBe(1);
    expect(snapshot.cars[1]?.carId).toBe(2);
    expect(snapshot.movement.maxSteps).toBe(9);
    expect(snapshot.movement.validTargets[0]?.moveSpend).toBeNull();
  });

  it("forces maxSteps to 1 when active car is in pit lane", () => {
    const track: TrackData = {
      trackId: "pit-track",
      zones: 2,
      lanes: 4,
      cells: [makeCell("P0", 0, 0, ["PIT_BOX"]), makeCell("S0", 1, 0, ["START_FINISH"])]
    };
    const cellMap = new Map(track.cells.map((cell) => [cell.id, cell]));
    const activeCar = makeCar(1, "P0", {
      tire: 0,
      fuel: 0,
      moveCycle: { index: 0, spent: [8, 8, 8, 8, 8] }
    });
    const snapshot = buildGameDebugSnapshot({
      buildInfo: { version: "v2", gitSha: "def" },
      track,
      cellMap,
      cars: [activeCar],
      activeCar,
      validTargets: new Map(),
      botDecisionCount: 0,
      moveBudget: { baseMax: 9, zeroResourceMax: 4 },
      moveRates: { softTire: 0.5, hardTire: 0.35, fuel: 0.45 },
      disallowPitBoxTargets: true
    });

    expect(snapshot.movement.maxSteps).toBe(1);
    expect(snapshot.movement.disallowPitBoxTargets).toBe(true);
  });
});
