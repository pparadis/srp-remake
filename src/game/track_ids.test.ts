import { describe, expect, it } from 'vitest';
import { knownTrackIds } from '../../backend/src/tracks';
import { DEFAULT_TRACK_ID, TRACK_CHOICES, isTrackId, trackName } from './track_ids';

describe('track choices', () => {
  const files = Object.keys(import.meta.glob('../../public/tracks/*.json')).map((path) =>
    path.replace(/^.*\/|\.json$/g, '')
  );

  it('lists every track file and every track the server can race on', () => {
    const ids = TRACK_CHOICES.map((track) => track.id).sort();
    expect(ids).toEqual([...files].sort());
    expect(ids).toEqual(knownTrackIds().sort());
  });

  it('starts on a track that exists', () => {
    expect(isTrackId(DEFAULT_TRACK_ID)).toBe(true);
  });

  it('knows its tracks and names them', () => {
    expect(isTrackId('oval32_3lanes')).toBe(true);
    expect(isTrackId('nope')).toBe(false);
    expect(isTrackId(undefined)).toBe(false);
    expect(trackName('oval32_3lanes')).toBe('Big oval');
    expect(trackName('from_the_future')).toBe('from_the_future');
  });

  it('gives every track its own name', () => {
    expect(new Set(TRACK_CHOICES.map((track) => track.name)).size).toBe(TRACK_CHOICES.length);
  });
});
