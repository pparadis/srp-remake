import type { TrackCell, TrackTag } from "../types/track";

export interface BuildLaneSequenceOptions {
  startTagPriority?: TrackTag[];
}

function pickLaneStart(cells: TrackCell[], startTagPriority: TrackTag[]): TrackCell {
  for (const tag of startTagPriority) {
    const tagged = cells.find((c) => (c.tags ?? []).includes(tag));
    if (tagged) return tagged;
  }
  let best = cells[0]!;
  for (const cell of cells) {
    if (cell.forwardIndex < best.forwardIndex) best = cell;
  }
  return best;
}

export function buildLaneSequence(
  cells: TrackCell[],
  byId: Map<string, TrackCell>,
  laneIndex: number,
  options: BuildLaneSequenceOptions = {}
): TrackCell[] {
  const laneCells = cells.filter((c) => c.laneIndex === laneIndex);
  if (laneCells.length === 0) return [];

  const startTagPriority = options.startTagPriority ?? ["START_FINISH", "PIT_ENTRY"];
  const start = pickLaneStart(laneCells, startTagPriority);

  const seq: TrackCell[] = [];
  const visited = new Set<string>();
  let current: TrackCell | undefined = start;

  while (current && !visited.has(current.id) && seq.length < laneCells.length) {
    visited.add(current.id);
    seq.push(current);
    const nextSameId: string | undefined = current.next.find((id) => {
      const nextCell = byId.get(id);
      return nextCell && nextCell.laneIndex === laneIndex;
    });
    current = nextSameId ? byId.get(nextSameId) : undefined;
  }

  if (seq.length < laneCells.length) {
    const remaining = laneCells
      .filter((c) => !visited.has(c.id))
      .sort((a, b) => a.forwardIndex - b.forwardIndex);
    seq.push(...remaining);
  }

  return seq;
}
