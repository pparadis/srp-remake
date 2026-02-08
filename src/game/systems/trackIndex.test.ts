import { describe, expect, it } from "vitest";
import type { TrackCell, TrackData } from "../types/track";
import { buildTrackIndex } from "./trackIndex";

function makeCell(
  id: string,
  laneIndex: number,
  zoneIndex: number,
  forwardIndex: number,
  tags: TrackCell["tags"] = []
): TrackCell {
  return {
    id,
    zoneIndex,
    laneIndex,
    forwardIndex,
    pos: { x: zoneIndex, y: laneIndex },
    next: [],
    tags
  };
}

describe("buildTrackIndex", () => {
  it("uses lane 1 cell count for spine length when present", () => {
    const track: TrackData = {
      trackId: "spine-present",
      zones: 3,
      lanes: 4,
      cells: [
        makeCell("L1_A", 1, 1, 0),
        makeCell("L1_B", 1, 2, 1),
        makeCell("L2_A", 2, 1, 0)
      ]
    };

    const index = buildTrackIndex(track);
    expect(index.spineLen).toBe(2);
    expect(index.cellMap.get("L1_A")?.id).toBe("L1_A");
    expect(index.cellMap.get("L2_A")?.id).toBe("L2_A");
  });

  it("falls back to forwardIndex range when lane 1 is missing", () => {
    const track: TrackData = {
      trackId: "spine-missing",
      zones: 3,
      lanes: 4,
      cells: [
        makeCell("L2_A", 2, 1, 0),
        makeCell("L2_B", 2, 2, 3),
        makeCell("L3_A", 3, 1, 2)
      ]
    };

    const index = buildTrackIndex(track);
    expect(index.spineLen).toBe(4);
  });

  it("builds pit lane zone map and tracks max pit box zone on pit lane only", () => {
    const track: TrackData = {
      trackId: "pit-metadata",
      zones: 5,
      lanes: 4,
      cells: [
        makeCell("P1", 0, 1, 0),
        makeCell("P2", 0, 2, 1, ["PIT_BOX"]),
        makeCell("P3", 0, 4, 3, ["PIT_BOX"]),
        makeCell("R1", 1, 3, 2, ["PIT_BOX"])
      ]
    };

    const index = buildTrackIndex(track);
    expect(index.pitLaneByZone.get(1)).toBe("P1");
    expect(index.pitLaneByZone.get(2)).toBe("P2");
    expect(index.pitLaneByZone.get(4)).toBe("P3");
    expect(index.pitLaneByZone.has(3)).toBe(false);
    expect(index.pitBoxMaxZone).toBe(4);
  });

  it("returns null pitBoxMaxZone when no pit boxes exist on pit lane", () => {
    const track: TrackData = {
      trackId: "no-pit-box",
      zones: 2,
      lanes: 4,
      cells: [makeCell("P1", 0, 1, 0), makeCell("R1", 1, 1, 0, ["PIT_BOX"])]
    };

    const index = buildTrackIndex(track);
    expect(index.pitBoxMaxZone).toBeNull();
  });
});
