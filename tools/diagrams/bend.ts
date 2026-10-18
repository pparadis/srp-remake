// A stretch of the track as it is on the board (bends included), travel left to right, the highest lane on top, with
// the cell's forwardIndex in each dot. Lanes 1-3 are the main lanes; lane 0 is the pit lane. Zone numbers differ per
// lane (the outer lanes have more cells), so cells are placed where they are, never in zone columns (#114).
import { PIT_LANE } from '../../src/game/constants';
import type { TrackCell } from '../../src/game/types/track';
import type { TrackIndex } from '../../src/game/systems/trackIndex';
import { circle, COLORS, text } from './svg';

export interface Point {
  x: number;
  y: number;
}
export interface Bend {
  cellPos: Map<string, Point>;
  svg: string;
  /** from `box.y` to the bottom of the lowest dot */
  height: number;
}

/** Where to draw: the top-left corner of the dots and the width they may take (they are centred in it). The lanes'
 * legend goes just above `y`. */
export interface BendBox {
  x: number;
  y: number;
  w: number;
}

const LANE_NAMES: Record<number, string> = {
  0: 'pit lane',
  1: 'lane 1 (inner)',
  2: 'lane 2',
  3: 'lane 3 (outer)'
};

// Diagram pixels per board pixel, the same in every diagram unless the stretch is too wide for its box: side-by-side
// cells (24 board px apart) get 45 px, room for a 20 px dot each.
const BOARD_SCALE = 1.9;
const SIDE_BY_SIDE = 24;

/** The zones from `first` to `last` inclusive. */
export function zoneRange(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_item, i) => first + i);
}

/**
 * The cells of `zones` (a stretch across the start line works: 27, 28, 1, 2) on `lanes` (top to bottom), drawn where
 * they are on the board. A lane with no cell in a zone (the pit lane has none beyond its length) gets no dot.
 */
