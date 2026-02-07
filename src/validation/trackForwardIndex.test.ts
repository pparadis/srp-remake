import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import { PIT_LANE } from "../game/constants";

function inWrapRange(zoneIndex: number, start: number, end: number, maxZone: number): boolean {
  if (start <= end) return zoneIndex >= start && zoneIndex <= end;
  return zoneIndex >= start && zoneIndex <= maxZone || zoneIndex >= 1 && zoneIndex <= end;
}

function mappedStraightSpineZone(zoneIndex: number, laneIndex: number, maxZone: number): number | null {
  if (laneIndex === 1) {
    if (inWrapRange(zoneIndex, 28, 6, maxZone)) return zoneIndex === 28 ? 28 : zoneIndex;
    if (zoneIndex >= 14 && zoneIndex <= 20) return zoneIndex;
    return null;
  }
  if (laneIndex === 2) {
    if (inWrapRange(zoneIndex, 30, 6, maxZone)) return zoneIndex === 30 ? 28 : zoneIndex;
    if (zoneIndex >= 15 && zoneIndex <= 21) return zoneIndex - 1;
    return null;
  }
  if (laneIndex === 3) {
    if (inWrapRange(zoneIndex, 32, 6, maxZone)) return zoneIndex === 32 ? 28 : zoneIndex;
    if (zoneIndex >= 16 && zoneIndex <= 22) return zoneIndex - 2;
    return null;
  }
  return null;
}

describe("track forwardIndex mapping", () => {
  it("includes forwardIndex on every cell", () => {
    for (const cell of track.cells) {
      expect(Number.isInteger(cell.forwardIndex)).toBe(true);
      expect(cell.forwardIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("assigns contiguous forwardIndex on spine lane", () => {
    const spineCells = track.cells
      .filter((c: { laneIndex: number }) => c.laneIndex === 1)
      .sort((a: { forwardIndex: number }, b: { forwardIndex: number }) => a.forwardIndex - b.forwardIndex);
    expect(spineCells.length).toBeGreaterThan(0);
    let i = 0;
    for (const cell of spineCells) {
      expect(cell.forwardIndex).toBe(i);
      i += 1;
    }
  });

  it("maps pit lane forwardIndex within spine range", () => {
    const spineCells = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === 1);
    const spineMax = spineCells.length > 0 ? spineCells.length - 1 : 0;
    const pitCells = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === PIT_LANE);
    for (const cell of pitCells) {
      expect(cell.forwardIndex).toBeGreaterThanOrEqual(0);
      expect(cell.forwardIndex).toBeLessThanOrEqual(spineMax);
    }
  });

  it("normalizes main-lane forwardIndex on straight zones", () => {
    const mainLanes = [1, 2, 3] as const;
    const spineLen = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === 1).length;
    for (const lane of mainLanes) {
      const laneCells = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === lane);
      const laneMaxZone = Math.max(...laneCells.map((c: { zoneIndex: number }) => c.zoneIndex));
      for (const cell of laneCells) {
        const mappedZone = mappedStraightSpineZone(cell.zoneIndex, lane, laneMaxZone);
        if (mappedZone == null) continue;
        const expected = ((mappedZone - 1) % spineLen + spineLen) % spineLen;
        expect(cell.forwardIndex).toBe(expected);
      }
    }
  });

  it("allows banking offset on corners for at least one outer-lane zone", () => {
    const lane1ByZone = new Map(
      track.cells
        .filter((c: { laneIndex: number }) => c.laneIndex === 1)
        .map((c: { zoneIndex: number; forwardIndex: number }) => [c.zoneIndex, c.forwardIndex])
    );
    const lane3ByZone = new Map(
      track.cells
        .filter((c: { laneIndex: number }) => c.laneIndex === 3)
        .map((c: { zoneIndex: number; forwardIndex: number }) => [c.zoneIndex, c.forwardIndex])
    );

    const cornerMismatch = Array.from(lane1ByZone.entries()).some(([zoneIndex, lane1Forward]) => {
      if (mappedStraightSpineZone(zoneIndex, 1, 28) != null) return false;
      if (mappedStraightSpineZone(zoneIndex, 3, 32) != null) return false;
      const lane3Forward = lane3ByZone.get(zoneIndex);
      if (lane3Forward == null) return false;
      return lane3Forward !== lane1Forward;
    });

    expect(cornerMismatch).toBe(true);
  });
});
