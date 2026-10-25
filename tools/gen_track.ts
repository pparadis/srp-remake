// Track generator (#175): a track from a closed centre line, so a new shape is data, not a new script.
//
// The centre line is lane 1 (the right-hand lane, the one the pit lane sits beside): a polygon whose corners are
// rounded by a radius. Lanes 2 and 3 are offset to its left, the pit lane to its right, exactly: a straight stays
// straight and a bend's radius grows by the offset (or shrinks, when the bend turns left), so an outer lane has more
// cells in a bend and the same on a straight, like the oval. Cells are `cellLength` apart along each stretch (a
// straight or a bend), the stretches being cut at the same places in every lane so that side-by-side cells stay in
// line on the straights.
//
//   npx tsx tools/gen_tracks.ts      writes public/tracks/<trackId>.json for every spec in track_specs.ts
//
// `oval16_3lanes.json` is older and stays as it is (the rule goldens and diagrams are made on it); a spec for it,
// `OVAL16`, is kept so that a test can check this generator against it (positions, zones, pit).
import type { TrackCell, TrackData, TrackTag } from '../src/game/types/track';

export interface Corner {
  x: number;
  y: number;
  /** Radius of the rounded corner on lane 1. */
  r: number;
}

export interface TrackSpec {
  trackId: string;
  /** The corners of lane 1 in driving order. Lane 1 is on the right of the car, so a clockwise loop (on screen). */
  corners: Corner[];
  /** Wanted distance between two cells of a lane. */
  cellLength: number;
  laneSpacing: number;
  /** How far the pit lane is to the right of lane 1. */
  pitInset: number;
  /** The start line is on the straight after corner `after`, `distance` from the end of that corner's bend. */
  start: { after: number; distance: number };
}

interface Vec {
  x: number;
  y: number;
}

interface Line {
  kind: 'line';
  from: Vec;
  to: Vec;
  /** The corner this straight follows. */
  after: number;
}

interface Arc {
  kind: 'arc';
  centre: Vec;
  /** Radius on lane 1. */
  radius: number;
  /** Polar angle of the start, and the (signed) angle swept. */
  start: number;
  sweep: number;
  leftTurn: boolean;
}

type Piece = Line | Arc;

/** A part of a piece, from `t0` to `t1` of it (0 to 1). */
interface Stretch {
  piece: Piece;
  t0: number;
  t1: number;
}

const MIN_LINK_GAIN = 0.75;
const EPSILON = 1e-6;
/** The pit lane has this many cells: entry, line, two boxes, two more, exit. */
const PIT_CELLS = 7;

function cellId(zone: number, lane: number): string {
  return `Z${String(zone).padStart(2, '0')}_L${lane}_00`;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function unit(a: Vec, b: Vec): Vec {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
}

/** Two bends of one circle that follow each other (a half circle made of two quarter corners) are one bend. */
function sameBend(a: Piece | undefined, b: Piece): a is Arc {
  return (
    a?.kind === 'arc' &&
    b.kind === 'arc' &&
    a.leftTurn === b.leftTurn &&
    Math.abs(a.radius - b.radius) < EPSILON &&
    Math.hypot(a.centre.x - b.centre.x, a.centre.y - b.centre.y) < EPSILON
  );
}

/** The pieces of lane 1 in driving order. */
function piecesOf(corners: Corner[]): Piece[] {
  const n = corners.length;
  const bends = corners.map((corner, i) => {
    const before = must(corners[(i + n - 1) % n], 'corner');
    const after = must(corners[(i + 1) % n], 'corner');
    const d1 = unit(before, corner);
    const d2 = unit(corner, after);
    const turn = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y)));
    const right = d1.x * d2.y - d1.y * d2.x > 0;
    const tangent = corner.r * Math.tan(turn / 2);
    const from = { x: corner.x - d1.x * tangent, y: corner.y - d1.y * tangent };
    const to = { x: corner.x + d2.x * tangent, y: corner.y + d2.y * tangent };
    return { corner, d1, turn, right, tangent, from, to };
  });
  const pieces: Piece[] = [];
  bends.forEach((bend, i) => {
    const next = must(bends[(i + 1) % n], 'bend');
    const gap = Math.hypot(next.corner.x - bend.corner.x, next.corner.y - bend.corner.y);
    if (bend.tangent + next.tangent > gap + EPSILON) {
      throw new Error(`corners ${i} and ${(i + 1) % n} are too close for their radii`);
    }
    if (bend.turn > EPSILON) {
      const leftTurn = !bend.right;
      // the centre is on the side the car turns to; the left normal of a heading (x, y) is (y, -x)
      const side = leftTurn ? 1 : -1;
      const centre = {
        x: bend.from.x + side * bend.d1.y * bend.corner.r,
        y: bend.from.y - side * bend.d1.x * bend.corner.r
      };
      const arc: Arc = {
        kind: 'arc',
        centre,
        radius: bend.corner.r,
        start: Math.atan2(bend.from.y - centre.y, bend.from.x - centre.x),
        sweep: leftTurn ? -bend.turn : bend.turn,
        leftTurn
      };
      const last = pieces[pieces.length - 1];
      if (sameBend(last, arc)) last.sweep += arc.sweep;
      else pieces.push(arc);
    }
    if (Math.hypot(next.from.x - bend.to.x, next.from.y - bend.to.y) > EPSILON) {
      pieces.push({ kind: 'line', from: bend.to, to: next.from, after: i });
    }
  });
  // the last bend may run on into the first
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (pieces.length > 1 && first?.kind === 'arc' && sameBend(last, first)) {
    last.sweep += first.sweep;
    pieces.shift();
  }
  return pieces;
}

