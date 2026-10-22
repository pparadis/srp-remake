// Diagram: the size of a move is a resource decision (docs/movement-spec.md, "Resources (rules v3)"). One soft-tyre car
// (cap 9) on an empty lane 1 and its 7, 8 and 9 point targets: the fuel and the tire each costs come from
// `computeTargets` on rules v3, so a change of the factors changes the picture.
import type { RaceContext } from '../../src/game/race/race_engine';
import { priceBar, SEGMENT_COLORS } from './price_bar';
import { offeredFrom, positionOf } from './scenario';
import { COLORS, document, panel, text } from './svg';

export const SIZE_START = 'Z05_L1_00';
// 7, 8 and 9 cells down lane 1 (one cell a zone): the points are the cells, no lane change.
export const SIZE_TARGETS = ['Z12_L1_00', 'Z13_L1_00', 'Z14_L1_00'];
const LABELS = ['7: conservative', '8: normal', '9: high consumption'];

export function moveSizeSvg(ctx: RaceContext): string {
  const targets = offeredFrom(
    positionOf(ctx, { start: SIZE_START, cars: [], edit: { compound: 'soft' } }, 'v3')
  );
  const body: string[] = [
    text(40, 44, 'The size of a move is a resource decision', {
      size: 22,
      bold: true,
      color: COLORS.text
    })
  ];
  body.push(
    text(40, 70, 'Rules v3, soft tires (cap 9), a lane-1 straight, 5 laps, full tank, no tow.')
  );
  body.push(
    text(
      40,
      88,
      'Fuel and tire per cell grow with the move points: 7 or less saves, 9 burns the most.'
    )
  );
  const rowH = 86;
  const y = 108;
  const ph = 20 + SIZE_TARGETS.length * rowH;
  body.push(panel(40, y, 760, ph));
  SIZE_TARGETS.forEach((id, i) => {
    const info = targets.get(id);
    if (!info) throw new Error(`${id} is not a target from ${SIZE_START}`);
    const points = info.moveSpend ?? info.distance;
    const row = y + 36 + i * rowH;
    body.push(text(60, row, LABELS[i]!, { size: 12, bold: true, color: COLORS.text }));
    body.push(
      priceBar(
        60,
        row + 10,
        [{ label: `${info.distance} cells`, value: info.distance, color: SEGMENT_COLORS.forward }],
        points,
        COLORS.good
      )
    );
    body.push(
      text(300, row, `fuel ${info.fuelCost} · tire ${info.tireCost}`, {
        size: 14,
        bold: true,
        color: COLORS.text
      })
    );
  });
  return document(840, y + ph + 20, body);
}
