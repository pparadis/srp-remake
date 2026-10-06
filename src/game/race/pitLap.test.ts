import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { CarSetup } from "../types/car";
import type { TrackData } from "../types/track";
import { createFeelMemory, detectFeel } from "../systems/feelEvents";
import { crossesStartLine } from "../systems/moveCommitSystem";
import { applyAction, computeTargets, createRace, createRaceContext, getActiveCar, type RaceState } from "./raceEngine";

// The start line crosses the pit lane too (F1: a lap is credited whatever lane crosses the Line).
// Real track: lane-1 feeder Z27_L1_00 -> PIT_ENTRY Z28_L0_00 -> Z01_L0_00 (PIT_LINE, under the
// START_FINISH cell) -> Z02/Z03 boxes -> Z04, Z05 -> PIT_EXIT Z06_L0_00 -> Z07_L1_00.
const ctx = createRaceContext(track as unknown as TrackData);
const SETUP: CarSetup = { compound: "hard", psi: { fl: 22, fr: 22, rl: 20, rr: 20 }, wingFrontDeg: 4, wingRearDeg: 10 };

function race(laps = 5, cars = 2): RaceState {
  return createRace(
    ctx,
    Array.from({ length: cars }, (_, i) => ({ isBot: false, ownerId: `P${i + 1}` })),
    laps
  );
}

// Puts the active car on `cellId` with `lapCount` laps done and plays one move or pit to `target`.
function play(state: RaceState, cellId: string, lapCount: number, target: string, pit = false) {
  const car = getActiveCar(state);
  car.cellId = cellId;
  car.lapCount = lapCount;
  const result = applyAction(
    ctx,
    state,
    pit ? { type: "pit", targetCellId: target, setup: SETUP } : { type: "move", targetCellId: target }
  );
  expect(result.ok).toBe(true);
  return car;
}

