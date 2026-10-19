import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import type { TrackData } from '../types/track';
import { computeValidTargets } from './movementSystem';
import { movePath } from './movePath';
import { buildTrackIndex } from './trackIndex';

const idx = buildTrackIndex(track as unknown as TrackData);
const lane = (id: string) => idx.cellMap.get(id)!.laneIndex;
const zone = (id: string) => idx.cellMap.get(id)!.zoneIndex;
const laneChanges = (path: string[]) =>
  path.slice(1).filter((id, i) => lane(id) !== lane(path[i]!)).length;

describe('movePath', () => {
  it('stays in the lane for a same-lane move, and is just the cell for a move of none', () => {
    expect(movePath(idx, 'Z05_L1_00', 'Z08_L1_00')).toEqual([
      'Z05_L1_00',
      'Z06_L1_00',
      'Z07_L1_00',
      'Z08_L1_00'
    ]);
    expect(movePath(idx, 'Z05_L1_00', 'Z05_L1_00')).toEqual(['Z05_L1_00']);
  });

  it('changes lane once for a one-lane-change move, and does not wander sideways', () => {
    const path = movePath(idx, 'Z05_L1_00', 'Z08_L2_00');
    expect(path).toHaveLength(4);
    expect(path[0]).toBe('Z05_L1_00');
    expect(path.at(-1)).toBe('Z08_L2_00');
    expect(laneChanges(path)).toBe(1);
    path.slice(1).forEach((id, i) => expect(zone(id)).not.toBe(zone(path[i]!)));
  });

  it('goes round a blocker through the adjacent lane, rejoining with a sideways step', () => {
    const path = movePath(idx, 'Z05_L1_00', 'Z08_L1_00', new Set(['Z07_L1_00']));
    expect(path).toEqual(['Z05_L1_00', 'Z06_L1_00', 'Z07_L2_00', 'Z08_L2_00', 'Z08_L1_00']);
    expect(laneChanges(path)).toBe(2); // out and back; it stays in its lane until the pull-out
  });

  it('follows the pit lane: entry, a jump to a box past the line, and the exit onto lane 1', () => {
    expect(movePath(idx, 'Z27_L1_00', 'Z28_L0_00')).toEqual(['Z27_L1_00', 'Z28_L0_00']);
    expect(movePath(idx, 'Z28_L0_00', 'Z04_L0_00')).toEqual([
      'Z28_L0_00',
      'Z01_L0_00',
      'Z02_L0_00',
      'Z03_L0_00',
      'Z04_L0_00'
    ]);
    expect(movePath(idx, 'Z06_L0_00', 'Z07_L1_00')).toEqual(['Z06_L0_00', 'Z07_L1_00']);
  });

  it('crosses the start line', () => {
    const path = movePath(idx, 'Z28_L1_00', 'Z02_L1_00');
    expect(path).toEqual(['Z28_L1_00', 'Z01_L1_00', 'Z02_L1_00']);
  });

  it('falls back to a straight line when no walk exists', () => {
    const wall = new Set(['Z06_L1_00', 'Z06_L2_00', 'Z06_L3_00']);
    expect(movePath(idx, 'Z05_L1_00', 'Z08_L1_00', wall)).toEqual(['Z05_L1_00', 'Z08_L1_00']);
    expect(movePath(idx, 'nowhere', 'Z08_L1_00')).toEqual(['nowhere', 'Z08_L1_00']);
  });

  it('reaches every target the engine offers, avoiding the other cars, in no more cells than it charged', () => {
    const costs = {
      tireRate: 1,
      fuelRate: 1,
      setup: {
        compound: 'hard' as const,
        psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
        wing: 'medium' as const
      }
    };
    const setups: Array<[string, string[]]> = [
      ['Z05_L1_00', []],
      ['Z05_L1_00', ['Z07_L1_00']],
      ['Z05_L2_00', ['Z06_L2_00', 'Z07_L1_00', 'Z08_L3_00']],
      ['Z27_L1_00', ['Z28_L1_00']],
      ['Z28_L1_00', ['Z01_L1_00', 'Z02_L2_00']],
      ['Z28_L0_00', []],
      ['Z03_L0_00', []]
    ];
    for (const [start, others] of setups) {
      const occupied = new Set([start, ...others]);
      const blocked = new Set(others);
      const targets = computeValidTargets(idx, start, occupied, 9, {}, costs);
      expect(targets.size, start).toBeGreaterThan(0);
      for (const [cellId, info] of targets) {
        const path = movePath(idx, start, cellId, blocked);
        const label = `${start} -> ${cellId}`;
        expect(path[0], label).toBe(start);
        expect(path.at(-1), label).toBe(cellId);
        expect(path.length - 1, label).toBeLessThanOrEqual(info.distance);
        expect(
          path.slice(1, -1).filter((id) => blocked.has(id)),
          label
        ).toEqual([]);
        // a real walk: every step is an edge of next[]
        path
          .slice(1)
          .forEach((id, i) => expect(idx.cellMap.get(path[i]!)!.next, label).toContain(id));
      }
    }
  });
});
