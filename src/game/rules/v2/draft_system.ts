// Frozen: v2's draft test, copied from the live code at tag rules-v2 (#118, #148). Never edit; v3 changes systems/draft_system.ts.
import { DRAFT_RANGE, INNER_MAIN_LANE, OUTER_MAIN_LANE } from '../../constants';
import { cellsAlongLane, type TrackIndex } from '../../systems/track_index';

// Drafting (issue #55, rules in docs/movement-spec.md): pure position logic, no costs here.

export interface DraftAhead {
  /** The car being drafted: the nearest car in the same lane, within DRAFT_RANGE cells ahead. */
  cellId: string;
  /** Cells between the two cars (1 = bumper to bumper). */
  gap: number;
}

/**
 * The car this position drafts behind, or null. Only main lanes draft (never the pit lane, so never on the pit entry or
 * exit), only a car in the same lane counts (an adjacent lane does not), and the gap is in cells along the lane (not
 * `forwardIndex`, which repeats on the outer lanes' bends, #114), wrapping at the start line.
 * `occupied` is every cell holding a car, the start cell included (it is skipped).
 */
export function draftAhead(
  trackIndex: TrackIndex,
  cellId: string,
  occupied: Iterable<string>
): DraftAhead | null {
  const { cellMap } = trackIndex;
  const start = cellMap.get(cellId);
  if (!start || start.laneIndex < INNER_MAIN_LANE || start.laneIndex > OUTER_MAIN_LANE) return null;
  let best: DraftAhead | null = null;
  for (const id of occupied) {
    if (id === cellId) continue;
    const cell = cellMap.get(id);
    if (!cell || cell.laneIndex !== start.laneIndex) continue;
    const gap = cellsAlongLane(trackIndex, start, cell);
    if (gap < 1 || gap > DRAFT_RANGE) continue;
    if (!best || gap < best.gap) best = { cellId: id, gap };
  }
  return best;
}
