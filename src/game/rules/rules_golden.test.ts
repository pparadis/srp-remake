import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { createRace, createRaceContext } from '../race/race_engine';
import type { TrackData } from '../types/track';
import { replay, type Golden } from './golden';
import v3 from './golden/v3.json';
import v4 from './golden/v4.json';
import { isRulesVersion, replayBlock } from './ids';
import { DEFAULT_RULES_VERSION, RULES, RULES_VERSIONS, type RulesVersion } from './versions';

// A frozen rules version never changes behavior (#118): every sample of its golden file must give the same targets
// (with prices) and the same car after the recorded move. A failure here means a change moved a frozen version, through
// its own code or through shared code (constants, track, pit, wear): change it back, or make the change a new version.
const GOLDEN: Partial<Record<RulesVersion, Golden>> = {
  v3: v3 as unknown as Golden,
  v4: v4 as unknown as Golden
};
const ctx = createRaceContext(track as unknown as TrackData);
const frozen = RULES_VERSIONS.filter((v) => RULES[v].status === 'frozen');

describe('rules versions', () => {
  it('v4 is the default, and every version is frozen', () => {
    expect(DEFAULT_RULES_VERSION).toBe('v4');
    for (const v of RULES_VERSIONS) expect(RULES[v].status).toBe('frozen');
  });

  it('every frozen version has a golden file for this track', () => {
    for (const v of frozen) {
      expect(GOLDEN[v]?.version).toBe(v);
      expect(GOLDEN[v]?.trackId).toBe(ctx.track.trackId);
    }
  });

  it('a race plays the version it was created with, the default when none is given', () => {
    const seats = [{ isBot: false, ownerId: 'P1' }];
    expect(createRace(ctx, seats, 3).rulesVersion).toBe(DEFAULT_RULES_VERSION);
    expect(createRace(ctx, seats, 3, 0, 'v3').rulesVersion).toBe('v3');
  });
});

for (const v of frozen) {
  describe(`frozen rules ${v} replay their golden file`, () => {
    const golden = GOLDEN[v]!;
    it.each(golden.samples.map((s) => [s.name, s] as const))('%s', (_name, sample) => {
      const now = replay(ctx, sample, v);
      expect(now.targets).toEqual(sample.targets);
      expect(now.after).toEqual(sample.after);
    });
  });
}

describe('v3', () => {
  // v3 has its own resource rules (#148): medium compound and a fuel load.
  it('offers the medium compound and a fuel load', () => {
    const race = { raceLaps: 5, spineLen: 28 };
    expect(RULES.v3.rules.resources(race).features).toEqual({
      medium: true,
      fuelLoad: true,
      psi: false
    });
  });
});

describe('retired versions', () => {
  it('are not versions, and their races cannot be replayed (#254)', () => {
    for (const v of ['v1', 'v2']) {
      expect(isRulesVersion(v)).toBe(false);
      expect(replayBlock(v)).toContain('retired');
    }
    expect(replayBlock('v4')).toBeNull();
  });
});
