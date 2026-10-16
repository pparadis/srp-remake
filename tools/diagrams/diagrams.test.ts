import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import laneChangePricing from "../../docs/img/lane-change-pricing.svg?raw";
import { buildTrackIndex } from "../../src/game/systems/trackIndex";
import type { TrackData } from "../../src/game/types/track";
import { allDiagrams } from "./index";
import { LANE_CHANGE_SCENARIO, laneChangePriceSvg, priceScenario } from "./laneChangePrice";

const trackIndex = buildTrackIndex(track as TrackData);
const committed = new Map([["lane-change-pricing.svg", laneChangePricing]]);

describe("diagrams", () => {
  it("are up to date with the engine (run `npm run gen:diagrams` and review the pictures)", () => {
    const generated = allDiagrams(track as TrackData);
    expect([...generated.keys()].sort()).toEqual([...committed.keys()].sort());
    for (const [name, svg] of generated) expect(svg === committed.get(name), `docs/img/${name} is stale: run npm run gen:diagrams`).toBe(true);
  });
});

describe("lane-change price scenario", () => {
  const p = priceScenario(trackIndex, LANE_CHANGE_SCENARIO);
  it("is a real route: starts on the start cell, ends on the target, avoids the cars", () => {
    expect(p.path[0]).toBe(LANE_CHANGE_SCENARIO.start);
    expect(p.path.at(-1)).toBe(LANE_CHANGE_SCENARIO.target);
    for (const car of LANE_CHANGE_SCENARIO.cars) expect(p.path).not.toContain(car);
  });
  it("prices the route as the engine does", () => {
    expect(p.code).toBeGreaterThanOrEqual(p.cellsWalked);
    expect(p.rule).toBe(p.forward + p.laneChanges);
  });
  it("shows one bar when the rule and the code agree, two when they differ", () => {
    const svg = laneChangePriceSvg(trackIndex);
    expect(svg).toContain(p.rule === p.code ? "The rule and the code agree" : "The code charges");
    // a plain forward move: both prices are the cells walked
    const plain = laneChangePriceSvg(trackIndex, { start: "Z12_L1_00", cars: [], target: "Z14_L1_00", zones: [11, 16] });
    expect(plain).toContain("The rule and the code agree");
  });
  it("rejects a target the engine does not offer", () => {
    expect(() => priceScenario(trackIndex, { ...LANE_CHANGE_SCENARIO, target: "Z12_L1_00" })).toThrow();
  });
});
