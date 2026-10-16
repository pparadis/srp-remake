// A route over a bend: each step has a kind, and the same kinds drive the drawing, the legend and the price.
import type { TrackCell } from "../../src/game/types/track";
import type { Point } from "./bend";
import { badge, COLORS, text } from "./svg";

export type StepKind = "sideways" | "forward" | "diagonal";
export interface Step {
  from: TrackCell;
  to: TrackCell;
  kind: StepKind;
}

const KIND_COLOR: Record<StepKind, string> = {
  sideways: COLORS.sideways,
  forward: COLORS.forward,
  diagonal: COLORS.diagonal
};

export function stepsOf(path: string[], cellMap: Map<string, TrackCell>): Step[] {
  const steps: Step[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const from = cellMap.get(path[i - 1]!)!;
    const to = cellMap.get(path[i]!)!;
    const laneChange = from.laneIndex !== to.laneIndex;
    const gain = to.forwardIndex > from.forwardIndex;
    steps.push({ from, to, kind: laneChange ? (gain ? "diagonal" : "sideways") : "forward" });
  }
  return steps;
}

/** The step's sentence: what it does to lane and forwardIndex, and how it is paid. */
export function describe(step: Step): string {
  const lane = `lane ${step.from.laneIndex} to ${step.to.laneIndex}`;
  const fwd = `forwardIndex ${step.from.forwardIndex} to ${step.to.forwardIndex}`;
  if (step.kind === "sideways") return `${lane}, ${fwd}: sideways: its cell pays the lane change`;
  if (step.kind === "diagonal") return `${lane}, ${fwd}: diagonal: needs the +1 surcharge`;
  return `same lane, ${fwd}: a forward cell`;
}

export function drawRoute(steps: Step[], cellPos: Map<string, Point>): string {
  const parts: string[] = [];
  steps.forEach((s, i) => {
    const a = cellPos.get(s.from.id)!;
    const b = cellPos.get(s.to.id)!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const color = KIND_COLOR[s.kind];
    const x1 = a.x + ux * 24;
    const y1 = a.y + uy * 24;
    const x2 = b.x - ux * 26;
    const y2 = b.y - uy * 26;
    const dash = s.kind === "sideways" ? ' stroke-dasharray="8 6"' : "";
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="4"${dash}/>`);
    const tipX = x2 + ux * 6;
    const tipY = y2 + uy * 6;
    const px = -uy * 5.4;
    const py = ux * 5.4;
    parts.push(`<polygon points="${tipX.toFixed(1)},${tipY.toFixed(1)} ${(x2 + px).toFixed(1)},${(y2 + py).toFixed(1)} ${(x2 - px).toFixed(1)},${(y2 - py).toFixed(1)}" fill="${color}"/>`);
    // the badge sits beside the arrow so it does not hide it
    parts.push(badge((x1 + x2) / 2 + py * 3, (y1 + y2) / 2 - px * 3, i + 1, color));
  });
  return parts.join("\n");
}

export function drawStepList(steps: Step[], x: number, y: number): string {
  return steps
    .map((s, i) => badge(x + 12, y + i * 24, i + 1, KIND_COLOR[s.kind]) + text(x + 32, y + i * 24 + 4, describe(s), { size: 12, color: KIND_COLOR[s.kind] }))
    .join("\n");
}
