import { describe, expect, it } from "vitest";
import { trackSchema } from "./trackSchema";

const baseCell = {
  id: "A0",
  zoneIndex: 1,
  laneIndex: 0,
  forwardIndex: 0,
  pos: { x: 0, y: 0 },
  next: []
};

const baseTrack = {
  trackId: "test-track",
  zones: 1,
  lanes: 1,
  cells: [baseCell]
};

describe("trackSchema forwardIndex", () => {
  it("fails when forwardIndex is missing", () => {
    const cell = { ...baseCell };
    // @ts-expect-error intentional omission for test
    delete cell.forwardIndex;
    const res = trackSchema.safeParse({ ...baseTrack, cells: [cell] });
    expect(res.success).toBe(false);
  });

  it("passes when forwardIndex is present", () => {
    const res = trackSchema.safeParse(baseTrack);
    expect(res.success).toBe(true);
  });
});
