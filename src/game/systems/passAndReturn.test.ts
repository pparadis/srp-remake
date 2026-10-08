import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { applyAction, computeTargets, createRace, createRaceContext, decideBotAction, getActiveCar } from "../race/raceEngine";
import type { TrackData } from "../types/track";
import { computeValidTargets, type TargetInfo } from "./movementSystem";
import { buildTrackIndex } from "./trackIndex";

const trackIndex = buildTrackIndex(track as unknown as TrackData);
const ctx = createRaceContext(track as unknown as TrackData);
const costs = {
  tireRate: 0.5,
  fuelRate: 0.45,
  setup: { compound: "soft" as const, psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 }
};
const targetsFrom = (start: string, occupied: string[] = [], maxSteps = 9) =>
  computeValidTargets(trackIndex, start, new Set(occupied), maxSteps, {}, costs);
const cell = (id: string) => trackIndex.cellMap.get(id)!;
const delta = (from: string, to: string) =>
  (cell(to).forwardIndex - cell(from).forwardIndex + trackIndex.spineLen) % trackIndex.spineLen;

// The position from the bug report: the player on Z20_L1_00 (inner lane), car 11 on Z23_L1_00, three cells ahead.
const START = "Z20_L1_00";
const BLOCKER = "Z23_L1_00";

describe("pass and return: go around a blocker and rejoin your lane", () => {
  it("offers lane-1 cells beyond the blocker, which used to be unreachable in one move", () => {
    const targets = targetsFrom(START, [BLOCKER]);
    // before the blocker: as before
    for (const id of ["Z21_L1_00", "Z22_L1_00"]) expect(targets.has(id)).toBe(true);
    // beyond it: now offered, priced forward cells + one point per lane change (out and back = +2)
    for (const id of ["Z24_L1_00", "Z25_L1_00", "Z26_L1_00", "Z27_L1_00"]) {
      const info = targets.get(id)!;
      expect(info, id).toBeDefined();
      expect(info.laneChanges).toBe(2);
      expect(info.moveSpend).toBe(delta(START, id) + 2);
    }
  });

  it("changes nothing when there is no blocker in your lane", () => {
    const free = targetsFrom(START);
    expect(free.size).toBeGreaterThan(0);
    for (const info of free.values()) expect(info.laneChanges).toBeUndefined();
    // a car in the next lane is no blocker for a lane-1 move
    const withNeighbour = targetsFrom(START, ["Z23_L2_00"]);
    expect(withNeighbour.get("Z24_L1_00")?.moveSpend).toBe(free.get("Z24_L1_00")?.moveSpend);
  });

  it("is still capped by the move points: a go-around that costs more than 9 is not offered", () => {
    const targets = targetsFrom(START, [BLOCKER]);
    expect(targets.has("Z28_L1_00")).toBe(false); // forward 8 + 2 = 10
    for (const info of targets.values()) expect(info.moveSpend).toBeLessThanOrEqual(9);
    // with fewer points left the reach shrinks with the price: forward 4 + 2 = 6
    expect(targetsFrom(START, [BLOCKER], 5).has("Z24_L1_00")).toBe(false);
    expect(targetsFrom(START, [BLOCKER], 6).has("Z24_L1_00")).toBe(true);
  });

  it("passes at most one blocker: not the next car in the same lane", () => {
    const targets = targetsFrom(START, [BLOCKER, "Z25_L1_00"]);
    expect(targets.has("Z24_L1_00")).toBe(true);
    for (const id of ["Z26_L1_00", "Z27_L1_00"]) expect(targets.has(id), id).toBe(false);
  });

  it("needs a free adjacent lane to go around through", () => {
    // lane 2 is blocked alongside the blocker: no way round
    const blocked = targetsFrom(START, [BLOCKER, "Z24_L2_00", "Z25_L2_00"]);
    expect(blocked.has("Z24_L1_00")).toBe(false);
    expect([...blocked.keys()].filter((id) => cell(id).laneIndex === 1 && delta(START, id) > 3)).toEqual([]);
  });

  it("may pass one car in the lane it goes round through, like a merge, but not two", () => {
    // a car in lane 2 behind the blocker (Z23_L2 is one cell ahead of the start): merge past it into lane 2, then
    // back into lane 1 in front of the blocker
    expect(targetsFrom(START, [BLOCKER, "Z23_L2_00"]).get("Z24_L1_00")?.laneChanges).toBe(2);
    // two cars in lane 2 behind the blocker (Z24_L2 stays free, so only the rule stops it): going round passes both
    expect(targetsFrom(START, [BLOCKER, "Z22_L2_00", "Z23_L2_00"]).has("Z24_L1_00")).toBe(false);
  });

  it("goes round a blocker with a car alongside in the other lane (position reported from the sandbox)", () => {
    // car 3 on Z14_L1, car 2 on Z17_L1 ahead in its lane, car 1 on Z17_L2 alongside: one car to pass in lane 2
    const targets = targetsFrom("Z14_L1_00", ["Z17_L1_00", "Z17_L2_00", "Z01_L2_00"]);
    for (const [id, spend] of [["Z18_L1_00", 6], ["Z19_L1_00", 7], ["Z20_L1_00", 8], ["Z21_L1_00", 9]] as const) {
      expect(targets.get(id), id).toMatchObject({ moveSpend: spend, laneChanges: 2 });
    }
  });

  it("never lands on a car or in the pit lane, and every route is within the target budget", () => {
    const occupied = [BLOCKER, "Z24_L2_00", "Z26_L1_00"];
    for (const [id, info] of targetsFrom(START, occupied)) {
      expect(occupied).not.toContain(id);
      expect(cell(id).laneIndex).not.toBe(0);
      expect(info.moveSpend ?? 0).toBeLessThanOrEqual(9);
    }
  });
});