function arcRadius(arc: Arc, offset: number): number {
  const radius = arc.radius - (arc.leftTurn ? offset : -offset);
  if (radius <= 0) {
    throw new Error(`a lane at offset ${offset} does not fit in a bend of radius ${arc.radius}`);
  }
  return radius;
}

/** Length of a whole piece on the lane `offset` to the left of lane 1 (negative: to the right). */
function pieceLength(piece: Piece, offset: number): number {
  if (piece.kind === 'line') {
    return Math.hypot(piece.to.x - piece.from.x, piece.to.y - piece.from.y);
  }
  return Math.abs(piece.sweep) * arcRadius(piece, offset);
}

function pointOn(piece: Piece, offset: number, t: number): Vec {
  if (piece.kind === 'arc') {
    const angle = piece.start + piece.sweep * t;
    const radius = arcRadius(piece, offset);
    return {
      x: piece.centre.x + radius * Math.cos(angle),
      y: piece.centre.y + radius * Math.sin(angle)
    };
  }
  const heading = unit(piece.from, piece.to);
  return {
    x: piece.from.x + (piece.to.x - piece.from.x) * t + heading.y * offset,
    y: piece.from.y + (piece.to.y - piece.from.y) * t - heading.x * offset
  };
}

/** The stretches of a lap, in driving order, from the start line round to the start line. */
function stretchesOf(spec: TrackSpec): Stretch[] {
  const pieces = piecesOf(spec.corners);
  const startIndex = pieces.findIndex((p) => p.kind === 'line' && p.after === spec.start.after);
  const line = pieces[startIndex];
  if (line === undefined) throw new Error(`no straight after corner ${spec.start.after}`);
  const length = pieceLength(line, 0);
  if (spec.start.distance <= 0 || spec.start.distance >= length) {
    throw new Error(`the start line is not on the straight (0 to ${length})`);
  }
  const t = spec.start.distance / length;
  return [
    { piece: line, t0: t, t1: 1 },
    ...pieces.slice(startIndex + 1).map((piece) => ({ piece, t0: 0, t1: 1 })),
    ...pieces.slice(0, startIndex).map((piece) => ({ piece, t0: 0, t1: 1 })),
    { piece: line, t0: 0, t1: t }
  ];
}

interface Placed {
  stretch: Stretch;
  /** Where in the stretch, 0 to 1 of the piece. */
  t: number;
  /** Position along the lap in lane-1 cells (not rounded): lane 1's cell k is at k. */
  u: number;
  pos: Vec;
}

/** The cells of the lane `offset` to the left of lane 1: `count1[i]` is how many lane 1 has in stretch i. */
function placeLane(
  stretches: Stretch[],
  offset: number,
  cellLength: number,
  count1: number[],
  before1: number[]
): Placed[] {
  const placed: Placed[] = [];
  stretches.forEach((stretch, i) => {
    const length = pieceLength(stretch.piece, offset) * (stretch.t1 - stretch.t0);
    const count = Math.round(length / cellLength);
    for (let j = 0; j < count; j += 1) {
      const t = stretch.t0 + ((stretch.t1 - stretch.t0) * j) / count;
      placed.push({
        stretch,
        t,
        u: must(before1[i], 'cells before') + (must(count1[i], 'cells in stretch') * j) / count,
        pos: pointOn(stretch.piece, offset, t)
      });
    }
  });
  return placed;
}

