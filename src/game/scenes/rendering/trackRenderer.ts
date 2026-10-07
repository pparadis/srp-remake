import Phaser from "phaser";
import type { TrackCell, TrackData } from "../../types/track";
import { INNER_MAIN_LANE, MIDDLE_MAIN_LANE, OUTER_MAIN_LANE, PIT_LANE } from "../../constants";

import { headingOf } from "./heading";

type CellMap = Map<string, TrackCell>;

export function laneColor(laneIndex: number): number {
  if (laneIndex === PIT_LANE) return 0xb87cff;
  if (laneIndex === INNER_MAIN_LANE) return 0x3aa0ff;
  if (laneIndex === MIDDLE_MAIN_LANE) return 0x66ff99;
  if (laneIndex === OUTER_MAIN_LANE) return 0xffcc66;
  return 0xffffff;
}

function buildLanePath(track: TrackData, cellMap: CellMap, laneIndex: number): TrackCell[] {
  const laneCells = track.cells.filter((c) => c.laneIndex === laneIndex);
  if (laneCells.length === 0) return [];

  const laneIds = new Set(laneCells.map((c) => c.id));
  const incoming = new Map<string, number>();
  for (const cell of laneCells) incoming.set(cell.id, 0);

  for (const cell of laneCells) {
    for (const nextId of cell.next) {
      if (!laneIds.has(nextId)) continue;
      incoming.set(nextId, (incoming.get(nextId) ?? 0) + 1);
    }
  }

  let start = laneCells.find((c) => (incoming.get(c.id) ?? 0) === 0);
  if (!start) {
    start = laneCells.reduce((best, c) => (c.zoneIndex < best.zoneIndex ? c : best), laneCells[0]!);
  }

  const path: TrackCell[] = [];
  const visited = new Set<string>();
  let current: TrackCell | undefined = start;
  while (current && !visited.has(current.id)) {
    path.push(current);
    visited.add(current.id);
    const nextId: string | undefined = current.next.find(
      (n: string) => laneIds.has(n) && !visited.has(n)
    );
    current = nextId ? cellMap.get(nextId) : undefined;
  }

  if (path.length < laneCells.length) {
    const remaining = laneCells
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => a.zoneIndex - b.zoneIndex);
    path.push(...remaining);
  }

  return path;
}

function smoothLanePoints(path: TrackCell[], closesLoop: boolean, iterations = 2): Phaser.Math.Vector2[] {
  let points = path.map((cell) => new Phaser.Math.Vector2(cell.pos.x, cell.pos.y));
  if (points.length < 3) return points;

  for (let iter = 0; iter < iterations; iter += 1) {
    const next: Phaser.Math.Vector2[] = [];

    if (closesLoop) {
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (!a || !b) continue;
        next.push(new Phaser.Math.Vector2(0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y));
        next.push(new Phaser.Math.Vector2(0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y));
      }
    } else {
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last) return points;
      next.push(first.clone());
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (!a || !b) continue;
        next.push(new Phaser.Math.Vector2(0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y));
        next.push(new Phaser.Math.Vector2(0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y));
      }
      next.push(last.clone());
    }

    points = next;
    if (points.length < 3) break;
  }

  return points;
}

function strokeLanePath(
  graphics: Phaser.GameObjects.Graphics,
  path: TrackCell[],
  closesLoop: boolean,
  width: number,
  color: number,
  alpha: number,
  round = false
): void {
  if (path.length < 2) return;
  const points = smoothLanePoints(path, closesLoop, 2);
  if (points.length < 2) return;

  graphics.lineStyle(width, color, alpha);

  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    if (!from || !to) continue;
    graphics.lineBetween(from.x, from.y, to.x, to.y);
  }
  if (round) {
    // fill the wedge gaps butt-capped segments leave in corners
    graphics.fillStyle(color, alpha);
    for (const p of points) graphics.fillCircle(p.x, p.y, width / 2);
  }

  if (closesLoop) {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return;
    graphics.lineBetween(last.x, last.y, first.x, first.y);
  }
}

function isClosed(path: TrackCell[], laneIndex: number, cellMap: CellMap): boolean {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return false;
  return last.next.some((nextId) => {
    const nextCell = cellMap.get(nextId);
    return nextCell?.id === first.id && nextCell.laneIndex === laneIndex;
  });
}

