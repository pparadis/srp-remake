import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import { hashText } from "./lock";
import { contextOf, offeredFrom, positionOf, targetOf } from "./scenario";
import type { TrackData } from "../../src/game/types/track";

const ctx = contextOf(track as TrackData);

describe("positionOf", () => {
  it("puts car 1 on the start cell to play, and the others where named, even on a spawn cell", () => {
    const spawn = ctx.track.cells.find((c) => c.zoneIndex === 1 && c.laneIndex === 1)!.id;
    const p = positionOf(ctx, { start: "Z12_L1_00", cars: ["Z13_L1_00", spawn] });
    expect(p.state.cars.map((c) => c.cellId)).toEqual(["Z12_L1_00", "Z13_L1_00", spawn]);
    expect(p.state.turn.order[p.state.turn.index]).toBe(1);
  });
  it("applies an edit to car 1 (the draft run here)", () => {
    expect(positionOf(ctx, { start: "Z12_L1_00", cars: [], edit: { draftTurns: 2 } }).car.draftTurns).toBe(2);
  });
  it("refuses a cell that is not on the track", () => {
    expect(() => positionOf(ctx, { start: "nowhere", cars: [] })).toThrow("No cell");
  });
});

describe("offeredFrom / targetOf", () => {
  const p = positionOf(ctx, { start: "Z12_L1_00", cars: ["Z13_L1_00"] });
  it("reads the engine's targets: a free cell ahead is offered, the car's own cell and a car's cell are not", () => {
    const offered = offeredFrom(p);
    expect(offered.has("Z14_L2_00")).toBe(true);
    expect(offered.has("Z12_L1_00")).toBe(false);
    expect(offered.has("Z13_L1_00")).toBe(false);
  });
  it("throws on a target that is not offered", () => {
    expect(() => targetOf(p, { start: "Z12_L1_00", target: "Z13_L1_00" })).toThrow("not a target");
  });
});

describe("hashText", () => {
  it("is stable and tells texts apart", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
});
