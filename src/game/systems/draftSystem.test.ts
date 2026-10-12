import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../types/track";
import { draftAhead } from "./draftSystem";
import { buildTrackIndex } from "./trackIndex";

const index = buildTrackIndex(track as unknown as TrackData);
const at = (from: string, ...others: string[]) => draftAhead(index, from, [from, ...others]);

describe("draftAhead", () => {
  it("drafts a car 1 or 2 cells ahead in the same lane, reporting the gap", () => {
    expect(at("Z05_L1_00", "Z06_L1_00")).toEqual({ cellId: "Z06_L1_00", gap: 1 });
    expect(at("Z05_L2_00", "Z07_L2_00")).toEqual({ cellId: "Z07_L2_00", gap: 2 });
    // forwardIndex decides, not the zone: on a bend the outer lanes share one (Z06_L3 and Z07_L3 are both 5)
    expect(at("Z05_L3_00", "Z07_L3_00")).toEqual({ cellId: "Z07_L3_00", gap: 1 });
  });

  it("does not draft a car 3 or more cells ahead", () => {
    expect(at("Z05_L1_00", "Z08_L1_00")).toBeNull();
  });

  it("does not draft a car in an adjacent lane, beside it, or behind it", () => {
    expect(at("Z05_L1_00", "Z06_L2_00")).toBeNull();
    expect(at("Z05_L1_00", "Z05_L2_00")).toBeNull();
    expect(at("Z05_L1_00", "Z04_L1_00")).toBeNull();
  });

  it("drafts the nearest of two cars ahead", () => {
    expect(at("Z05_L1_00", "Z07_L1_00", "Z06_L1_00")).toEqual({ cellId: "Z06_L1_00", gap: 1 });
  });

  it("wraps across the start line", () => {
    expect(at("Z28_L1_00", "Z01_L1_00")).toEqual({ cellId: "Z01_L1_00", gap: 1 });
    expect(at("Z27_L1_00", "Z01_L1_00")).toEqual({ cellId: "Z01_L1_00", gap: 2 });
  });

  it("never drafts in the pit lane", () => {
    expect(at("Z02_L0_00", "Z03_L0_00")).toBeNull();
    expect(at("Z01_L1_00", "Z02_L0_00")).toBeNull();
  });

  it("ignores the cell the car itself stands on", () => {
    expect(draftAhead(index, "Z05_L1_00", ["Z05_L1_00"])).toBeNull();
  });
});
