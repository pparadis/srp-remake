export type TrackTag = 'START_FINISH' | 'PIT_ENTRY' | 'PIT_BOX' | 'PIT_EXIT' | 'PIT_LINE';

interface Vec2 {
  x: number;
  y: number;
}

export interface TrackCell {
  id: string;
  zoneIndex: number; // 1..N
  laneIndex: number; // 0..3
  forwardIndex: number; // 0..M-1 (spine-mapped)
  pos: Vec2;
  next: string[];
  tags?: TrackTag[];
}

export interface TrackData {
  trackId: string;
  zones: number;
  lanes: number; // 4 with pit lane
  cells: TrackCell[];
}

const TRACK_TAGS: readonly string[] = [
  'START_FINISH',
  'PIT_ENTRY',
  'PIT_BOX',
  'PIT_EXIT',
  'PIT_LINE'
];

function isTrackTag(tag: string): tag is TrackTag {
  return TRACK_TAGS.includes(tag);
}

/** A track as an imported JSON types it: the same, with `tags` as plain strings. */
interface TrackJson extends Omit<TrackData, 'cells'> {
  cells: Array<Omit<TrackCell, 'tags'> & { tags?: string[] }>;
}

/**
 * A track JSON as `TrackData`, without the zod schema (so the home page does not load it) and without `as`: only the
 * tags need narrowing, and an unknown one is dropped. The server checks the whole file with `parseTrack`.
 */
export function trackOfJson(json: TrackJson): TrackData {
  return {
    ...json,
    cells: json.cells.map(({ tags, ...cell }) =>
      tags ? { ...cell, tags: tags.filter(isTrackTag) } : cell
    )
  };
}