describe("price of a lane change", () => {
  it("keeps ordinary single lane changes at today's price", () => {
    // values the engine charged before pass-and-return (checked against it on simulated races)
    expect(targetsFrom("Z01_L1_00").get("Z02_L2_00")?.moveSpend).toBe(2);
    expect(targetsFrom("Z10_L1_00").get("Z12_L2_00")?.moveSpend).toBe(2);
    expect(targetsFrom("Z10_L1_00").get("Z13_L2_00")?.moveSpend).toBe(3);
    expect(targetsFrom("Z10_L1_00").get("Z12_L1_00")?.moveSpend).toBe(2);
  });

  it("charges every extra lane change: out and back costs +2", () => {
    const targets = targetsFrom(START, [BLOCKER]);
    const straight = targetsFrom(START).get("Z25_L1_00")!;
    expect(targets.get("Z25_L1_00")!.moveSpend).toBe(straight.moveSpend! + 2);
  });

  it("charges tire and fuel on the cells walked, not on the lane-change points", () => {
    const info = targetsFrom(START, [BLOCKER]).get("Z24_L1_00")!;
    const plain = targetsFrom(START).get("Z24_L1_00")!;
    expect(info.distance).toBeGreaterThanOrEqual(plain.distance);
    expect(info.moveSpend).toBeGreaterThan(info.distance - 1);
    expect(info.tireCost).toBeLessThanOrEqual(plain.tireCost + 1);
  });
});

describe("pass and return through the engine", () => {
  function raceWithBlocker() {
    const state = createRace(ctx, [{ isBot: false, ownerId: "P1" }, { isBot: false, ownerId: "P2" }], 5);
    state.cars[0]!.cellId = START;
    state.cars[1]!.cellId = BLOCKER;
    return state;
  }

  it("applies the move: lands in lane 1 beyond the blocker, records the price, advances the turn", () => {
    const state = raceWithBlocker();
    const car = getActiveCar(state);
    const targets = computeTargets(ctx, state, car);
    const info = targets.get("Z25_L1_00")!;
    expect(info.laneChanges).toBe(2);
    const tire = car.tire;
    const result = applyAction(ctx, state, { type: "move", targetCellId: "Z25_L1_00" });
    expect(result).toMatchObject({ ok: true, carId: 1, fromCellId: START, moveSpend: info.moveSpend });
    expect(car.cellId).toBe("Z25_L1_00");
    expect(tire - car.tire).toBe(info.tireCost);
    expect(car.moveCycle.spent[0]).toBe(info.moveSpend);
    expect(getActiveCar(state).carId).toBe(2);
  });

  it("still rejects a same-lane move beyond the blocker when no route goes round", () => {
    const state = raceWithBlocker();
    state.cars.push({ ...state.cars[1]!, carId: 3, cellId: "Z23_L2_00" }, { ...state.cars[1]!, carId: 4, cellId: "Z24_L2_00" });
    expect(applyAction(ctx, state, { type: "move", targetCellId: "Z25_L1_00" })).toMatchObject({ ok: false });
  });
});

// Simulated races (the cars play with the Normal bot): the rules hold at every position that comes up.
describe("over simulated races", () => {
  it("prices every target at least forward cells + lane changes and caps it at the budget", () => {
    let positions = 0;
    let goArounds = 0;
    for (const cars of [4, 8]) {
      for (const seed of [1, 2]) {
        const state = createRace(
          ctx,
          Array.from({ length: cars }, (_, i) => ({ isBot: true, ownerId: `B${i}`, botLevel: "normal" as const })),
          3,
          seed
        );
        for (let turn = 0; turn < 90 && state.winnerCarId === null; turn += 1) {
          const car = getActiveCar(state);
          const from = cell(car.cellId);
          const targets: Map<string, TargetInfo> = computeTargets(ctx, state, car);
          positions += 1;
          const sameLaneBlockers = state.cars
            .map((c) => cell(c.cellId))
            .filter((c) => c.laneIndex === from.laneIndex && c.laneIndex !== 0 && c.id !== from.id)
            .map((c) => delta(from.id, c.id))
            .filter((d) => d > 0)
            .sort((a, b) => a - b);
          for (const [id, info] of targets) {
            const to = cell(id);
            if (info.squeezePassed || to.laneIndex === 0 || from.laneIndex === 0) continue;
            const changes = info.laneChanges ?? (to.laneIndex !== from.laneIndex ? 1 : 0);
            expect(info.moveSpend ?? 0).toBeGreaterThanOrEqual(delta(from.id, id) + changes);
            expect(info.moveSpend ?? 0).toBeLessThanOrEqual(9);
            // a same-lane target beyond the nearest same-lane car is only ever a go-around
            if (to.laneIndex === from.laneIndex && sameLaneBlockers[0] != null && delta(from.id, id) > sameLaneBlockers[0]) {
              goArounds += 1;
              expect(info.laneChanges).toBeGreaterThanOrEqual(2);
              if (sameLaneBlockers[1] != null) expect(delta(from.id, id)).toBeLessThanOrEqual(sameLaneBlockers[1]);
            }
          }
          const action = decideBotAction(ctx, state).action;
          expect(applyAction(ctx, state, action).ok).toBe(true);
        }
      }
    }
    expect(positions).toBeGreaterThan(200);
    expect(goArounds).toBeGreaterThan(0);
  });
});
