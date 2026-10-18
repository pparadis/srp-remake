import { describe, expect, it } from "vitest";
import realTrack from "../../../public/tracks/oval16_3lanes.json";
import type { TrackCell, TrackData } from "../types/track";
import { buildTrackIndex, cellsAlongLane, lapAhead, rankPosition } from "./trackIndex";

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

describe("lap position and cells along the lane (#114)", () => {
  const index = buildTrackIndex(realTrack as unknown as TrackData);
  const cell = (id: string) => index.cellMap.get(id)!;
  const lane = (l: number) =>
    realTrack.cells.filter((c) => c.laneIndex === l).sort((a, b) => a.zoneIndex - b.zoneIndex);

  it("reads 0 on the start line and never repeats within a lane", () => {
    for (const l of [1, 2, 3]) {
      const pos = lane(l).map((c) => index.lapPos.get(c.id)!);
      expect(pos[0]).toBe(0);
      for (let i = 1; i < pos.length; i += 1) expect(pos[i]!).toBeGreaterThan(pos[i - 1]!);
      expect(pos[pos.length - 1]!).toBeLessThan(index.spineLen);
    }
  });

  it("is level for side-by-side cells on the straights, and lane 1 is its forwardIndex", () => {
    for (const c of lane(1)) expect(index.lapPos.get(c.id)).toBe(c.forwardIndex);
    expect(index.lapPos.get("Z03_L3_00")).toBe(index.lapPos.get("Z03_L1_00"));
    expect(lapAhead(index, cell("Z07_L1_00"), cell("Z07_L3_00"))).toBe(0);
  });

  it("puts a lane-3 car one cell ahead of a lane-2 start where forwardIndex says level (#113)", () => {
    expect(cell("Z07_L3_00").forwardIndex).toBe(cell("Z06_L2_00").forwardIndex);
    expect(lapAhead(index, cell("Z06_L2_00"), cell("Z07_L3_00"))).toBe(1);
  });

  it("wraps across the start line", () => {
    expect(lapAhead(index, cell("Z28_L1_00"), cell("Z01_L1_00"))).toBe(1);
    expect(lapAhead(index, cell("Z01_L1_00"), cell("Z28_L1_00"))).toBe(27);
  });

  it("counts cells along a lane at that lane's own length", () => {
    expect(index.laneLength.get(3)).toBe(32);
    expect(cellsAlongLane(index, cell("Z12_L3_00"), cell("Z13_L3_00"))).toBe(1);
    expect(cellsAlongLane(index, cell("Z32_L3_00"), cell("Z01_L3_00"))).toBe(1);
    expect(cellsAlongLane(index, cell("Z30_L2_00"), cell("Z01_L2_00"))).toBe(1);
  });

  it("ranks a main-lane cell by its lap position and a pit cell by the lane-1 cell beside it", () => {
    expect(rankPosition(index, cell("Z12_L3_00"))).toBeLessThan(rankPosition(index, cell("Z13_L3_00"))); // forwardIndex: 10 and 10
    expect(rankPosition(index, cell("Z05_L1_00"))).toBe(4); // lane 1 is its forwardIndex
    expect(rankPosition(index, cell("Z28_L0_00"))).toBe(27);
    expect(rankPosition(index, cell("Z01_L0_00"))).toBe(0);
    expect(rankPosition(index, cell("Z02_L0_00"))).toBe(1);
  });
});
