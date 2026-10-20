import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { trackOfJson } from './track';

describe('trackOfJson', () => {
  it('returns the real track unchanged', () => {
    expect(trackOfJson(track)).toEqual(track);
  });

  it('drops a tag it does not know and leaves a cell without tags alone', () => {
    const [first] = track.cells;
    const { tags: _tags, ...plain } = first!;
    const out = trackOfJson({
      ...track,
      cells: [
        { ...plain, tags: ['PIT_BOX', 'NOT_A_TAG'] },
        { ...plain, id: 'other' }
      ]
    });
    expect(out.cells[0]?.tags).toEqual(['PIT_BOX']);
    expect(out.cells[1]).not.toHaveProperty('tags');
  });
});
