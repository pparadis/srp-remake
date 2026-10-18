import type { TrackCell } from "../types/track";
import type { CarSetup } from "../types/car";
import { DIAGONAL_MIN_GAIN, lapAhead, type TrackIndex } from "./trackIndex";
import {
  INNER_MAIN_LANE,
  MIDDLE_MAIN_LANE,
  OUTER_MAIN_LANE,
  PIT_LANE,
  DRAFT_FUEL_FACTOR,
  DRAFT_TIRE_FACTOR,
  SQUEEZE_SURCHARGE_PER_CAR,
  WING_EFFECTS
} from "../constants";
import { computeMoveSpend } from "./moveBudgetSystem";

export interface TargetInfo {
  distance: number;
  moveSpend?: number;
  tireCost: number;
  fuelCost: number;
  isPitTrigger: boolean;
  // Set only for squeeze targets: number of cars passed (each adds SQUEEZE_SURCHARGE_PER_CAR move points).
  squeezePassed?: number;
  // Set only when the route changes lane 2 or more times (go around a blocker and rejoin, or a zig-zag).
  laneChanges?: number;
  // Set only when the car ended its last move tucked in behind a car: its tire and fuel cost carry the draft discount.
  drafted?: true;
  // Set only on a slingshot: a lane change of a car that has been tucked in long enough, whose surcharge was waived.
  slingshot?: true;
  // Set only on a slingshot that would be out of reach with the surcharge: the draft is what opens this move.
  slingshotOnly?: true;
}

interface MovementOptions {
  allowPitExitSkip?: boolean;
  disallowPitBoxTargets?: boolean;
  // The car ended its last move tucked in behind a car (not where it stands now: the leader has moved on by then).
  drafted?: boolean;
  // ... and has done so for DRAFT_SLINGSHOT_TURNS moves in a row: a lane change skips the +1 surcharge.
  slingshotReady?: boolean;
}

interface MovementCostRates {
  tireRate: number;
  fuelRate: number;
}

interface MovementCostContext extends MovementCostRates {
  setup: CarSetup;
}

function laneFactor(laneIndex: number, factors: { inner: number; middle: number; outer: number }): number {
  if (laneIndex === INNER_MAIN_LANE) return factors.inner;
  if (laneIndex === MIDDLE_MAIN_LANE) return factors.middle;
  if (laneIndex === OUTER_MAIN_LANE) return factors.outer;
  return 1;
}

// Setup multipliers on per-cell wear (1 = no penalty). Exported so bots can project wear.
export function setupFactors(setup: CarSetup): { aeroTire: number; aeroFuel: number; psiFactor: number } {
  const { tire: aeroTire, fuel: aeroFuel } = WING_EFFECTS[setup.wing];
  const psi = setup.psi;
  const psiFactor =
    1 +
    (Math.abs(psi.fl - 32) + Math.abs(psi.fr - 32) + Math.abs(psi.rl - 32) + Math.abs(psi.rr - 32)) * 0.002;
  return { aeroTire, aeroFuel, psiFactor };
}

// Per-lane wear multipliers: the inner lane is hard on tires, the outer one on fuel.
export function laneWearFactors(laneIndex: number): { tire: number; fuel: number } {
  return {
    tire: laneFactor(laneIndex, { inner: 1.05, middle: 1.0, outer: 0.98 }),
    fuel: laneFactor(laneIndex, { inner: 0.98, middle: 1.0, outer: 1.03 })
  };
}

function computeCosts(
  distance: number,
  laneIndex: number,
  costs: MovementCostContext,
  drafting = false
): { tireCost: number; fuelCost: number } {
  const { aeroTire, aeroFuel, psiFactor } = setupFactors(costs.setup);
  const { tire: tireLaneFactor, fuel: fuelLaneFactor } = laneWearFactors(laneIndex);
  const draftTire = drafting ? DRAFT_TIRE_FACTOR : 1;
  const draftFuel = drafting ? DRAFT_FUEL_FACTOR : 1;

  const tireCost = Math.round(distance * costs.tireRate * aeroTire * psiFactor * tireLaneFactor * draftTire);
  const fuelCost = Math.round(distance * costs.fuelRate * aeroFuel * fuelLaneFactor * draftFuel);

  return { tireCost, fuelCost };
}