describe("pit-lane start line", () => {
  it("tags exactly one pit cell as the line and exposes its forwardIndex", () => {
    expect(ctx.trackIndex.pitLineFwd).toBe(ctx.cellMap.get("Z01_L0_00")!.forwardIndex);
  });

  it("credits one lap when the pit entry moves onto the pit line cell", () => {
    expect(play(race(), "Z28_L0_00", 1, "Z01_L0_00").lapCount).toBe(2);
  });

  it("counts a jump from the entry over the line cell to a box as a crossing (rule level)", () => {
    const cell = (id: string) => ctx.cellMap.get(id)!;
    const line = ctx.trackIndex.pitLineFwd;
    expect(crossesStartLine(cell("Z28_L0_00"), cell("Z02_L0_00"), line)).toBe(true);
    expect(crossesStartLine(cell("Z28_L0_00"), cell("Z01_L0_00"), line)).toBe(true);
    expect(crossesStartLine(cell("Z01_L0_00"), cell("Z02_L0_00"), line)).toBe(false);
    expect(crossesStartLine(cell("Z27_L1_00"), cell("Z28_L0_00"), line)).toBe(false);
    expect(crossesStartLine(cell("Z06_L0_00"), cell("Z07_L1_00"), line)).toBe(false);
    // On this track the movement rules never offer a box from the entry (only one step, boxes are
    // reachable from Z01_L0_00), so every real stop credits its lap by landing on the line cell.
    const state = race();
    const car = getActiveCar(state);
    car.cellId = "Z28_L0_00";
    expect(computeTargets(ctx, state, car).has("Z02_L0_00")).toBe(false);
    expect(computeTargets(ctx, state, car).has("Z01_L0_00")).toBe(true);
  });

  it("does not credit the move from the lane-1 feeder onto the pit entry", () => {
    expect(play(race(), "Z27_L1_00", 1, "Z28_L0_00").lapCount).toBe(1);
  });

  it("does not credit again from the pit line cell, a box, or the pit exit onto lane 1", () => {
    expect(play(race(), "Z01_L0_00", 2, "Z02_L0_00", true).lapCount).toBe(2);
    expect(play(race(), "Z03_L0_00", 2, "Z04_L0_00").lapCount).toBe(2);
    const exit = play(race(), "Z06_L0_00", 2, "Z07_L1_00");
    expect(exit.lapCount).toBe(2);
    expect(exit.cellId).toBe("Z07_L1_00");
  });

  it("a rear-grid car (-1) crossing in the pit lane goes to 0 without a win, even in a 1-lap race", () => {
    const state = race(1);
    const car = play(state, "Z28_L0_00", -1, "Z01_L0_00");
    expect(car.lapCount).toBe(0);
    expect(state.winnerCarId).toBeNull();
  });

  it("a whole pit stop from the feeder to the exit credits exactly one lap, like staying on track", () => {
    const state = race(9, 1);
    const car = getActiveCar(state);
    car.cellId = "Z27_L1_00";
    car.lapCount = 1;
    const laps: number[] = [];
    for (let i = 0; i < 20 && (i === 0 || ctx.cellMap.get(car.cellId)!.laneIndex !== 1); i += 1) {
      const targets = computeTargets(ctx, state, car);
      const box = [...targets.keys()].find((id) => ctx.cellMap.get(id)!.tags?.includes("PIT_BOX"));
      const forward = [...targets.keys()].sort(
        (a, b) => ctx.cellMap.get(b)!.forwardIndex - ctx.cellMap.get(a)!.forwardIndex
      )[0]!;
      const entry = [...targets.keys()].find((id) => ctx.cellMap.get(id)!.tags?.includes("PIT_ENTRY"));
      const action =
        box && !car.pitServiced
          ? ({ type: "pit", targetCellId: box, setup: SETUP } as const)
          : ({ type: "move", targetCellId: entry ?? forward } as const);
      expect(applyAction(ctx, state, action).ok).toBe(true);
      laps.push(car.lapCount);
    }
    expect(ctx.cellMap.get(car.cellId)).toMatchObject({ laneIndex: 1, forwardIndex: 6 });
    expect(car.lapCount).toBe(2);
    // one credit, at the step that reaches the line cell or a box beyond it
    expect(laps.filter((n, i) => n > (laps[i - 1] ?? 1))).toHaveLength(1);

    // The same stretch (feeder to past the line) on track credits the same single lap.
    const trackState = race(9, 1);
    const runner = getActiveCar(trackState);
    runner.cellId = "Z27_L1_00";
    runner.lapCount = 1;
    for (let i = 0; i < 6 && runner.lapCount < 2; i += 1) {
      const t = computeTargets(ctx, trackState, runner);
      const best = [...t.keys()].filter((id) => ctx.cellMap.get(id)!.laneIndex === 1)[0];
      applyAction(ctx, trackState, { type: "move", targetCellId: best! });
    }
    expect(runner.lapCount).toBe(2);
  });

  it("the first car to complete raceLaps wins, even when it does it in the pit lane", () => {
    const state = race(3, 2);
    const [a, b] = state.cars;
    b!.cellId = "Z20_L1_00";
    b!.lapCount = 2;
    const car = play(state, "Z28_L0_00", 2, "Z01_L0_00");
    expect(car).toBe(a);
    expect(state.winnerCarId).toBe(a!.carId);
    // B only got there second: the race is over, nothing more is accepted
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "race_finished" });
  });

  it("an on-track crossing that comes first wins; the pit car behind it never gets to cross", () => {
    const state = race(3, 2);
    const [a, b] = state.cars;
    a!.cellId = "Z28_L0_00";
    a!.lapCount = 2;
    state.turn.index = 1;
    const from = ctx.cellMap.get("Z28_L1_00")!;
    const car = getActiveCar(state);
    car.cellId = from.id;
    car.lapCount = 2;
    const wrap = [...computeTargets(ctx, state, car).keys()].find((id) => ctx.cellMap.get(id)!.forwardIndex < from.forwardIndex);
    expect(applyAction(ctx, state, { type: "move", targetCellId: wrap! }).ok).toBe(true);
    expect(state.winnerCarId).toBe(b!.carId);
    expect(a!.lapCount).toBe(2);
  });
});

describe("feel events for pit-lane crossings", () => {
  const view = (lapCount: number, cellId: string, finished = false) => ({
    myCarId: 1,
    raceLaps: 3,
    finished,
    canControl: false,
    cars: [{ carId: 1, lapCount, cellId, tire: 90, fuel: 90 }]
  });

  it("toasts a pit-lane crossing like a track crossing", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view(1, "Z28_L0_00"));
    expect(detectFeel(mem, view(2, "Z01_L0_00"))).toEqual([
      { type: "move" },
      { type: "lap", lap: 3, laps: 3, final: true }
    ]);
  });

  it("is silent for the first crossing (-1 to 0) in the pit lane", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view(-1, "Z28_L0_00"));
    expect(detectFeel(mem, view(0, "Z01_L0_00"))).toEqual([{ type: "move" }]);
  });

  it("finishes the race from the pit lane with a finish event and no lap toast", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view(2, "Z28_L0_00"));
    expect(detectFeel(mem, view(3, "Z01_L0_00", true))).toEqual([{ type: "move" }, { type: "finish" }]);
  });
});