export function generateTrack(spec: TrackSpec): TrackData {
  const stretches = stretchesOf(spec);
  const count1 = stretches.map((s) =>
    Math.round((pieceLength(s.piece, 0) * (s.t1 - s.t0)) / spec.cellLength)
  );
  const before1 = count1.map((_n, i) => count1.slice(0, i).reduce((a, b) => a + b, 0));
  const lanes = [1, 2, 3].map((lane) =>
    placeLane(stretches, (lane - 1) * spec.laneSpacing, spec.cellLength, count1, before1)
  );
  const spine = must(lanes[0], 'lane 1');
  const spineLen = spine.length;
  const first = must(stretches[0], 'stretch');
  if (first.piece.kind !== 'line' || count1[0] === 0) throw new Error('the start line has no cell');

  const cells: TrackCell[] = [];
  lanes.forEach((placed, laneIndex) => {
    placed.forEach((p, k) => {
      const tags: TrackTag[] = k === 0 ? ['START_FINISH'] : [];
      cells.push({
        id: cellId(k + 1, laneIndex + 1),
        zoneIndex: k + 1,
        laneIndex: laneIndex + 1,
        forwardIndex: laneIndex === 0 ? k : Math.round(p.u) % spineLen,
        pos: { x: Math.round(p.pos.x), y: Math.round(p.pos.y) },
        next: [cellId(((k + 1) % placed.length) + 1, laneIndex + 1)],
        ...(tags.length > 0 ? { tags } : {})
      });
    });
  });

  // Lane changes: to the nearest cell of each neighbouring lane that is ahead by at least MIN_LINK_GAIN.
  lanes.forEach((placed, laneIndex) => {
    placed.forEach((p, k) => {
      const cell = must(
        cells.find((c) => c.id === cellId(k + 1, laneIndex + 1)),
        'cell'
      );
      for (const other of [laneIndex - 1, laneIndex + 1]) {
        const candidates = lanes[other];
        if (candidates === undefined) continue;
        let best = -1;
        let bestGain = Infinity;
        candidates.forEach((q, m) => {
          const gain = (((q.u - p.u) % spineLen) + spineLen) % spineLen;
          if (gain >= MIN_LINK_GAIN && gain < bestGain) {
            best = m;
            bestGain = gain;
          }
        });
        if (best >= 0) cell.next.push(cellId(best + 1, other + 1));
      }
    });
  });

  // Pit lane: beside lane 1's last cell, then its cells 1 to 6, so the entry is one cell before the line.
  const pitZones = [spineLen, ...Array.from({ length: PIT_CELLS - 1 }, (_n, i) => i + 1)];
  pitZones.forEach((zone, i) => {
    const beside = must(spine[zone - 1], 'cell beside the pit');
    if (beside.stretch.piece.kind !== 'line') throw new Error('the pit lane is not on a straight');
    const tags: TrackTag[] = [];
    if (i === 0) tags.push('PIT_ENTRY');
    if (i === 1) tags.push('PIT_LINE');
    if (i === 2 || i === 3) tags.push('PIT_BOX');
    if (i === PIT_CELLS - 1) tags.push('PIT_EXIT');
    const pos = pointOn(beside.stretch.piece, -spec.pitInset, beside.t);
    const rejoin = cellId(PIT_CELLS, 1);
    const nextZone = pitZones[i + 1];
    cells.push({
      id: cellId(zone, 0),
      zoneIndex: zone,
      laneIndex: 0,
      forwardIndex: Math.round((i / (PIT_CELLS - 1)) * (spineLen - 1)),
      pos: { x: Math.round(pos.x), y: Math.round(pos.y) },
      next: [nextZone === undefined ? rejoin : cellId(nextZone, 0)],
      ...(tags.length > 0 ? { tags } : {})
    });
  });
  // The cell before the entry's neighbour leads into the pit.
  must(
    cells.find((c) => c.id === cellId(spineLen - 1, 1)),
    'cell before the pit'
  ).next.push(cellId(spineLen, 0));

  return {
    trackId: spec.trackId,
    zones: Math.max(...lanes.map((l) => l.length)),
    lanes: 4,
    cells
  };
}
