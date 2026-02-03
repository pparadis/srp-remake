import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";

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
    for (let i = 0; i < spineCells.length; i += 1) {
      expect(spineCells[i].forwardIndex).toBe(i);
    }
  });

  it("maps pit lane forwardIndex within spine range", () => {
    const spineCells = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === 1);
    const spineMax = spineCells.length - 1;
    const pitCells = track.cells.filter((c: { laneIndex: number }) => c.laneIndex === 3);
    for (const cell of pitCells) {
      expect(cell.forwardIndex).toBeGreaterThanOrEqual(0);
      expect(cell.forwardIndex).toBeLessThanOrEqual(spineMax);
    }
  });
});
