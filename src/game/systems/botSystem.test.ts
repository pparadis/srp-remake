import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import type { TargetInfo } from "./movementSystem";
import {
  decideBotAction,
  decideBotActionWithTrace,
  evaluateAutopilotTargets,
  evaluateBotTargets,
  pickBotMove
} from "./botSystem";
import type { TrackCell } from "../types/track";

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

function makeCell(id: string, laneIndex = 1, tags: TrackCell["tags"] = []): TrackCell {
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

describe("evaluateBotTargets", () => {
  it("produces deterministic candidates and selected target", () => {
    const car = makeCar({ tire: 80, fuel: 80 });
    const targets = makeTargets([
      ["B", { distance: 2, tireCost: 2, fuelCost: 2, isPitTrigger: false }],
      ["A", { distance: 2, tireCost: 2, fuelCost: 2, isPitTrigger: false }]
    ]);
    const trace = evaluateBotTargets(targets, car);
    expect(trace.candidates).toHaveLength(2);
    expect(trace.candidates[0]?.cellId).toBe("A");
    expect(trace.candidates[1]?.cellId).toBe("B");
    expect(trace.selectedCellId).toBe("A");
  });
});

describe("decideBotAction", () => {
  it("returns skip when no targets", () => {
    const car = makeCar();
    const action = decideBotAction(new Map(), car, new Map());
    expect(action.type).toBe("skip");
  });

  it("returns pit when target is pit box and service is needed", () => {
    const car = makeCar({ pitServiced: false });
    const fromCell = makeCell(car.cellId, 1);
    const cell = makeCell("P", 3, ["PIT_BOX"]);
    const targets = makeTargets([["P", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }]]);
    const action = decideBotAction(targets, car, new Map([[fromCell.id, fromCell], [cell.id, cell]]));
    expect(action.type).toBe("pit");
  });

  it("returns move with computed spend", () => {
    const car = makeCar();
    const fromCell = makeCell(car.cellId, 1);
    const cell = makeCell("B", 1);
    const targets = makeTargets([["B", { distance: 2, tireCost: 1, fuelCost: 1, isPitTrigger: false }]]);
    const action = decideBotAction(targets, car, new Map([[fromCell.id, fromCell], [cell.id, cell]]));
    expect(action.type).toBe("move");
    if (action.type === "move") {
      expect(action.moveSpend).toBe(2);
    }
  });

  it("adds +1 move spend for lane changes", () => {
    const car = makeCar();
    const fromCell = makeCell(car.cellId, 1);
    const cell = makeCell("B", 2);
    const targets = makeTargets([["B", { distance: 2, tireCost: 1, fuelCost: 1, isPitTrigger: false }]]);
    const action = decideBotAction(targets, car, new Map([[fromCell.id, fromCell], [cell.id, cell]]));
    expect(action.type).toBe("move");
    if (action.type === "move") {
      expect(action.moveSpend).toBe(3);
    }
  });

  it("returns structured decision trace", () => {
    const car = makeCar({ tire: 20, fuel: 20 });
    const fromCell = makeCell(car.cellId, 1);
    const pitCell = makeCell("P", 0, ["PIT_BOX"]);
    const targets = makeTargets([
      ["P", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }],
      ["A", { distance: 2, tireCost: 5, fuelCost: 5, isPitTrigger: false }]
    ]);
    const result = decideBotActionWithTrace(targets, car, new Map([[fromCell.id, fromCell], [pitCell.id, pitCell]]));
    expect(result.action.type).toBe("pit");
    expect(result.trace.selectedCellId).toBe("P");
    expect(result.trace.candidates.some((candidate) => candidate.cellId === "P")).toBe(true);
  });
});

describe("autopilot policy", () => {
  const t = (distance: number, isPitTrigger = false): TargetInfo => ({
    distance,
    tireCost: 1,
    fuelCost: 1,
    isPitTrigger
  });
  const cells = (...list: TrackCell[]) => new Map(list.map((c) => [c.id, c]));

  it("picks the non-pit target closest to the median distance", () => {
    const car = makeCar();
    const targets = makeTargets([
      ["A", t(1)],
      ["B", t(4)],
      ["C", t(5)],
      ["D", t(9)],
      ["PIT", t(5, true)]
    ]);
    const cellMap = cells(makeCell("A0"), makeCell("A"), makeCell("B"), makeCell("C"), makeCell("D"), makeCell("PIT", 1, ["PIT_BOX"]));
    // distances 1,4,5,9: lower median is 4
    expect(evaluateAutopilotTargets(targets, car, cellMap).selectedCellId).toBe("B");
    expect(decideBotAction(targets, car, cellMap, "autopilot")).toMatchObject({ type: "move", target: { id: "B" } });
  });

  it("prefers the current lane on a tie and is deterministic", () => {
    const car = makeCar();
    const targets = makeTargets([
      ["A", t(3)],
      ["B", t(3)]
    ]);
    const cellMap = cells(makeCell("A0", 1), makeCell("A", 2), makeCell("B", 1));
    const first = evaluateAutopilotTargets(targets, car, cellMap);
    expect(first.selectedCellId).toBe("B");
    expect(evaluateAutopilotTargets(targets, car, cellMap)).toEqual(first);
  });

  it("never pits when a normal target exists, even when worn out", () => {
    const car = makeCar({ tire: 5, fuel: 5 });
    const targets = makeTargets([
      ["A", t(2)],
      ["PIT", t(6, true)]
    ]);
    const cellMap = cells(makeCell("A0"), makeCell("A"), makeCell("PIT", 1, ["PIT_BOX"]));
    expect(decideBotAction(targets, car, cellMap, "autopilot").type).toBe("move");
  });

  it("skips only when there are no targets", () => {
    expect(decideBotAction(new Map(), makeCar(), new Map(), "autopilot")).toEqual({ type: "skip" });
  });
});
