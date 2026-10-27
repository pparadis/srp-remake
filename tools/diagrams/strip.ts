// A titled panel with one position drawn on a stretch of the track: every free cell the rule is about shows what the
// engine offers there (its move points) or a cross, with the cars and "you" on top. Shared by the diagrams that read
// `computeTargets` (blockers, squeeze, pit).
import type { RaceContext } from '../../src/game/race/race_engine';
import type { RulesVersion } from '../../src/game/rules/ids';
import type { CarEdit } from '../../src/game/race/sandbox';
import type { TargetInfo } from '../../src/game/systems/movement_system';
import type { TrackCell } from '../../src/game/types/track';
import { drawBend, type Bend } from './bend';
import { drawCars, drawOffer, drawYou } from './marks';
import { offeredFrom, positionOf } from './scenario';
import { COLORS, panel, text } from './svg';

export interface StripSpec {
  title: string;
  note: string;
  start: string;
  cars: string[];
  /** the stretch, in driving order, e.g. [27, 28, 1, 2] across the start line (other lanes add their level cells) */
  zones: number[];
  /** lanes top to bottom; default 3, 2, 1 */
  lanes?: number[];
  edit?: CarEdit;
  /** the rules version the position is played on; default as `positionOf` (v2) */
  rules?: RulesVersion;
  /** which free cells get an offer or a cross; default: the main-lane cells further along than the start */
  mark?: (cell: TrackCell, start: TrackCell) => boolean;
}

export interface Strip {
  svg: string;
  height: number;
  bend: Bend;
  offered: Map<string, TargetInfo>;
}

function ahead(c: TrackCell, start: TrackCell): boolean {
  return c.laneIndex !== 0 && c.forwardIndex > start.forwardIndex;
}

/**
 * A titled panel with a stretch of the track drawn in it as it is on the board, sized to the drawing; `below` leaves
 * room under the lowest dot (labels, a price).
 */
export function bendPanel(
  ctx: RaceContext,
  head: { title: string; note: string; zones: number[]; lanes: number[] },
  x: number,
  y: number,
  width: number,
  below = 36
): { svg: string; bend: Bend; height: number } {
  const bend = drawBend(
    ctx.trackIndex,
    head.zones,
    { x: x + 20, y: y + 86, w: width - 40 },
    head.lanes
  );
  const height = 86 + bend.height + below;
  return {
    svg: [
      panel(x, y, width, height),
      text(x + 20, y + 28, head.title, { size: 14, bold: true, color: COLORS.text }),
      text(x + 20, y + 46, head.note, { size: 11 }),
      bend.svg
    ].join('\n'),
    bend,
    height
  };
}

export function drawStrip(
  ctx: RaceContext,
  spec: StripSpec,
  x: number,
  y: number,
  width: number
): Strip {
  const lanes = spec.lanes ?? [3, 2, 1];
  const mark = spec.mark ?? ahead;
  const offered = offeredFrom(positionOf(ctx, spec, spec.rules));
  const { svg, bend, height } = bendPanel(ctx, { ...spec, lanes }, x, y, width);
  const parts: string[] = [svg];
  const start = ctx.cellMap.get(spec.start)!;
  for (const [id, p] of bend.cellPos) {
    if (id === spec.start || spec.cars.includes(id) || !mark(ctx.cellMap.get(id)!, start)) continue;
    parts.push(drawOffer(p, offered.get(id)));
  }
  parts.push(drawCars(bend.cellPos, spec.cars));
  parts.push(drawYou(bend.cellPos, spec.start));
  return { svg: parts.join('\n'), height, bend, offered };
}
