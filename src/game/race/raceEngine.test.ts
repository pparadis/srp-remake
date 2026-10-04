import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { CarSetup } from "../types/car";
import type { TrackData } from "../types/track";
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  isValidSetup,
  type RaceSeat,
  type RaceState
} from "./raceEngine";

const ctx = createRaceContext(track as unknown as TrackData);
const SEATS: RaceSeat[] = [
  { isBot: false, ownerId: "P1" },
  { isBot: true, ownerId: "BOT2" },
  { isBot: false, ownerId: "P3" }
];
const SETUP: CarSetup = {
  compound: "hard",
  psi: { fl: 22, fr: 22, rl: 20, rr: 20 },
  wingFrontDeg: 4,
  wingRearDeg: 10
};

function newRace(laps = 5, seats = SEATS): RaceState {
  return createRace(ctx, seats, laps);
}

function firstTarget(state: RaceState): string {
  const [first] = Array.from(computeTargets(ctx, state, getActiveCar(state)).keys()).sort();
  if (!first) throw new Error("no targets");
  return first;
}

// Put the active car in the pit lane, one step before the first PIT_BOX.
function parkActiveCarBeforePitBox(state: RaceState) {
  getActiveCar(state).cellId = "Z01_L0_00";
}

describe("createRace", () => {
  it("applies seat ownership and bot flags to spawned cars", () => {
    const state = newRace();
    expect(state.cars.map((c) => [c.carId, c.ownerId, c.isBot])).toEqual([
      [1, "P1", false],
      [2, "BOT2", true],
      [3, "P3", false]
    ]);
    expect(state.winnerCarId).toBeNull();
    expect(getActiveCar(state).carId).toBe(1);
  });

  it("rejects more seats than the track has spawn slots", () => {
    const seats = Array.from({ length: 200 }, (_, i) => ({ isBot: true, ownerId: `BOT${i}` }));
    expect(() => createRace(ctx, seats, 3)).toThrow(/room for/);
  });
});

describe("applyAction: move", () => {
  it("moves the car, spends tire/fuel and budget, and passes the turn", () => {
    const state = newRace();
    const car = getActiveCar(state);
    const target = firstTarget(state);
    const info = computeTargets(ctx, state, car).get(target)!;

    const result = applyAction(ctx, state, { type: "move", targetCellId: target });

    expect(result.ok).toBe(true);
    expect(car.cellId).toBe(target);
    expect(car.tire).toBe(100 - info.tireCost);
    expect(car.fuel).toBe(100 - info.fuelCost);
    expect(car.moveCycle.spent[0]).toBeGreaterThan(0);
    expect(getActiveCar(state).carId).toBe(2);
    if (result.ok) {
      expect(result.log[0]).toBe(`Car 1 moved to ${target}.`);
      expect(result.log.at(-1)).toBe("Car 2 to play.");
    }
  });

  it("rejects an unreachable cell and leaves the state untouched", () => {
    const state = newRace();
    const before = structuredClone(state);

    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z16_L3_00" })).toEqual({
      ok: false,
      reason: "invalid_target"
    });
    expect(applyAction(ctx, state, { type: "move", targetCellId: "nope" })).toEqual({
      ok: false,
      reason: "invalid_target"
    });
    expect(state).toEqual(before);
  });

  it("rejects a plain move onto a pit box", () => {
    const state = newRace();
    parkActiveCarBeforePitBox(state);
    const before = structuredClone(state);

    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z02_L0_00" })).toEqual({
      ok: false,
      reason: "use_pit_action"
    });
    expect(state).toEqual(before);
  });
});

