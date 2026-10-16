// What stands on the bend besides the cells: cars, "you", the target, and what the engine offers (a price) or does not
// (a cross) on each free cell.
import type { TargetInfo } from "../../src/game/systems/movementSystem";
import type { Point } from "./bend";
import { circle, COLORS, rect, text } from "./svg";

export function drawCars(cellPos: Map<string, Point>, cars: string[]): string {
  return cars
    .map((id) => {
      const c = cellPos.get(id)!;
      return (
        rect(c.x - 20, c.y - 14, 40, 28, `rx="6" fill="${COLORS.car}" stroke="${COLORS.carStroke}"`) +
        "\n" +
        text(c.x, c.y + 4, "car", { size: 11, anchor: "middle", color: COLORS.text })
      );
    })
    .join("\n");
}

export function drawYou(cellPos: Map<string, Point>, start: string): string {
  const you = cellPos.get(start)!;
  return (
    rect(you.x - 22, you.y - 15, 44, 30, `rx="7" fill="${COLORS.you}" stroke="#ffd0d2" stroke-width="2"`) +
    "\n" +
    text(you.x, you.y + 4, "you", { size: 12, bold: true, anchor: "middle", color: "#fff" })
  );
}

export function drawTarget(cellPos: Map<string, Point>, target: string): string {
  const tgt = cellPos.get(target)!;
  return (
    circle(tgt.x, tgt.y, 27, `fill="none" stroke="${COLORS.target}" stroke-width="3" stroke-dasharray="5 4"`) +
    "\n" +
    text(tgt.x, tgt.y + 46, "target", { size: 12, bold: true, anchor: "middle", color: COLORS.target })
  );
}

/** A cell where a car would be tucked in, with its gap to the car ahead; or, when it would not, a cross. */
export function drawTuck(p: Point, gap: number | null): string {
  const cover = circle(p.x, p.y, 21, `fill="${COLORS.bg}"`) + "\n";
  if (gap === null) {
    return cover + circle(p.x, p.y, 21, `fill="${COLORS.bg}" stroke="${COLORS.bad}" stroke-width="1.5" stroke-dasharray="3 3"`) + "\n" + text(p.x, p.y + 6, "×", { size: 18, bold: true, anchor: "middle", color: COLORS.bad });
  }
  return (
    cover +
    circle(p.x, p.y, 21, `fill="${COLORS.diagonal}" fill-opacity="0.2" stroke="${COLORS.diagonal}" stroke-width="2" stroke-dasharray="5 4"`) +
    "\n" +
    text(p.x, p.y + 5, gap, { size: 15, bold: true, anchor: "middle", color: COLORS.diagonal })
  );
}

/** A free cell the engine offers, with the move points it costs; or, when it does not, a cross. */
export function drawOffer(p: Point, info: TargetInfo | undefined): string {
  // an opaque disc first: it hides the cell's forwardIndex underneath
  const cover = circle(p.x, p.y, 21, `fill="${COLORS.bg}"`) + "\n";
  if (info) {
    return (
      cover +
      circle(p.x, p.y, 21, `fill="${COLORS.good}" fill-opacity="0.2" stroke="${COLORS.good}" stroke-width="2"`) +
      "\n" +
      text(p.x, p.y + 5, info.moveSpend ?? info.distance, { size: 15, bold: true, anchor: "middle", color: COLORS.good })
    );
  }
  return (
    cover +
    circle(p.x, p.y, 21, `fill="${COLORS.bg}" stroke="${COLORS.bad}" stroke-width="1.5" stroke-dasharray="3 3"`) +
    "\n" +
    text(p.x, p.y + 6, "×", { size: 18, bold: true, anchor: "middle", color: COLORS.bad })
  );
}
