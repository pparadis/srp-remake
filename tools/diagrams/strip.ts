// A titled panel with one position drawn on a stretch of the track: every free cell the rule is about shows what the
// engine offers there (its move points) or a cross, with the cars and "you" on top. Shared by the diagrams that read
// `computeTargets` (blockers, squeeze, pit).
import type { RaceContext } from "../../src/game/race/raceEngine";
import type { CarEdit } from "../../src/game/race/sandbox";
import type { TargetInfo } from "../../src/game/systems/movementSystem";
import type { TrackCell } from "../../src/game/types/track";
import { drawBend, type Bend } from "./bend";
import { drawCars, drawOffer, drawYou } from "./marks";
import { offeredFrom, positionOf } from "./scenario";
import { COLORS, panel, text } from "./svg";

export interface StripSpec {
  title: string;
  note: string;
  start: string;
  cars: string[];
  /** zones left to right, e.g. [27, 28, 1, 2] across the start line */
  zones: number[];
  /** lanes top to bottom; default 3, 2, 1 */
  lanes?: number[];
  zoneStep?: number;
  edit?: CarEdit;
  /** which free cells get an offer or a cross; default: the main-lane cells further along than the start */
  mark?: (cell: TrackCell, start: TrackCell) => boolean;
}

export interface Strip {
  svg: string;
  height: number;
  bend: Bend;
  offered: Map<string, TargetInfo>;
}

const ahead = (c: TrackCell, start: TrackCell) => c.laneIndex !== 0 && c.forwardIndex > start.forwardIndex;

/** The panel's height for `lanes` rows. */
export const stripHeight = (laneCount: number) => 100 + (laneCount - 1) * 62 + 36;

export function drawStrip(ctx: RaceContext, spec: StripSpec, x: number, y: number, width: number): Strip {
  const lanes = spec.lanes ?? [3, 2, 1];
  const mark = spec.mark ?? ahead;
  const offered = offeredFrom(positionOf(ctx, spec));
  const height = stripHeight(lanes.length);
  const parts: string[] = [panel(x, y, width, height)];
  parts.push(text(x + 20, y + 28, spec.title, { size: 14, bold: true, color: COLORS.text }));
  parts.push(text(x + 20, y + 46, spec.note, { size: 11 }));
  const bend = drawBend(ctx.trackIndex, spec.zones, { x: x + 150, y: y + 100, zoneStep: spec.zoneStep ?? 104, laneStep: 62 }, lanes);
  parts.push(bend.svg);
  const start = ctx.cellMap.get(spec.start)!;
  for (const [id, p] of bend.cellPos) {
    if (id === spec.start || spec.cars.includes(id) || !mark(ctx.cellMap.get(id)!, start)) continue;
    parts.push(drawOffer(p, offered.get(id)));
  }
  parts.push(drawCars(bend.cellPos, spec.cars));
  parts.push(drawYou(bend.cellPos, spec.start));
  return { svg: parts.join("\n"), height, bend, offered };
}
