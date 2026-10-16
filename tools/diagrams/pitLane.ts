// Diagrams: the pit rules (docs/movement-spec.md, "Pit Rules"): where you may enter, how far you move in the pit lane,
// the jump to a box, and the exit. Each cell the rule is about shows what `computeTargets` offers there, or a cross.
import type { RaceContext } from "../../src/game/race/raceEngine";
import type { TrackCell } from "../../src/game/types/track";
import { drawStrip, type StripSpec } from "./strip";
import { COLORS, document, text } from "./svg";

const pitCell = (c: TrackCell) => c.laneIndex === 0;
// ahead of the start along the pit lane (its forwardIndex scale is its own)
const pitAhead = (c: TrackCell, s: TrackCell) => pitCell(c) && c.forwardIndex > s.forwardIndex;
const SIDE = "The pit lane has its own forwardIndex scale: its dots do not compare with lane 1.";

export const PIT_ENTRY_PANELS: StripSpec[] = [
  {
    title: "Entry: from lane 1, in the zone before the entry",
    note: "Z28_L0_00 is the PIT_ENTRY cell.",
    start: "Z27_L1_00",
    cars: [],
    zones: [26, 27, 28, 1],
    lanes: [1, 0],
    mark: pitCell
  },
  {
    title: "Not from lane 2 (or 3): only lane 1 leads into the pit",
    note: "The entry is a step away, but not from this lane.",
    start: "Z27_L2_00",
    cars: [],
    zones: [26, 27, 28, 1],
    lanes: [2, 1, 0],
    mark: pitCell
  },
  {
    title: "Not from two zones away: the entry is taken at distance 1",
    note: "No multi-zone jump into the pit.",
    start: "Z26_L1_00",
    cars: [],
    zones: [26, 27, 28, 1],
    lanes: [1, 0],
    mark: pitCell
  }
];

export const PIT_LANE_PANELS: StripSpec[] = [
  {
    title: "In the pit lane you move one step",
    note: "Z01_L0_00 is the PIT_LINE cell, under the start line.",
    start: "Z28_L0_00",
    cars: [],
    zones: [28, 1, 2, 3, 4, 5],
    lanes: [1, 0],
    zoneStep: 90,
    mark: pitAhead
  },
  {
    title: "Next to a PIT_BOX you may target any box ahead",
    note: "Z02_L0_00 and Z03_L0_00 are boxes; the cells after them are still one step only.",
    start: "Z01_L0_00",
    cars: [],
    zones: [28, 1, 2, 3, 4, 5],
    lanes: [1, 0],
    zoneStep: 90,
    mark: pitAhead
  },
  {
    title: "The exit leads back onto lane 1",
    note: "Z06_L0_00 is the PIT_EXIT cell: one step, onto lane 1.",
    start: "Z06_L0_00",
    cars: [],
    zones: [4, 5, 6, 7, 8, 9],
    lanes: [1, 0],
    zoneStep: 90,
    mark: (c) => c.zoneIndex > 6
  }
];

function stack(ctx: RaceContext, title: string, intro: string[], panels: StripSpec[]): string {
  const body: string[] = [text(40, 44, title, { size: 22, bold: true, color: COLORS.text })];
  intro.forEach((line, i) => body.push(text(40, 70 + i * 18, line)));
  let y = 70 + intro.length * 18 + 20;
  for (const spec of panels) {
    const strip = drawStrip(ctx, spec, 40, y, 760);
    body.push(strip.svg);
    y += strip.height + 20;
  }
  return document(840, y, body);
}

export const pitEntrySvg = (ctx: RaceContext) =>
  stack(ctx, "Pit entry: from lane 1, one zone before", ["Each pit cell shows what the engine offers, or a cross.", SIDE], PIT_ENTRY_PANELS);

export const pitLaneSvg = (ctx: RaceContext) =>
  stack(ctx, "In the pit lane: one step, the box jump, the exit", ["Each cell shows what the engine offers, or a cross.", SIDE], PIT_LANE_PANELS);
