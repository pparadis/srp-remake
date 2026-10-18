import { describe, expect, it } from "vitest";
import trackJson from "../../../../public/tracks/oval16_3lanes.json";
import type { TrackCell, TrackData } from "../../types/track";
import { PIT_LANE } from "../../constants";
import { easeAngle, headingOf } from "./heading";

const track = trackJson as unknown as TrackData;
const cellMap = new Map<string, TrackCell>(track.cells.map((c) => [c.id, c]));

// Tangent of the lane's smoothed line at a cell = previous -> next same-lane cell.
function laneTangent(cell: TrackCell) {
  const next = cell.next.map((id) => cellMap.get(id)!).find((c) => c.laneIndex === cell.laneIndex)!;
  const prev = track.cells.find((c) => c.laneIndex === cell.laneIndex && c.next.includes(cell.id))!;
  return Math.atan2(next.pos.y - prev.pos.y, next.pos.x - prev.pos.x);
}

describe("headingOf", () => {
  it("follows the lane tangent on every main-lane cell", () => {
    for (const cell of track.cells.filter((c) => c.laneIndex !== PIT_LANE)) {
      const h = headingOf(cell, cellMap);
      const diff = Math.abs(Math.atan2(Math.sin(Math.atan2(h.y, h.x) - laneTangent(cell)), Math.cos(Math.atan2(h.y, h.x) - laneTangent(cell))));
      expect(diff, cell.id).toBeLessThan(0.05);
    }
  });

  it("points along the travel direction on the straights and never backwards", () => {
    for (const cell of track.cells) {
      const h = headingOf(cell, cellMap);
      const next = cellMap.get(cell.next[0]!)!;
      expect(h.x * (next.pos.x - cell.pos.x) + h.y * (next.pos.y - cell.pos.y), cell.id).toBeGreaterThan(0);
    }
  });
});

describe("easeAngle", () => {
  const deg = (d: number) => (d * Math.PI) / 180;

  it("stays at 0 and arrives at 1", () => {
    expect(easeAngle(deg(30), deg(100), 0)).toBeCloseTo(deg(30));
    expect(easeAngle(deg(30), deg(100), 1)).toBeCloseTo(deg(100));
  });

  it("takes a fraction of the gap", () => {
    expect(easeAngle(0, deg(90), 0.5)).toBeCloseTo(deg(45));
  });

  it("goes the short way round: 170° to -170° passes through 180°, not 0°", () => {
    const half = easeAngle(deg(170), deg(-170), 0.5);
    expect(Math.cos(half)).toBeCloseTo(-1); // at 180°
    expect(easeAngle(deg(-170), deg(170), 1) % (2 * Math.PI)).toBeCloseTo(deg(-190) % (2 * Math.PI));
  });

  it("converges on the target from any start by repeated steps", () => {
    let a = deg(-120);
    for (let i = 0; i < 40; i += 1) a = easeAngle(a, deg(150), 0.33);
    expect(Math.cos(a - deg(150))).toBeCloseTo(1, 3);
  });
});
