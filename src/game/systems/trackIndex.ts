import type { TrackCell, TrackData } from "../types/track";
import { PIT_LANE } from "../constants";

export interface TrackIndex {
  track: TrackData;
  cellMap: Map<string, TrackCell>;
  spineLen: number;
  pitBoxMaxZone: number | null;
  pitLaneByZone: Map<number, string>;
  // forwardIndex of the pit cell tagged PIT_LINE (where the start line crosses the pit lane), or null.
  pitLineFwd: number | null;
  // Lane-1 forwardIndex of each zone: the main-lane position beside a pit cell (see trackFwd).
  lane1FwdByZone: Map<number, number>;
  // Cells per lane (main lanes differ: the outer lanes are longer). Distances within a lane count these (#114).
  laneLength: Map<number, number>;
  // Unrounded lap position of each cell (see lapPositions): compares cars in different lanes (#114).
  lapPos: Map<string, number>;
}

const lane1Cache = new WeakMap<Map<string, TrackCell>, Map<number, number>>();

export function lane1FwdByZoneOf(cellMap: Map<string, TrackCell>): Map<number, number> {
  let byZone = lane1Cache.get(cellMap);
  if (!byZone) {
    byZone = new Map();
    for (const cell of cellMap.values()) if (cell.laneIndex === 1) byZone.set(cell.zoneIndex, cell.forwardIndex);
    lane1Cache.set(cellMap, byZone);
  }
  return byZone;
}

/**
 * forwardIndex of a cell on the scale used for ranking and gaps. Pit cells carry their own
 * forwardIndex scale (entry 0, exit 27), so they are mapped to the lane-1 cell of the same zone:
 * the entry stands beside the last cell before the line (27), the pit line cell beside the line (0).
 */
export function trackFwd(cell: TrackCell, lane1FwdByZone: Map<number, number>): number {
  return cell.laneIndex === PIT_LANE ? (lane1FwdByZone.get(cell.zoneIndex) ?? cell.forwardIndex) : cell.forwardIndex;
}

export function buildTrackIndex(track: TrackData): TrackIndex {
  const cellMap = new Map(track.cells.map((c) => [c.id, c]));
  const spineCells = track.cells.filter((c) => c.laneIndex === 1);
  const spineLen =
    spineCells.length > 0
      ? spineCells.length
      : Math.max(1, Math.max(...track.cells.map((c) => c.forwardIndex ?? 0)) + 1);

  let pitBoxMaxZone: number | null = null;
  const pitLaneByZone = new Map<number, string>();
  let pitLineFwd: number | null = null;
  for (const cell of track.cells) {
    if (cell.laneIndex === PIT_LANE && (cell.tags ?? []).includes("PIT_LINE")) pitLineFwd = cell.forwardIndex;
    if (cell.laneIndex === PIT_LANE) {
      pitLaneByZone.set(cell.zoneIndex, cell.id);
    }
    if ((cell.tags ?? []).includes("PIT_BOX") && cell.laneIndex === PIT_LANE) {
      if (pitBoxMaxZone == null || cell.zoneIndex > pitBoxMaxZone) pitBoxMaxZone = cell.zoneIndex;
    }
  }

  const laneLength = new Map<number, number>();
  for (const cell of track.cells) laneLength.set(cell.laneIndex, (laneLength.get(cell.laneIndex) ?? 0) + 1);

  return {
    track,
    cellMap,
    spineLen,
    pitBoxMaxZone,
    pitLaneByZone,
    pitLineFwd,
    lane1FwdByZone: lane1FwdByZoneOf(cellMap),
    laneLength,
    lapPos: lapPositions(track, spineCells)
  };
}

/**
 * Each main-lane cell's position along the lap, in lane-1 cells from the start line (0 to spineLen, not rounded): its
 * `pos` projected onto the lane-1 line. Side-by-side cells read the same; two cells of one lane never do (#114), unlike
 * `forwardIndex`, which the generator rounds. Rounded to 0.1 so level cells compare equal (`pos` is whole pixels); the
 * smallest step in a lane is 0.65. Pit cells (and a track without lane-1 geometry) fall back to `forwardIndex`.
 */
function lapPositions(track: TrackData, spineCells: TrackCell[]): Map<string, number> {
  const spine = [...spineCells].sort((a, b) => a.forwardIndex - b.forwardIndex);
  const n = spine.length;
  const project = (cell: TrackCell): number => {
    let best = { d: Infinity, at: cell.forwardIndex };
    for (let i = 0; i < n; i += 1) {
      const a = spine[i]!.pos;
      const b = spine[(i + 1) % n]!.pos;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const u = Math.max(0, Math.min(1, ((cell.pos.x - a.x) * dx + (cell.pos.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(a.x + u * dx - cell.pos.x, a.y + u * dy - cell.pos.y);
      if (d < best.d) best = { d, at: i + u };
    }
    return (Math.round(best.at * 10) / 10) % n;
  };
  const usable = n >= 3 && spine.every((c) => c.pos);
  return new Map(
    track.cells.map((c) => [c.id, usable && c.laneIndex !== PIT_LANE && c.pos ? project(c) : c.forwardIndex])
  );
}

/** Cells from `from` to `to` along their lane (both in the same lane), wrapping at the lane's own length. */
export function cellsAlongLane(trackIndex: TrackIndex, from: TrackCell, to: TrackCell): number {
  const len = trackIndex.laneLength.get(from.laneIndex) ?? trackIndex.spineLen;
  return (((to.zoneIndex - from.zoneIndex) % len) + len) % len;
}

/**
 * A lane change gaining at least this much lap position moves forward (diagonal, +1 move point); less is sideways. On
 * the straights a change gains 0 or 1; through the bends the outer lanes' extra cells give anything in between (#114).
 */
export const DIAGONAL_MIN_GAIN = 0.5;

/** How far `to` is ahead of `from` along the lap, any lanes: 0 = level, in [0, spineLen). */
export function lapAhead(trackIndex: TrackIndex, from: TrackCell, to: TrackCell): number {
  const { lapPos, spineLen } = trackIndex;
  const d = (lapPos.get(to.id) ?? to.forwardIndex) - (lapPos.get(from.id) ?? from.forwardIndex);
  return Math.round((((d % spineLen) + spineLen) % spineLen) * 10) / 10;
}