// The cheapest route to a cell: `steps` cells walked (what tire and fuel are charged on), `price` the move points.
interface Route {
  steps: number;
  price: number;
  laneChanges: number;
}

// The track as integer arrays, built once per track: the route search runs for every bot decision and every lookahead.
interface RouteGraph {
  ids: string[];
  index: Map<string, number>;
  next: number[][];
  lane: number[];
  lap: number[];
  pitEntry: boolean[];
}
const routeGraphs = new WeakMap<TrackIndex, RouteGraph>();
function routeGraphOf(trackIndex: TrackIndex): RouteGraph {
  let graph = routeGraphs.get(trackIndex);
  if (graph) return graph;
  const cells = trackIndex.track.cells;
  const index = new Map(cells.map((c, i) => [c.id, i]));
  graph = {
    ids: cells.map((c) => c.id),
    index,
    next: cells.map((c) => c.next.flatMap((id) => (index.has(id) ? [index.get(id)!] : []))),
    lane: cells.map((c) => c.laneIndex),
    lap: cells.map((c) => trackIndex.lapPos.get(c.id) ?? c.forwardIndex),
    pitEntry: cells.map((c) => (c.tags ?? []).includes("PIT_ENTRY"))
  };
  routeGraphs.set(trackIndex, graph);
  return graph;
}

const MAX_DIAGONALS = 12; // state slots per cell: more diagonal changes than that never fit the 9-point cap

// Breadth-first over (cell, diagonal lane changes): the fewest steps per state, then the cheapest state per cell.
// Same traversal rules as the plain search (occupied cells block, pit entry only from lane 1, pit lane only from the
// pit lane). Results come in order of first discovery. Price: every lane change costs +1 move point on top of the cells walked. A sideways change (less
// than DIAGONAL_MIN_GAIN of lap position) is paid by the extra cell it walks; each diagonal one adds +1 (one change +1,
// out and back +2).
function searchRoutes(
  trackIndex: TrackIndex,
  startCell: TrackCell,
  occupied: Set<string>,
  maxSteps: number
): Map<string, Route & { minSteps: number }> {
  const g = routeGraphOf(trackIndex);
  const { spineLen } = trackIndex;
  const start = g.index.get(startCell.id)!;
  // lap position gained from cell a to cell b, as lapAhead does it
  const gain = (a: number, b: number) => Math.round(((((g.lap[b]! - g.lap[a]!) % spineLen) + spineLen) % spineLen) * 10) / 10;
  const blocked = new Uint8Array(g.ids.length);
  for (const id of occupied) {
    const i = g.index.get(id);
    if (i !== undefined && i !== start) blocked[i] = 1;
  }
  const seen = new Uint8Array(g.ids.length * MAX_DIAGONALS);
  seen[start * MAX_DIAGONALS] = 1;
  const minSteps = new Int16Array(g.ids.length);
  const steps = new Int16Array(g.ids.length);
  const price = new Int16Array(g.ids.length).fill(32767);
  const changes = new Int16Array(g.ids.length);
  const order: number[] = [];
  // frontier entries: cell, diagonal lane changes, all lane changes
  let frontier = [start, 0, 0];
  for (let step = 0; step < maxSteps && frontier.length > 0; step += 1) {
    const nextFrontier: number[] = [];
    for (let f = 0; f < frontier.length; f += 3) {
      const cur = frontier[f]!;
      const diagonals = frontier[f + 1]!;
      const laneChanges = frontier[f + 2]!;
      const curLane = g.lane[cur]!;
      for (const nxt of g.next[cur]!) {
        if (blocked[nxt]) continue;
        const lane = g.lane[nxt]!;
        const isPitLane = lane === PIT_LANE;
        if (g.pitEntry[nxt] && curLane !== INNER_MAIN_LANE) continue;
        if (isPitLane && !g.pitEntry[nxt] && curLane !== PIT_LANE) continue;
        const changesLane = !isPitLane && curLane !== PIT_LANE && lane !== curLane;
        const diagonal = changesLane && gain(cur, nxt) >= DIAGONAL_MIN_GAIN;
        const nextDiagonals = diagonals + (diagonal ? 1 : 0);
        // Even the cheapest price of this route (cells + surcharges beyond the first) is over budget: prune.
        if (step + 1 + (nextDiagonals > 1 ? nextDiagonals - 1 : 0) > maxSteps) continue;
        const key = nxt * MAX_DIAGONALS + nextDiagonals;
        if (seen[key]) continue;
        seen[key] = 1;
        const nextChanges = laneChanges + (changesLane ? 1 : 0);
        nextFrontier.push(nxt, nextDiagonals, nextChanges);
        const p = step + 1 + nextDiagonals;
        if (price[nxt] === 32767) {
          order.push(nxt);
          minSteps[nxt] = step + 1;
        }
        // frontiers go by steps, so the first visit has the fewest; later visits can only win on price.
        if (p < price[nxt]!) {
          price[nxt] = p;
          steps[nxt] = step + 1;
          changes[nxt] = nextChanges;
        }
      }
    }
    frontier = nextFrontier;
  }
  const best = new Map<string, Route & { minSteps: number }>();
  for (const i of order) {
    best.set(g.ids[i]!, { steps: steps[i]!, price: price[i]!, laneChanges: changes[i]!, minSteps: minSteps[i]! });
  }
  return best;
}

