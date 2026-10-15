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
import type { BotLevel, Car } from "../types/car";

const ctx = createRaceContext(track as unknown as TrackData);
const SEATS: RaceSeat[] = [
  { isBot: false, ownerId: "P1" },
  { isBot: true, ownerId: "BOT2" },
  { isBot: false, ownerId: "P3" }
];
const SETUP: CarSetup = {
  compound: "hard",
  psi: { fl: 22, fr: 22, rl: 20, rr: 20 },
  wing: "medium" as const
};

// The plain setup (hard, Medium wing: a cycle budget of 40). createRace gives bots a setup for the distance; the
// rules tests below want the same budget on every car, and the grid-setup tests pick their own.
function newRace(laps = 5, seats = SEATS): RaceState {
  const state = createRace(ctx, seats, laps);
  for (const car of state.cars) Object.assign(car.setup, { compound: "hard", wing: "medium" });
  return state;
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

  it("gives bot seats their level (normal by default) and leaves humans without one", () => {
    const state = newRace(5, [
      { isBot: true, ownerId: "BOT1", botLevel: "hard" },
      { isBot: true, ownerId: "BOT2" },
      { isBot: false, ownerId: "P3", botLevel: "easy" }
    ]);
    expect(state.cars.map((c) => c.botLevel)).toEqual(["hard", "normal", undefined]);
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
    expect(isValidSetup({ ...SETUP, wing: "huge" as never })).toBe(false);
    expect(isValidSetup({ ...SETUP, wing: "high" })).toBe(true);
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
    if (result.ok) expect(result.log.at(-1)).toBe("Race finished. Car 1 wins the 1-lap race.");
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "race_finished" });
  });
});

