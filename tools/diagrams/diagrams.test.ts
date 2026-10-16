import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import lock from "../../docs/img/diagrams.lock.json";
import { createRaceContext } from "../../src/game/race/raceEngine";
import type { TrackData } from "../../src/game/types/track";
import { BLOCKER_PANELS, offersOf } from "./blockers";
import { allDiagrams } from "./index";
import { LANE_CHANGE_SCENARIO, laneChangePriceSvg, priceScenario } from "./laneChangePrice";
import { hashText } from "./lock";
import { PASS_AND_RETURN_SCENARIO } from "./passAndReturn";
import { positionOf, targetOf } from "./scenario";

type Offers = ReturnType<typeof offersOf>;

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const byName = <T>(files: Record<string, T>) => new Map(Object.entries(files).map(([path, v]) => [base(path), v]));
// What is committed: the SVGs (text), the PNGs (only their names matter) and the docs that must show them.
const svgs = byName(import.meta.glob<string>("../../docs/img/*.svg", { query: "?raw", import: "default", eager: true }));
const pngs = byName(import.meta.glob<string>("../../docs/img/*.png", { query: "?url", import: "default", eager: true }));
const docs = [...Object.values(import.meta.glob<string>("../../docs/*.md", { query: "?raw", import: "default", eager: true }))];

const ctx = createRaceContext(track as TrackData);
const generated = allDiagrams(track as TrackData);
const STALE = "run `npm run gen:diagrams`, look at the picture and commit it";

describe("diagrams are kept current", () => {
  it("every diagram has its committed SVG, and every committed SVG has a diagram", () => {
    expect([...svgs.keys()].sort()).toEqual([...generated.keys()].sort());
  });
  it.each([...generated])("%s is what the engine draws today", (name, svg) => {
    expect(svgs.get(name) === svg, `docs/img/${name} is stale: ${STALE}`).toBe(true);
  });
  it.each([...generated])("%s has a PNG rendered from this SVG", (name, svg) => {
    const png = name.replace(/\.svg$/, ".png");
    expect(pngs.has(png), `docs/img/${png} is missing: ${STALE}`).toBe(true);
    expect((lock as Record<string, string>)[png], `docs/img/${png} was rendered from another SVG: ${STALE}`).toBe(hashText(svg));
  });
  it("the lock lists no PNG that has no diagram", () => {
    expect(Object.keys(lock).sort()).toEqual([...generated.keys()].map((n) => n.replace(/\.svg$/, ".png")).sort());
  });
  it.each([...generated.keys()])("%s is shown in a doc", (name) => {
    expect(docs.some((d) => d.includes(`img/${name}`)), `no docs/*.md embeds img/${name}`).toBe(true);
  });
});

describe("blockers diagram shows the Occupancy rules", () => {
  const [twoCars, oneCar, wall] = BLOCKER_PANELS.map((p) => offersOf(ctx, p.scenario)) as [Offers, Offers, Offers];
  it("a lane change may pass one car in its lane, not the second", () => {
    expect(twoCars.has("Z15_L3_00")).toBe(true); // past the first, in front of the second
    expect(twoCars.has("Z17_L3_00")).toBe(false); // past the second
  });
  it("a lone car in the lane can be passed like the first of two", () => {
    for (const id of ["Z15_L3_00", "Z16_L3_00", "Z17_L3_00"]) expect(oneCar.has(id)).toBe(true);
  });
  it("a full row stops everything behind it", () => {
    expect(wall.has("Z13_L2_00")).toBe(true);
    for (const zone of [15, 16, 17]) for (const lane of [1, 2, 3]) expect(wall.has(`Z${zone}_L${lane}_00`)).toBe(false);
  });
});

describe("pass-and-return scenario", () => {
  const p = priceScenario(ctx, PASS_AND_RETURN_SCENARIO);
  const info = targetOf(positionOf(ctx, PASS_AND_RETURN_SCENARIO), PASS_AND_RETURN_SCENARIO);
  it("lands in the start lane beyond the car, round it through one adjacent lane", () => {
    const lanes = new Set(p.path.map((id) => ctx.cellMap.get(id)!.laneIndex));
    expect(lanes).toEqual(new Set([1, 2]));
    expect(p.path).not.toContain(PASS_AND_RETURN_SCENARIO.cars[0]);
    expect(ctx.cellMap.get(PASS_AND_RETURN_SCENARIO.target)!.laneIndex).toBe(1);
  });
  it("pays for out and back: two lane changes, and the rule and the engine agree", () => {
    expect(info.laneChanges).toBe(2);
    expect(p.rule).toBe(p.code);
    expect(p.code).toBe(p.forward + 2);
  });
});

describe("lane-change price scenario", () => {
  const p = priceScenario(ctx, LANE_CHANGE_SCENARIO);
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
    const svg = laneChangePriceSvg(ctx);
    expect(svg).toContain(p.rule === p.code ? "The rule and the code agree" : "The code charges");
    // a plain forward move: both prices are the cells walked
    const plain = laneChangePriceSvg(ctx, { start: "Z12_L1_00", cars: [], target: "Z14_L1_00", zones: [11, 16] });
    expect(plain).toContain("The rule and the code agree");
  });
  it("rejects a target the engine does not offer", () => {
    expect(() => priceScenario(ctx, { ...LANE_CHANGE_SCENARIO, target: "Z12_L1_00" })).toThrow();
  });
});
