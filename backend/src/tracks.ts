import oval16 from '../../public/tracks/oval16_3lanes.json';
import oval32 from '../../public/tracks/oval32_3lanes.json';
import { createRaceContext, type RaceContext } from '../../src/game/race/race_engine';
import type { TrackData } from '../../src/game/types/track';
import { parseTrack } from '../../src/validation/track_schema';

// Tracks the server can race on, keyed by lobby `settings.trackId`.
const TRACKS: Record<string, TrackData> = {
  oval16_3lanes: parseTrack(oval16),
  oval32_3lanes: parseTrack(oval32)
};

const contexts = new Map<string, RaceContext>();

export function getRaceContext(trackId: string): RaceContext | undefined {
  const cached = contexts.get(trackId);
  if (cached) return cached;
  const track = Object.hasOwn(TRACKS, trackId) ? TRACKS[trackId] : undefined;
  if (!track) return undefined;
  const ctx = createRaceContext(track);
  contexts.set(trackId, ctx);
  return ctx;
}

export function knownTrackIds(): string[] {
  return Object.keys(TRACKS);
}