describe("laps from a staggered grid", () => {
  const FOUR: RaceSeat[] = [
    { isBot: false, ownerId: "P1" },
    { isBot: false, ownerId: "P2" },
    { isBot: false, ownerId: "P3" },
    { isBot: false, ownerId: "P4" }
  ];
  // A move by the active car that ends past the start line (forwardIndex wraps).
  const crossingTarget = (state: RaceState) => {
    const car = getActiveCar(state);
    const from = ctx.cellMap.get(car.cellId)!;
    const hit = [...computeTargets(ctx, state, car).keys()].find(
      (id) => ctx.cellMap.get(id)!.forwardIndex < from.forwardIndex
    );
    if (!hit) throw new Error("no crossing target");
    return hit;
  };

  it("starts the front row at 0 laps done and the row behind the line at -1", () => {
    expect(newRace(5, FOUR).cars.map((c) => c.lapCount)).toEqual([0, 0, 0, -1]);
  });

  it("the first crossing of a rear-grid car only starts lap 1: no lap, no win, even in a 1-lap race", () => {
    const state = newRace(1, FOUR);
    state.turn.index = 3;
    const car = getActiveCar(state);
    expect(car.carId).toBe(4);
    const result = applyAction(ctx, state, { type: "move", targetCellId: crossingTarget(state) });
    expect(result.ok).toBe(true);
    expect(car.lapCount).toBe(0);
    expect(state.winnerCarId).toBeNull();
    if (result.ok) expect(result.log.join("\n")).not.toContain("Race finished");
  });

  it("a 1-lap race is won by the first car to cross the line after starting on it", () => {
    const state = newRace(1, FOUR);
    const [pole] = state.cars;
    pole!.cellId = [...ctx.cellMap.values()].find((c) => c.laneIndex === 1 && c.forwardIndex === 27)!.id;
    const result = applyAction(ctx, state, { type: "move", targetCellId: crossingTarget(state) });
    expect(pole!.lapCount).toBe(1);
    expect(state.winnerCarId).toBe(1);
    if (result.ok) expect(result.log.at(-1)).toBe("Race finished. Car 1 wins the 1-lap race.");
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

  const wornInPitLane = (level?: BotLevel) => {
    const state = newRace(5, [
      { isBot: true, ownerId: "BOT1", ...(level ? { botLevel: level } : {}) },
      { isBot: false, ownerId: "P2" }
    ]);
    const car = getActiveCar(state);
    car.cellId = "Z01_L0_00";
    car.tire = 10;
    car.fuel = 10;
    return { state, car };
  };

  it("pits when worn out in the pit lane, and fits the cheapest-to-run setup (Normal)", () => {
    const { state, car } = wornInPitLane();
    const decision = decideBotAction(ctx, state);

    // 32 psi costs nothing extra; the wing and compound are the best pair for what is left of the 5 laps.
    expect(decision.action).toMatchObject({ type: "pit", setup: { psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: "low" } });
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
    expect(car).toMatchObject({ tire: 100, fuel: 100, state: "PITTING", pitServiced: true });
  });

  it("Easy pits at 10 and keeps its own setup", () => {
    const { state, car } = wornInPitLane("easy");
    const decision = decideBotAction(ctx, state);
    expect(decision.action).toMatchObject({ type: "pit", setup: car.setup });
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
  });

  describe("by level", () => {
    const duo = (level: BotLevel | undefined) =>
      newRace(5, [
        { isBot: true, ownerId: "BOT1", ...(level ? { botLevel: level } : {}) },
        { isBot: true, ownerId: "BOT2" }
      ]);

    it("reads the active car's level when no policy is passed", () => {
      const viaCar = decideBotAction(ctx, duo("easy"));
      expect(viaCar.action).toEqual(decideBotAction(ctx, duo(undefined), "easy").action);
      expect(decideBotAction(ctx, duo(undefined)).action).toEqual(decideBotAction(ctx, duo(undefined), "normal").action);
    });

    it("lets an explicit policy override the car's level (the server's autopilot)", () => {
      const state = duo("hard");
      expect(decideBotAction(ctx, state, "autopilot").action).toEqual(
        decideBotAction(ctx, duo("normal"), "autopilot").action
      );
    });

    it("never mutates the race, also for the lookahead", () => {
      for (const level of ["easy", "normal", "hard"] as const) {
        const state = duo(level);
        const before = JSON.stringify(state);
        decideBotAction(ctx, state);
        expect(JSON.stringify(state)).toBe(before);
      }
    });

    it("always proposes an action the engine accepts", () => {
      for (const level of ["easy", "normal", "hard"] as const) {
        const state = createRace(ctx, Array.from({ length: 4 }, (_, i) => ({ isBot: true, ownerId: `B${i}`, botLevel: level })), 2);
        for (let i = 0; i < 40 && state.winnerCarId === null; i += 1) {
          expect(applyAction(ctx, state, decideBotAction(ctx, state).action).ok).toBe(true);
        }
      }
    });
  });

  describe("pit planning (Normal)", () => {
    // Long race, the car on the pit-entry feeder cell (lane 1, forwardIndex 26) and nearly empty.
    const setup = (laps: number, lapCount: number, cellId: string, tire = 5, fuel = 20) => {
      const state = newRace(laps, [
        { isBot: true, ownerId: "BOT1" },
        { isBot: false, ownerId: "P2" }
      ]);
      const car = getActiveCar(state);
      Object.assign(car, { cellId, lapCount, tire, fuel });
      return state;
    };
    const targetCell = (state: RaceState) => {
      const action = decideBotAction(ctx, state).action;
      if (action.type === "skip" || action.type === "setup") throw new Error("unexpected skip");
      return ctx.cellMap.get(action.targetCellId)!;
    };

    it("enters the pit lane when a stop is due and the entry is next", () => {
      const cell = targetCell(setup(12, 4, "Z27_L1_00"));
      expect(cell.tags).toContain("PIT_ENTRY");
    });

    it("does not stop in a race too short to repay it", () => {
      const cell = targetCell(setup(3, 1, "Z27_L1_00", 20, 20));
      expect(cell.laneIndex).not.toBe(0);
    });

    it("never enters the pit lane on the final lap", () => {
      const cell = targetCell(setup(12, 11, "Z27_L1_00", 0, 0));
      expect(cell.laneIndex).not.toBe(0);
    });

    it("drifts to lane 1 and lands exactly on the entry cell when a stop is due", () => {
      // Z20_L2 is 8 cells before the feeder; the lane change costs one budget point, 9 in all.
      const cell = targetCell(setup(12, 4, "Z20_L2_00"));
      expect(cell.id).toBe("Z27_L1_00");
    });
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

describe("decideBotAction autopilot policy", () => {
  const seats = Array.from({ length: 3 }, (_, i) => ({ isBot: true, ownerId: `BOT${i + 1}` }));

  it("never goes further than Normal, never pits, and is always accepted by the engine", () => {
    const state = createRace(ctx, seats, 2);
    for (let i = 0; i < 400 && state.winnerCarId === null; i += 1) {
      const normal = decideBotAction(ctx, state);
      const auto = decideBotAction(ctx, state, "autopilot");
      expect(auto.action.type).not.toBe("pit");
      if (auto.action.type === "move" && normal.action.type === "move") {
        const distance = (a: typeof auto) =>
          a.targets.get((a.action as { targetCellId: string }).targetCellId)!.distance;
        expect(distance(auto)).toBeLessThanOrEqual(distance(normal));
      }
      expect(decideBotAction(ctx, state, "autopilot").action).toEqual(auto.action);
      // alternate who plays so the autopilot also drives real positions
      expect(applyAction(ctx, state, (i % 2 === 0 ? auto : normal).action).ok).toBe(true);
    }
  });
});

describe("squeeze (boxed in)", () => {
  // Car 1 in the middle lane, blocker ahead in its lane and both neighbouring-lane cells ahead taken.
  function boxedRace() {
    const state = newRace(5, [
      { isBot: true, ownerId: "B1" },
      { isBot: true, ownerId: "B2" },
      { isBot: true, ownerId: "B3" },
      { isBot: true, ownerId: "B4" }
    ]);
    ["Z05_L2_00", "Z06_L2_00", "Z06_L1_00", "Z06_L3_00"].forEach((id, i) => {
      state.cars[i]!.cellId = id;
    });
    return state;
  }

  it("offers squeeze targets instead of an empty map and rejects a skip", () => {
    const state = boxedRace();
    const targets = computeTargets(ctx, state, getActiveCar(state));
    expect(targets.size).toBeGreaterThan(0);
    for (const info of targets.values()) expect(info.squeezePassed).toBeGreaterThanOrEqual(1);
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "moves_available" });
  });

  it("accepts a skip when not even a squeeze fits the budget", () => {
    const state = boxedRace();
    getActiveCar(state).moveCycle.spent = [39, 0, 0, 0, 0];
    getActiveCar(state).moveCycle.index = 1;
    expect(computeTargets(ctx, state, getActiveCar(state)).size).toBe(0);
    expect(applyAction(ctx, state, { type: "skip" }).ok).toBe(true);
  });

  it("applies a squeeze move with the surcharged spend and advances the turn", () => {
    const state = boxedRace();
    const car = getActiveCar(state);
    const result = applyAction(ctx, state, { type: "move", targetCellId: "Z07_L2_00" });
    expect(result).toMatchObject({ ok: true, moveSpend: 4 });
    expect(car.cellId).toBe("Z07_L2_00");
    expect(car.moveCycle.spent[0]).toBe(4);
    expect(getActiveCar(state).carId).toBe(2);
  });

  it.each(["easy", "normal", "hard", "autopilot"] as const)("%s bot squeezes instead of skipping", (level) => {
    const state = boxedRace();
    const decision = decideBotAction(ctx, state, level);
    expect(decision.action.type).toBe("move");
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
  });
});

describe("squeeze out of a blocked pit exit", () => {
  function exitRace(exitSkip = false) {
    const state = newRace(5, [
      { isBot: true, ownerId: "B1" },
      { isBot: true, ownerId: "B2" }
    ]);
    const car = state.cars[0]!;
    car.cellId = "Z06_L0_00";
    car.pitServiced = true;
    car.pitExitBoost = exitSkip;
    state.cars[1]!.cellId = "Z07_L1_00";
    return { state, car };
  }

  it("rejects a skip while a squeeze exists, accepts it when the budget is too small", () => {
    const { state, car } = exitRace();
    expect([...computeTargets(ctx, state, car).keys()].sort()).toEqual(["Z08_L1_00", "Z09_L1_00"]);
    expect(applyAction(ctx, state, { type: "skip" })).toEqual({ ok: false, reason: "moves_available" });
    car.moveCycle.spent = [37, 0, 0, 0, 0];
    car.moveCycle.index = 1;
    expect(computeTargets(ctx, state, car).size).toBe(0);
    expect(applyAction(ctx, state, { type: "skip" }).ok).toBe(true);
  });

  it("applies the squeeze: leaves the pit lane on lane 1, surcharged spend, pit state reset, no lap", () => {
    const { state, car } = exitRace(true);
    car.lapCount = 0;
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z08_L1_00" })).toMatchObject({ ok: true, moveSpend: 4 });
    expect(car).toMatchObject({ cellId: "Z08_L1_00", pitServiced: false, pitExitBoost: false, lapCount: 0 });
    expect(car.moveCycle.spent[0]).toBe(4);
  });

  it("gives a serviced car no pit-box targets and keeps the normal exit when free", () => {
    const { state, car } = exitRace(true);
    state.cars[1]!.cellId = "Z10_L1_00";
    expect([...computeTargets(ctx, state, car).keys()]).toEqual(["Z07_L1_00"]);
    car.cellId = "Z05_L0_00";
    expect([...computeTargets(ctx, state, car).keys()]).toEqual(["Z06_L0_00"]);
  });

  it.each(["easy", "normal", "hard", "autopilot"] as const)("%s bot squeezes out instead of skipping", (level) => {
    const { state } = exitRace();
    const decision = decideBotAction(ctx, state, level);
    expect(decision.action.type).toBe("move");
    expect(applyAction(ctx, state, decision.action).ok).toBe(true);
  });
});

describe("grid setup and the wing", () => {
  const fresh = () => newRace(5, [{ isBot: false, ownerId: "P1" }, { isBot: false, ownerId: "P2" }]);
  const lowSoft: CarSetup = { compound: "soft", psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: "low" };

  it("changes the car's setup for free and leaves the turn with the same car", () => {
    const state = fresh();
    const result = applyAction(ctx, state, { type: "setup", setup: lowSoft });
    expect(result).toMatchObject({ ok: true, carId: 1, moveSpend: 0 });
    expect(getActiveCar(state)).toMatchObject({ carId: 1, setup: lowSoft });
    expect(getActiveCar(state).moveCycle.index).toBe(0);
  });

  it("can be changed again until the car has played a turn", () => {
    const state = fresh();
    expect(applyAction(ctx, state, { type: "setup", setup: lowSoft }).ok).toBe(true);
    expect(applyAction(ctx, state, { type: "setup", setup: { ...lowSoft, wing: "high" } }).ok).toBe(true);
    expect(getActiveCar(state).setup.wing).toBe("high");
  });

  it("is refused after the car's first move, and for another car's later turn", () => {
    const state = fresh();
    expect(applyAction(ctx, state, { type: "move", targetCellId: firstTarget(state) }).ok).toBe(true);
    expect(getActiveCar(state).carId).toBe(2);
    // car 2 has not moved yet: it can still set up
    expect(applyAction(ctx, state, { type: "setup", setup: lowSoft }).ok).toBe(true);
    expect(applyAction(ctx, state, { type: "move", targetCellId: firstTarget(state) }).ok).toBe(true);
    // back to car 1, which has moved
    expect(applyAction(ctx, state, { type: "setup", setup: lowSoft })).toEqual({ ok: false, reason: "setup_locked" });
    expect(getActiveCar(state).setup.wing).toBe("medium");
  });

  it("rejects an invalid setup and leaves the car untouched", () => {
    const state = fresh();
    const bad = { ...lowSoft, wing: "huge" as never };
    expect(applyAction(ctx, state, { type: "setup", setup: bad })).toEqual({ ok: false, reason: "invalid_setup" });
    expect(getActiveCar(state).setup.wing).toBe("medium");
  });

  it("sets the cycle budget: Low wing +1, High wing -1, soft +1", () => {
    const budget = (setup: CarSetup) => {
      const state = fresh();
      expect(applyAction(ctx, state, { type: "setup", setup }).ok).toBe(true);
      // The 9 cells a move covers at most, so read the budget through the move cap of a fresh cycle.
      const car = getActiveCar(state);
      car.moveCycle.spent = [8, 8, 8, 8, 0];
      car.moveCycle.index = 4;
      return Math.max(...[...computeTargets(ctx, state, car).values()].map((t) => t.moveSpend ?? t.distance));
    };
    const plain = { ...SETUP, psi: lowSoft.psi };
    // 32 of 40 spent leaves 8; with Low wing 9 (41), with soft + Low 10 (capped at 9 a move), with High 7 (39)
    expect(budget(plain)).toBe(8);
    expect(budget({ ...plain, wing: "low" })).toBe(9);
    expect(budget({ ...plain, wing: "high" })).toBe(7);
    expect(budget({ ...plain, compound: "soft" })).toBe(9);
    expect(budget({ ...plain, compound: "soft", wing: "high" })).toBe(8);
  });

  it("gives every non-Easy bot a setup for the distance on the grid, and Easy keeps the default", () => {
    const state = createRace(
      ctx,
      [
        { isBot: true, ownerId: "B1", botLevel: "normal" },
        { isBot: true, ownerId: "B2", botLevel: "easy" },
        { isBot: false, ownerId: "P3" }
      ],
      3
    );
    expect(state.cars[0]!.setup).toMatchObject({ compound: "soft", wing: "low" });
    expect(state.cars[1]!.setup).toMatchObject({ compound: "hard", wing: "medium" });
    expect(state.cars[2]!.setup).toMatchObject({ compound: "hard", wing: "medium" });
  });
});

describe("drafting turns and the slingshot", () => {
  const humans = (): RaceState =>
    newRace(5, [
      { isBot: false, ownerId: "P1" },
      { isBot: false, ownerId: "P2" },
      { isBot: false, ownerId: "P3" }
    ]);
  // Car 1 in lane 1 at Z05, car 2 three cells ahead of it in the same lane (a move to Z06 or Z07 ends tucked in behind
  // it); car 3 out of the way. Car 1 plays first.
  const draftRace = (): RaceState => {
    const state = humans();
    const [c1, c2, c3] = state.cars as [Car, Car, Car];
    Object.assign(c1, { cellId: "Z05_L1_00", lapCount: 0 });
    Object.assign(c2, { cellId: "Z08_L1_00", lapCount: 0 });
    Object.assign(c3, { cellId: "Z20_L3_00", lapCount: 0 });
    return state;
  };
  // Hands the turn back to car 1 with the other cars where the test wants them.
  const backToCar1 = (state: RaceState, car2At: string) => {
    const [, c2, c3] = state.cars as [Car, Car, Car];
    for (const car of [c2, c3]) expect(applyAction(ctx, state, { type: "move", targetCellId: firstTargetFor(state, car) }).ok).toBe(true);
    c2.cellId = car2At;
    c3.cellId = "Z20_L3_00";
    expect(getActiveCar(state).carId).toBe(1);
  };
  const firstTargetFor = (state: RaceState, car: Car): string => {
    expect(getActiveCar(state).carId).toBe(car.carId);
    return firstTarget(state);
  };

  it("a move that ends 1-2 cells behind a car is in its tow for the next move, whatever the leader does", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    // nothing to tow behind yet: the plain price of the longest same-lane move
    const plain = [...computeTargets(ctx, state, car1).values()].find((t) => t.distance === 9)!;
    expect(plain.drafted).toBeUndefined();

    // the move ends 2 cells behind car 2: the run is 1
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z06_L1_00" }).ok).toBe(true);
    expect(car1.draftTurns).toBe(1);

    // car 2 has run away (that is what a leader does between two turns): the tow is still there
    backToCar1(state, "Z20_L1_00");
    const targets = [...computeTargets(ctx, state, car1).values()].filter((t) => !t.isPitTrigger);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t.drafted).toBe(true);
    const towed = targets.find((t) => t.distance === 9)!;
    expect(towed.fuelCost).toBeLessThan(plain.fuelCost);
  });

  it("two moves in a row that end tucked in open the slingshot: a lane change without its surcharge", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z06_L1_00" }).ok).toBe(true); // 2 behind car 2
    expect(car1.draftTurns).toBe(1);

    backToCar1(state, "Z09_L1_00");
    expect(computeTargets(ctx, state, car1).get("Z09_L2_00")?.slingshot).toBeUndefined(); // not ready yet
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z07_L1_00" }).ok).toBe(true); // 2 behind again
    expect(car1.draftTurns).toBe(2);

    backToCar1(state, "Z20_L1_00"); // the leader is gone
    const offered = [...computeTargets(ctx, state, car1).values()];
    const slingshots = offered.filter((t) => t.slingshot);
    expect(slingshots.length).toBeGreaterThan(0);
    // a lane change that cost its cells plus 1 now costs the cells
    for (const t of slingshots) expect(t).toMatchObject({ drafted: true, moveSpend: t.distance });
    // a same-lane move has no surcharge to waive
    expect(computeTargets(ctx, state, car1).get("Z08_L1_00")?.slingshot).toBeUndefined();
  });

  it("a move that ends out of the tow breaks the run", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z06_L1_00" }).ok).toBe(true);
    expect(car1.draftTurns).toBe(1);

    backToCar1(state, "Z20_L1_00");
    // Z12 is nowhere near a car in its lane: it ends untucked
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z12_L1_00" }).ok).toBe(true);
    expect(car1.draftTurns).toBe(0);
  });

  it("a car ends tucked in behind a car that was already there, in its own lane only", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    // Z06_L2 is beside nothing and two cells ahead of car 2's lane neighbour: a different lane does not tow
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z06_L2_00" }).ok).toBe(true);
    expect(car1.draftTurns).toBe(0);
  });

  it("a setup is not a turn: it leaves the counter alone", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    car1.draftTurns = 1;
    expect(applyAction(ctx, state, { type: "setup", setup: { ...car1.setup, wing: "low" } }).ok).toBe(true);
    expect(car1.draftTurns).toBe(1);
  });

  it("charges the discounted wear and the slingshot price when the move is played", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    car1.draftTurns = 2;
    const tire = car1.tire;
    const fuel = car1.fuel;
    const info = computeTargets(ctx, state, car1).get("Z08_L2_00")!;
    expect(info.slingshot).toBe(true);
    const result = applyAction(ctx, state, { type: "move", targetCellId: "Z08_L2_00" });
    expect(result).toMatchObject({ ok: true, moveSpend: info.moveSpend });
    expect(tire - car1.tire).toBe(info.tireCost);
    expect(fuel - car1.fuel).toBe(info.fuelCost);
    expect(car1.moveCycle.spent[0]).toBe(3);
    // counted and logged
    expect(car1.slingshots).toBe(1);
    expect(result.ok && result.log).toContain("Car 1 slingshots.");
  });

  it("a drafted move that is not a slingshot is neither counted nor logged as one", () => {
    const state = draftRace();
    const car1 = state.cars[0]!;
    car1.draftTurns = 2;
    const result = applyAction(ctx, state, { type: "move", targetCellId: "Z06_L1_00" });
    expect(result.ok).toBe(true);
    expect(car1.slingshots ?? 0).toBe(0);
    expect(result.ok && result.log.some((line) => line.includes("slingshot"))).toBe(false);
  });
});
