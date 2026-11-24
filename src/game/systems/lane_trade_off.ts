// v5 (#268): the lanes as a trade-off. The inside is short and hard on tires, the outside is long and easy on them. The
// tire wear per cell comes from the track's lane lengths; fuel is 1.0 per cell in every lane (the outside already burns
// more by its length). Pure and Phaser-free: the engine, the bots and the HUD all read this one table.
import {
  INNER_MAIN_LANE,
  LANE_PAYBACK,
  LANE_TIRE_INNER,
  MIDDLE_MAIN_LANE,
  OUTER_MAIN_LANE
} from '../constants';

/** A figure for each main lane. */
export interface LaneTable {
  inner: number;
  middle: number;
  outer: number;
}

/** What the lanes cost per lane-1 cell of progress: a lap outside is longer, so its fuel counts the extra cells. */
export interface LaneWear {
  tire: LaneTable;
  fuel: LaneTable;
}

interface LaneLengths {
  laneLength?: Map<number, number>;
}

const tireCache = new WeakMap<Map<number, number>, LaneTable>();

function tireFactors(laneLength: Map<number, number>): LaneTable {
  let table = tireCache.get(laneLength);
  if (table) return table;
  const inner = laneLength.get(INNER_MAIN_LANE) ?? 1;
  const factor = (lane: number) => {
    const len = laneLength.get(lane) ?? inner;
    const extra = (len - inner) / inner;
    return (LANE_TIRE_INNER * (1 - LANE_PAYBACK * extra) * inner) / len;
  };
  table = {
    inner: factor(INNER_MAIN_LANE),
    middle: factor(MIDDLE_MAIN_LANE),
    outer: factor(OUTER_MAIN_LANE)
  };
  tireCache.set(laneLength, table);
  return table;
}

/** Tire wear multiplier per cell walked in each main lane. Null without lane lengths (no table: v3 and v4 factors). */
export function laneTireFactors(track: LaneLengths): LaneTable | null {
  return track.laneLength ? tireFactors(track.laneLength) : null;
}

/** The same, per lane-1 cell of progress: what the bots' plan and the stint readout count (a lap outside has more cells). */
export function laneWearPerProgress(track: LaneLengths): LaneWear | null {
  const { laneLength } = track;
  if (!laneLength) return null;
  const tire = tireFactors(laneLength);
  const inner = laneLength.get(INNER_MAIN_LANE) ?? 1;
  const length = (lane: number) => (laneLength.get(lane) ?? inner) / inner;
  return {
    tire: {
      inner: tire.inner * length(INNER_MAIN_LANE),
      middle: tire.middle * length(MIDDLE_MAIN_LANE),
      outer: tire.outer * length(OUTER_MAIN_LANE)
    },
    fuel: {
      inner: length(INNER_MAIN_LANE),
      middle: length(MIDDLE_MAIN_LANE),
      outer: length(OUTER_MAIN_LANE)
    }
  };
}
