import { describe, expect, it, vi } from "vitest";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import type { TargetInfo } from "../../systems/movementSystem";
import type { BotDecisionAppendEntry } from "../debug/botDecisionDebug";
import { executeBotTurn } from "./executeBotTurn";

function makeCell(id: string, laneIndex: number, tags: TrackCell["tags"] = []): TrackCell {
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

function makeCar(overrides: Partial<Car> = {}): Car {
  return {
    carId: 2,
    ownerId: "BOT2",
    isBot: true,
    cellId: "A",
    lapCount: 0,
    tire: 90,
    fuel: 90,
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

describe("executeBotTurn", () => {
  it("skips inactive cars and records reason", () => {
    const car = makeCar({ state: "DNF" });
    const appendEntries: Array<{ entry: BotDecisionAppendEntry; fromCellId: string | undefined }> = [];
    const logLines: string[] = [];
    const result = executeBotTurn({
      activeCar: car,
      cellMap: new Map(),
      computeTargetsForCar: () => new Map(),
      appendBotDecision: (entry, fromCellId) => appendEntries.push({ entry, fromCellId }),
      addLog: (line) => logLines.push(line),
      onPitStop: vi.fn()
    });

    expect(result).toBeNull();
    expect(appendEntries).toHaveLength(1);
    expect(appendEntries[0]?.entry.action.type).toBe("skip");
    expect(appendEntries[0]?.entry.action.note).toBe("inactive");
    expect(car.moveCycle.index).toBe(1);
    expect(logLines[0]).toBe("Car 2 skipped (inactive).");
  });

  it("applies move action and logs origin cell in decision entry", () => {
    const car = makeCar({ cellId: "A" });
    const fromCell = makeCell("A", 1);
    const targetCell = makeCell("B", 1);
    targetCell.pos = { x: 12, y: 34 };
    const cellMap = new Map<string, TrackCell>([
      ["A", fromCell],
      ["B", targetCell]
    ]);
    const targets = new Map<string, TargetInfo>([
      ["B", { distance: 1, moveSpend: 1, tireCost: 1, fuelCost: 1, isPitTrigger: false }]
    ]);
    const appendEntries: Array<{ entry: BotDecisionAppendEntry; fromCellId: string | undefined }> = [];
    const logLines: string[] = [];

    const result = executeBotTurn({
      activeCar: car,
      cellMap,
      computeTargetsForCar: () => targets,
      appendBotDecision: (entry, fromCellId) => appendEntries.push({ entry, fromCellId }),
      addLog: (line) => logLines.push(line),
      onPitStop: vi.fn()
    });

    expect(result?.id).toBe("B");
    expect(car.cellId).toBe("B");
    expect(appendEntries).toHaveLength(1);
    expect(appendEntries[0]?.fromCellId).toBe("A");
    expect(appendEntries[0]?.entry.action.type).toBe("move");
    expect(appendEntries[0]?.entry.action.targetCellId).toBe("B");
    expect(logLines[0]).toBe("Car 2 moved to B.");
  });

  it("applies pit stop action and calls onPitStop callback", () => {
    const car = makeCar({ cellId: "A", pitServiced: false, tire: 10, fuel: 10 });
    const fromCell = makeCell("A", 1);
    const pitCell = makeCell("P1", 0, ["PIT_BOX"]);
    const cellMap = new Map<string, TrackCell>([
      ["A", fromCell],
      ["P1", pitCell]
    ]);
    const targets = new Map<string, TargetInfo>([
      ["P1", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }]
    ]);
    const appendEntries: Array<{ entry: BotDecisionAppendEntry; fromCellId: string | undefined }> = [];
    const onPitStop = vi.fn();

    const result = executeBotTurn({
      activeCar: car,
      cellMap,
      computeTargetsForCar: () => targets,
      appendBotDecision: (entry, fromCellId) => appendEntries.push({ entry, fromCellId }),
      addLog: vi.fn(),
      onPitStop
    });

    expect(result?.id).toBe("P1");
    expect(car.cellId).toBe("P1");
    expect(car.state).toBe("PITTING");
    expect(car.pitServiced).toBe(true);
    expect(onPitStop).toHaveBeenCalledWith(pitCell);
    expect(appendEntries[0]?.fromCellId).toBe("A");
    expect(appendEntries[0]?.entry.action.type).toBe("pit");
    expect(appendEntries[0]?.entry.action.targetCellId).toBe("P1");
  });
});
