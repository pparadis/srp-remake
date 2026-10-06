import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { IDEAL_PIT_SETUP } from "../systems/botPlan";
import type { TrackData } from "../types/track";
import { HARD_CANDIDATES } from "./botHard";
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceState
} from "./raceEngine";

const ctx = createRaceContext(track as unknown as TrackData);

// Car 1 (Hard) on lane 1 at forwardIndex 8, with three broken-down cars that stay where they are:
// lane 1 at 15 and 17, lane 2 at 15. Greedy runs the 6 cells to the one free cell behind the
// lane-1 blocker and then has to squeeze past it; the lookahead sees that and changes lane now.
function blockedTrack(level: "normal" | "hard"): RaceState {
  const state = createRace(
    ctx,
    Array.from({ length: 4 }, (_, i) => ({ isBot: true, ownerId: `BOT${i + 1}`, botLevel: level })),
    5
  );
  state.cars[0]!.cellId = "Z09_L1_00";
  ["Z18_L1_00", "Z16_L2_00", "Z16_L1_00"].forEach((cellId, i) => {
    Object.assign(state.cars[i + 1]!, { cellId, state: "DNF" });
  });
  return state;
}

function progressAfterTwoTurns(state: RaceState, first: string): number {
  applyAction(ctx, state, { type: "move", targetCellId: first });
  while (getActiveCar(state).carId !== 1) {
    applyAction(ctx, state, decideBotAction(ctx, state).action); // the broken-down cars skip
  }
  applyAction(ctx, state, decideBotAction(ctx, state, "normal").action);
  const car = state.cars[0]!;
  return (car.lapCount ?? 0) * 28 + ctx.cellMap.get(car.cellId)!.forwardIndex;
}

describe("hard bot lookahead", () => {
  it("picks a different, better move than Normal where greedy runs into a wall", () => {
    const normal = decideBotAction(ctx, blockedTrack("normal"), "normal").action;
    const hard = decideBotAction(ctx, blockedTrack("hard")).action;
    if (normal.type !== "move" || hard.type !== "move") throw new Error("expected moves");

    expect(hard.targetCellId).not.toBe(normal.targetCellId);
    const normalProgress = progressAfterTwoTurns(blockedTrack("normal"), normal.targetCellId);
    const hardProgress = progressAfterTwoTurns(blockedTrack("hard"), hard.targetCellId);
    expect(hardProgress).toBeGreaterThan(normalProgress + 3);
  });

  it("only considers the best few candidates and reports their lookahead values", () => {
    const decision = decideBotAction(ctx, blockedTrack("hard"));
    expect(decision.trace!.candidates.length).toBeLessThanOrEqual(HARD_CANDIDATES);
    expect(decision.trace!.candidates.length).toBeGreaterThan(1);
    expect(decision.trace!.selectedCellId).toBe(
      decision.action.type === "move" ? decision.action.targetCellId : null
    );
    // Every candidate is a legal target of the current position.
    const legal = computeTargets(ctx, blockedTrack("hard"), getActiveCar(blockedTrack("hard")));
    for (const c of decision.trace!.candidates) expect(legal.has(c.cellId)).toBe(true);
  });

  it("is deterministic and leaves the race untouched", () => {
    const state = blockedTrack("hard");
    const before = JSON.stringify(state);
    const a = decideBotAction(ctx, state);
    expect(JSON.stringify(state)).toBe(before);
    expect(decideBotAction(ctx, blockedTrack("hard")).action).toEqual(a.action);
  });

  it("falls back to Normal's move when there is a single choice", () => {
    const state = blockedTrack("hard");
    state.cars[0]!.moveCycle = { index: 4, spent: [10, 10, 10, 9, 0] }; // 1 budget left: one target
    const hard = decideBotAction(ctx, state);
    expect(hard.action).toEqual(decideBotAction(ctx, state, "normal").action);
  });

  it("plans a pit stop that a worn car needs and fits the ideal setup", () => {
    const state = createRace(
      ctx,
      [
        { isBot: true, ownerId: "BOT1", botLevel: "hard" },
        { isBot: false, ownerId: "P2" }
      ],
      12
    );
    Object.assign(state.cars[0]!, { cellId: "Z01_L0_00", lapCount: 5, tire: 4, fuel: 6 });
    const decision = decideBotAction(ctx, state);
    expect(decision.action).toMatchObject({ type: "pit", setup: IDEAL_PIT_SETUP });
  });

  it("enters the pit lane when worn out on a long race (the stop is valued ahead of the lap it costs)", () => {
    const state = createRace(
      ctx,
      [
        { isBot: true, ownerId: "BOT1", botLevel: "hard" },
        { isBot: false, ownerId: "P2" }
      ],
      12
    );
    Object.assign(state.cars[0]!, { cellId: "Z27_L1_00", lapCount: 4, tire: 5, fuel: 20 });
    const action = decideBotAction(ctx, state).action;
    if (action.type !== "move") throw new Error("expected a move");
    expect(ctx.cellMap.get(action.targetCellId)!.tags).toContain("PIT_ENTRY");
  });
});
