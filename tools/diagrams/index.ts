// Every diagram, by output file name (under docs/img/). Add a diagram here and it is generated, checked in CI, and
// must be embedded in a doc (diagrams.test.ts).
import type { TrackData } from "../../src/game/types/track";
import { laneChangePriceSvg } from "./laneChangePrice";
import { contextOf } from "./scenario";

export function allDiagrams(track: TrackData): Map<string, string> {
  const ctx = contextOf(track);
  return new Map([["lane-change-pricing.svg", laneChangePriceSvg(ctx)]]);
}
