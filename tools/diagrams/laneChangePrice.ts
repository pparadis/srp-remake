// Diagram: what one route costs by the written rule (docs/movement-spec.md, "Price of a lane change") and what the
// engine charges. Every number comes from the route (movePath) and from computeValidTargets; the rule is computed
// from the route's steps, so a disagreement shows as two different bars and an agreement as one.
import { MOVE_BUDGET, MOVE_RATES } from "../../src/game/constants";
import { computeValidTargets } from "../../src/game/systems/movementSystem";
import { movePath } from "../../src/game/systems/movePath";
import type { TrackIndex } from "../../src/game/systems/trackIndex";
import type { CarSetup } from "../../src/game/types/car";
import { drawBend } from "./bend";
import { priceBar, SEGMENT_COLORS, type Segment } from "./priceBar";
import { drawRoute, drawStepList, stepsOf, type Step } from "./route";
import { circle, COLORS, document, panel, rect, text } from "./svg";

export interface Scenario {
  start: string;
  cars: string[];
  target: string;
  zones: [number, number];
}

// The oval's top-left bend: you on lane 1, a car ahead on lane 1 and one on lane 2, the target two lanes over.
export const LANE_CHANGE_SCENARIO: Scenario = {
  start: "Z12_L1_00",
  cars: ["Z13_L1_00", "Z14_L2_00"],
  target: "Z15_L2_00",
  zones: [11, 16]
};

const SETUP: CarSetup = { compound: "hard", psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wing: "medium" };

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
export function priceScenario(trackIndex: TrackIndex, s: Scenario): Pricing {
  const blocked = new Set(s.cars);
  const path = movePath(trackIndex, s.start, s.target, blocked);
  const steps = stepsOf(path, trackIndex.cellMap);
  const targets = computeValidTargets(
    trackIndex,
    s.start,
    new Set([s.start, ...s.cars]),
    MOVE_BUDGET.baseMax,
    {},
    { tireRate: MOVE_RATES.hardTire, fuelRate: MOVE_RATES.fuel, setup: SETUP }
  );
  const info = targets.get(s.target);
  if (!info) throw new Error(`${s.target} is not a target from ${s.start}`);
  const forward = steps.filter((x) => x.kind !== "sideways" && x.to.forwardIndex > x.from.forwardIndex).length;
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

export function laneChangePriceSvg(trackIndex: TrackIndex, s: Scenario = LANE_CHANGE_SCENARIO): string {
  const p = priceScenario(trackIndex, s);
  const H = Math.max(640, 580 + p.steps.length * 24 + 40);
  const body: string[] = [];
  body.push(text(40, 44, "Lane-change price: what the rule says, and what the code charges", { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, `One real route on the oval's bend (zones ${s.zones[0]}-${s.zones[1]}), drawn straight: zones left to right, lanes top to bottom.`));
  body.push(text(40, 88, "The number in a dot is the cell's forwardIndex: it does not go up when a step only changes lane."));
  body.push(panel(40, 108, 700, 420));
  const bend = drawBend(trackIndex, s.zones, { x: 160, y: 193, zoneStep: 104, laneStep: 105 });
  body.push(bend.svg);
  for (const id of s.cars) {
    const c = bend.cellPos.get(id)!;
    body.push(rect(c.x - 20, c.y - 14, 40, 28, `rx="6" fill="${COLORS.car}" stroke="${COLORS.carStroke}"`));
    body.push(text(c.x, c.y + 4, "car", { size: 11, anchor: "middle", color: COLORS.text }));
  }
  const you = bend.cellPos.get(s.start)!;
  body.push(rect(you.x - 22, you.y - 15, 44, 30, `rx="7" fill="${COLORS.you}" stroke="#ffd0d2" stroke-width="2"`));
  body.push(text(you.x, you.y + 4, "you", { size: 12, bold: true, anchor: "middle", color: "#fff" }));
  const tgt = bend.cellPos.get(s.target)!;
  body.push(circle(tgt.x, tgt.y, 27, `fill="none" stroke="${COLORS.target}" stroke-width="3" stroke-dasharray="5 4"`));
  body.push(text(tgt.x, tgt.y + 46, "target", { size: 12, bold: true, anchor: "middle", color: COLORS.target }));
  body.push(drawRoute(p.steps, bend.cellPos));

  body.push(text(40, 562, `The route, step by step (${p.cellsWalked} cells walked, ${p.forward} of them forward, ${p.laneChanges} lane changes)`, { bold: true, color: COLORS.text }));
  body.push(drawStepList(p.steps, 40, 584));

  body.push(panel(780, 100, 400, H - 140));
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
  body.push(text(800, H - 70, `${p.forward} forward cell${p.forward === 1 ? "" : "s"} cost ${p.code} points here.`, { size: 11, color: COLORS.sideways }));
  return document(1220, H, body);
}