export function computeValidTargets(
  trackIndex: TrackIndex,
  startCellId: string,
  occupied: Set<string>,
  maxSteps: number,
  options: MovementOptions = {},
  costs: MovementCostContext
): Map<string, TargetInfo> {
  const { track, cellMap } = trackIndex;
  const startCell = cellMap.get(startCellId);
  if (!startCell) return new Map();
  const startIsPitLane = startCell.laneIndex === PIT_LANE;
  const effectiveMaxSteps = startIsPitLane ? 1 : maxSteps;

  const routes = searchRoutes(trackIndex, startCell, occupied, effectiveMaxSteps);
  // Fewest steps per cell (pit-lane rules below add to it), in discovery order.
  const dist = new Map<string, number>([[startCellId, 0]]);
  for (const [id, route] of routes) dist.set(id, route.minSteps);

  let pitBoxAdjacent = false;
  if (startIsPitLane) {
    for (const [id, d] of dist.entries()) {
      if (d !== 1) continue;
      const c = cellMap.get(id);
      if (c && (c.tags ?? []).includes("PIT_BOX")) {
        pitBoxAdjacent = true;
        break;
      }
    }
  }

  if (startIsPitLane && pitBoxAdjacent) {
    const visited = new Set<string>();
    let current: TrackCell | undefined = startCell;
    let steps = 0;
    const maxWalk = track.cells.length + 1;
    while (current && !visited.has(current.id) && steps < maxWalk) {
      visited.add(current.id);
      const nextSame: TrackCell | undefined = current.next
        .map((id) => cellMap.get(id))
        .find((c) => c && c.laneIndex === PIT_LANE);
      if (!nextSame) break;
      steps += 1;
      if ((nextSame.tags ?? []).includes("PIT_BOX")) {
        const prev = dist.get(nextSame.id);
        if (prev == null || steps < prev) dist.set(nextSame.id, steps);
      }
      current = nextSame;
    }
  }

  // Drafting: the car ended its last move tucked in behind a car (see draftSystem); never in the pit lane.
  const drafted = options.drafted === true && !startIsPitLane;

  const targets = new Map<string, TargetInfo>();
  for (const [cellId, d] of dist.entries()) {
    if (d <= 0) continue;
    if (occupied.has(cellId)) continue;
    const cell = cellMap.get(cellId);
    if (!cell) continue;
    const isPitEntryTarget = (cell.tags ?? []).includes("PIT_ENTRY");
    const isPitBox = (cell.tags ?? []).includes("PIT_BOX");
    if (d > effectiveMaxSteps) {
      if (!(startIsPitLane && pitBoxAdjacent && isPitBox)) continue;
    }
    if (startIsPitLane && cell.laneIndex === PIT_LANE && d > 1) {
      if (!pitBoxAdjacent || !isPitBox) continue;
    }
    if (!startIsPitLane && cell.laneIndex !== PIT_LANE && Math.abs(cell.laneIndex - startCell.laneIndex) > 1)
      continue;
    const targetDelta = lapAhead(trackIndex, startCell, cell);
    // Main-lane moves are priced by their cheapest route (lane changes included); the pit lane keeps the plain walk.
    const route: Route | undefined = !startIsPitLane && cell.laneIndex !== PIT_LANE ? routes.get(cellId) : undefined;
    // A lane change must advance: no sideways target, by lap position or by zone (the owner's rule, #108).
    if (
      !startIsPitLane &&
      cell.laneIndex !== startCell.laneIndex &&
      (targetDelta < DIAGONAL_MIN_GAIN || cell.zoneIndex === startCell.zoneIndex) &&
      !isPitEntryTarget
    )
      continue;
    if (!startIsPitLane && cell.laneIndex === PIT_LANE) {
      if (!isPitEntryTarget) continue;
      if (d !== 1) continue;
    }
    const steps = route?.steps ?? d;
    let moveSpend = route?.price ?? computeMoveSpend(d, startCell.laneIndex, cell.laneIndex);
    // Slingshot: after enough moves in a row ended tucked in, a route with a lane change skips the +1 surcharge. The
    // walk itself is still paid.
    const slingshot =
      drafted && options.slingshotReady === true && route !== undefined && route.laneChanges >= 1 && moveSpend > steps;
    if (slingshot) moveSpend -= 1;
    if (moveSpend > maxSteps) continue;
    if (options.disallowPitBoxTargets && (cell.tags ?? []).includes("PIT_BOX")) continue;

    const { tireCost, fuelCost } = computeCosts(steps, cell.laneIndex, costs, drafted);
    targets.set(cellId, {
      distance: steps,
      moveSpend,
      tireCost,
      fuelCost,
      isPitTrigger: (cell.tags ?? []).includes("PIT_BOX"),
      ...(route && route.laneChanges >= 2 ? { laneChanges: route.laneChanges } : {}),
      ...(drafted ? { drafted: true as const } : {}),
      ...(slingshot ? { slingshot: true as const } : {}),
      ...(slingshot && moveSpend + 1 > maxSteps ? { slingshotOnly: true as const } : {})
    });
  }

  if (options.allowPitExitSkip && startIsPitLane && (startCell.tags ?? []).includes("PIT_BOX")) {
    const lastPitBoxZone = trackIndex.pitBoxMaxZone;
    if (lastPitBoxZone == null) return targets;
    const exitZone = lastPitBoxZone + 1;
    const exitCellId = trackIndex.pitLaneByZone.get(exitZone);
    if (exitCellId && !occupied.has(exitCellId)) {
      const exitCell = cellMap.get(exitCellId);
      if (exitCell) {
        const distance = Math.max(1, exitZone - startCell.zoneIndex);
        const { tireCost, fuelCost } = computeCosts(distance, exitCell.laneIndex, costs);
        const moveSpend = computeMoveSpend(distance, startCell.laneIndex, exitCell.laneIndex);
        if (moveSpend <= maxSteps) {
          targets.set(exitCellId, {
            distance,
            moveSpend,
            tireCost,
            fuelCost,
            isPitTrigger: false
          });
        }
      }
    }
  }

  return targets;
}

