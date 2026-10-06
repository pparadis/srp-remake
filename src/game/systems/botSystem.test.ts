import { describe, expect, it } from "vitest";
import type { Car } from "../types/car";
import type { TargetInfo } from "./movementSystem";
import {
  decideBotAction,
  decideBotActionWithTrace,
  evaluateAutopilotTargets,
  evaluateBotTargets,
  evaluateEasyTargets,
  evaluateNormalTargets,
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

describe("easy policy", () => {
  const t = (distance: number): TargetInfo => ({ distance, tireCost: 1, fuelCost: 1, isPitTrigger: false });
  const targets = makeTargets(
    [9, 8, 7, 6, 5, 4, 3, 2, 1].map((d): [string, TargetInfo] => [`T${d}`, t(d)])
  );

  it("is deterministic for the same car state", () => {
    const car = makeCar();
    expect(evaluateEasyTargets(targets, car)).toEqual(evaluateEasyTargets(targets, makeCar()));
  });

  it("only ever picks one of the three best-scoring targets, and not always the best", () => {
    const picked = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      // The noise is seeded by the car's state, so walking the car along the track varies it.
      const trace = evaluateEasyTargets(targets, makeCar({ cellId: `C${i}`, lapCount: i % 7, tire: 100 - (i % 40) }));
      picked.add(trace.selectedCellId!);
    }
    expect([...picked].sort()).toEqual(["T7", "T8", "T9"]);
  });

  it("falls back to the plain score when fewer than three targets exist", () => {
    const two = makeTargets([["A", t(2)], ["B", t(1)]]);
    for (let i = 0; i < 30; i += 1) {
      expect(["A", "B"]).toContain(evaluateEasyTargets(two, makeCar({ cellId: `C${i}` })).selectedCellId);
    }
    expect(evaluateEasyTargets(new Map(), makeCar()).selectedCellId).toBeNull();
  });

  it("waits until 10 to want a pit box (Normal wants it at 25)", () => {
    const wornAt20 = makeCar({ tire: 20, fuel: 20 });
    const pit: Array<[string, TargetInfo]> = [
      ["P", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }],
      ["A", { distance: 2, tireCost: 1, fuelCost: 1, isPitTrigger: false }]
    ];
    const scores = (car: Car) =>
      Object.fromEntries(evaluateEasyTargets(makeTargets(pit), car).candidates.map((c) => [c.cellId, c.score]));
    // At 20 the box is penalised (-2), at 10 it gets the +5 bonus.
    expect(scores(wornAt20).P).toBe(10 - 2 - 2);
    expect(scores(makeCar({ tire: 10, fuel: 10 })).P).toBe(10 - 2 + 5);
  });
});

describe("normal policy scoring", () => {
  const t = (distance: number, moveSpend = distance): TargetInfo => ({
    distance,
    moveSpend,
    tireCost: 1,
    fuelCost: 1,
    isPitTrigger: false
  });
  const cellMap = new Map(["A0", "A", "B"].map((id) => [id, makeCell(id)]));

  it("keeps the plain distance order when the budget is untouched", () => {
    const targets = makeTargets([["A", t(9)], ["B", t(8)]]);
    expect(evaluateNormalTargets(targets, makeCar(), cellMap).selectedCellId).toBe("A");
  });

  it("penalises a spend that leaves budget it can no longer use", () => {
    // Three moves left with 12 budget: a 2-spend leaves 10 for two moves (fine), a 1-spend leaves 11.
    // With 2 moves left and 20 budget, a small spend wastes cells that 9 + 9 could not cover.
    const car = makeCar({ moveCycle: { index: 3, spent: [9, 9, 9, 0, 0] } }); // 13 left, 2 moves
    const targets = makeTargets([["A", t(9)], ["B", t(1)]]);
    const scores = Object.fromEntries(evaluateNormalTargets(targets, car, cellMap).candidates.map((c) => [c.cellId, c.score]));
    // B leaves 12 for one move that can only use 9: 3 wasted.
    expect(scores.B).toBeLessThan(scores.A! - 50);
  });

  it("prefers the even-spend move over a lane-change move of the same distance", () => {
    const targets = makeTargets([["A", t(8, 8)], ["B", t(8, 9)]]);
    const trace = evaluateNormalTargets(targets, makeCar(), cellMap);
    expect(trace.selectedCellId).toBe("A");
  });

  it("reduces to the legacy pit preference when the car is worn out", () => {
    const car = makeCar({ tire: 20, fuel: 20 });
    const targets = makeTargets([
      ["A", t(2)],
      ["P", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }]
    ]);
    expect(evaluateNormalTargets(targets, car, cellMap).selectedCellId).toBe("P");
  });

  it("scores by forward progress, not cells walked, when the track is known", () => {
    // An outer-lane cell 9 steps away that is only 7 forwardIndex ahead loses to an inner 8/8.
    const from = { ...makeCell("A0", 1), forwardIndex: 0 };
    const outer = { ...makeCell("A", 3), forwardIndex: 7 };
    const inner = { ...makeCell("B", 1), forwardIndex: 8 };
    const targets = makeTargets([["A", t(9)], ["B", t(8)]]);
    const plan = { raceLaps: 5, spineLen: 28, feederFwd: 26 };
    const map = new Map([from, outer, inner].map((c) => [c.id, c]));
    expect(evaluateNormalTargets(targets, makeCar(), map, plan).selectedCellId).toBe("B");
    // Without the plan it only knows distance.
    expect(evaluateNormalTargets(targets, makeCar(), map).selectedCellId).toBe("A");
  });
});