describe("applyAction: pit", () => {
  it("applies setup, refills, and makes the car lose its next turn", () => {
    const state = newRace(5, [
      { isBot: false, ownerId: "P1" },
      { isBot: false, ownerId: "P2" }
    ]);
    const car = getActiveCar(state);
    car.tire = 30;
    car.fuel = 20;
    parkActiveCarBeforePitBox(state);

    const result = applyAction(ctx, state, { type: "pit", targetCellId: "Z02_L0_00", setup: SETUP });

    expect(result.ok).toBe(true);
    expect(car).toMatchObject({ cellId: "Z02_L0_00", tire: 100, fuel: 100, pitServiced: true, state: "PITTING" });
    expect(car.setup).toEqual(SETUP);
    expect(car.setup).not.toBe(SETUP);
    expect(getActiveCar(state).carId).toBe(2);

    // Car 2 moves, then car 1 serves its penalty and car 2 plays again.
    const second = applyAction(ctx, state, { type: "move", targetCellId: firstTarget(state) });
    expect(getActiveCar(state).carId).toBe(2);
    expect(car.state).toBe("ACTIVE");
    expect(car.pitExitBoost).toBe(true);
    if (second.ok) expect(second.log).toContain("Car 1 pit penalty (remaining 0).");
  });

  it("rejects a pit action that is not on a pit box, or with an invalid setup", () => {
    const state = newRace();
    const target = firstTarget(state);
    expect(applyAction(ctx, state, { type: "pit", targetCellId: target, setup: SETUP })).toEqual({
      ok: false,
      reason: "not_pit_box"
    });

    parkActiveCarBeforePitBox(state);
    const bad = { ...SETUP, psi: { ...SETUP.psi, fl: 99 } };
    expect(applyAction(ctx, state, { type: "pit", targetCellId: "Z02_L0_00", setup: bad })).toEqual({
      ok: false,
      reason: "invalid_setup"
    });
    expect(getActiveCar(state).carId).toBe(1);
  });

  it("validates setup limits", () => {
    expect(isValidSetup(SETUP)).toBe(true);
    expect(isValidSetup({ ...SETUP, compound: "wet" as never })).toBe(false);
    expect(isValidSetup({ ...SETUP, wingRearDeg: 21 })).toBe(false);
    expect(isValidSetup({ ...SETUP, wingFrontDeg: 1.5 })).toBe(false);
    expect(isValidSetup({ ...SETUP, psi: { ...SETUP.psi, rr: 14 } })).toBe(false);
  });
});

describe("applyAction: skip", () => {
  it("refuses a skip while moves are available", () => {
    const state = newRace();
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "moves_available" });
    expect(getActiveCar(state).carId).toBe(1);
  });

  it("allows a skip when the car has no moves left", () => {
    const state = newRace();
    const car = getActiveCar(state);
    car.moveCycle.spent = [40, 0, 0, 0, 0];
    car.moveCycle.index = 1;

    const result = applyAction(ctx, state, { type: "skip" });

    expect(result.ok).toBe(true);
    expect(getActiveCar(state).carId).toBe(2);
  });
});

describe("laps and winning", () => {
  it("counts a lap on forwardIndex wrap, ends the race at raceLaps, then rejects actions", () => {
    const state = newRace(1);
    const car = getActiveCar(state);
    // Last forwardIndex cell of lane 1; the next move crosses the start/finish line.
    const lane1 = (track as unknown as TrackData).cells.filter((c) => c.laneIndex === 1);
    const last = lane1.reduce((a, b) => (b.forwardIndex > a.forwardIndex ? b : a));
    car.cellId = last.id;

    const result = applyAction(ctx, state, { type: "move", targetCellId: firstTarget(state) });

    expect(car.lapCount).toBe(1);
    expect(state.winnerCarId).toBe(1);
    expect(getActiveCar(state).carId).toBe(1);
    if (result.ok) expect(result.log.at(-1)).toBe("Race finished. Car 1 wins (1/1 laps).");
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "race_finished" });
  });
});

describe("decideBotAction", () => {
  it("picks a move the engine then accepts", () => {
    const state = newRace(5, [
      { isBot: true, ownerId: "BOT1" },
      { isBot: false, ownerId: "P2" }
    ]);
    const decision = decideBotAction(ctx, state);

    expect(decision.action.type).toBe("move");
    expect(decision.trace?.selectedCellId).toBeTruthy();
    expect(decision.targets.size).toBeGreaterThan(0);
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
  });

  it("skips an inactive car without evaluating targets", () => {
    const state = newRace();
    getActiveCar(state).state = "DNF";
    const decision = decideBotAction(ctx, state);
    expect(decision).toMatchObject({ action: { type: "skip" }, trace: null, skipNote: "inactive" });
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
  });

  it("skips when no target is reachable", () => {
    const state = newRace();
    const car = getActiveCar(state);
    car.moveCycle.spent = [40, 0, 0, 0, 0];
    car.moveCycle.index = 1;
    const decision = decideBotAction(ctx, state);
    expect(decision).toMatchObject({ action: { type: "skip" }, skipNote: "no-target" });
  });

  it("is deterministic", () => {
    const a = decideBotAction(ctx, newRace());
    const b = decideBotAction(ctx, newRace());
    expect(a.action).toEqual(b.action);
  });

  it("plays a full bot-only race to a winner", () => {
    const seats = Array.from({ length: 4 }, (_, i) => ({ isBot: true, ownerId: `BOT${i + 1}` }));
    const state = createRace(ctx, seats, 1);
    for (let i = 0; i < 2000 && state.winnerCarId === null; i += 1) {
      const result = applyAction(ctx, state, decideBotAction(ctx, state).action);
      expect(result.ok).toBe(true);
    }
    expect(state.winnerCarId).not.toBeNull();
  });
});