// Boxed-in fallback: targets reachable by passing through occupied cells, main lanes only.
// Call only when computeValidTargets is empty. Each passed car costs extra move points.
export function computeSqueezeTargets(
  trackIndex: TrackIndex,
  startCellId: string,
  occupied: Set<string>,
  maxSteps: number,
  costs: MovementCostContext
): Map<string, TargetInfo> {
  const { cellMap } = trackIndex;
  const startCell = cellMap.get(startCellId);
  const targets = new Map<string, TargetInfo>();
  if (!startCell) return targets;
  if (startCell.laneIndex === PIT_LANE) {
    return (startCell.tags ?? []).includes("PIT_EXIT")
      ? computePitExitSqueezeTargets(trackIndex, startCell, occupied, maxSteps, costs)
      : targets;
  }

  // "Passed" compares cars in two lanes, so it reads the lap position, not forwardIndex (#114).
  const occupiedAhead = new Map<number, number[]>();
  for (const id of occupied) {
    const c = cellMap.get(id);
    if (!c || id === startCellId || c.laneIndex === PIT_LANE) continue;
    occupiedAhead.set(c.laneIndex, [...(occupiedAhead.get(c.laneIndex) ?? []), lapAhead(trackIndex, startCell, c)]);
  }

  // Fewest cells to each cell, and the fewest diagonal lane changes among those paths (priced like a route).
  const dist = new Map<string, number>([[startCellId, 0]]);
  const diagonals = new Map<string, number>([[startCellId, 0]]);
  const queue = [startCellId];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    const d = dist.get(id)!;
    if (d >= maxSteps) continue;
    const from = cellMap.get(id)!;
    for (const nextId of from.next) {
      const n = cellMap.get(nextId);
      if (!n || n.laneIndex === PIT_LANE) continue;
      const diag =
        diagonals.get(id)! + (n.laneIndex !== from.laneIndex && lapAhead(trackIndex, from, n) >= DIAGONAL_MIN_GAIN ? 1 : 0);
      // a cell one layer further is still open to a cheaper parent of the same layer
      if (dist.get(nextId) === d + 1 && diag < diagonals.get(nextId)!) diagonals.set(nextId, diag);
      if (dist.has(nextId)) continue;
      dist.set(nextId, d + 1);
      diagonals.set(nextId, diag);
      queue.push(nextId);
    }
  }

  for (const [cellId, d] of dist) {
    const cell = cellMap.get(cellId)!;
    if (d <= 0 || occupied.has(cellId)) continue;
    if (Math.abs(cell.laneIndex - startCell.laneIndex) > 1) continue;
    const targetAhead = lapAhead(trackIndex, startCell, cell);
    if (targetAhead < DIAGONAL_MIN_GAIN || cell.zoneIndex === startCell.zoneIndex) continue;
    const lanes = new Set([startCell.laneIndex, cell.laneIndex]);
    let passed = 0;
    for (const lane of lanes) passed += (occupiedAhead.get(lane) ?? []).filter((x) => x > 0 && x < targetAhead).length;
    if (passed < 1) continue;
    const moveSpend = d + diagonals.get(cellId)! + SQUEEZE_SURCHARGE_PER_CAR * passed;
    if (moveSpend > maxSteps) continue;
    const { tireCost, fuelCost } = computeCosts(d, cell.laneIndex, costs);
    targets.set(cellId, { distance: d, moveSpend, tireCost, fuelCost, isPitTrigger: false, squeezePassed: passed });
  }
  return targets;
}

