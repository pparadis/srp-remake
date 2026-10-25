import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGONAL_MIN_GAIN, buildTrackIndex, lapAhead } from '../src/game/systems/track_index';
import { parseTrack } from '../src/validation/track_schema';
import { validateTrack } from '../src/validation/track_validation';
import { generateTrack } from './gen_track';
import { OVAL16, TRACK_SPECS } from './track_specs';

function committed(trackId: string) {
  return parseTrack(
    JSON.parse(readFileSync(join(process.cwd(), 'public', 'tracks', `${trackId}.json`), 'utf8'))
  );
}

describe('generateTrack', () => {
  it('rebuilds the older hand-written oval: same cells, positions, pit and start line', () => {
    const made = generateTrack(OVAL16);
    const old = committed('oval16_3lanes');
    expect(made.cells.map((c) => c.id).sort()).toEqual(old.cells.map((c) => c.id).sort());
    expect(made.zones).toBe(old.zones);
    const byId = new Map(old.cells.map((c) => [c.id, c]));
    for (const cell of made.cells) {
      const was = byId.get(cell.id);
      expect(cell.pos, cell.id).toEqual(was?.pos);
      expect(cell.tags ?? [], cell.id).toEqual(was?.tags ?? []);
      // the outer lanes round their bends another way; lane 1 and the pit lane are the same
      if (cell.laneIndex === 1 || cell.laneIndex === 0) {
        expect(cell.forwardIndex, cell.id).toBe(was?.forwardIndex);
      }
    }
  });

  it.each([OVAL16, ...TRACK_SPECS])('$trackId is a valid track', (spec) => {
    expect(validateTrack(generateTrack(spec))).toEqual([]);
  });

  it.each([OVAL16, ...TRACK_SPECS])('$trackId: every lane change moves forward', (spec) => {
    const track = generateTrack(spec);
    const index = buildTrackIndex(track);
    for (const cell of track.cells) {
      for (const id of cell.next) {
        const to = index.cellMap.get(id);
        if (!to || cell.laneIndex === 0 || to.laneIndex === 0 || to.laneIndex === cell.laneIndex) {
          continue;
        }
        expect(lapAhead(index, cell, to), `${cell.id} -> ${id}`).toBeGreaterThanOrEqual(
          DIAGONAL_MIN_GAIN
        );
      }
    }
  });

  it.each(TRACK_SPECS)(
    '$trackId.json is what the generator makes (run npm run gen:tracks)',
    (spec) => {
      expect(committed(spec.trackId)).toEqual(generateTrack(spec));
    }
  );

  it('a bigger track has more cells on the same lanes', () => {
    const lane1 = (cells: { laneIndex: number }[]) => cells.filter((c) => c.laneIndex === 1).length;
    expect(lane1(generateTrack(OVAL16).cells)).toBe(28);
    for (const spec of TRACK_SPECS) {
      expect(lane1(generateTrack(spec).cells)).toBeGreaterThan(28);
    }
  });

  // the same oval driven the other way: every bend turns left, so the lanes to the left of lane 1 are the inner ones
  const anticlockwise = {
    ...OVAL16,
    corners: [...OVAL16.corners].reverse(),
    start: { after: 0, distance: 130 }
  };

  it('makes a loop driven the other way, with the outer lanes inside the bends', () => {
    const track = generateTrack(anticlockwise);
    expect(validateTrack(track)).toEqual([]);
    const sizes = [1, 2, 3].map((lane) => track.cells.filter((c) => c.laneIndex === lane).length);
    // the straights hold 16 cells on every lane; each half circle 6 (radius 120), 5 (96) or 3 (72)
    expect(sizes).toEqual([28, 26, 22]);
  });

  it('refuses a lane that does not fit in a bend', () => {
    expect(() => generateTrack({ ...anticlockwise, laneSpacing: 80 })).toThrow('does not fit');
  });

  it('refuses a start line that is not on the straight', () => {
    expect(() => generateTrack({ ...OVAL16, start: { after: 2, distance: 9000 } })).toThrow(
      'not on the straight'
    );
  });

  it('refuses corners too close for their radii', () => {
    expect(() =>
      generateTrack({
        ...OVAL16,
        corners: OVAL16.corners.map((c) => ({ ...c, r: 300 }))
      })
    ).toThrow('too close');
  });
});
