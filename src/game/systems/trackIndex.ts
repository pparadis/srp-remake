import type { TrackCell, TrackData } from "../types/track";

export interface TrackIndex {
  track: TrackData;
  cellMap: Map<string, TrackCell>;
  spineLen: number;
  pitBoxMaxZone: number | null;
  pitLaneByZone: Map<number, string>;
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
  for (const cell of track.cells) {
    if (cell.laneIndex === 3) {
      pitLaneByZone.set(cell.zoneIndex, cell.id);
    }
    if ((cell.tags ?? []).includes("PIT_BOX") && cell.laneIndex === 3) {
      if (pitBoxMaxZone == null || cell.zoneIndex > pitBoxMaxZone) pitBoxMaxZone = cell.zoneIndex;
    }
  }

  return { track, cellMap, spineLen, pitBoxMaxZone, pitLaneByZone };
}
