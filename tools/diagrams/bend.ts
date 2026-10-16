// The straightened bend: zones left to right, lanes top to bottom (the highest lane on top, as the board is read), with
// the cell's forwardIndex in each dot. Lanes 1-3 are the main lanes; lane 0 is the pit lane.
import type { TrackCell } from "../../src/game/types/track";
import type { TrackIndex } from "../../src/game/systems/trackIndex";
import { circle, COLORS, text } from "./svg";

export interface Point {
  x: number;
  y: number;
}
export interface Bend {
  cellPos: Map<string, Point>;
  svg: string;
}

export interface BendBox {
  x: number;
  y: number;
  zoneStep: number;
  laneStep: number;
}

const LANE_NAMES: Record<number, string> = { 0: "pit lane", 1: "lane 1 (inner)", 2: "lane 2", 3: "lane 3 (outer)" };

/** The zones from `first` to `last` inclusive. */
export function zoneRange(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * The cells of `zones` (in this order, so a stretch across the start line works: 27, 28, 1, 2) on `lanes` (top to
 * bottom), placed inside the box. A lane with no cell in a zone (the pit lane has none beyond its length) gets no dot.
 */
export function drawBend(trackIndex: TrackIndex, zones: number[], box: BendBox, lanes: number[] = [3, 2, 1]): Bend {
  const cells = new Map<string, TrackCell>();
  for (const c of trackIndex.track.cells) {
    if (!lanes.includes(c.laneIndex) || !zones.includes(c.zoneIndex)) continue;
    const key = `${c.zoneIndex}:${c.laneIndex}`;
    if (!cells.has(key)) cells.set(key, c);
  }
  const cellPos = new Map<string, Point>();
  const parts: string[] = [];
  const laneY = (lane: number) => box.y + lanes.indexOf(lane) * box.laneStep;
  const zoneX = (zone: number) => box.x + zones.indexOf(zone) * box.zoneStep;
  // drawn in lane order, whatever the rows' order
  const byLane = [...lanes].sort((a, b) => a - b);
  for (const lane of byLane) {
    const color = COLORS.lane[lane]!;
    const pts = zones.filter((z) => cells.has(`${z}:${lane}`)).map((z) => `${zoneX(z).toFixed(1)},${laneY(lane).toFixed(1)}`);
    if (pts.length > 1) parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" opacity="0.3"/>`);
  }
  for (const z of zones) {
    for (const lane of byLane) {
      const c = cells.get(`${z}:${lane}`);
      if (!c) continue;
      const p = { x: zoneX(z), y: laneY(lane) };
      cellPos.set(c.id, p);
      parts.push(circle(p.x, p.y, 21, `fill="${COLORS.bg}" stroke="${COLORS.lane[lane]!}" stroke-width="1.5"`));
      parts.push(text(p.x, p.y + 4, c.forwardIndex, { anchor: "middle" }));
    }
  }
  for (const lane of byLane) parts.push(text(box.x - 106, laneY(lane) - 30, LANE_NAMES[lane]!, { size: 11, color: COLORS.lane[lane]! }));
  return { cellPos, svg: parts.join("\n") };
}
