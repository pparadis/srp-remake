import Phaser from "phaser";
import type { TrackCell, TrackData } from "../../types/track";
import { INNER_MAIN_LANE, MIDDLE_MAIN_LANE, OUTER_MAIN_LANE, PIT_LANE } from "../../constants";

type CellMap = Map<string, TrackCell>;

function laneColor(laneIndex: number): number {
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
  alpha: number
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

  if (closesLoop) {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return;
    graphics.lineBetween(last.x, last.y, first.x, first.y);
  }
}

function drawLaneRibbon(
  graphics: Phaser.GameObjects.Graphics,
  path: TrackCell[],
  laneIndex: number,
  cellMap: CellMap
): void {
  if (path.length < 2) return;

  const outerWidth = laneIndex === PIT_LANE ? 16 : 20;
  const innerWidth = laneIndex === PIT_LANE ? 11 : 14;
  const innerAlpha = laneIndex === PIT_LANE ? 0.42 : 0.34;

  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return;
  const closesLoop = last.next.some((nextId) => {
    const nextCell = cellMap.get(nextId);
    return nextCell?.id === first.id && nextCell.laneIndex === laneIndex;
  });

  strokeLanePath(graphics, path, closesLoop, outerWidth, 0x0b0f14, 0.55);
  strokeLanePath(graphics, path, closesLoop, innerWidth, laneColor(laneIndex), innerAlpha);
}

function drawPitConnectors(graphics: Phaser.GameObjects.Graphics, track: TrackData, cellMap: CellMap): void {
  const drawn = new Set<string>();

  for (const from of track.cells) {
    for (const nextId of from.next) {
      const to = cellMap.get(nextId);
      if (!to) continue;

      const isPitTransition = from.laneIndex === PIT_LANE || to.laneIndex === PIT_LANE;
      const isCrossLane = from.laneIndex !== to.laneIndex;
      if (!isPitTransition || !isCrossLane) continue;

      const key = [from.id, to.id].sort().join("|");
      if (drawn.has(key)) continue;
      drawn.add(key);

      graphics.lineStyle(12, 0x0b0f14, 0.6);
      graphics.lineBetween(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
      graphics.lineStyle(8, laneColor(PIT_LANE), 0.55);
      graphics.lineBetween(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
    }
  }
}

export interface DrawTrackParams {
  graphics: Phaser.GameObjects.Graphics;
  track: TrackData;
  cellMap: CellMap;
  showForwardIndex: boolean;
  renderForwardIndexOverlay: () => void;
}

export function drawTrack(params: DrawTrackParams): void {
  const { graphics, track, cellMap, showForwardIndex, renderForwardIndexOverlay } = params;
  graphics.clear();

  for (let lane = 0; lane < track.lanes; lane += 1) {
    drawLaneRibbon(graphics, buildLanePath(track, cellMap, lane), lane, cellMap);
  }
  drawPitConnectors(graphics, track, cellMap);

  for (const cell of track.cells) {
    const r = 4;
    const fill = laneColor(cell.laneIndex);

    graphics.fillStyle(fill, 1);
    graphics.fillCircle(cell.pos.x, cell.pos.y, r);

    graphics.lineStyle(1, 0x0b0f14, 1);
    graphics.strokeCircle(cell.pos.x, cell.pos.y, r + 1);

    const tags = cell.tags ?? [];
    if (tags.includes("PIT_BOX")) {
      graphics.lineStyle(3, 0xff2d95, 1);
      graphics.strokeCircle(cell.pos.x, cell.pos.y, r + 3);
      graphics.lineStyle(1, 0xffffff, 0.8);
      graphics.strokeCircle(cell.pos.x, cell.pos.y, r + 1);
    }
  }

  if (showForwardIndex) {
    graphics.lineStyle(1, 0xffffff, 0.2);
    for (const fromCell of track.cells) {
      for (const nextId of fromCell.next) {
        const to = cellMap.get(nextId);
        if (!to) continue;
        graphics.lineBetween(fromCell.pos.x, fromCell.pos.y, to.pos.x, to.pos.y);
      }
    }
  }

  renderForwardIndexOverlay();
}