// Debug-only: the per-lane coloured ribbon.
function drawLaneRibbon(
  graphics: Phaser.GameObjects.Graphics,
  path: TrackCell[],
  laneIndex: number,
  cellMap: CellMap
): void {
  if (path.length < 2) return;
  const closesLoop = isClosed(path, laneIndex, cellMap);
  strokeLanePath(graphics, path, closesLoop, laneIndex === PIT_LANE ? 16 : 20, 0x0b0f14, 0.55);
  strokeLanePath(graphics, path, closesLoop, laneIndex === PIT_LANE ? 11 : 14, laneColor(laneIndex), 0.4);
}

function pitConnectors(track: TrackData, cellMap: CellMap): Array<[TrackCell, TrackCell]> {
  const drawn = new Set<string>();
  const out: Array<[TrackCell, TrackCell]> = [];
  for (const from of track.cells) {
    for (const nextId of from.next) {
      const to = cellMap.get(nextId);
      if (!to || from.laneIndex === to.laneIndex) continue;
      if (from.laneIndex !== PIT_LANE && to.laneIndex !== PIT_LANE) continue;
      const key = [from.id, to.id].sort().join("|");
      if (drawn.has(key)) continue;
      drawn.add(key);
      out.push([from, to]);
    }
  }
  return out;
}

const ASPHALT = 0x3b4048;
const MAIN_WIDTH = 74;
const PIT_WIDTH = 20;

// Alternating red/white kerb along both edges: the smoothed centre line offset by half the asphalt width.
function strokeKerb(
  graphics: Phaser.GameObjects.Graphics,
  path: TrackCell[],
  closesLoop: boolean,
  width: number
): void {
  const pts = smoothLanePoints(path, closesLoop, 2);
  const n = pts.length;
  for (const side of [-1, 1]) {
    const edge = pts.map((p, i) => {
      const a = pts[(i + n - 1) % n]!;
      const b = pts[(i + 1) % n]!;
      const t = new Phaser.Math.Vector2(b.x - a.x, b.y - a.y).normalize();
      return new Phaser.Math.Vector2(p.x - t.y * side * (width / 2), p.y + t.x * side * (width / 2));
    });
    for (let i = 0; i < (closesLoop ? n : n - 1); i += 1) {
      const a = edge[i]!;
      const b = edge[(i + 1) % n]!;
      graphics.lineStyle(7, i % 2 === 0 ? 0xd62828 : 0xf5f5f5, 1);
      graphics.lineBetween(a.x, a.y, b.x, b.y);
    }
  }
}

