// Diagrams: squeeze (docs/movement-spec.md, "Squeeze (boxed in)" and "Pit exit squeeze"). A car with no normal target may
// drive through cars to a free cell beyond them, +2 move points per car passed. Positions and prices come from
// `computeTargets`; the bars split each price into cells walked, lane change and cars passed.
import type { RaceContext } from "../../src/game/race/raceEngine";
import { SQUEEZE_SURCHARGE_PER_CAR } from "../../src/game/constants";
import type { TargetInfo } from "../../src/game/systems/movementSystem";
import { zoneRange } from "./bend";
import { priceBar, SEGMENT_COLORS, type Segment } from "./priceBar";
import { drawStrip, type StripSpec } from "./strip";
import { COLORS, document, panel, text } from "./svg";

// The spec's example on the inner lane: a car in your lane and one in the next, just ahead. (Lane 3 is two lanes away, so
// it plays no part; and on this track the outer lane's forwardIndex runs behind from zone 7, which would blur the picture.)
export const SQUEEZE_SPEC: StripSpec = {
  title: "Boxed in: a car in your lane and one in the next, just ahead",
  note: "No normal target exists, so the engine offers cells beyond the cars. Each free cell shows its price.",
  start: "Z05_L1_00",
  cars: ["Z06_L1_00", "Z06_L2_00"],
  zones: zoneRange(5, 9),
  lanes: [2, 1]
};
export const SQUEEZE_BARS = ["Z07_L1_00", "Z07_L2_00"];

// The exit of the pit lane blocked: the only way on is along lane 1, through the car(s) standing there.
function onLane1Ahead(c: { laneIndex: number; zoneIndex: number }): boolean {
  return c.laneIndex === 1 && c.zoneIndex > 6;
}
export const PIT_EXIT_CASES: { spec: StripSpec; bars: string[] }[] = [
  {
    spec: {
      title: "A car stands on the cell the exit leads to",
      note: "From the exit cell you may squeeze along lane 1, at most 3 cells, never back into the pit lane.",
      start: "Z06_L0_00",
      cars: ["Z07_L1_00"],
      zones: zoneRange(4, 10),
      lanes: [1, 0],
      mark: onLane1Ahead
    },
    bars: ["Z08_L1_00", "Z09_L1_00"]
  },
  {
    spec: {
      title: "Two cars in a row",
      note: "Only the cell beyond both is free: it passes both.",
      start: "Z06_L0_00",
      cars: ["Z07_L1_00", "Z08_L1_00"],
      zones: zoneRange(4, 10),
      lanes: [1, 0],
      mark: onLane1Ahead
    },
    bars: ["Z09_L1_00"]
  }
];

/** A squeeze price split into what it is made of; throws if the parts do not add up (a wrong example). */
export function squeezeParts(info: TargetInfo): { cells: number; laneChange: number; passed: number; cars: number } {
  const passed = info.squeezePassed;
  if (passed === undefined) throw new Error("not a squeeze target");
  const cars = passed * SQUEEZE_SURCHARGE_PER_CAR;
  const laneChange = (info.moveSpend ?? info.distance) - info.distance - cars;
  if (laneChange < 0) throw new Error(`price ${info.moveSpend} is less than its parts`);
  return { cells: info.distance, laneChange, passed, cars };
}

function barsOf(offered: Map<string, TargetInfo>, ids: string[], x: number, y: number): string {
  return ids
    .map((id, i) => {
      const info = offered.get(id);
      if (!info) throw new Error(`${id} is not offered`);
      const p = squeezeParts(info);
      const segments: Segment[] = [{ label: `${p.cells} cells`, value: p.cells, color: SEGMENT_COLORS.forward }];
      if (p.laneChange > 0) segments.push({ label: `+${p.laneChange} lane`, value: p.laneChange, color: SEGMENT_COLORS.surcharge });
      segments.push({ label: `+${p.cars} (${p.passed} car${p.passed === 1 ? "" : "s"})`, value: p.cars, color: COLORS.bad });
      const row = y + i * 66;
      return text(x, row, `${id}: ${p.cells} cells, ${p.passed} car${p.passed === 1 ? "" : "s"} passed`, { size: 12, color: COLORS.text }) + "\n" + priceBar(x, row + 10, segments, info.moveSpend ?? info.distance, COLORS.good);
    })
    .join("\n");
}

function barsHeight(n: number): number {
  return 20 + n * 66;
}

export function squeezeSvg(ctx: RaceContext): string {
  const body: string[] = [];
  body.push(text(40, 44, "Squeeze: driving through cars when boxed in", { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, `Only when no normal target exists: +${SQUEEZE_SURCHARGE_PER_CAR} move points per car passed.`));
  body.push(text(40, 88, "Main lanes only, at most one lane change, and a later zone than yours."));
  const strip = drawStrip(ctx, SQUEEZE_SPEC, 40, 108, 760);
  body.push(strip.svg);
  const y = 108 + strip.height + 20;
  const h = barsHeight(SQUEEZE_BARS.length) + 40;
  body.push(panel(40, y, 760, h));
  body.push(text(60, y + 28, "What two of those cost", { size: 14, bold: true, color: COLORS.text }));
  body.push(barsOf(strip.offered, SQUEEZE_BARS, 60, y + 56));
  return document(840, y + h + 20, body);
}

export function pitExitSqueezeSvg(ctx: RaceContext): string {
  const body: string[] = [];
  body.push(text(40, 44, "Pit exit squeeze: out through a blocked exit", { size: 22, bold: true, color: COLORS.text }));
  body.push(text(40, 70, `On the PIT_EXIT cell with no normal target: squeeze along lane 1, +${SQUEEZE_SURCHARGE_PER_CAR} per car passed.`));
  body.push(text(40, 88, "The pit lane has its own forwardIndex scale: its dots do not compare with lane 1."));
  let y = 108;
  for (const c of PIT_EXIT_CASES) {
    const strip = drawStrip(ctx, c.spec, 40, y, 760);
    body.push(strip.svg);
    y += strip.height + 10;
    body.push(barsOf(strip.offered, c.bars, 60, y + 14));
    y += barsHeight(c.bars.length) + 20;
  }
  return document(840, y, body);
}
