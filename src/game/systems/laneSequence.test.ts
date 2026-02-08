import { describe, expect, it } from "vitest";
import type { TrackCell } from "../types/track";
import { buildLaneSequence } from "./laneSequence";

function makeCell(
  id: string,
  laneIndex: number,
  forwardIndex: number,
  next: string[],
  tags: TrackCell["tags"] = []
): TrackCell {
  return {
    id,
    zoneIndex: forwardIndex + 1,
    laneIndex,
    forwardIndex,
    pos: { x: 0, y: 0 },
    next,
    tags
  };
}

describe("buildLaneSequence", () => {
  it("starts from START_FINISH when present", () => {
    const cells: TrackCell[] = [
      makeCell("A", 1, 0, ["B"]),
      makeCell("B", 1, 1, ["C"], ["START_FINISH"]),
      makeCell("C", 1, 2, ["A"])
    ];
    const byId = new Map(cells.map((c) => [c.id, c]));
    const seq = buildLaneSequence(cells, byId, 1);
    expect(seq.map((c) => c.id)).toEqual(["B", "C", "A"]);
  });

  it("falls back to PIT_ENTRY when START_FINISH is missing", () => {
    const cells: TrackCell[] = [
      makeCell("P0", 0, 0, ["P1"], ["PIT_ENTRY"]),
      makeCell("P1", 0, 1, ["P2"]),
      makeCell("P2", 0, 2, ["P0"])
    ];
    const byId = new Map(cells.map((c) => [c.id, c]));
    const seq = buildLaneSequence(cells, byId, 0);
    expect(seq.map((c) => c.id)).toEqual(["P0", "P1", "P2"]);
  });

  it("respects explicit startTagPriority", () => {
    const cells: TrackCell[] = [
      makeCell("A", 1, 2, ["B"], ["PIT_ENTRY"]),
      makeCell("B", 1, 0, ["C"]),
      makeCell("C", 1, 1, ["A"])
    ];
    const byId = new Map(cells.map((c) => [c.id, c]));
    const seq = buildLaneSequence(cells, byId, 1, { startTagPriority: ["START_FINISH"] });
    expect(seq.map((c) => c.id)).toEqual(["B", "C", "A"]);
  });

  it("appends disconnected cells sorted by forwardIndex", () => {
    const cells: TrackCell[] = [
      makeCell("A", 2, 0, ["B"], ["START_FINISH"]),
      makeCell("B", 2, 1, []),
      makeCell("C", 2, 2, []),
      makeCell("D", 2, 3, [])
    ];
    const byId = new Map(cells.map((c) => [c.id, c]));
    const seq = buildLaneSequence(cells, byId, 2);
    expect(seq.map((c) => c.id)).toEqual(["A", "B", "C", "D"]);
  });
});
