import { describe, expect, it } from "vitest";
import type { Car } from "../../types/car";
import type { BotDecisionTrace } from "../../systems/botSystem";
import type { TargetInfo } from "../../systems/movementSystem";
import {
  appendBotDecisionEntry,
  buildBotDecisionSnapshot,
  type BotDecisionLogEntry,
  serializeBotTargets,
  serializeBotTrace
} from "./botDecisionDebug";

function makeCar(overrides: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: "BOT1",
    isBot: true,
    cellId: "A1",
    lapCount: 0,
    tire: 90,
    fuel: 80,
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

describe("botDecisionDebug helpers", () => {
  it("serializes bot targets in cell id order", () => {
    const targets = new Map<string, TargetInfo>([
      ["B2", { distance: 2, tireCost: 1, fuelCost: 1, isPitTrigger: false }],
      ["A1", { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }]
    ]);
    const serialized = serializeBotTargets(targets);
    expect(serialized.map((entry) => entry.cellId)).toEqual(["A1", "B2"]);
    expect(serialized[0]?.isPitTrigger).toBe(true);
  });

  it("serializes bot trace candidates", () => {
    const trace: BotDecisionTrace = {
      lowResources: true,
      heuristics: { lowResourceThreshold: 25, pitBonus: 5, pitPenalty: 2 },
      selectedCellId: "P1",
      candidates: [
        {
          cellId: "P1",
          score: 12,
          info: { distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: true }
        }
      ]
    };
    const serialized = serializeBotTrace(trace);
    expect(serialized?.selectedCellId).toBe("P1");
    expect(serialized?.candidates[0]?.distance).toBe(1);
    expect(serialized?.candidates[0]?.isPitTrigger).toBe(true);
  });

  it("appends log entries with explicit origin and trims to limit", () => {
    const car = makeCar();
    const log: BotDecisionLogEntry[] = [];
    let seq = appendBotDecisionEntry(
      log,
      1,
      1,
      0,
      car,
      {
        validTargets: [],
        action: { type: "skip", note: "first" },
        trace: null
      },
      "ORIGIN"
    );
    seq = appendBotDecisionEntry(
      log,
      1,
      seq,
      1,
      { ...car, cellId: "B2" },
      {
        validTargets: [],
        action: { type: "skip", note: "second" },
        trace: null
      }
    );
    expect(seq).toBe(3);
    expect(log).toHaveLength(1);
    expect(log[0]?.fromCellId).toBe("B2");
    expect(log[0]?.action.note).toBe("second");
  });

  it("builds short snapshot without trace and validTargets fields", () => {
    const car = makeCar();
    const log: BotDecisionLogEntry[] = [];
    appendBotDecisionEntry(
      log,
      10,
      1,
      2,
      car,
      {
        validTargets: [{ cellId: "A1", distance: 1, tireCost: 1, fuelCost: 1, isPitTrigger: false }],
        action: { type: "move", targetCellId: "A1", moveSpend: 1 },
        trace: null
      }
    );
    const snapshot = buildBotDecisionSnapshot({ version: "v", gitSha: "sha" }, "track", log, true);
    expect(snapshot.shortMode).toBe(true);
    expect(snapshot.botDecisionCount).toBe(1);
    const shortEntry = snapshot.botDecisions[0] as Record<string, unknown>;
    expect("validTargets" in shortEntry).toBe(false);
    expect("trace" in shortEntry).toBe(false);
  });
});
