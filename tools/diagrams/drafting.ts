// Diagram: drafting (docs/movement-spec.md, "Drafting"). Where a car is tucked in (from `draftAhead`), and what the run
// of moves ended tucked in buys on the next move (from `computeTargets` with `Car.draftTurns` 0, 1, 2).
import type { RaceContext } from '../../src/game/race/raceEngine';
import { DRAFT_RANGE, DRAFT_SLINGSHOT_TURNS } from '../../src/game/constants';
import { draftAhead } from '../../src/game/systems/draftSystem';
import type { TargetInfo } from '../../src/game/systems/movementSystem';
import { zoneRange } from './bend';
import { drawCars, drawTuck } from './marks';
import { priceBar, SEGMENT_COLORS } from './priceBar';
import { offeredFrom, positionOf } from './scenario';
import { bendPanel } from './strip';
import { COLORS, document, panel, text } from './svg';

// The car ahead, and where every other cell would stand in relation to it.
export const LEADER = 'Z08_L2_00';
export const TOW_ZONES = zoneRange(5, 9);
// The same on the outer lane's bend, where forwardIndex repeats (Z12_L3 and Z13_L3 are both 10): the gap is in cells
// along the lane, so the car right behind the leader is still tucked in (#113).
export const OUTER_LEADER = 'Z13_L3_00';
export const OUTER_ZONES = zoneRange(10, 14);

/** The gap to the leader a car on `cellId` would have in the tow, or null when it would not be tucked in. */
export function towGap(ctx: RaceContext, cellId: string, leader = LEADER): number | null {
  return draftAhead(ctx.trackIndex, cellId, [leader, cellId])?.gap ?? null;
}

// You on the inner lane: a 4-cell move in your lane, and a 3-cell move with a lane change.
export const RUN_START = 'Z05_L1_00';
export const RUN_SAME_LANE = 'Z09_L1_00';
export const RUN_LANE_CHANGE = 'Z08_L2_00';
export const RUN_STAGES = [
  { run: 0, label: 'Run 0: no tow' },
  { run: 1, label: 'Run 1: the last move ended tucked in' },
  {
    run: DRAFT_SLINGSHOT_TURNS,
    label: `Run ${DRAFT_SLINGSHOT_TURNS}: tucked in twice in a row: the slingshot`
  }
];

export function runTargets(ctx: RaceContext, run: number): Map<string, TargetInfo> {
  return offeredFrom(positionOf(ctx, { start: RUN_START, cars: [], edit: { draftTurns: run } }));
}

export function draftingSvg(ctx: RaceContext): string {
  const body: string[] = [
    text(40, 44, 'Drafting: the tow and the slingshot', {
      size: 22,
      bold: true,
      color: COLORS.text
    })
  ];
  body.push(
    text(
      40,
      70,
      `Tucked in: ${DRAFT_RANGE} cells or fewer behind a car in your own lane, judged at the end of a move.`
    )
  );
  body.push(
    text(40, 88, 'Once: the next move wears less. Twice in a row: the next lane change is free.')
  );

  // 1. where a car is tucked in
  let y = 108;
  const lanes = [3, 2, 1];
  const tow = bendPanel(
    ctx,
    {
      title: 'Where you are tucked in',
      note: 'The number is the gap to the car ahead. Not in the next lane, not further back.',
      zones: TOW_ZONES,
      lanes
    },
    40,
    y,
    760
  );
  const bend = tow.bend;
  body.push(tow.svg);
  for (const [id, p] of bend.cellPos) if (id !== LEADER) body.push(drawTuck(p, towGap(ctx, id)));
  body.push(drawCars(bend.cellPos, [LEADER]));
  y += tow.height + 20;

  // 1b. the same on the outer lane, where two neighbouring cells share a forwardIndex
  const bendPanelOuter = bendPanel(
    ctx,
    {
      title: "On the outer lane's bend: counted in cells, not by the number in the dot",
      note: 'Lane 3 has 32 cells, so two neighbours can share a forwardIndex (10 and 10). The gap is still 1.',
      zones: OUTER_ZONES,
      lanes
    },
    40,
    y,
    760
  );
  const outer = bendPanelOuter.bend;
  body.push(bendPanelOuter.svg);
  for (const [id, p] of outer.cellPos) {
    if (id !== OUTER_LEADER) body.push(drawTuck(p, towGap(ctx, id, OUTER_LEADER)));
  }
  body.push(drawCars(outer.cellPos, [OUTER_LEADER]));
  // the dots show the gap, so the repeated forwardIndex is written under the lane-3 cells
  for (const [id, p] of outer.cellPos) {
    const c = ctx.cellMap.get(id)!;
    if (c.laneIndex === 3) {
      body.push(text(p.x, p.y - 26, `fwd ${c.forwardIndex}`, { size: 10, anchor: 'middle' }));
    }
  }
  y += bendPanelOuter.height + 20;

  // 2. what the run buys
  const rowH = 86;
  const ph = 56 + RUN_STAGES.length * rowH;
  body.push(panel(40, y, 760, ph));
  body.push(
    text(60, y + 28, 'What the run buys on your next move', {
      size: 14,
      bold: true,
      color: COLORS.text
    })
  );
  RUN_STAGES.forEach((s, i) => {
    const t = runTargets(ctx, s.run);
    const same = t.get(RUN_SAME_LANE)!;
    const change = t.get(RUN_LANE_CHANGE)!;
    const row = y + 58 + i * rowH;
    const price = change.moveSpend ?? change.distance;
    const surcharge = price - change.distance;
    body.push(text(60, row, s.label, { size: 12, bold: true, color: COLORS.text }));
    body.push(
      text(
        60,
        row + 18,
        `${same.distance}-cell move in your lane: fuel ${same.fuelCost}${same.drafted ? ' (tow discount)' : ''}`,
        { size: 11 }
      )
    );
    body.push(
      priceBar(
        60,
        row + 26,
        [
          {
            label: `${change.distance} cells`,
            value: change.distance,
            color: SEGMENT_COLORS.forward
          },
          {
            label: change.slingshot ? '+0' : '+1',
            value: 1,
            color: SEGMENT_COLORS.surcharge,
            hatched: surcharge === 0
          }
        ],
        price,
        COLORS.good
      )
    );
    body.push(
      text(
        460,
        row + 51,
        `${change.distance}-cell lane change${change.slingshot ? ': slingshot, surcharge waived' : ''}`,
        { size: 11 }
      )
    );
  });
  return document(840, y + ph + 20, body);
}
