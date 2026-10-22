// Every diagram, by output file name (under docs/img/). Add a diagram here and it is generated, checked in CI, and
// must be embedded in a doc (diagrams.test.ts).
import type { TrackData } from '../../src/game/types/track';
import { blockersSvg } from './blockers';
import { draftingSvg } from './drafting';
import { laneChangePriceSvg } from './lane_change_price';
import { lapsSvg } from './laps';
import { moveSizeSvg } from './move_size';
import { passAndReturnSvg } from './pass_and_return';
import { pitEntrySvg, pitLaneSvg } from './pit_lane';
import { contextOf } from './scenario';
import { pitExitSqueezeSvg, squeezeSvg } from './squeeze';

export function allDiagrams(track: TrackData): Map<string, string> {
  const ctx = contextOf(track);
  return new Map([
    ['lane-change-pricing.svg', laneChangePriceSvg(ctx)],
    ['blockers.svg', blockersSvg(ctx)],
    ['pass-and-return.svg', passAndReturnSvg(ctx)],
    ['squeeze.svg', squeezeSvg(ctx)],
    ['pit-exit-squeeze.svg', pitExitSqueezeSvg(ctx)],
    ['pit-entry.svg', pitEntrySvg(ctx)],
    ['pit-lane.svg', pitLaneSvg(ctx)],
    ['laps.svg', lapsSvg(ctx)],
    ['drafting.svg', draftingSvg(ctx)],
    ['move-size.svg', moveSizeSvg(ctx)]
  ]);
}
