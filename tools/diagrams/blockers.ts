// Diagram: which cells the engine offers around other cars (docs/movement-spec.md, "Occupancy"). Every free cell ahead
// of "you" shows the move points the engine charges for it, or a cross when it is not offered at all.
import type { RaceContext } from "../../src/game/race/raceEngine";
import { zoneRange } from "./bend";
import { drawStrip, type StripSpec } from "./strip";
import { COLORS, document, text } from "./svg";

export type BlockerPanel = Pick<StripSpec, "title" | "note" | "start" | "cars" | "zones">;

export const BLOCKER_PANELS: BlockerPanel[] = [
  {
    title: "Cars in the next lane are no cap: a lane change may pass any number of them",
    note: "Two cars in lane 3: the cells between, and past, both are offered; each price is its route's.",
    start: "Z12_L2_00",
    cars: ["Z14_L3_00", "Z16_L3_00"],
    zones: zoneRange(12, 17)
  },
  {
    title: "A pack in the next lane: past it by the free lane, as far as the budget reaches",
    note: "Four cars in lane 1, lane 2 free: 7 cells down lane 2 and in is 8 points, one more is 9, then the cap.",
    start: "Z16_L2_00",
    cars: ["Z18_L1_00", "Z19_L1_00", "Z20_L1_00", "Z21_L1_00"],
    zones: zoneRange(16, 24)
  },
  {
    title: "A full row cannot be passed: occupied cells are never driven through",
    note: "With no free way round, nothing beyond the row is offered, in any lane.",
    start: "Z12_L2_00",
    cars: ["Z14_L1_00", "Z14_L2_00", "Z14_L3_00"],
    zones: zoneRange(12, 17)
  }
];

const GAP = 20;
const TOP = 128;

export function blockersSvg(ctx: RaceContext): string {
  const body: string[] = [];
  body.push(text(40, 44, "Cars in the way: what the engine offers", { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, "Each free cell ahead of you shows the move points it costs, or a cross when it is not offered."));
  body.push(text(40, 88, "Drawn as on the board, travel left to right; the number in a plain dot is its forwardIndex."));
  body.push(text(40, 106, "A cell in your own zone is never offered: a car only moves forward, straight or diagonally."));
  let y = TOP;
  for (const pn of BLOCKER_PANELS) {
    const strip = drawStrip(ctx, pn, 40, y, 760);
    body.push(strip.svg);
    y += strip.height + GAP;
  }
  return document(840, y, body);
}
