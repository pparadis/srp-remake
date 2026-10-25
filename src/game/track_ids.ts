// The tracks a race can be played on (#175): the id is the file name in public/tracks/ and the lobby's `trackId`. The
// page loads this list eagerly; the track itself (its JSON) is fetched when a race starts. A new track is a JSON file
// (tools/gen_tracks.ts), a line here and an entry in backend/src/tracks.ts; `track_ids.test.ts` checks the three agree.
import { must } from './must';

export interface TrackChoice {
  id: string;
  name: string;
  /** Laps the lobby proposes when the track is picked: about the same distance as the oval's 5. */
  laps: number;
}

export const TRACK_CHOICES: readonly TrackChoice[] = [
  { id: 'oval16_3lanes', name: 'Oval', laps: 5 },
  { id: 'oval32_3lanes', name: 'Big oval', laps: 3 }
];

export const DEFAULT_TRACK_ID = 'oval16_3lanes';

export function isTrackId(value: unknown): value is string {
  return TRACK_CHOICES.some((track) => track.id === value);
}

/** The laps to propose on a track; the oval's for an unknown id. */
export function trackLaps(id: string): number {
  return (TRACK_CHOICES.find((track) => track.id === id) ?? must(TRACK_CHOICES[0], 'track')).laps;
}

/** The name to show for a track; an unknown id (a race saved by a newer version) shows as it is. */
export function trackName(id: string): string {
  return TRACK_CHOICES.find((track) => track.id === id)?.name ?? id;
}