// Dashed white line halfway between two adjacent main lanes.
function drawSeparator(
  graphics: Phaser.GameObjects.Graphics,
  upper: TrackCell[],
  lower: TrackCell[],
  closesLoop: boolean
): void {
  if (upper.length < 3 || lower.length === 0) return;
  const mids = upper.map((c) => {
    let best = lower[0]!;
    let bestD = Infinity;
    for (const o of lower) {
      const d = (o.pos.x - c.pos.x) ** 2 + (o.pos.y - c.pos.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return { pos: { x: (c.pos.x + best.pos.x) / 2, y: (c.pos.y + best.pos.y) / 2 } } as TrackCell;
  });
  const pts = smoothLanePoints(mids, closesLoop, 2);
  graphics.lineStyle(2, 0xffffff, 0.75);
  for (let i = 0; i + 1 < pts.length; i += 2) {
    graphics.lineBetween(pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y);
  }
}

// Filled rectangle centred on c, `along` long in direction t and `across` wide.
function fillQuad(
  g: Phaser.GameObjects.Graphics,
  c: { x: number; y: number },
  t: { x: number; y: number },
  along: number,
  across: number,
  stroke = false
): void {
  const n = new Phaser.Math.Vector2(-t.y, t.x);
  const pts = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ].map(([a, b]) => new Phaser.Math.Vector2(c.x + (t.x * a! * along + n.x * b! * across) / 2, c.y + (t.y * a! * along + n.y * b! * across) / 2));
  if (stroke) g.strokePoints(pts, true, true);
  else g.fillPoints(pts, true);
}

function drawStartFinish(g: Phaser.GameObjects.Graphics, track: TrackData, cellMap: CellMap): void {
  const sq = 6;
  for (const start of track.cells.filter((c) => (c.tags ?? []).includes("START_FINISH"))) {
    const row = track.cells.filter((c) => c.zoneIndex === start.zoneIndex && c.laneIndex !== PIT_LANE);
    const xs = row.map((c) => c.pos.x);
    const ys = row.map((c) => c.pos.y);
    const a = new Phaser.Math.Vector2(Math.min(...xs), Math.min(...ys));
    const b = new Phaser.Math.Vector2(Math.max(...xs), Math.max(...ys));
    const span = b.clone().subtract(a);
    const len = span.length() + MAIN_WIDTH / 3;
    const dir = len > MAIN_WIDTH / 3 ? span.clone().normalize() : new Phaser.Math.Vector2(0, 1);
    const t = headingOf(start, cellMap);
    // cross-track axis: perpendicular to the driving direction, signed to match the lane spread
    const across = new Phaser.Math.Vector2(-t.y, t.x);
    if (across.dot(dir) < 0) across.negate();
    const mid = a.clone().add(b).scale(0.5);
    const count = Math.ceil(len / sq);
    for (let k = 0; k < count; k += 1) {
      for (let r = 0; r < 2; r += 1) {
        const off = (k - (count - 1) / 2) * sq;
        const c = {
          x: mid.x + across.x * off + t.x * (r - 0.5) * sq,
          y: mid.y + across.y * off + t.y * (r - 0.5) * sq
        };
        g.fillStyle((k + r) % 2 === 0 ? 0xffffff : 0x111111, 1);
        fillQuad(g, c, t, sq, sq);
      }
    }
  }
}

interface DrawTrackParams {
  graphics: Phaser.GameObjects.Graphics;
  track: TrackData;
  cellMap: CellMap;
  showForwardIndex: boolean;
  renderForwardIndexOverlay: () => void;
}

export function drawTrack(params: DrawTrackParams): void {
  const { graphics: g, track, cellMap, showForwardIndex, renderForwardIndexOverlay } = params;
  g.clear();

  const paths = Array.from({ length: track.lanes }, (_, lane) => buildLanePath(track, cellMap, lane));
  const pit = paths[PIT_LANE] ?? [];
  const connectors = pitConnectors(track, cellMap);
  const mainLane = paths[MIDDLE_MAIN_LANE] ?? [];
  const mainClosed = isClosed(mainLane, MIDDLE_MAIN_LANE, cellMap);

  // pit lane edge (beneath the main asphalt so connectors merge into it)
  g.lineStyle(PIT_WIDTH + 6, 0xf5f5f5, 1);
  for (const [a, b] of connectors) g.lineBetween(a.pos.x, a.pos.y, b.pos.x, b.pos.y);
  strokeLanePath(g, pit, false, PIT_WIDTH + 6, 0xf5f5f5, 1, true);

  strokeLanePath(g, mainLane, mainClosed, MAIN_WIDTH + 4, 0xf5f5f5, 1, true);
  strokeLanePath(g, mainLane, mainClosed, MAIN_WIDTH, ASPHALT, 1, true);
  strokeKerb(g, mainLane, mainClosed, MAIN_WIDTH + 3);

  g.lineStyle(PIT_WIDTH, ASPHALT, 1);
  for (const [a, b] of connectors) g.lineBetween(a.pos.x, a.pos.y, b.pos.x, b.pos.y);
  strokeLanePath(g, pit, false, PIT_WIDTH, ASPHALT, 1, true);

  drawSeparator(g, paths[INNER_MAIN_LANE] ?? [], paths[MIDDLE_MAIN_LANE] ?? [], mainClosed);
  drawSeparator(g, paths[OUTER_MAIN_LANE] ?? [], paths[MIDDLE_MAIN_LANE] ?? [], mainClosed);
  drawStartFinish(g, track, cellMap);

  for (const box of track.cells.filter((c) => (c.tags ?? []).includes("PIT_BOX"))) {
    const t = headingOf(box, cellMap);
    g.fillStyle(0xffd23f, 0.18);
    fillQuad(g, box.pos, t, 44, PIT_WIDTH - 4);
    g.lineStyle(2, 0xffd23f, 0.9);
    fillQuad(g, box.pos, t, 44, PIT_WIDTH - 4, true);
  }

  if (showForwardIndex) {
    for (const lane of paths) {
      if (lane.length > 0) drawLaneRibbon(g, lane, lane[0]!.laneIndex, cellMap);
    }
    for (const cell of track.cells) {
      g.fillStyle(laneColor(cell.laneIndex), 1);
      g.fillCircle(cell.pos.x, cell.pos.y, 4);
      g.lineStyle(1, 0x0b0f14, 1);
      g.strokeCircle(cell.pos.x, cell.pos.y, 5);
    }
    g.lineStyle(1, 0xffffff, 0.2);
    for (const fromCell of track.cells) {
      for (const nextId of fromCell.next) {
        const to = cellMap.get(nextId);
        if (to) g.lineBetween(fromCell.pos.x, fromCell.pos.y, to.pos.x, to.pos.y);
      }
    }
  }

  renderForwardIndexOverlay();
}

