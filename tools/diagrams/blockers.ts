// Diagram: which cells the engine offers around other cars (docs/movement-spec.md, "Occupancy"). Every free cell ahead
// of "you" shows the move points the engine charges for it, or a cross when it is not offered at all.
import type { RaceContext } from "../../src/game/race/raceEngine";
import { drawBend } from "./bend";
import { drawCars, drawOffer, drawYou } from "./marks";
import { offeredFrom, positionOf, type Scenario } from "./scenario";
import { COLORS, document, panel, text } from "./svg";

export interface BlockerPanel {
  title: string;
  note: string;
  scenario: Omit<Scenario, "target">;
}

export const BLOCKER_PANELS: BlockerPanel[] = [
  {
    title: "A lane change passes one car in its lane, never the second",
    note: "Two cars in lane 3: merging past the first car is fine, the cell past the second is not.",
    scenario: { start: "Z12_L2_00", cars: ["Z14_L3_00", "Z16_L3_00"], zones: [12, 17] }
  },
  {
    title: "With only one car in the lane, the lane is open beyond it",
    note: "A lone car can be passed like the first of two.",
    scenario: { start: "Z12_L2_00", cars: ["Z14_L3_00"], zones: [12, 17] }
  },
  {
    title: "A full row cannot be passed: occupied cells are never driven through",
    note: "With no free way round, nothing beyond the row is offered, in any lane.",
    scenario: { start: "Z12_L2_00", cars: ["Z14_L1_00", "Z14_L2_00", "Z14_L3_00"], zones: [12, 17] }
  }
];

const PANEL_H = 280;
const TOP = 128;

/** What the engine offers car 1 in a panel's position, for every free cell ahead of it. */
export function offersOf(ctx: RaceContext, s: BlockerPanel["scenario"]) {
  return offeredFrom(positionOf(ctx, s));
}

export function blockersSvg(ctx: RaceContext): string {
  const body: string[] = [];
  body.push(text(40, 44, "Cars in the way: what the engine offers", { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, "Each free cell ahead of you shows the move points it costs, or a cross when it is not offered."));
  body.push(text(40, 88, "Zones left to right, lanes top to bottom; the number in a plain dot is its forwardIndex."));
  body.push(text(40, 106, "A cell in your own zone is never offered: a car only moves forward, straight or diagonally."));
  BLOCKER_PANELS.forEach((pn, i) => {
    const y = TOP + i * PANEL_H;
    const s = pn.scenario;
    const offered = offersOf(ctx, s);
    body.push(panel(40, y, 760, PANEL_H - 20));
    body.push(text(60, y + 28, pn.title, { size: 14, bold: true, color: COLORS.text }));
    body.push(text(60, y + 46, pn.note, { size: 11 }));
    const bend = drawBend(ctx.trackIndex, s.zones, { x: 190, y: y + 100, zoneStep: 104, laneStep: 62 });
    body.push(bend.svg);
    const fwd = ctx.cellMap.get(s.start)!.forwardIndex;
    for (const [id, p] of bend.cellPos) {
      if (id === s.start || s.cars.includes(id) || ctx.cellMap.get(id)!.forwardIndex <= fwd) continue;
      body.push(drawOffer(p, offered.get(id)));
    }
    body.push(drawCars(bend.cellPos, s.cars));
    body.push(drawYou(bend.cellPos, s.start));
  });
  return document(840, TOP + BLOCKER_PANELS.length * PANEL_H, body);
}