const PIT_EXIT_SQUEEZE_RANGE = 3;

// Pit exit blocked: squeeze along lane 1 within PIT_EXIT_SQUEEZE_RANGE cells (no lane change). forwardIndex is on its own
// scale in the pit lane, so cars passed = occupied cells on the (unique) lane-1 path.
function computePitExitSqueezeTargets(
  trackIndex: TrackIndex,
  startCell: TrackCell,
  occupied: Set<string>,
  maxSteps: number,
  costs: MovementCostContext
): Map<string, TargetInfo> {
  const { cellMap } = trackIndex;
  const targets = new Map<string, TargetInfo>();
  const dist = new Map<string, number>([[startCell.id, 0]]);
  const passedTo = new Map<string, number>([[startCell.id, 0]]);
  const queue = [startCell.id];
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!;
    const d = dist.get(id)!;
    if (d >= PIT_EXIT_SQUEEZE_RANGE) continue;
    const through = passedTo.get(id)! + (d > 0 && occupied.has(id) ? 1 : 0);
    for (const nextId of cellMap.get(id)?.next ?? []) {
      const n = cellMap.get(nextId);
      if (!n || n.laneIndex !== INNER_MAIN_LANE || dist.has(nextId)) continue;
      dist.set(nextId, d + 1);
      passedTo.set(nextId, through);
      queue.push(nextId);
    }
  }
  for (const [cellId, d] of dist) {
    const cell = cellMap.get(cellId)!;
    const passed = passedTo.get(cellId)!;
    if (d <= 0 || occupied.has(cellId) || passed < 1) continue;
    const moveSpend = computeMoveSpend(d, startCell.laneIndex, cell.laneIndex) + SQUEEZE_SURCHARGE_PER_CAR * passed;
    if (moveSpend > maxSteps) continue;
    const { tireCost, fuelCost } = computeCosts(d, cell.laneIndex, costs);
    targets.set(cellId, { distance: d, moveSpend, tireCost, fuelCost, isPitTrigger: false, squeezePassed: passed });
  }
  return targets;
}
