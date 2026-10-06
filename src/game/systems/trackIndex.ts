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

  return { track, cellMap, spineLen, pitBoxMaxZone, pitLaneByZone, pitLineFwd, lane1FwdByZone: lane1FwdByZoneOf(cellMap) };
}