export function drawBend(
  trackIndex: TrackIndex,
  zones: number[],
  box: BendBox,
  lanes: number[] = [3, 2, 1]
): Bend {
  const cells = new Map<string, TrackCell>();
  for (const c of trackIndex.track.cells) {
    if (!lanes.includes(c.laneIndex) || !zones.includes(c.zoneIndex)) continue;
    const key = `${c.zoneIndex}:${c.laneIndex}`;
    if (!cells.has(key)) cells.set(key, c);
  }
  // Zone numbers differ per lane, so a main lane also gets every cell level with the stretch (by lap position): lane 2
  // runs on to zone 30 before the line, and zones 27, 28, 1 alone would leave a hole in it. The pit lane keeps its zones.
  const { lapPos, spineLen } = trackIndex;
  const main = [...cells.values()].filter((c) => c.laneIndex !== PIT_LANE);
  // lap position from `from`, within half a lap either way (a stretch can cross the start line)
  const rel = (c: TrackCell, from: number) => {
    const a = ((((lapPos.get(c.id) ?? 0) - from) % spineLen) + spineLen) % spineLen;
    return a > spineLen / 2 ? a - spineLen : a;
  };
  const ref = main.length > 0 ? (lapPos.get(main[0]!.id) ?? 0) : 0;
  // the stretch starts at its rearmost cell
  const lo = ref + Math.min(0, ...main.map((c) => rel(c, ref)));
  const along = (c: TrackCell) => rel(c, lo);
  const span = Math.max(0, ...main.map(along));
  for (const c of trackIndex.track.cells) {
    if (c.laneIndex === PIT_LANE || !lanes.includes(c.laneIndex) || main.length === 0) continue;
    const a = along(c);
    if (a >= -0.3 && a <= span + 0.3 && !cells.has(`${c.zoneIndex}:${c.laneIndex}`)) {
      cells.set(`${c.zoneIndex}:${c.laneIndex}`, c);
    }
  }
  // each lane's cells in driving order (the pit lane in the order of `zones`)
  const order = (c: TrackCell) =>
    c.laneIndex === PIT_LANE ? zones.indexOf(c.zoneIndex) : along(c);
  const turned = turnToTravel([...cells.values()], zones, lanes);
  const xs = [...turned.values()].map((p) => p.x);
  const ys = [...turned.values()].map((p) => p.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys)
  ];
  const scale = Math.min(BOARD_SCALE, (box.w - 44) / (maxX - minX || 1));
  const r = Math.min(20, (SIDE_BY_SIDE * scale) / 2.2);
  const offX = box.x + (box.w - (maxX - minX) * scale) / 2;
  const cellPos = new Map(
    [...turned].map(([id, p]) => [
      id,
      { x: offX + (p.x - minX) * scale, y: box.y + r + (p.y - minY) * scale }
    ])
  );

  const parts: string[] = [];
  // drawn in lane order, whatever the rows' order
  const byLane = [...lanes].sort((a, b) => a - b);
  const laneCells = (lane: number) =>
    [...cells.values()].filter((c) => c.laneIndex === lane).sort((a, b) => order(a) - order(b));
  for (const lane of byLane) {
    const pts = laneCells(lane).map(
      (c) => `${cellPos.get(c.id)!.x.toFixed(1)},${cellPos.get(c.id)!.y.toFixed(1)}`
    );
    if (pts.length > 1) {
      parts.push(
        `<polyline points="${pts.join(' ')}" fill="none" stroke="${COLORS.lane[lane]!}" stroke-width="2" opacity="0.3"/>`
      );
    }
  }
  for (const lane of byLane) {
    for (const c of laneCells(lane)) {
      const p = cellPos.get(c.id)!;
      parts.push(
        circle(p.x, p.y, r, `fill="${COLORS.bg}" stroke="${COLORS.lane[lane]!}" stroke-width="1.5"`)
      );
      parts.push(text(p.x, p.y + 4, c.forwardIndex, { anchor: 'middle', size: r < 16 ? 11 : 13 }));
    }
  }
  // the lanes' names as a legend above the drawing, in row order (on a bend a name beside a dot would sit among others)
  let lx = box.x;
  for (const lane of lanes) {
    parts.push(text(lx, box.y - 8, LANE_NAMES[lane]!, { size: 11, color: COLORS.lane[lane]! }));
    lx += LANE_NAMES[lane]!.length * 7 + 22;
  }
  return { cellPos, svg: parts.join('\n'), height: (maxY - minY) * scale + 2 * r };
}

/**
 * Board positions turned so the stretch runs left to right (first zone shown to last) with `lanes[0]` on top, as the
 * board is read. On this oval the outer lane is always on the same side of travel; a stretch that comes out the other
 * way up is mirrored.
 */
function turnToTravel(cells: TrackCell[], zones: number[], lanes: number[]): Map<string, Point> {
  // the top lane's cells set the direction (a straight lies flat), all cells of the zone when it has none there
  const centre = (zone: number) => {
    const inZone = cells.filter((c) => c.zoneIndex === zone);
    const top = inZone.filter((c) => c.laneIndex === lanes[0]);
    const at = top.length > 0 ? top : inZone;
    return {
      x: at.reduce((s, c) => s + c.pos.x, 0) / (at.length || 1),
      y: at.reduce((s, c) => s + c.pos.y, 0) / (at.length || 1)
    };
  };
  const a = centre(zones[0]!);
  const b = centre(zones[zones.length - 1]!);
  const angle = zones.length > 1 ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  const [cos, sin] = [Math.cos(-angle), Math.sin(-angle)];
  const turned = cells.map((c) => ({
    c,
    x: c.pos.x * cos - c.pos.y * sin,
    y: c.pos.x * sin + c.pos.y * cos
  }));
  const meanY = (lane: number) => {
    const ys = turned.filter((p) => p.c.laneIndex === lane).map((p) => p.y);
    return ys.reduce((s, y) => s + y, 0) / (ys.length || 1);
  };
  const flip = lanes.length > 1 && meanY(lanes[0]!) > meanY(lanes[lanes.length - 1]!) ? -1 : 1;
  return new Map(turned.map((p) => [p.c.id, { x: p.x, y: p.y * flip }]));
}
