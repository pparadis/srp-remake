import type { TrackCell } from "../../types/track";

type Vec = { x: number; y: number };
type CellMap = Map<string, TrackCell>;

const previousCache = new WeakMap<CellMap, Map<string, TrackCell>>();

// For each cell, the cell before it on its own lane (the last one in map order that lists it in `next`). Built once per
// track: headingOf used to scan every cell for it on each call.
function previousCells(cellMap: CellMap): Map<string, TrackCell> {
  let previous = previousCache.get(cellMap);
  if (!previous) {
    previous = new Map();
    for (const cell of cellMap.values()) {
      for (const id of cell.next) {
        if (cellMap.get(id)?.laneIndex === cell.laneIndex) previous.set(id, cell);
      }
    }
    previousCache.set(cellMap, previous);
  }
  return previous;
}

// Direction of travel: previous -> next cell on the same lane (central difference, which matches
// the smoothed lane line the car sits on). Falls back to the plain next cell at lane ends (pit).
export function headingOf(cell: TrackCell, cellMap: CellMap): Vec {
  const nexts = cell.next.map((id) => cellMap.get(id));
  const next = nexts.find((c) => c && c.laneIndex === cell.laneIndex) ?? nexts[0];
  const prev = previousCells(cellMap).get(cell.id);
  const from = next && prev ? prev.pos : cell.pos;
  const v: Vec = next
    ? { x: next.pos.x - from.x, y: next.pos.y - from.y }
    : { x: 1, y: 0 };
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

// Kenney cars point up, so the sprite is rotated a quarter turn from the heading.
export function spriteRotation(cell: TrackCell, cellMap: CellMap): number {
  const h = headingOf(cell, cellMap);
  return Math.atan2(h.y, h.x) + Math.PI / 2;
}

/**
 * A step from angle `current` toward `target` (radians), the short way round (wrapping at ±π), `t` of the gap: 0 stays,
 * 1 arrives. For a car turning with the road while it is dragged and when it settles on a cell (#110).
 */
export function easeAngle(current: number, target: number, t: number): number {
  const gap = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + gap * t;
}
