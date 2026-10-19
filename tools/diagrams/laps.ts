// Diagram: where a lap is counted (docs/movement-spec.md, "Laps"). The start line spans every lane, the pit lane too:
// each panel plays a few moves with the engine's applyAction and prints the completed laps after each, so a move that
// credits a lap (or one that must not) is read off the engine, not typed.
import type { RaceContext } from '../../src/game/race/race_engine';
import { lapCountAtSpawn } from '../../src/game/systems/lap_progress';
import { movePath } from '../../src/game/systems/move_path';
import { drawRoute, stepsOf } from './route';
import { drawYou } from './marks';
import { playMoves, positionOf } from './scenario';
import { bendPanel } from './strip';
import { COLORS, document, text } from './svg';

export interface LapPanel {
  title: string;
  note: string;
  start: string;
  /** the moves played one after the other, as target cells */
  moves: string[];
  zones: number[];
  lanes: number[];
  /** completed laps at the start; default: what a car on this cell is dealt at the grid (lapCountAtSpawn) or 0 */
  laps?: number;
}

const ZONES = [27, 28, 1, 2];

export const LAP_PANELS: LapPanel[] = [
  {
    title: 'Main lanes: crossing the start line completes a lap',
    note: 'The line is just before zone 1, in whatever lane you are.',
    start: 'Z27_L1_00',
    moves: ['Z02_L1_00'],
    zones: ZONES,
    lanes: [1],
    laps: 0
  },
  {
    title: 'The same in lane 2, whose zones run on to 30 before the line',
    note: 'The outer lanes have more cells per lap, so their zone numbers wrap later.',
    start: 'Z29_L2_00',
    moves: ['Z02_L2_00'],
    zones: [29, 30, 1, 2],
    lanes: [2],
    laps: 0
  },
  {
    title: 'Behind the line at the start: the first crossing only begins lap 1',
    note: 'A car dealt a row behind the line has -1; its first crossing makes 0 (no toast, no sound).',
    start: 'Z28_L1_00',
    moves: ['Z02_L1_00'],
    zones: ZONES,
    lanes: [1]
  },
  {
    title: 'In the pit lane the line is the PIT_LINE cell',
    note: 'Landing on Z01_L0_00 (under the start line) crosses it, as in F1.',
    start: 'Z28_L0_00',
    moves: ['Z01_L0_00'],
    zones: ZONES,
    lanes: [1, 0],
    laps: 0
  },
  {
    title: 'A whole stop credits one lap: entering does not, the line does, the box does not',
    note: 'Z27_L1_00 to the entry (before the line), to the line, then the box.',
    start: 'Z27_L1_00',
    moves: ['Z28_L0_00', 'Z01_L0_00', 'Z02_L0_00'],
    zones: ZONES,
    lanes: [1, 0],
    laps: 0
  },
  {
    title: 'The pit exit onto lane 1 never credits',
    note: 'Landing on forwardIndex 6 is not a wrap.',
    start: 'Z06_L0_00',
    moves: ['Z07_L1_00'],
    zones: [5, 6, 7, 8],
    lanes: [1, 0],
    laps: 1
  }
];

const GAP = 20;

/** The panel's laps: before the first move, then after each. */
export function lapsOf(ctx: RaceContext, p: LapPanel): number[] {
  const start = ctx.cellMap.get(p.start)!;
  const pos = positionOf(ctx, {
    start: p.start,
    cars: [],
    edit: { lapCount: p.laps ?? lapCountAtSpawn(start.forwardIndex) }
  });
  return [pos.car.lapCount ?? 0, ...playMoves(pos, p.moves)];
}

function drawLapPanel(ctx: RaceContext, p: LapPanel, y: number): { svg: string; height: number } {
  const laps = lapsOf(ctx, p);
  const { svg, bend, height } = bendPanel(ctx, p, 40, y, 760, 52);
  const parts = [svg];
  // the start line: just before zone 1, across every lane (the pit lane too)
  const z1 = [...bend.cellPos].find(([id]) => ctx.cellMap.get(id)!.zoneIndex === 1);
  if (z1) {
    const lane = ctx.cellMap.get(z1[0])!.laneIndex;
    const before = [...bend.cellPos].find(([id]) => {
      const c = ctx.cellMap.get(id)!;
      return c.laneIndex === lane && p.zones.indexOf(c.zoneIndex) === p.zones.indexOf(1) - 1;
    });
    const lx = before ? (before[1].x + z1[1].x) / 2 : z1[1].x - 30;
    const ys = [...bend.cellPos.values()].map((c) => c.y);
    parts.push(
      `<line x1="${lx}" y1="${Math.min(...ys) - 30}" x2="${lx}" y2="${Math.max(...ys) + 30}" stroke="${COLORS.target}" stroke-width="3" stroke-dasharray="6 4"/>`
    );
    parts.push(
      text(lx, Math.min(...ys) - 36, 'start line', {
        size: 11,
        bold: true,
        anchor: 'middle',
        color: COLORS.target
      })
    );
  }
  const path = [p.start];
  for (const id of p.moves) path.push(...movePath(ctx.trackIndex, path.at(-1)!, id).slice(1));
  parts.push(drawRoute(stepsOf(path, ctx.trackIndex), bend.cellPos));
  parts.push(drawYou(bend.cellPos, p.start));
  [p.start, ...p.moves].forEach((id, i) => {
    const c = bend.cellPos.get(id)!;
    const gained = i > 0 && laps[i]! > laps[i - 1]!;
    parts.push(
      text(c.x, c.y + 38, `laps ${laps[i]}${gained ? ' +1' : ''}`, {
        size: 11,
        bold: gained,
        anchor: 'middle',
        color: gained ? COLORS.good : COLORS.muted
      })
    );
  });
  return { svg: parts.join('\n'), height };
}

export function lapsSvg(ctx: RaceContext): string {
  const body: string[] = [
    text(40, 44, 'Laps: where the start line counts', { size: 22, bold: true, color: COLORS.text })
  ];
  body.push(
    text(
      40,
      70,
      'Each panel plays its moves with the engine; "laps" is the completed laps after each.'
    )
  );
  body.push(
    text(
      40,
      88,
      'The pit lane has its own forwardIndex scale: its dots do not compare with lane 1.'
    )
  );
  let y = 108;
  for (const p of LAP_PANELS) {
    const lap = drawLapPanel(ctx, p, y);
    body.push(lap.svg);
    y += lap.height + GAP;
  }
  return document(840, y, body);
}
