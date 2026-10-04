import type { TrackCell } from "../../types/track";

type Vec = { x: number; y: number };
type CellMap = Map<string, TrackCell>;

// Direction of travel: previous -> next cell on the same lane (central difference, which matches
// the smoothed lane line the car sits on). Falls back to the plain next cell at lane ends (pit).
export function headingOf(cell: TrackCell, cellMap: CellMap): Vec {
  const nexts = cell.next.map((id) => cellMap.get(id));
  const next = nexts.find((c) => c && c.laneIndex === cell.laneIndex) ?? nexts[0];
  let prev: TrackCell | undefined;
  for (const c of cellMap.values()) {
    if (c.laneIndex === cell.laneIndex && c.next.includes(cell.id)) prev = c;
  }
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
