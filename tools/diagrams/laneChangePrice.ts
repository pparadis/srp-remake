// Diagram: what one route costs by the written rule (docs/movement-spec.md, "Price of a lane change") and what the
// engine charges. Every number comes from the route (movePath) and from computeValidTargets; the rule is computed
// from the route's steps, so a disagreement shows as two different bars and an agreement as one.
import type { RaceContext } from "../../src/game/race/raceEngine";
import { movePath } from "../../src/game/systems/movePath";
import { drawBend, zoneRange } from "./bend";
import { priceBar, SEGMENT_COLORS, type Segment } from "./priceBar";
import { drawRoute, drawStepList, stepsOf, type Step } from "./route";
import { positionOf, targetOf, type Scenario } from "./scenario";
import { drawCars, drawTarget, drawYou } from "./marks";
import { COLORS, document, panel, text } from "./svg";

// The oval's top-left bend: you on lane 1, a car ahead on lane 1 and one on lane 2, the target two lanes over.
export const LANE_CHANGE_SCENARIO: Scenario = {
  start: "Z12_L1_00",
  cars: ["Z13_L1_00", "Z14_L2_00"],
  target: "Z15_L2_00",
  zones: [11, 16]
};

export interface Pricing {
  path: string[];
  steps: Step[];
  /** forward cells + lane changes: the written rule */
  rule: number;
  /** TargetInfo.moveSpend: what computeValidTargets charges */
  code: number;
  cellsWalked: number;
  forward: number;
  sideways: number;
  laneChanges: number;
}

/** The route and its two prices. Throws when the target is not one the engine offers (a wrong example). */
export function priceScenario(ctx: RaceContext, s: Scenario): Pricing {
  const info = targetOf(positionOf(ctx, s), s);
  const path = movePath(ctx.trackIndex, s.start, s.target, new Set(s.cars));
  const steps = stepsOf(path, ctx.trackIndex);
  const forward = steps.filter((x) => x.kind !== "sideways").length;
  const sideways = steps.filter((x) => x.kind === "sideways").length;
  const laneChanges = steps.filter((x) => x.kind !== "forward").length;
  if (steps.length !== info.distance) throw new Error(`route walks ${steps.length} cells, the engine ${info.distance}`);
  return { path, steps, rule: forward + laneChanges, code: info.moveSpend ?? info.distance, cellsWalked: steps.length, forward, sideways, laneChanges };
}

function segmentsOf(p: Pricing, price: number): Segment[] {
  const surcharge = price - p.cellsWalked;
  return [
    { label: `${p.forward} fwd`, value: p.forward, color: SEGMENT_COLORS.forward },
    { label: `${p.sideways} side`, value: p.sideways, color: SEGMENT_COLORS.sideways },
    { label: `+${surcharge}`, value: Math.max(surcharge, 1), color: SEGMENT_COLORS.surcharge, hatched: surcharge === 0 }
  ];
}

/** The words around a route picture; the numbers in it always come from the engine. */
export interface RouteCopy {
  title: string;
  /** the line under the title; a second line explains the number in a dot */
  intro: string;
}

export const LANE_CHANGE_COPY: RouteCopy = {
  title: "Lane-change price: what the rule says, and what the code charges",
  intro: "One real route on the oval's bend"
};

/** One route drawn on a bend, step by step, with its price by the written rule and by the engine. */
export function laneChangePriceSvg(ctx: RaceContext, s: Scenario = LANE_CHANGE_SCENARIO, copy: RouteCopy = LANE_CHANGE_COPY): string {
  const p = priceScenario(ctx, s);
  const bend = drawBend(ctx.trackIndex, zoneRange(...s.zones), { x: 60, y: 146, w: 660 });
  const panelH = Math.max(300, bend.height + 84);
  const listY = 108 + panelH + 34;
  const height = Math.max(640, listY + 22 + p.steps.length * 24 + 40);
  const body: string[] = [];
  body.push(text(40, 44, copy.title, { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, `${copy.intro} (zones ${s.zones[0]}-${s.zones[1]}), drawn as it is on the board, travel left to right.`));
  body.push(text(40, 88, "The number in a dot is the cell's forwardIndex; a step is priced by the lap position it gains (below)."));
  body.push(panel(40, 108, 700, panelH));
  body.push(bend.svg);
  body.push(drawCars(bend.cellPos, s.cars));
  body.push(drawYou(bend.cellPos, s.start));
  body.push(drawTarget(bend.cellPos, s.target));
  body.push(drawRoute(p.steps, bend.cellPos));

  body.push(text(40, listY, `The route, step by step (${p.cellsWalked} cells walked, ${p.forward} of them forward, ${p.laneChanges} lane changes)`, { bold: true, color: COLORS.text }));
  body.push(drawStepList(p.steps, 40, listY + 22));

  body.push(panel(780, 100, 400, height - 140));
  body.push(text(800, 134, "What this route costs", { size: 16, bold: true, color: COLORS.text }));
  if (p.rule === p.code) {
    body.push(text(800, 179, "The rule and the code agree", { bold: true, color: COLORS.text }));
    body.push(text(800, 196, "every lane change +1, on top of the forward cells", { size: 11 }));
    body.push(priceBar(800, 205, segmentsOf(p, p.code), p.code, COLORS.good));
  } else {
    body.push(text(800, 179, "The rule (docs/movement-spec.md)", { bold: true, color: COLORS.text }));
    body.push(text(800, 196, "every lane change +1, on top of the forward cells", { size: 11 }));
    body.push(priceBar(800, 205, segmentsOf(p, p.rule), p.rule, COLORS.good));
    body.push(text(800, 309, "The code", { bold: true, color: COLORS.text }));
    body.push(text(800, 326, "TargetInfo.moveSpend from computeValidTargets", { size: 11 }));
    body.push(priceBar(800, 335, segmentsOf(p, p.code), p.code, COLORS.bad));
    const diff = p.rule - p.code;
    body.push(text(800, 420, `The code charges ${Math.abs(diff)} point${Math.abs(diff) === 1 ? "" : "s"} ${diff > 0 ? "under" : "over"} the rule.`, { size: 11, color: COLORS.sideways }));
  }
  body.push(text(800, height - 70, `${p.forward} forward cell${p.forward === 1 ? "" : "s"} cost ${p.code} points here.`, { size: 11, color: COLORS.sideways }));
  return document(1220, height, body);
}
