// The tracks tools/gen_tracks.ts makes (#175). The cars and the cells keep their size, a bigger track is more cells.
import type { Corner, TrackSpec } from './gen_track';

/** A stadium: two straights of `straight` joined by half circles of radius `r`, centred on (cx, cy), clockwise. */
function stadium(cx: number, cy: number, straight: number, r: number): Corner[] {
  const hx = straight / 2 + r;
  return [
    { x: cx - hx, y: cy - r, r },
    { x: cx + hx, y: cy - r, r },
    { x: cx + hx, y: cy + r, r },
    { x: cx - hx, y: cy + r, r }
  ];
}

/** The shape of public/tracks/oval16_3lanes.json (made by the older genOval16_3lanes.mjs), to test this generator. */
export const OVAL16: TrackSpec = {
  trackId: 'oval16_3lanes',
  corners: stadium(560, 350, 520, 120),
  cellLength: 65,
  laneSpacing: 24,
  pitInset: 44,
  start: { after: 2, distance: 130 }
};

/** The same oval twice as big: 56 cells on lane 1 instead of 28. */
const OVAL32: TrackSpec = {
  trackId: 'oval32_3lanes',
  corners: stadium(908, 388, 1040, 240),
  cellLength: 65,
  laneSpacing: 24,
  pitInset: 44,
  start: { after: 2, distance: 130 }
};

export const TRACK_SPECS: TrackSpec[] = [OVAL32];
