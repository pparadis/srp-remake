import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import lock from "../../docs/img/diagrams.lock.json";
import { createRaceContext } from "../../src/game/race/raceEngine";
import type { TrackData } from "../../src/game/types/track";
import { BLOCKER_PANELS } from "./blockers";
import { RUN_LANE_CHANGE, RUN_SAME_LANE, RUN_STAGES, runTargets, towGap } from "./drafting";
import { allDiagrams } from "./index";
import { LAP_PANELS, lapsOf } from "./laps";
import { LANE_CHANGE_SCENARIO, laneChangePriceSvg, priceScenario } from "./laneChangePrice";
import { hashText } from "./lock";
import { PASS_AND_RETURN_SCENARIO } from "./passAndReturn";
import { PIT_ENTRY_PANELS, PIT_LANE_PANELS } from "./pitLane";
import { offeredFrom, positionOf, targetOf } from "./scenario";
import { PIT_EXIT_CASES, SQUEEZE_SPEC, squeezeParts } from "./squeeze";
import type { StripSpec } from "./strip";

type Offers = ReturnType<typeof offeredFrom>;

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
  const [twoCars, oneCar, wall] = BLOCKER_PANELS.map((p) => offeredFrom(positionOf(ctx, p))) as [Offers, Offers, Offers];
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

describe("squeeze diagrams show the Squeeze rules", () => {
  it("boxed in: only squeeze targets, +2 per car passed, the lane change on top", () => {
    const offered = offeredFrom(positionOf(ctx, SQUEEZE_SPEC));
    expect(offered.size).toBeGreaterThan(0);
    for (const t of offered.values()) expect(t.squeezePassed).toBeGreaterThanOrEqual(1);
    expect(offered.get("Z07_L1_00")).toMatchObject({ distance: 2, moveSpend: 4, squeezePassed: 1 });
    expect(offered.get("Z07_L2_00")).toMatchObject({ distance: 2, moveSpend: 7, squeezePassed: 2 });
    expect(squeezeParts(offered.get("Z07_L2_00")!)).toEqual({ cells: 2, laneChange: 1, passed: 2, cars: 4 });
  });
  it("pit exit: along lane 1, at most 3 cells, +2 per car, no lane-change charge", () => {
    const [one, two] = PIT_EXIT_CASES.map((c) => offeredFrom(positionOf(ctx, c.spec))) as [Offers, Offers];
    expect(one.get("Z08_L1_00")).toMatchObject({ distance: 2, moveSpend: 4, squeezePassed: 1 });
    expect(one.get("Z09_L1_00")).toMatchObject({ distance: 3, moveSpend: 5, squeezePassed: 1 });
    expect(one.has("Z10_L1_00")).toBe(false);
    expect(two.get("Z09_L1_00")).toMatchObject({ distance: 3, moveSpend: 7, squeezePassed: 2 });
    expect(squeezeParts(two.get("Z09_L1_00")!).laneChange).toBe(0);
  });
  it("rejects a squeeze price that is less than its parts", () => {
    expect(() => squeezeParts({ distance: 3, moveSpend: 4, tireCost: 0, fuelCost: 0, isPitTrigger: false, squeezePassed: 2 })).toThrow();
    expect(() => squeezeParts({ distance: 3, tireCost: 0, fuelCost: 0, isPitTrigger: false })).toThrow("not a squeeze");
  });
});

describe("pit diagrams show the Pit rules", () => {
  const offers = (panels: StripSpec[]) => panels.map((p) => offeredFrom(positionOf(ctx, p)));
  it("entry: only from lane 1, only at distance 1", () => {
    const [fromLane1, fromLane2, fromFar] = offers(PIT_ENTRY_PANELS);
    expect(fromLane1!.has("Z28_L0_00")).toBe(true);
    expect(fromLane2!.has("Z28_L0_00")).toBe(false);
    expect(fromFar!.has("Z28_L0_00")).toBe(false);
    for (const o of [fromLane1!, fromLane2!, fromFar!]) expect(o.has("Z01_L0_00")).toBe(false);
  });
  it("in the pit lane: one step, any box ahead from next to a box, the exit onto lane 1", () => {
    const [step, boxes, exit] = offers(PIT_LANE_PANELS);
    expect([...step!.keys()].filter((id) => id.includes("_L0_"))).toEqual(["Z01_L0_00"]);
    expect([...boxes!.keys()].sort()).toEqual(["Z02_L0_00", "Z03_L0_00"]);
    expect([...exit!.keys()]).toEqual(["Z07_L1_00"]);
  });
});

describe("laps diagram shows the Laps rules", () => {
  const laps = LAP_PANELS.map((p) => lapsOf(ctx, p));
  it("the line spans every lane: a main-lane crossing and the pit lane's PIT_LINE each credit one lap", () => {
    expect(laps[0]).toEqual([0, 1]); // lane 1
    expect(laps[1]).toEqual([0, 1]); // lane 2, whose zones wrap later
    expect(laps[3]).toEqual([0, 1]); // PIT_LINE
  });
  it("a car dealt behind the line begins at -1 and its first crossing only reaches 0", () => {
    expect(laps[2]).toEqual([-1, 0]);
  });
  it("a whole stop credits one lap: the entry does not, the line does, the box does not; the exit never does", () => {
    expect(laps[4]).toEqual([0, 0, 1, 1]);
    expect(laps[5]).toEqual([1, 1]);
  });
});

describe("drafting diagram shows the Drafting rules", () => {
  it("tucked in is 1-2 cells behind a car in the same lane, not further, not ahead, not in the next lane", () => {
    expect(towGap(ctx, "Z07_L2_00")).toBe(1);
    expect(towGap(ctx, "Z06_L2_00")).toBe(2);
    expect(towGap(ctx, "Z05_L2_00")).toBeNull();
    expect(towGap(ctx, "Z09_L2_00")).toBeNull();
    for (const id of ["Z07_L1_00", "Z07_L3_00", "Z06_L1_00", "Z06_L3_00"]) expect(towGap(ctx, id)).toBeNull();
  });
  it("run 1 wears less; run 2 also waives the lane-change surcharge", () => {
    const [r0, r1, r2] = RUN_STAGES.map((s) => runTargets(ctx, s.run));
    expect(r0!.get(RUN_SAME_LANE)!.drafted).toBeUndefined();
    expect(r1!.get(RUN_SAME_LANE)).toMatchObject({ drafted: true });
    expect(r1!.get(RUN_SAME_LANE)!.fuelCost).toBeLessThan(r0!.get(RUN_SAME_LANE)!.fuelCost);
    expect(r1!.get(RUN_LANE_CHANGE)!.slingshot).toBeUndefined();
    expect(r1!.get(RUN_LANE_CHANGE)!.moveSpend).toBe(r0!.get(RUN_LANE_CHANGE)!.moveSpend);
    expect(r2!.get(RUN_LANE_CHANGE)).toMatchObject({ slingshot: true });
    expect(r2!.get(RUN_LANE_CHANGE)!.moveSpend).toBe(r2!.get(RUN_LANE_CHANGE)!.distance);
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
