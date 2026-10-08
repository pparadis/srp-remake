import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { MOVE_BUDGET, MOVE_RATES } from "../constants";
import { buildGameDebugSnapshot } from "../scenes/debug/gameDebugSnapshot";
import type { TrackData } from "../types/track";
import { computeTargets, createRace, createRaceContext, getActiveCar, type RaceState } from "./raceEngine";
import { budgetLeftOf, editCar, placeCar, positionAsTest, restorePosition, setActiveCar } from "./sandbox";

const ctx = createRaceContext(track as unknown as TrackData);
const newRace = (cars = 3): RaceState =>
  createRace(ctx, Array.from({ length: cars }, (_, i) => ({ isBot: i > 0, ownerId: i > 0 ? `BOT${i}` : "P1" })), 5);
const targetsOf = (state: RaceState) => computeTargets(ctx, state, getActiveCar(state));

describe("sandbox edits", () => {
  it("moves a car to any free cell (no rules) and refuses a taken or unknown cell", () => {
    const state = newRace();
    expect(editCar(ctx, state, 1, { cellId: "Z20_L1_00" })).toBeNull();
    expect(state.cars[0]!.cellId).toBe("Z20_L1_00");
    expect(editCar(ctx, state, 2, { cellId: "Z20_L1_00" })).toMatch(/taken by car 1/);
    expect(editCar(ctx, state, 2, { cellId: "nope" })).toMatch(/No cell/);
    expect(state.cars[1]!.cellId).not.toBe("Z20_L1_00");
  });

  it("a drop on a free cell moves the car, on another car swaps the two", () => {
    const state = newRace();
    placeCar(ctx, state, 1, "Z20_L1_00");
    expect(state.cars[0]!.cellId).toBe("Z20_L1_00");
    const three = state.cars[2]!.cellId;
    expect(placeCar(ctx, state, 1, three)).toBeNull();
    expect([state.cars[0]!.cellId, state.cars[2]!.cellId]).toEqual([three, "Z20_L1_00"]);
    expect(placeCar(ctx, state, 1, "nope")).toMatch(/No cell/);
    expect(new Set(state.cars.map((c) => c.cellId)).size).toBe(3);
  });

  it("edits lap, tire, fuel, compound and clamps them", () => {
    const state = newRace();
    editCar(ctx, state, 1, { lapCount: 99, tire: -5, fuel: 250, compound: "hard" });
    const car = state.cars[0]!;
    expect([car.lapCount, car.tire, car.fuel, car.setup.compound]).toEqual([4, 0, 100, "hard"]);
    editCar(ctx, state, 1, { lapCount: -9 });
    expect(car.lapCount).toBe(-1);
  });

  it("move points left cap the targets, and the cycle keeps counting from there", () => {
    const state = newRace(1);
    const car = state.cars[0]!;
    editCar(ctx, state, 1, { cellId: "Z10_L1_00", budgetLeft: 3 });
    expect(budgetLeftOf(car)).toBe(3);
    const max = Math.max(...[...targetsOf(state).values()].map((t) => t.moveSpend ?? t.distance));
    expect(max).toBeLessThanOrEqual(3);
    editCar(ctx, state, 1, { budgetLeft: 40 });
    expect(Math.max(...[...targetsOf(state).values()].map((t) => t.moveSpend ?? t.distance))).toBe(MOVE_BUDGET.baseMax);
  });

  it("switches a car between human and bot", () => {
    const state = newRace();
    editCar(ctx, state, 2, { isBot: false });
    expect(state.cars[1]).toMatchObject({ isBot: false, ownerId: "P2" });
    expect(state.cars[1]!.botLevel).toBeUndefined();
    editCar(ctx, state, 2, { isBot: true, botLevel: "hard" });
    expect(state.cars[1]).toMatchObject({ isBot: true, ownerId: "BOT2", botLevel: "hard" });
  });

  it("makes any car the active one", () => {
    const state = newRace();
    expect(setActiveCar(state, 3)).toBe(true);
    expect(getActiveCar(state).carId).toBe(3);
    expect(setActiveCar(state, 99)).toBe(false);
    expect(getActiveCar(state).carId).toBe(3);
  });
});

describe("sandbox positions", () => {
  const snapshotOf = (state: RaceState) =>
    JSON.parse(
      JSON.stringify(
        buildGameDebugSnapshot({
          buildInfo: { version: "t", gitSha: "t" },
          track: ctx.track,
          cellMap: ctx.cellMap,
          cars: state.cars,
          activeCar: getActiveCar(state),
          validTargets: targetsOf(state),
          botDecisionCount: 0,
          moveBudget: MOVE_BUDGET,
          moveRates: MOVE_RATES,
          disallowPitBoxTargets: false,
          seed: state.seed
        })
      )
    );

  it("restores a Copy debug snapshot: cars, lap, resources, move points and the active car", () => {
    const a = newRace();
    editCar(ctx, a, 1, { cellId: "Z20_L1_00", lapCount: 2, tire: 40, budgetLeft: 5 });
    editCar(ctx, a, 2, { cellId: "Z23_L1_00", compound: "hard" });
    setActiveCar(a, 2);
    const b = newRace();
    expect(restorePosition(ctx, b, snapshotOf(a))).toBeNull();
    expect(JSON.parse(JSON.stringify(b.cars))).toEqual(JSON.parse(JSON.stringify(a.cars)));
    expect(getActiveCar(b).carId).toBe(2);
  });

  it("refuses a snapshot that does not fit, changing nothing", () => {
    const a = newRace(3);
    const before = JSON.stringify(a);
    expect(restorePosition(ctx, a, snapshotOf(newRace(4)))).toMatch(/4 cars, this race has 3/);
    const dup = snapshotOf(newRace(3));
    dup.cars[1].cellId = dup.cars[0].cellId;
    expect(restorePosition(ctx, a, dup)).toMatch(/Two cars on/);
    dup.cars[1].cellId = "nope";
    expect(restorePosition(ctx, a, dup)).toMatch(/No cell/);
    expect(restorePosition(ctx, a, { nothing: true })).toMatch(/Not a debug snapshot/);
    expect(JSON.stringify(a)).toBe(before);
  });

  it("the copied test carries the state and the offered targets", () => {
    const state = newRace();
    editCar(ctx, state, 1, { cellId: "Z20_L1_00" });
    editCar(ctx, state, 2, { cellId: "Z23_L1_00" });
    const text = positionAsTest(ctx, state);
    expect(text).toContain("car 1 on Z20_L1_00 to play");
    const body = text.slice(text.indexOf("toEqual({") + 9, text.lastIndexOf("});\n  });"));
    const offered = Object.fromEntries(
      [...body.matchAll(/"(\w+)": (\d+),/g)].map((m) => [m[1], Number(m[2])])
    );
    const expected = Object.fromEntries([...targetsOf(state)].map(([id, t]) => [id, t.moveSpend ?? t.distance]));
    expect(offered).toEqual(expected);
    // the state literal is plain JSON of the race
    const literal = text.slice(text.indexOf("= {", text.indexOf("const state")) + 2, text.indexOf(";\n\ndescribe"));
    expect(JSON.parse(literal)).toEqual(JSON.parse(JSON.stringify(state)));
  });
});
