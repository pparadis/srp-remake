import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { createRace, createRaceContext } from '../race/raceEngine';
import type { TrackData } from '../types/track';
import { replay, type Golden } from './golden';
import v1 from './golden/v1.json';
import v2 from './golden/v2.json';
import { DEFAULT_RULES_VERSION, RULES, RULES_VERSIONS, type RulesVersion } from './versions';

// A frozen rules version never changes behavior (#118): every sample of its golden file must give the same targets
// (with prices) and the same car after the recorded move. A failure here means a change moved a frozen version, through
// its own code or through shared code (constants, track, pit, wear): change it back, or make the change a new version.
const GOLDEN: Partial<Record<RulesVersion, Golden>> = {
  v1: v1 as unknown as Golden,
  v2: v2 as unknown as Golden
};
const ctx = createRaceContext(track as unknown as TrackData);
const frozen = RULES_VERSIONS.filter((v) => RULES[v].status === 'frozen');

describe('rules versions', () => {
  it('v2 is the default, and v1 and v2 are frozen', () => {
    expect(DEFAULT_RULES_VERSION).toBe('v2');
    expect(RULES.v1.status).toBe('frozen');
    expect(RULES.v2.status).toBe('frozen');
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
    expect(createRace(ctx, seats, 3, 0, 'v1').rulesVersion).toBe('v1');
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

describe('versions really differ', () => {
  // Without this the test above would pass with v1 wired to v2's code.
  it('v2 answers differently from v1 on the #113 positions', () => {
    const differs = v1.samples
      .slice(0, 10)
      .filter(
        (s) =>
          JSON.stringify(replay(ctx, s as unknown as Golden['samples'][number], 'v2')) !==
          JSON.stringify({ targets: s.targets, after: s.after })
      );
    expect(differs.length).toBeGreaterThanOrEqual(3);
  });
});
