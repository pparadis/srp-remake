import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import { PIT_LANE } from "../game/constants";

function isStraightZone(zoneIndex: number): boolean {
  return zoneIndex >= 30 || zoneIndex <= 6 || (zoneIndex >= 15 && zoneIndex <= 21);
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
    const mainLanes = [1, 2, 3];
    const laneZoneForward = new Map<number, Map<number, number>>();
    for (const lane of mainLanes) {
      laneZoneForward.set(
        lane,
        new Map(
          track.cells
            .filter((c: { laneIndex: number }) => c.laneIndex === lane)
            .map((c: { zoneIndex: number; forwardIndex: number }) => [c.zoneIndex, c.forwardIndex])
        )
      );
    }

    const spineZones = laneZoneForward.get(1);
    expect(spineZones).toBeDefined();
    if (!spineZones) return;

    for (const [zoneIndex, spineForward] of spineZones.entries()) {
      if (!isStraightZone(zoneIndex)) continue;
      for (const lane of [2, 3]) {
        const laneForward = laneZoneForward.get(lane)?.get(zoneIndex);
        if (laneForward == null) continue;
        expect(laneForward).toBe(spineForward);
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
      if (isStraightZone(zoneIndex)) return false;
      const lane3Forward = lane3ByZone.get(zoneIndex);
      if (lane3Forward == null) return false;
      return lane3Forward !== lane1Forward;
    });

    expect(cornerMismatch).toBe(true);
  });
});
