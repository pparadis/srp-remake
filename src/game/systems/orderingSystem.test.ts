import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import type { TrackCell, TrackData, TrackTag } from "../types/track";
import { buildProgressMap, computeCarSortKey, getCellForwardIndex, sortCarsByProgress } from "./orderingSystem";

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
    isBot: false,
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

describe("orderingSystem helpers", () => {
  it("returns -1 when a cell id is missing", () => {
    const cellMap = new Map<string, TrackCell>();
    expect(getCellForwardIndex("missing", cellMap)).toBe(-1);
  });

  it("uses progressMap when provided and defaults lapCount to 0", () => {
    const cellMap = new Map<string, TrackCell>([["A", makeCell("A", 9)]]);
    const progressMap = new Map<string, number>([["A", 2.5]]);
    const car = makeCar(7, "A");
    delete car.lapCount;
    const key = computeCarSortKey(car, cellMap, progressMap);
    expect(key.progressIndex).toBe(2.5);
    expect(key.lapCount).toBe(0);
  });
});

describe("buildProgressMap", () => {
  it("builds progress scaled to the spine lane length", () => {
    const track: TrackData = {
      trackId: "progress",
      zones: 3,
      lanes: 4,
      cells: [
        makeCell("S0", 0),
        makeCell("S1", 1),
        makeCell("S2", 2),
        {
          ...makeCell("L0a", 0),
          laneIndex: 0,
          tags: ["PIT_ENTRY"] as TrackTag[],
          next: ["L0b"]
        },
        {
          ...makeCell("L0b", 1),
          laneIndex: 0,
          next: ["L0a"]
        },
        {
          ...makeCell("L2b", 1),
          laneIndex: 2,
          next: ["L2a"]
        },
        {
          ...makeCell("L2a", 0),
          laneIndex: 2,
          next: ["L2b"]
        }
      ]
    };

    const cell0 = track.cells[0]!;
    const cell1 = track.cells[1]!;
    const cell2 = track.cells[2]!;
    track.cells[0] = { ...cell0, laneIndex: 1, tags: ["START_FINISH"] as TrackTag[], next: ["S1"] };
    track.cells[1] = { ...cell1, laneIndex: 1, next: ["S2"] };
    track.cells[2] = { ...cell2, laneIndex: 1, next: ["S0"] };

    const progress = buildProgressMap(track);
    expect(progress.get("S0")).toBe(0);
    expect(progress.get("S1")).toBe(1);
    expect(progress.get("S2")).toBe(2);
    expect(progress.get("L0a")).toBe(0);
    expect(progress.get("L0b")).toBe(2);
    expect(progress.get("L2a")).toBe(0);
    expect(progress.get("L2b")).toBe(2);
  });

  it("falls back to forwardIndex range when the spine lane is missing", () => {
    const track: TrackData = {
      trackId: "no-spine",
      zones: 3,
      lanes: 3,
      cells: [
        { ...makeCell("A0", 0), laneIndex: 0, next: ["A1"] },
        { ...makeCell("A1", 1), laneIndex: 0, next: ["A2"] },
        { ...makeCell("A2", 2), laneIndex: 0, next: ["A0"] }
      ]
    };

    const progress = buildProgressMap(track);
    expect(progress.get("A0")).toBe(0);
    expect(progress.get("A1")).toBe(1);
    expect(progress.get("A2")).toBe(2);
  });
});
