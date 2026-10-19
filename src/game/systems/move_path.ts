import { INNER_MAIN_LANE, PIT_LANE } from '../constants';
import type { TrackIndex } from './track_index';

/**
 * The cells a car drives through from `fromCellId` to `toCellId`, both included, for drawing it (a glide, a preview, a
 * trail). Visual only: the shortest walk on `next[]` that never crosses a `blocked` cell, with the fewest lane changes
 * among the shortest, under the movement search's traversal rules (pit entry only from lane 1, the pit lane only from
 * the pit lane; a sideways step is a cell walked, which is how a go-round rejoins its lane). The engine prices its own
 * cheapest route and does not record it, so this can differ from what a move was charged, never from where it ended.
 * `blocked` is the cells holding cars (the start cell is ignored; a target is never one). With no such walk it returns `[from, to]` (a straight
 * line), so a caller always has something to draw.
 */
export function movePath(
  trackIndex: Pick<TrackIndex, 'cellMap'>,
  fromCellId: string,
  toCellId: string,
  blocked: ReadonlySet<string> = new Set()
): string[] {
  const { cellMap } = trackIndex;
  if (fromCellId === toCellId) return [fromCellId];
  if (!cellMap.has(fromCellId) || !cellMap.has(toCellId)) return [fromCellId, toCellId];

  const steps = new Map<string, number>([[fromCellId, 0]]);
  const changes = new Map<string, number>([[fromCellId, 0]]);
  const parent = new Map<string, string>();
  const queue = [fromCellId];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    if (id === toCellId) break;
    const cell = cellMap.get(id)!;
    for (const nextId of cell.next) {
      const next = cellMap.get(nextId);
      if (!next || blocked.has(nextId)) continue;
      if ((next.tags ?? []).includes('PIT_ENTRY') && cell.laneIndex !== INNER_MAIN_LANE) continue;
      if (
        next.laneIndex === PIT_LANE &&
        cell.laneIndex !== PIT_LANE &&
        !(next.tags ?? []).includes('PIT_ENTRY')
      ) {
        continue;
      }
      const nextSteps = steps.get(id)! + 1;
      const nextChanges = changes.get(id)! + (next.laneIndex === cell.laneIndex ? 0 : 1);
      const seen = steps.get(nextId);
      if (seen === undefined) {
        steps.set(nextId, nextSteps);
        changes.set(nextId, nextChanges);
        parent.set(nextId, id);
        queue.push(nextId);
      } else if (seen === nextSteps && nextChanges < changes.get(nextId)!) {
        // another shortest walk with fewer lane changes (its cell is still queued, so its own successors follow it)
        changes.set(nextId, nextChanges);
        parent.set(nextId, id);
      }
    }
  }
  if (!parent.has(toCellId)) return [fromCellId, toCellId];

  const path = [toCellId];
  for (let id = toCellId; id !== fromCellId; ) {
    id = parent.get(id)!;
    path.push(id);
  }
  return path.reverse();
}
