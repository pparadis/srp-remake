// The straightened bend: zones left to right, main lanes top to bottom (lane 3 on top, lane 1 at the bottom, as the
// board is read), with the cell's forwardIndex in each dot.
import type { TrackCell } from "../../src/game/types/track";
import type { TrackIndex } from "../../src/game/systems/trackIndex";
import { circle, COLORS, text } from "./svg";

export interface Point {
  x: number;
  y: number;
}
export interface Bend {
  cellPos: Map<string, Point>;
  lanes: number[];
  svg: string;
}

export interface BendBox {
  x: number;
  y: number;
  zoneStep: number;
  laneStep: number;
}

const LANES = [1, 2, 3];

/** Cells of `zones` (inclusive) on the main lanes, placed inside the box. */
export function drawBend(trackIndex: TrackIndex, zones: [number, number], box: BendBox): Bend {
  const cells = new Map<string, TrackCell>();
  for (const c of trackIndex.track.cells) {
    if (!LANES.includes(c.laneIndex) || c.zoneIndex < zones[0] || c.zoneIndex > zones[1]) continue;
    const key = `${c.zoneIndex}:${c.laneIndex}`;
    if (!cells.has(key)) cells.set(key, c);
  }
  const cellPos = new Map<string, Point>();
  const parts: string[] = [];
  const laneY = (lane: number) => box.y + (3 - lane) * box.laneStep;
  const zoneX = (zone: number) => box.x + (zone - zones[0]) * box.zoneStep;
  for (const lane of LANES) {
    const color = COLORS.lane[lane]!;
    const pts = [];
    for (let z = zones[0]; z <= zones[1]; z += 1) pts.push(`${zoneX(z).toFixed(1)},${laneY(lane).toFixed(1)}`);
    parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" opacity="0.3"/>`);
  }
  for (let z = zones[0]; z <= zones[1]; z += 1) {
    for (const lane of LANES) {
      const c = cells.get(`${z}:${lane}`);
      if (!c) continue;
      const p = { x: zoneX(z), y: laneY(lane) };
      cellPos.set(c.id, p);
      parts.push(circle(p.x, p.y, 21, `fill="${COLORS.bg}" stroke="${COLORS.lane[lane]!}" stroke-width="1.5"`));
      parts.push(text(p.x, p.y + 4, c.forwardIndex, { anchor: "middle" }));
    }
  }
  const names: Record<number, string> = { 1: "lane 1 (inner)", 2: "lane 2", 3: "lane 3 (outer)" };
  for (const lane of LANES) parts.push(text(box.x - 106, laneY(lane) - 30, names[lane]!, { size: 11, color: COLORS.lane[lane]! }));
  return { cellPos, lanes: LANES, svg: parts.join("\n") };
}
