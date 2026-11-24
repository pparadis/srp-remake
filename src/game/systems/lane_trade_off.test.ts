import { describe, expect, it } from 'vitest';
import small from '../../../public/tracks/oval16_3lanes.json';
import big from '../../../public/tracks/oval32_3lanes.json';
import { parseTrack } from '../../validation/track_schema';
import type { TrackData } from '../types/track';
import { laneTireFactors, laneWearPerProgress } from './lane_trade_off';
import { computeValidTargets, laneWearFactors } from './movement_system';
import { moveFactor } from './resource_system';
import { buildTrackIndex } from './track_index';

const smallIndex = buildTrackIndex(small as unknown as TrackData);
const bigIndex = buildTrackIndex(parseTrack(big));

describe('the v5 lane table (#268)', () => {
  it('reads the lane lengths of both ovals', () => {
    expect([1, 2, 3].map((l) => smallIndex.laneLength.get(l))).toEqual([28, 30, 32]);
    expect([1, 2, 3].map((l) => bigIndex.laneLength.get(l))).toEqual([56, 58, 60]);
  });

  it('prices tire per cell by lane: the inside 1.05, the outside easier by its extra distance', () => {
    const s = laneTireFactors(smallIndex)!;
    expect([s.inner, s.middle, s.outer]).toEqual([
      expect.closeTo(1.05, 3),
      expect.closeTo(0.924, 3),
      expect.closeTo(0.814, 3)
    ]);
    const b = laneTireFactors(bigIndex)!;
    expect([b.inner, b.middle, b.outer]).toEqual([
      expect.closeTo(1.05, 3),
      expect.closeTo(0.985, 3),
      expect.closeTo(0.924, 3)
    ]);
  });

  it('a lap outside wears less tire than a lap inside, for more cells and more fuel', () => {
    const lap = laneWearPerProgress(smallIndex)!;
    expect(lap.tire.outer / lap.tire.inner).toBeCloseTo(0.886, 3); // 11.4% less tire for 14.3% more cells
    expect(lap.fuel.outer).toBeCloseTo(32 / 28, 5);
    expect(lap.fuel.inner).toBe(1);
  });

  it('is absent without lane lengths', () => {
    expect(laneTireFactors({})).toBeNull();
    expect(laneWearFactors(1).tire).toBe(1.05); // v3 and v4 keep their table
    expect(laneWearFactors(3).fuel).toBe(1.03);
    expect(laneWearFactors(3, smallIndex)).toEqual({ tire: expect.closeTo(0.814, 3), fuel: 1 });
    expect(laneWearFactors(0, smallIndex)).toEqual({ tire: 1, fuel: 1 }); // the pit lane
  });
});

describe('a v5 move is priced by its target lane', () => {
  const start = smallIndex.track.cells.find((c) => c.laneIndex === 2 && c.forwardIndex === 3)!;
  const costs = {
    tireRate: 10,
    fuelRate: 10,
    setup: {
      compound: 'hard' as const,
      psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
      wing: 'medium' as const
    }
  };
  const targets = (laneTradeOff: boolean) =>
    computeValidTargets(smallIndex, start.id, new Set(), 8, { laneTradeOff }, costs);
  // The same walk and the same price, ending in lane 1 or in lane 3.
  const pair = (laneTradeOff: boolean) => {
    const all = [...targets(laneTradeOff)].map(([id, info]) => ({
      ...info,
      lane: smallIndex.cellMap.get(id)!.laneIndex
    }));
    const inner = all.find((t) => t.lane === 1 && t.distance === 6)!;
    const outer = all.find(
      (t) => t.lane === 3 && t.distance === 6 && t.moveSpend === inner.moveSpend
    )!;
    return { inner, outer };
  };

  it('costs the outside lane 0.775 of the inside one, and fuel the same', () => {
    const { inner, outer } = pair(true);
    const size = moveFactor(inner.moveSpend!).tire; // 6 cells and a lane change: a 7, the conservative size
    expect(inner.tireCost).toBeCloseTo(6 * 10 * size * 1.05, 0);
    expect(outer.tireCost).toBeCloseTo(6 * 10 * size * 0.81375, 0);
    expect(outer.fuelCost).toBe(inner.fuelCost);
  });

  it('keeps the v4 lane factors with the flag off', () => {
    const { inner, outer } = pair(false);
    const size = moveFactor(inner.moveSpend!);
    expect(inner.tireCost).toBeCloseTo(6 * 10 * size.tire * 1.05, 0);
    expect(outer.tireCost).toBeCloseTo(6 * 10 * size.tire * 0.98, 0);
    expect(inner.fuelCost).toBeCloseTo(6 * 10 * size.fuel * 0.98, 0);
    expect(outer.fuelCost).toBeCloseTo(6 * 10 * size.fuel * 1.03, 0);
  });
});
