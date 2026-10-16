// Every diagram, by output file name (under docs/img/). Add a diagram here and it is generated and checked in CI.
import { buildTrackIndex } from "../../src/game/systems/trackIndex";
import type { TrackData } from "../../src/game/types/track";
import { laneChangePriceSvg } from "./laneChangePrice";

export function allDiagrams(track: TrackData): Map<string, string> {
  const trackIndex = buildTrackIndex(track);
  return new Map([["lane-change-pricing.svg", laneChangePriceSvg(trackIndex)]]);
}
