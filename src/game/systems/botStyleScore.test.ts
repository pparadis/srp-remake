import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { applyAction, createRace, createRaceContext, decideBotAction, type RaceState } from "../race/raceEngine";
import type { TrackData } from "../types/track";
import { buildPlanContext, stopIsDue } from "./botPlan";
import { PERSONALITIES, personalityFor, type PersonalityKey } from "./botStyle";

const ctx = createRaceContext(track as unknown as TrackData);

function solo(style: PersonalityKey, laps = 5, level: "easy" | "normal" | "hard" = "normal"): RaceState {
  return createRace(ctx, [{ isBot: true, ownerId: "BOT1", botLevel: level, style }], laps, 3);
}

function spends(style: PersonalityKey, moves = 10): number[] {
  const state = solo(style);
  const out: number[] = [];
  for (let i = 0; i < moves; i += 1) {
    const result = applyAction(ctx, state, decideBotAction(ctx, state).action);
    if (!result.ok) throw new Error("rejected");
    out.push(result.moveSpend);
  }
  return out;
}

// Car A on lane 1 at fwd 4, a broken-down car 5 cells ahead in its lane.
const behindAWall = (style: PersonalityKey, level: "normal" | "hard" = "normal") => {
  const state = createRace(ctx, [{ isBot: true, ownerId: "A", style, botLevel: level }, { isBot: true, ownerId: "B" }], 5, 0);
  Object.assign(state.cars[0]!, { cellId: "Z05_L1_00" });
  Object.assign(state.cars[1]!, { cellId: "Z10_L1_00", state: "DNF" });
  const action = decideBotAction(ctx, state).action;
  if (action.type !== "move") throw new Error("expected a move");
  return ctx.cellMap.get(action.targetCellId)!;
};

describe("personality parameters on the Normal scorer", () => {
  it("the pusher front-loads the cycle (9-9-9-9-4), the steady driver spends it evenly (8 a move)", () => {
    expect(spends("pusher", 5)).toEqual([9, 9, 9, 9, 4]);
    expect(spends("steady", 5)).toEqual([8, 8, 8, 8, 8]);
  });

  it("balanced (seed 0) is the old Normal: the same moves as the pusher on an empty track", () => {
    expect(spends("balanced", 5)).toEqual([9, 9, 9, 9, 4]);
  });

  it("an inner-lane driver works its way in from the outer lane", () => {
    const state = createRace(ctx, Array.from({ length: 3 }, (_, i) => ({ isBot: true, ownerId: `B${i}`, style: "defender" as const })), 5, 0);
    // car 3 starts on lane 3; the others are parked
    state.cars[0]!.state = "DNF";
    state.cars[1]!.state = "DNF";
    state.turn.index = 2;
    for (let i = 0; i < 3; i += 1) {
      applyAction(ctx, state, decideBotAction(ctx, state).action);
      while (state.turn.order[state.turn.index] !== 3) applyAction(ctx, state, { type: "skip" });
    }
    expect(ctx.cellMap.get(state.cars[2]!.cellId)!.laneIndex).toBe(1);
  });

  it("the pusher and the racer pass the car ahead with a lane change; the lane-loyal ones queue behind it", () => {
    for (const style of ["pusher", "racer"] as const) expect(behindAWall(style).laneIndex).not.toBe(1);
    for (const style of ["steady", "defender"] as const) expect(behindAWall(style).laneIndex).toBe(1);
  });

  it("the pit strategist shifts the stop decision: the early one is due before the late one", () => {
    const plan = buildPlanContext(ctx.trackIndex, 9);
    const state = solo("balanced", 9);
    const car = state.cars[0]!;
    const cell = ctx.cellMap.get("Z20_L1_00")!;
    const dueAt = (style: ReturnType<typeof personalityFor>) => {
      let first: number | null = null;
      for (let tire = 100; tire >= 0 && first === null; tire -= 1) {
        if (stopIsDue({ ...car, tire, lapCount: 3 }, cell, { ...plan, style })) first = tire;
      }
      return first;
    };
    const early = { ...PERSONALITIES.strategist, pitGain: 12, pitWindow: 14 };
    const late = { ...PERSONALITIES.strategist, pitGain: -12, pitWindow: -5 };
    expect(dueAt(early)).toBeGreaterThan(dueAt(late) ?? -1);
  });
});

describe("Easy follows its style sloppily", () => {
  it("is deterministic for a seed but varies its choice across seeds", () => {
    const pick = (seed: number) => {
      const state = createRace(ctx, [{ isBot: true, ownerId: "B", botLevel: "easy" }, { isBot: true, ownerId: "C" }], 5, seed);
      return JSON.stringify(decideBotAction(ctx, state).action);
    };
    expect(pick(11)).toBe(pick(11));
    expect(new Set(Array.from({ length: 30 }, (_, i) => pick(i + 1))).size).toBeGreaterThan(2);
  });
});

describe("Hard reads the field", () => {
  it("passes where the same Normal driver would hold its lane behind the car ahead", () => {
    expect(behindAWall("defender", "normal").laneIndex).toBe(1);
    expect(behindAWall("defender", "hard").laneIndex).not.toBe(1);
  });
});
